import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Refused, Unreachable } from "@withmarfa/connector";
import {
  connectGoogle,
  GoogleError,
  missingScopes,
  toChangeError,
  type GoogleOptions,
} from "../src/index.js";
import {
  captured,
  clientEnv,
  freshToken,
  GoogleStub,
  idToken,
} from "./stub.js";

const A = "https://www.googleapis.com/auth/a";
const B = "https://www.googleapis.com/auth/b";

let stub: GoogleStub;
let time: number;
beforeEach(async () => {
  stub = await new GoogleStub().start();
  stub.scope = `openid ${A} ${B}`;
  time = Date.parse("2026-10-23T09:00:00.000Z");
});
afterEach(async () => {
  await stub.stop();
});

function options(extra: Partial<GoogleOptions> = {}): GoogleOptions {
  return { endpoints: stub.endpoints, now: () => time, ...extra };
}

const rowType = "google.test.entry";

function needs(scopes: string[]) {
  return { scopes, types: [rowType] };
}

function run(token: string, state = new Map<string, unknown>()) {
  const seen = captured({ ...clientEnv, GOOGLE_REFRESH_TOKEN: token }, state);
  return seen;
}

/** What `onChange`, `remake` or `preflight` is handed. */
function watch(token: string, state = new Map<string, unknown>()) {
  return captured(
    { ...clientEnv, GOOGLE_REFRESH_TOKEN: token },
    state,
    "watch",
  );
}

async function failure(promise: Promise<unknown>): Promise<GoogleError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GoogleError)) throw new Error("it did not fail");
  return error;
}

/** Everything a person could read after a run. */
function everything(seen: ReturnType<typeof run>, ...errors: Error[]): string {
  return [
    ...seen.lines,
    ...seen.conditions.values(),
    ...errors.map((error) => error.message),
  ].join("\n");
}

describe("the access token", () => {
  it("is refreshed when missing, kept until near its end, and refreshed again then", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    await google.ready();
    await google.ready();
    expect(stub.token).toHaveLength(1);
    const call = stub.token[0];
    expect(call?.method).toBe("POST");
    expect(call?.form.get("grant_type")).toBe("refresh_token");
    expect(call?.form.get("client_id")).toBe(clientEnv.GOOGLE_CLIENT_ID);
    expect(call?.form.get("client_secret")).toBe(
      clientEnv.GOOGLE_CLIENT_SECRET,
    );
    expect(call?.form.get("refresh_token")).toBe(
      seen.context.env["GOOGLE_REFRESH_TOKEN"],
    );
    await google.json(`${stub.url}/things`);
    expect(stub.api[0]?.authorization).toBe(
      "Bearer ya29.access-token-number-1",
    );
    time += 3600_000 - 30_000;
    await google.json(`${stub.url}/things`);
    expect(stub.token).toHaveLength(2);
    expect(stub.api[1]?.authorization).toBe(
      "Bearer ya29.access-token-number-2",
    );
  });

  it("is kept for the whole process, so a later run's handle does not refresh it again", async () => {
    const token = freshToken();
    await connectGoogle(run(token).context, needs([A]), options()).ready();
    await connectGoogle(run(token).context, needs([A]), options()).ready();
    expect(stub.token).toHaveLength(1);
  });

  it("is refreshed once and the call sent once more where Google answers 401, never in a loop", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    stub.onApi = (call) =>
      stub.api.length === 1
        ? { status: 401, json: {} }
        : { json: { ok: call.path } };
    expect(await google.json(`${stub.url}/things`)).toEqual({ ok: "/things" });
    expect(stub.token).toHaveLength(2);
    expect(stub.api.map((call) => call.authorization)).toEqual([
      "Bearer ya29.access-token-number-1",
      "Bearer ya29.access-token-number-2",
    ]);

    stub.onApi = () => ({
      status: 401,
      json: { error: { code: 401, message: "Invalid Credentials" } },
    });
    const error = await failure(google.json(`${stub.url}/things`));
    expect(error.kind).toBe("refused");
    expect(error.status).toBe(401);
    expect(stub.token).toHaveLength(3);
    expect(stub.api).toHaveLength(4);
  });

  it("is sent only to Google's own API hosts", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    await expect(google.fetch("https://evil.example/steal")).rejects.toThrow(
      /will not send a Google access token to https:\/\/evil\.example/,
    );
    await expect(google.fetch("http://www.googleapis.com/x")).rejects.toThrow(
      /will not send/,
    );
    await expect(
      google.fetch("https://googleapis.com.evil.example/x"),
    ).rejects.toThrow(/will not send/);
    expect(stub.token).toHaveLength(0);
    expect(stub.api).toHaveLength(0);
  });

  it("gives up on a call that outlasts its time limit, as a passing failure", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(
      seen.context,
      needs([A]),
      options({ timeoutMs: 80 }),
    );
    await google.ready();
    stub.onApi = () => ({ hang: true });
    const error = await failure(google.json(`${stub.url}/slow`));
    expect(error.kind).toBe("passing");
    expect(error.message).toMatch(/did not answer/);
  });

  it("stops with the run's own signal, not as a Google failure", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    await google.ready();
    stub.onApi = () => ({ hang: true });
    const pending = google.json(`${stub.url}/slow`).catch((e: unknown) => e);
    setTimeout(() => {
      seen.abort();
    }, 30);
    const error = await pending;
    expect(error).not.toBeInstanceOf(GoogleError);
  });
});

