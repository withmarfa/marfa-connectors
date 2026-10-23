import { Refused, Unreachable } from "@withmarfa/connector";

/**
 * - `reconnect`: Google no longer accepts the grant (`invalid_grant`).
 * - `client`: Google does not know the OAuth client (`invalid_client`).
 * - `account`: the grant belongs to another Google account than the rows.
 * - `passing`: a rate limit, a server error or no answer; it can pass.
 * - `quota`: the usage limit, which lasts until Google resets it.
 * - `refused`: Google will not take the request as it stands.
 */
export type GoogleErrorKind =
  "reconnect" | "client" | "account" | "passing" | "quota" | "refused";

export interface Condition {
  readonly key: string;
  readonly message: string;
}

export interface GoogleErrorDetail {
  readonly status?: number | undefined;
  /** Google's own word for it: an `error` code or an error's `reason`. */
  readonly reason?: string | undefined;
  /** When Google said to ask again, as an ISO time. */
  readonly retryAt?: string | undefined;
  /** What a run raises so the person can see it and what to do. */
  readonly condition?: Condition | undefined;
  readonly cause?: unknown;
}

/** An error whose message never holds a token or an `Authorization` header. */
export class GoogleError extends Error {
  override name = "GoogleError";
  readonly status: number | undefined;
  readonly reason: string | undefined;
  readonly retryAt: string | undefined;
  readonly condition: Condition | undefined;

  constructor(
    message: string,
    readonly kind: GoogleErrorKind,
    detail: GoogleErrorDetail = {},
  ) {
    super(
      message,
      detail.cause === undefined ? undefined : { cause: detail.cause },
    );
    this.status = detail.status;
    this.reason = detail.reason;
    this.retryAt = detail.retryAt;
    this.condition = detail.condition;
  }
}

/** The longest Google can ask to wait before the wait is not believed. */
const longestWaitMs = 24 * 60 * 60 * 1000;

/** `Retry-After` as an ISO time, or `undefined` for a value that is missing,
 *  past or not a time. */
export function retryAfter(
  header: string | null,
  now: number,
): string | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return new Date(Math.min(at, now + longestWaitMs)).toISOString();
}

/** A text cut to `limit`, so Google's words never crowd out the rest. */
export function brief(text: string, limit = 200): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= limit ? one : `${one.slice(0, limit - 1)}…`;
}

const rateReasons = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const quotaReasons = new Set(["quotaExceeded", "dailyLimitExceeded"]);

interface Said {
  readonly message: string | undefined;
  readonly reason: string | undefined;
}

/** Google's error body is `{error:{code,message,errors:[{reason}]}}`. */
function said(body: unknown): Said {
  if (typeof body !== "object" || body === null) {
    return { message: undefined, reason: undefined };
  }
  const error: unknown = Reflect.get(body, "error");
  if (typeof error !== "object" || error === null) {
    return { message: undefined, reason: undefined };
  }
  const message: unknown = Reflect.get(error, "message");
  const errors: unknown = Reflect.get(error, "errors");
  const details: unknown = Reflect.get(error, "details");
  const reasons = [errors, details]
    .flatMap((list) => (Array.isArray(list) ? (list as unknown[]) : []))
    .map((one: unknown): unknown =>
      typeof one === "object" && one !== null
        ? Reflect.get(one, "reason")
        : undefined,
    )
    .filter((one): one is string => typeof one === "string");
  return {
    message: typeof message === "string" ? brief(message) : undefined,
    reason: reasons[0],
  };
}

/** What an API answer that was not a success is, from its status, parsed
 *  body (`undefined` where it was not JSON) and `Retry-After`. */
export function classify(
  status: number,
  body: unknown,
  retryHeader: string | null,
  now: number,
): GoogleError {
  const { message, reason } = said(body);
  const kind: GoogleErrorKind =
    status === 429 ||
    status >= 500 ||
    (status === 403 && reason !== undefined && rateReasons.has(reason))
      ? "passing"
      : status === 403 && reason !== undefined && quotaReasons.has(reason)
        ? "quota"
        : "refused";
  const detail = [
    String(status),
    ...(reason === undefined ? [] : [reason]),
  ].join(" ");
  return new GoogleError(
    `Google answered ${detail}${message === undefined ? "" : `: ${message}`}`,
    kind,
    {
      status,
      reason,
      retryAt: kind === "passing" ? retryAfter(retryHeader, now) : undefined,
    },
  );
}

/**
 * What a connector's `onChange` throws for a Google error: `Unreachable` for
 * one that can pass or that waits on the usage limit, with Google's deadline
 * where it gave one, and `Refused` for one that will not change by sending
 * again. Any other error, and one that ends the sign-in, is not a change's
 * to answer, so this returns `undefined` and the connector lets it fail the
 * run.
 */
export function toChangeError(
  error: unknown,
): Unreachable | Refused | undefined {
  if (!(error instanceof GoogleError)) return undefined;
  if (error.kind === "passing" || error.kind === "quota") {
    return new Unreachable(
      error.message,
      error.retryAt === undefined ? undefined : { retryAt: error.retryAt },
    );
  }
  if (error.kind === "refused") return new Refused(error.message);
  return undefined;
}
