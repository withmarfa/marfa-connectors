import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalCallback } from "@withmarfa/connector";
import { signIn, type GoogleSetupContext } from "../src/index.js";
import { clientEnv, GoogleStub, idToken } from "./stub.js";

async function failure(result: Promise<unknown>): Promise<Error> {
  const outcome = await result.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("setup did not fail");
  return outcome;
}

const A = "https://www.googleapis.com/auth/a";
const B = "https://www.googleapis.com/auth/b";
const issued = "1//the-refresh-token-google-issued-in-setup";
const code = "4/0AVeryLongAuthorizationCodeFromGoogle";

let stub: GoogleStub;
let time: number;
beforeEach(async () => {
  stub = await new GoogleStub().start();
  time = Date.parse("2026-10-23T09:00:00.000Z");
  stub.onToken = (call) =>
    call.form.get("grant_type") === "authorization_code"
      ? stub.granted({
          refresh_token: issued,
          scope: `openid ${A}`,
        })
      : undefined;
});
afterEach(async () => {
  await stub.stop();
});

interface Driven {
  readonly context: GoogleSetupContext;
  readonly lines: string[];
  readonly secrets: string[];
  readonly page: () => string;
  /** The address a browser on another machine opens, where setup asked the
   *  kit to take a pasted redirect. */
  readonly elsewhere: () => string | undefined;
  /** The address Google's consent screen is at, once setup gave it. */
  consent(): Promise<URL>;
  redirect(query: Record<string, string>): void;
  abort(): void;
}

/** A setup context standing in for the kit's, with the person's browser played by the test. */
function driven(env: Record<string, string | undefined>): Driven {
  const lines: string[] = [];
  const secrets: string[] = [];
  const controller = new AbortController();
  let arrive!: (query: URLSearchParams) => void;
  let fail!: (error: Error) => void;
  const redirected = new Promise<URLSearchParams>((resolve, reject) => {
    arrive = resolve;
    fail = reject;
  });
  redirected.catch(() => undefined);
  controller.signal.addEventListener("abort", () => {
    fail(new Error("stopped before the vendor redirected back"));
  });
  let shown = "";
  let elsewhere: string | undefined;
  const callback = "http://127.0.0.1:50123/0b1a2c3d/callback";
  const context: GoogleSetupContext = {
    env,
    signal: controller.signal,
    log: {
      info: (message) => lines.push(`info ${message}`),
      warn: (message) => lines.push(`warn ${message}`),
    },
    secret: (value) => {
      if (value.length < 8) throw new Error("too short to keep secret");
      secrets.push(value);
    },
    listen: (page, listening) => {
      shown = typeof page === "function" ? page(callback) : (page ?? "");
      elsewhere = listening?.paste?.(callback);
      const local: LocalCallback = {
        url: "http://127.0.0.1:50123/0b1a2c3d",
        callback,
        redirected,
        onward: () => undefined,
      };
      lines.push("info open http://127.0.0.1:50123/0b1a2c3d in a browser");
      return Promise.resolve(local);
    },
  };
  return {
    context,
    lines,
    secrets,
    page: () => shown,
    elsewhere: () => elsewhere,
    consent: async () => {
      const deadline = Date.now() + 3000;
      for (;;) {
        const found = /href="([^"]+)"/.exec(shown)?.[1];
        if (found !== undefined) {
          return new URL(found.replaceAll("&amp;", "&"));
        }
        if (Date.now() > deadline)
          throw new Error("setup never gave the address");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    redirect: (query) => {
      arrive(new URLSearchParams(query));
    },
    abort: () => {
      controller.abort();
    },
  };
}

const options = () => ({ endpoints: stub.endpoints, now: () => time });
const env = (extra: Record<string, string | undefined> = {}) => ({
  ...clientEnv,
  ...extra,
});