describe("a grant Google no longer accepts", () => {
  it("raises one condition to reconnect on invalid_grant, fails the run, and never calls Google again in that process", async () => {
    const token = freshToken();
    stub.onToken = () => ({
      status: 400,
      json: {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
    });
    const seen = run(token);
    const google = connectGoogle(seen.context, needs([A]), options());
    const error = await failure(google.ready());
    expect(error.kind).toBe("reconnect");
    expect([...seen.conditions.keys()]).toEqual(["google:reconnect"]);
    const text = seen.conditions.get("google:reconnect") ?? "";
    expect(text).toMatch(/reconnect/i);
    expect(text).toContain("--setup <file>");
    expect(stub.token).toHaveLength(1);

    // Under --every, each later run fails fast with the same condition.
    for (let again = 0; again < 3; again += 1) {
      const later = run(token);
      const handle = connectGoogle(later.context, needs([A]), options());
      const same = await failure(handle.ready());
      expect(same.kind).toBe("reconnect");
      expect(later.conditions.get("google:reconnect")).toBe(text);
      await failure(handle.json(`${stub.url}/things`));
      time += 15 * 60_000;
    }
    expect(stub.token).toHaveLength(1);
    expect(stub.api).toHaveLength(0);
    expect(stub.userinfo).toHaveLength(0);

    // Restarted with a new refresh token, it signs in again.
    stub.onToken = () => undefined;
    await connectGoogle(
      run(freshToken()).context,
      needs([A]),
      options(),
    ).ready();
    expect(stub.token).toHaveLength(2);
  });

  it("stops at the first invalid_grant that comes from a 401 retry too", async () => {
    const token = freshToken();
    const seen = run(token);
    const google = connectGoogle(seen.context, needs([A]), options());
    await google.ready();
    stub.onApi = () => ({ status: 401, json: {} });
    stub.onToken = () => ({ status: 400, json: { error: "invalid_grant" } });
    const error = await failure(google.json(`${stub.url}/things`));
    expect(error.kind).toBe("reconnect");
    expect(seen.conditions.has("google:reconnect")).toBe(true);
    await failure(google.json(`${stub.url}/things`));
    expect(stub.token).toHaveLength(2);
    expect(stub.api).toHaveLength(1);
  });

  it("names its own condition for invalid_client, and stops calling Google", async () => {
    const token = freshToken();
    stub.onToken = () => ({
      status: 401,
      json: {
        error: "invalid_client",
        error_description: "The OAuth client was not found.",
      },
    });
    const seen = run(token);
    const error = await failure(
      connectGoogle(seen.context, needs([A]), options()).ready(),
    );
    expect(error.kind).toBe("client");
    expect([...seen.conditions.keys()]).toEqual(["google:client"]);
    const text = seen.conditions.get("google:client") ?? "";
    expect(text).toContain("GOOGLE_CLIENT_ID");
    expect(text).toContain("GOOGLE_CLIENT_SECRET");
    expect(text).not.toMatch(/reconnect/i);
    await failure(
      connectGoogle(run(token).context, needs([A]), options()).ready(),
    );
    expect(stub.token).toHaveLength(1);
  });

  it("is told apart from a server error, a rate limit, a timeout and a body that is not JSON, which pass", async () => {
    const token = freshToken();
    const seen = run(token);
    const google = connectGoogle(
      seen.context,
      needs([A]),
      options({ timeoutMs: 80 }),
    );

    stub.onToken = () => ({ status: 500, text: "<html>boom</html>" });
    let error = await failure(google.ready());
    expect(error.kind).toBe("passing");
    expect(error.message).not.toContain("boom");

    stub.onToken = () => ({
      status: 200,
      text: "<html>captive portal secret-body</html>",
    });
    error = await failure(google.ready());
    expect(error.kind).toBe("passing");
    expect(error.message).toMatch(/not JSON/);
    expect(error.message).not.toContain("secret-body");

    stub.onToken = () => ({ status: 400, text: "Bad Request" });
    error = await failure(google.ready());
    expect(error.kind).toBe("passing");

    stub.onToken = () => ({ hang: true });
    error = await failure(google.ready());
    expect(error.kind).toBe("passing");

    expect(seen.conditions.size).toBe(0);
    // None of them ended the grant: the next call asks again.
    stub.onToken = () => undefined;
    await google.ready();
    expect(stub.token).toHaveLength(5);
  });

  it("waits out a Retry-After from the token endpoint without asking again, then asks again", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    stub.onToken = () => ({
      status: 429,
      headers: { "Retry-After": "120" },
      json: { error: "rate_limit" },
    });
    const error = await failure(google.ready());
    expect(error.kind).toBe("passing");
    expect(error.retryAt).toBe(new Date(time + 120_000).toISOString());
    expect(seen.conditions.size).toBe(0);
    time += 60_000;
    const again = await failure(google.ready());
    expect(again.retryAt).toBe(error.retryAt);
    expect(stub.token).toHaveLength(1);
    time += 61_000;
    stub.onToken = () => undefined;
    await google.ready();
    expect(stub.token).toHaveLength(2);
  });

  it("fails a 429 with no Retry-After as passing, asking again next time", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    stub.onToken = () => ({ status: 429, json: {} });
    const error = await failure(google.ready());
    expect(error.kind).toBe("passing");
    expect(error.retryAt).toBeUndefined();
    stub.onToken = () => undefined;
    await google.ready();
  });
});

