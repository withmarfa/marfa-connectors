import type { Secret } from "@withmarfa/connector";
import { brief, classify, GoogleError, retryAfter } from "./errors.js";
import type { Settings } from "./endpoints.js";
import { clientCondition, reconnectCondition } from "./conditions.js";

/** The most of an answer read, so a broken peer cannot fill memory. */
export const largest = 16 * 1024 * 1024;

/** What Google's token endpoint answered to a good request. */
export interface Tokens {
  readonly accessToken: string;
  readonly expiresInMs: number;
  /** Every scope the grant holds, or `undefined` where Google said none. */
  readonly scope: ReadonlySet<string> | undefined;
  /** The account's `sub`, from the `id_token`, where one came. */
  readonly sub: string | undefined;
  /** A refresh token Google issued with this answer. */
  readonly refreshToken: string | undefined;
  /** When time-based access ends, as milliseconds. */
  readonly endsAt: number | undefined;
}

export async function readText(
  response: Response,
  limit: number,
): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
    response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        throw new GoogleError(
          "Google's answer is larger than this connector reads",
          "passing",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The `sub` in an `id_token`. The token came straight from Google's token
 *  endpoint over TLS, so its signature is not checked. */
export function subOf(idToken: string): string | undefined {
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    );
    const sub: unknown =
      typeof payload === "object" && payload !== null
        ? Reflect.get(payload, "sub")
        : undefined;
    return typeof sub === "string" && sub !== "" ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** Sends `fetch` with the caller's signal and the time limit, and turns a
 *  call that failed or took too long into a passing failure. */
export async function send(
  settings: Settings,
  signal: AbortSignal,
  what: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const limit = AbortSignal.timeout(settings.timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([
        signal,
        limit,
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  } catch (cause) {
    // The run stopping is its own, not a failure of Google's.
    signal.throwIfAborted();
    throw new GoogleError(
      limit.aborted
        ? `${what} did not answer within ${String(Math.round(settings.timeoutMs / 1000))} seconds`
        : `${what} could not be reached`,
      "passing",
      { cause },
    );
  }
}

/**
 * Asks Google's token endpoint for tokens. Every token in the answer goes
 * through `secret` before anything else, and no body is ever put in an
 * error: Google's `error` code and description are.
 */
export async function requestTokens(
  settings: Settings,
  signal: AbortSignal,
  secret: Secret,
  form: Record<string, string>,
): Promise<Tokens> {
  const response = await send(
    settings,
    signal,
    "Google's token endpoint",
    settings.endpoints.token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    },
  );
  const now = settings.now();
  const text = await readText(response, 1024 * 1024).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw cause instanceof GoogleError
      ? cause
      : new GoogleError(
          "Google's token endpoint stopped answering",
          "passing",
          { cause },
        );
  });
  const retryAt = retryAfter(response.headers.get("Retry-After"), now);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GoogleError(
      `Google's token endpoint answered something that is not JSON (HTTP ${String(response.status)})`,
      "passing",
      { status: response.status, retryAt },
    );
  }
  const field = (name: string): unknown =>
    typeof body === "object" && body !== null
      ? Reflect.get(body, name)
      : undefined;
  for (const name of ["access_token", "id_token", "refresh_token"]) {
    const value = field(name);
    if (typeof value === "string" && value.length >= 8) secret(value);
  }
  const code = field("error");
  if (typeof code === "string") {
    const description = field("error_description");
    const said = `${code}${typeof description === "string" ? `: ${brief(description)}` : ""}`;
    if (code === "invalid_grant") {
      throw new GoogleError(`Google refused the grant (${said})`, "reconnect", {
        status: response.status,
        reason: code,
        condition: reconnectCondition(),
      });
    }
    if (code === "invalid_client") {
      throw new GoogleError(
        `Google does not know the OAuth client (${said})`,
        "client",
        {
          status: response.status,
          reason: code,
          condition: clientCondition(),
        },
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GoogleError(
        `Google's token endpoint answered ${String(response.status)} (${said})`,
        "passing",
        {
          status: response.status,
          reason: code,
          retryAt,
        },
      );
    }
    throw new GoogleError(
      `Google refused the token request (${said})`,
      "refused",
      {
        status: response.status,
        reason: code,
      },
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw classify(
      response.status,
      body,
      response.headers.get("Retry-After"),
      now,
    );
  }
  const accessToken = field("access_token");
  if (!response.ok || typeof accessToken !== "string" || accessToken === "") {
    throw new GoogleError(
      `Google's token endpoint answered HTTP ${String(response.status)} without an access token`,
      "passing",
      { status: response.status },
    );
  }
  const expires = field("expires_in");
  const scope = field("scope");
  const idToken = field("id_token");
  const refreshToken = field("refresh_token");
  const endsIn = field("refresh_token_expires_in");
  return {
    accessToken,
    // Google always sends it; short if it did not, so the token is refreshed soon.
    expiresInMs:
      typeof expires === "number" && expires > 0 ? expires * 1000 : 300_000,
    scope:
      typeof scope === "string"
        ? new Set(scope.split(/\s+/).filter(Boolean))
        : undefined,
    sub: typeof idToken === "string" ? subOf(idToken) : undefined,
    refreshToken:
      typeof refreshToken === "string" && refreshToken !== ""
        ? refreshToken
        : undefined,
    endsAt:
      typeof endsIn === "number" && endsIn > 0
        ? now + endsIn * 1000
        : undefined,
  };
}