describe("signing in", () => {
  it("asks Google for consent with PKCE S256, a state, offline access and every scope, and answers the refresh token", async () => {
    const seen = driven(env());
    const result = signIn(seen.context, [A, B], options());
    const consent = await seen.consent();
    const query = consent.searchParams;
    expect(consent.origin + consent.pathname).toBe(`${stub.url}/auth`);
    expect(query.get("client_id")).toBe(clientEnv.GOOGLE_CLIENT_ID);
    expect(query.get("redirect_uri")).toBe(
      "http://127.0.0.1:50123/0b1a2c3d/callback",
    );
    expect(query.get("response_type")).toBe("code");
    expect(query.get("scope")).toBe(`openid ${A} ${B}`);
    expect(query.get("access_type")).toBe("offline");
    expect(query.get("prompt")).toBe("consent");
    expect(query.get("include_granted_scopes")).toBe("true");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(seen.page()).toContain(
      `href="${consent.toString().replaceAll("&", "&amp;")}"`,
    );

    seen.redirect({ code, state: query.get("state") ?? "" });
    expect(await result).toEqual({ GOOGLE_REFRESH_TOKEN: issued });

    expect(stub.token).toHaveLength(1);
    const form = stub.token[0]?.form;
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code")).toBe(code);
    expect(form?.get("client_id")).toBe(clientEnv.GOOGLE_CLIENT_ID);
    expect(form?.get("client_secret")).toBe(clientEnv.GOOGLE_CLIENT_SECRET);
    expect(form?.get("redirect_uri")).toBe(query.get("redirect_uri"));
    const verifier = form?.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      query.get("code_challenge"),
    );

    const logged = seen.lines.join("\n");
    for (const secret of [
      issued,
      code,
      verifier,
      clientEnv.GOOGLE_CLIENT_SECRET,
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(seen.secrets).toEqual(
      expect.arrayContaining([issued, code, verifier]),
    );
    expect(logged).toContain("every Google connector");
  });

  it("asks the kit to take a pasted redirect, from a browser on another machine that opens Google's consent address", async () => {
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    expect(seen.elsewhere()).toBe(consent.toString());
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    await result;
  });

  it("refuses without the client in the environment", async () => {
    for (const missing of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
      const seen = driven(env({ [missing]: undefined }));
      await expect(signIn(seen.context, [A], options())).rejects.toThrow(
        /setup needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
      );
    }
    expect(stub.token).toHaveLength(0);
  });

  it("refuses a redirect whose state is not the one it sent, without asking Google for tokens", async () => {
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    await seen.consent();
    seen.redirect({ code, state: "forged" });
    await expect(result).rejects.toThrow(/state/);
    expect(stub.token).toHaveLength(0);
    expect(seen.lines.join("\n")).not.toContain(code);
  });

  it.each([
    ["access_denied", "The user denied access", /access_denied/],
    [
      "admin_policy_enforced",
      "Blocked by your administrator",
      /admin_policy_enforced/,
    ],
  ])("reports Google's %s as it is", async (error, description, pattern) => {
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({
      error,
      error_description: description,
      state: consent.searchParams.get("state") ?? "",
    });
    const thrown = await failure(result);
    expect(thrown.message).toMatch(pattern);
    expect(thrown.message).toContain(description);
    expect(stub.token).toHaveLength(0);
  });

  it("says Advanced Protection can block an unverified app where access is denied", async () => {
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({
      error: "access_denied",
      state: consent.searchParams.get("state") ?? "",
    });
    const thrown = await failure(result);
    expect(thrown.message).toMatch(/Advanced Protection/);
  });

  it("fails where Google sends no usable code", async () => {
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({ state: consent.searchParams.get("state") ?? "" });
    await expect(result).rejects.toThrow(/no authorization code/);
  });

  it("fails where Google answers no refresh token, and says how to get one", async () => {
    stub.onToken = () => stub.granted({ scope: `openid ${A}` });
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    const thrown = await failure(result);
    expect(thrown.message).toMatch(/no refresh token/);
    expect(thrown.message).toMatch(/myaccount\.google\.com\/permissions/);
  });

  it("explains a code Google refuses", async () => {
    stub.onToken = () => ({
      status: 400,
      json: { error: "invalid_grant", error_description: "Bad Request" },
    });
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    const thrown = await failure(result);
    expect(thrown.message).toMatch(/authorization code/);
    expect(thrown.message).toMatch(/start setup again/);
    expect(thrown.message).not.toContain(code);
  });

  it("warns by name for each scope left unticked, and still answers the token", async () => {
    stub.onToken = () =>
      stub.granted({ refresh_token: issued, scope: `openid ${A}` });
    const seen = driven(env());
    const result = signIn(seen.context, [A, B], options());
    const consent = await seen.consent();
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    expect(await result).toEqual({ GOOGLE_REFRESH_TOKEN: issued });
    const warnings = seen.lines.filter((line) => line.startsWith("warn"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(B);
    expect(warnings[0]).not.toContain(`${A} `);
  });

  it("warns where Google did not say which scopes it granted", async () => {
    stub.onToken = () => {
      const reply = stub.granted({ refresh_token: issued });
      delete (reply.json as Record<string, unknown>)["scope"];
      return reply;
    };
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    await result;
    expect(seen.lines.join("\n")).toMatch(/did not say which permissions/);
  });

  it("warns with the date where Google granted time-based access", async () => {
    stub.onToken = () =>
      stub.granted({
        refresh_token: issued,
        scope: `openid ${A}`,
        refresh_token_expires_in: 7 * 86_400,
      });
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    const consent = await seen.consent();
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    await result;
    const warning = seen.lines.find((line) => line.startsWith("warn")) ?? "";
    expect(warning).toContain("2026-10-30");
    expect(warning).toMatch(/ongoing access/);
  });

  it("stops where setup is stopped while it waits", async () => {
    const seen = driven(env());
    const result = signIn(seen.context, [A], options());
    await seen.consent();
    seen.abort();
    await expect(result).rejects.toThrow(/stopped/);
  });
});

describe("signing in again with a grant already held", () => {
  const existing = "1//the-refresh-token-already-in-the-environment";

  it("asks for the scopes the grant holds and the connector's own, so the grant grows", async () => {
    stub.onToken = (call) => {
      if (call.form.get("grant_type") === "refresh_token") {
        return stub.granted({ scope: `openid ${A}` });
      }
      return stub.granted({ refresh_token: issued, scope: `openid ${A} ${B}` });
    };
    const seen = driven(env({ GOOGLE_REFRESH_TOKEN: existing }));
    const result = signIn(seen.context, [B], options());
    const consent = await seen.consent();
    expect(consent.searchParams.get("scope")?.split(" ").sort()).toEqual(
      ["openid", A, B].sort(),
    );
    expect(stub.token[0]?.form.get("refresh_token")).toBe(existing);
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    expect(await result).toEqual({ GOOGLE_REFRESH_TOKEN: issued });
    const logged = seen.lines.join("\n");
    expect(logged).not.toContain(existing);
    expect(logged).not.toContain(issued);
    expect(logged).toMatch(/adds .* to the grant/);
  });

  it("asks only for the connector's own scopes, and says so, where the grant it holds is no longer accepted", async () => {
    stub.onToken = (call) => {
      if (call.form.get("grant_type") === "refresh_token") {
        return { status: 400, json: { error: "invalid_grant" } };
      }
      return stub.granted({ refresh_token: issued, scope: `openid ${B}` });
    };
    const seen = driven(env({ GOOGLE_REFRESH_TOKEN: existing }));
    const result = signIn(seen.context, [B], options());
    const consent = await seen.consent();
    expect(consent.searchParams.get("scope")).toBe(`openid ${B}`);
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    await result;
    const warning = seen.lines.find((line) => line.startsWith("warn")) ?? "";
    expect(warning).toMatch(/no longer accepted/);
    expect(warning).toMatch(/every Google connector/);
    expect(seen.lines.join("\n")).not.toContain(existing);
  });

  it("stops where the client is wrong or Google cannot be reached, so it does not drop the grant's scopes unseen", async () => {
    stub.onToken = () => ({ status: 401, json: { error: "invalid_client" } });
    let seen = driven(env({ GOOGLE_REFRESH_TOKEN: existing }));
    await expect(signIn(seen.context, [B], options())).rejects.toThrow(
      /OAuth client/,
    );
    stub.onToken = () => ({ status: 503, json: {} });
    seen = driven(env({ GOOGLE_REFRESH_TOKEN: existing }));
    await expect(signIn(seen.context, [B], options())).rejects.toThrow(
      /existing grant/,
    );
  });

  it("asks for the connector's scopes alone, with a warning, where Google does not say what the grant holds", async () => {
    stub.onToken = (call) =>
      call.form.get("grant_type") === "refresh_token"
        ? (() => {
            const reply = stub.granted();
            delete (reply.json as Record<string, unknown>)["scope"];
            return reply;
          })()
        : stub.granted({ refresh_token: issued, scope: `openid ${B}` });
    const seen = driven(env({ GOOGLE_REFRESH_TOKEN: existing }));
    const result = signIn(seen.context, [B], options());
    const consent = await seen.consent();
    expect(consent.searchParams.get("scope")).toBe(`openid ${B}`);
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    await result;
    expect(seen.lines.join("\n")).toMatch(
      /did not say which permissions the existing grant holds/,
    );
  });

  it("warns where the new sign-in is a different Google account than the grant it replaces", async () => {
    stub.onToken = (call) => {
      if (call.form.get("grant_type") === "refresh_token") {
        return stub.granted({
          scope: `openid ${A}`,
          id_token: idToken("sub-old"),
        });
      }
      return stub.granted({
        refresh_token: issued,
        scope: `openid ${A} ${B}`,
        id_token: idToken("sub-new"),
      });
    };
    const seen = driven(env({ GOOGLE_REFRESH_TOKEN: existing }));
    const result = signIn(seen.context, [B], options());
    const consent = await seen.consent();
    seen.redirect({ code, state: consent.searchParams.get("state") ?? "" });
    await result;
    expect(seen.lines.join("\n")).toMatch(/different Google account/);
  });
});