describe("a refresh that answers more than an access token", () => {
  it("raises a condition for a new refresh token, uses it in memory, and never logs it", async () => {
    const original = freshToken();
    const issued = "1//a-new-refresh-token-google-issued";
    stub.onToken = (call) =>
      call.form.get("refresh_token") === original
        ? stub.granted({ refresh_token: issued })
        : undefined;
    const seen = run(original);
    const google = connectGoogle(seen.context, needs([A]), options());
    await google.ready();
    const text = seen.conditions.get("google:refresh-token-changed") ?? "";
    expect(text).toContain("--setup <file>");
    expect(text).toContain("GOOGLE_REFRESH_TOKEN");
    expect(seen.secrets).toContain(issued);

    time += 3600_000;
    await google.ready();
    expect(stub.token[1]?.form.get("refresh_token")).toBe(issued);

    // The next run raises it again, since the process still holds it.
    const later = run(original);
    await connectGoogle(later.context, needs([A]), options()).ready();
    expect(later.conditions.has("google:refresh-token-changed")).toBe(true);
    expect(everything(seen)).not.toContain(issued);
    expect(everything(later)).not.toContain(issued);
  });

  it("raises a condition with the date time-based access ends, and says ongoing access avoids it", async () => {
    stub.onToken = () => stub.granted({ refresh_token_expires_in: 7 * 86_400 });
    const seen = run(freshToken());
    await connectGoogle(seen.context, needs([A]), options()).ready();
    const text = seen.conditions.get("google:refresh-token-expires") ?? "";
    expect(text).toContain("2026-10-30 at 09:00 UTC");
    expect(text).toMatch(/ongoing access/);
    expect(text).toContain("--setup <file>");
  });
});

describe("the scopes granted", () => {
  it("raises one condition for each wanted scope Google did not grant, naming it and the setup that fixes it", async () => {
    stub.scope = `openid ${A}`;
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A, B]), options());
    const access = await google.ready();
    expect(access.missing).toEqual([B]);
    expect(access.has(A)).toBe(true);
    expect(access.has(B)).toBe(false);
    expect([...seen.conditions.keys()]).toEqual([`google:scope:${B}`]);
    const text = seen.conditions.get(`google:scope:${B}`) ?? "";
    expect(text).toContain(B);
    expect(text).toContain("--setup <file>");
  });

  it("raises none where every wanted scope was granted", async () => {
    const seen = run(freshToken());
    const access = await connectGoogle(
      seen.context,
      needs([A, B]),
      options(),
    ).ready();
    expect(access.missing).toEqual([]);
    expect(seen.conditions.size).toBe(0);
  });

  it("goes on where Google sends no scope, saying it could not check", async () => {
    stub.scope = undefined;
    const seen = run(freshToken());
    const access = await connectGoogle(
      seen.context,
      needs([A, B]),
      options(),
    ).ready();
    expect(access.missing).toEqual([]);
    expect(access.granted).toBeUndefined();
    expect(seen.conditions.size).toBe(0);
    expect(seen.lines.join("\n")).toMatch(/did not say which permissions/);
  });

  it("answers which scopes are missing without Google", () => {
    expect(missingScopes(new Set([A]), [A, B])).toEqual([B]);
    expect(missingScopes(undefined, [A, B])).toEqual([]);
  });
});

describe("the Google account", () => {
  it("keeps the first sub in the connector's state and accepts it on later runs", async () => {
    const state = new Map<string, unknown>();
    const first = run(freshToken(), state);
    const access = await connectGoogle(
      first.context,
      needs([A]),
      options(),
    ).ready();
    expect(access.account).toBe(stub.sub);
    expect([...state.values()]).toEqual([stub.sub]);
    const second = run(freshToken(), state);
    await connectGoogle(second.context, needs([A]), options()).ready();
    expect(second.conditions.size).toBe(0);
  });

  it("refuses a grant that belongs to a different account before anything is read, with a condition", async () => {
    const state = new Map<string, unknown>();
    await connectGoogle(
      run(freshToken(), state).context,
      needs([A]),
      options(),
    ).ready();
    stub.sub = "sub-2222222222";
    const seen = run(freshToken(), state);
    const google = connectGoogle(seen.context, needs([A]), options());
    const error = await failure(google.ready());
    expect(error.kind).toBe("account");
    expect(seen.conditions.get("google:account")).toMatch(
      /different Google account/,
    );
    expect(stub.api).toHaveLength(0);
    expect([...state.values()]).toEqual(["sub-1111111111"]);
  });

  it("asks Google's userinfo where a refresh carries no id_token", async () => {
    stub.withIdToken = false;
    stub.sub = "sub-3333333333";
    const state = new Map<string, unknown>();
    const seen = run(freshToken(), state);
    const access = await connectGoogle(
      seen.context,
      needs([A]),
      options(),
    ).ready();
    expect(access.account).toBe("sub-3333333333");
    expect(stub.userinfo).toHaveLength(1);
    expect(stub.userinfo[0]?.authorization).toMatch(/^Bearer ya29\./);
    expect([...state.values()]).toEqual(["sub-3333333333"]);
  });

  it("asks userinfo, and does not trust the token, where the id_token is not one", async () => {
    stub.onToken = () => stub.granted({ id_token: "not.a.jwt" });
    const seen = run(freshToken());
    const access = await connectGoogle(
      seen.context,
      needs([A]),
      options(),
    ).ready();
    expect(access.account).toBe(stub.sub);
    expect(stub.userinfo).toHaveLength(1);
  });

  it("fails clearly where userinfo does not say who the account is", async () => {
    stub.withIdToken = false;
    stub.onUserinfo = () => ({ json: {} });
    const error = await failure(
      connectGoogle(run(freshToken()).context, needs([A]), options()).ready(),
    );
    expect(error.message).toMatch(/which Google account/);
  });

  it("refuses, where no account is kept, rows the connector wrote for another account, as after its state was cleared", async () => {
    const seen = run(freshToken());
    seen.rows.set(rowType, ["sub-2222222222:event-1"]);
    const error = await failure(
      connectGoogle(seen.context, needs([A]), options()).ready(),
    );
    expect(error.kind).toBe("account");
    expect(seen.conditions.has("google:account")).toBe(true);
    expect(seen.state.size).toBe(0);
    // The witness: rows of its own account, or without one, are taken.
    const own = run(freshToken());
    own.rows.set(rowType, [`${stub.sub}:event-1`, "made-by-hand"]);
    await connectGoogle(own.context, needs([A]), options()).ready();
    expect([...own.state.values()]).toEqual([stub.sub]);
  });

  it("does not keep an account in a run started between scheduled runs", async () => {
    const seen = captured(
      { ...clientEnv, GOOGLE_REFRESH_TOKEN: freshToken() },
      new Map(),
    );
    const context = { ...seen.context, hints: new Map() };
    await expect(
      connectGoogle(context, needs([A]), options()).ready(),
    ).rejects.toThrow(/next scheduled run keeps it/);
    expect(seen.state.size).toBe(0);
  });

  it("fails before reading where the instance would not keep the account", async () => {
    const seen = run(freshToken());
    const context = {
      ...seen.context,
      forScope: () => ({
        state: {
          checkpoint: () =>
            Promise.resolve({ committed: false, reason: "state-oversized" }),
        },
      }),
    };
    const google = connectGoogle(context, needs([A]), options());
    await expect(google.ready()).rejects.toThrow(/state-oversized/);
    await expect(google.json(`${stub.url}/items`)).rejects.toThrow(
      /state-oversized/,
    );
    expect(stub.api).toHaveLength(0);
  });
});

describe("a call outside a run", () => {
  it("is not sent, and raises the account condition, where the grant is another account's than the one kept", async () => {
    const state = new Map<string, unknown>([["google_account", "sub-a"]]);
    const seen = watch(freshToken(), state);
    const google = connectGoogle(seen.context, needs([A]), options());
    const error = await failure(
      google.json(`${stub.url}/items`, { method: "POST", body: "{}" }),
    );
    expect(error.kind).toBe("account");
    expect(toChangeError(error)).toBeUndefined();
    expect(seen.conditions.has("google:account")).toBe(true);
    expect(stub.api).toHaveLength(0);
    // The witness: the kept account's own call is sent.
    const own = watch(freshToken(), new Map([["google_account", stub.sub]]));
    await connectGoogle(own.context, needs([A]), options()).json(
      `${stub.url}/items`,
      { method: "POST", body: "{}" },
    );
    expect(stub.api).toHaveLength(1);
  });

  it("waits, unsent, until a run keeps an account, and keeps none itself", async () => {
    const state = new Map<string, unknown>();
    const seen = watch(freshToken(), state);
    const google = connectGoogle(seen.context, needs([A]), options());
    const error = await google
      .fetch(`${stub.url}/items`, { method: "POST" })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(Unreachable);
    expect((error as Unreachable).scope).toBe("google:account");
    expect(stub.api).toHaveLength(0);
    expect(state.size).toBe(0);
    await connectGoogle(
      run(freshToken(), state).context,
      needs([A]),
      options(),
    ).ready();
    await google.fetch(`${stub.url}/items`, { method: "POST" });
    expect(stub.api).toHaveLength(1);
  });

  it("checks the account once for a handle, before its first call", async () => {
    const state = new Map<string, unknown>([["google_account", stub.sub]]);
    stub.withIdToken = false;
    const seen = watch(freshToken(), state);
    const google = connectGoogle(seen.context, needs([A]), options());
    await Promise.all([
      google.json(`${stub.url}/one`),
      google.json(`${stub.url}/two`),
    ]);
    await google.json(`${stub.url}/three`);
    expect(stub.userinfo).toHaveLength(1);
    expect(stub.api).toHaveLength(3);
  });
});

describe("what Google answers to an API call", () => {
  const cases: [string, number, unknown, string][] = [
    ["a rate limit", 429, {}, "passing"],
    ["a rate limit by 403", 403, reason("rateLimitExceeded"), "passing"],
    [
      "a user rate limit by 403",
      403,
      reason("userRateLimitExceeded"),
      "passing",
    ],
    ["a server error", 500, {}, "passing"],
    ["an unavailable backend", 503, reason("backendError"), "passing"],
    ["the usage limit", 403, reason("quotaExceeded"), "quota"],
    ["a forbidden call", 403, reason("forbidden"), "refused"],
    ["a missing row", 404, reason("notFound"), "refused"],
    ["a bad request", 400, reason("invalid"), "refused"],
    ["a body that is not JSON", 502, "<html>bad gateway</html>", "passing"],
    ["a refusal that is not JSON", 400, "<html>no</html>", "refused"],
  ];
  function reason(value: string): unknown {
    return {
      error: {
        code: 403,
        message: `because ${value}`,
        errors: [{ reason: value }],
      },
    };
  }
  it.each(cases)("classifies %s", async (_name, status, body, kind) => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    stub.onApi = () =>
      typeof body === "string"
        ? { status, text: body }
        : { status, json: body };
    const error = await failure(google.json(`${stub.url}/things`));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    const said = everything(seen, error);
    expect(said).not.toContain("Bearer");
    expect(said).not.toContain("ya29.");
    expect(said).not.toContain("<html>");
  });

  it("names Google's reason and message, and honors Retry-After in seconds and as a date", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    stub.onApi = () => ({
      status: 429,
      headers: { "Retry-After": "30" },
      json: {
        error: {
          code: 429,
          message: "Too many requests",
          errors: [{ reason: "rateLimitExceeded" }],
        },
      },
    });
    let error = await failure(google.json(`${stub.url}/things`));
    expect(error.reason).toBe("rateLimitExceeded");
    expect(error.message).toContain("Too many requests");
    expect(error.retryAt).toBe(new Date(time + 30_000).toISOString());

    const at = new Date(time + 90_000).toUTCString();
    stub.onApi = () => ({
      status: 503,
      headers: { "Retry-After": at },
      json: {},
    });
    error = await failure(google.json(`${stub.url}/things`));
    expect(error.retryAt).toBe(new Date(time + 90_000).toISOString());

    stub.onApi = () => ({
      status: 503,
      headers: { "Retry-After": "soon" },
      json: {},
    });
    error = await failure(google.json(`${stub.url}/things`));
    expect(error.retryAt).toBeUndefined();
  });

  it("becomes what onChange throws: a passing failure Unreachable with its deadline, a refusal Refused", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    stub.onApi = () => ({
      status: 429,
      headers: { "Retry-After": "30" },
      json: {},
    });
    const passing = toChangeError(await failure(google.json(`${stub.url}/x`)));
    expect(passing).toBeInstanceOf(Unreachable);
    expect((passing as Unreachable).retryAt).toBe(
      new Date(time + 30_000).toISOString(),
    );
    stub.onApi = () => ({ status: 404, json: reason("notFound") });
    expect(
      toChangeError(await failure(google.json(`${stub.url}/x`))),
    ).toBeInstanceOf(Refused);
    stub.onApi = () => ({ status: 403, json: reason("quotaExceeded") });
    expect(
      toChangeError(await failure(google.json(`${stub.url}/x`))),
    ).toBeInstanceOf(Unreachable);
    expect(toChangeError(new Error("not Google's"))).toBeUndefined();
    stub.onToken = () => ({ status: 400, json: { error: "invalid_grant" } });
    const reconnect = await failure(
      connectGoogle(run(freshToken()).context, needs([A]), options()).ready(),
    );
    expect(toChangeError(reconnect)).toBeUndefined();
  });

  it("answers JSON, and an empty body as undefined", async () => {
    const seen = run(freshToken());
    const google = connectGoogle(seen.context, needs([A]), options());
    expect(await google.json(`${stub.url}/x`)).toEqual({ ok: true });
    stub.onApi = () => ({ status: 204, text: "" });
    expect(await google.json(`${stub.url}/x`)).toBeUndefined();
  });
});

describe("secrets", () => {
  it("never reach a log line, a condition or an error, and every token is handed to the kit's secret first", async () => {
    const original = freshToken();
    const issued = "1//a-new-refresh-token-google-issued-two";
    stub.onToken = () =>
      stub.granted({ refresh_token: issued, refresh_token_expires_in: 86_400 });
    const seen = run(original);
    const google = connectGoogle(
      seen.context,
      needs([A, "https://www.googleapis.com/auth/c"]),
      options(),
    );
    await google.ready();
    stub.onApi = () => ({ status: 403, json: reason403() });
    const error = await failure(google.json(`${stub.url}/x`));
    function reason403(): unknown {
      return {
        error: {
          code: 403,
          message: "nope",
          errors: [{ reason: "forbidden" }],
        },
      };
    }
    const said = everything(seen, error);
    for (const secret of [
      original,
      issued,
      clientEnv.GOOGLE_CLIENT_SECRET,
      "ya29.access-token-number-1",
      idToken(stub.sub),
    ]) {
      expect(said).not.toContain(secret);
    }
    expect(seen.secrets).toEqual(
      expect.arrayContaining([
        issued,
        "ya29.access-token-number-1",
        idToken(stub.sub),
      ]),
    );
    // The witness: the same text does hold a token where one is put there.
    expect(`${said}${issued}`).toContain(issued);
  });
});
