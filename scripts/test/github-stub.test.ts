import { createSign, generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { appKey, GitHubStub } from "../proof/github-stub.js";

// What each test holds the stand-in to is what GitHub does, as its
// documentation says or, where a title says "observed", as a read-only
// probe of api.github.com showed. The probe used user tokens only.

let key: string;
let github: GitHubStub;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  github = await new GitHubStub().start();
  github.appPem = key;
});

afterEach(async () => {
  await github.stop();
});

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT as GitHub documents it, with whichever claims a test bends. */
function jwt(
  claims: Record<string, unknown> = {},
  options: { key?: string; alg?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${base64url({ alg: options.alg ?? "RS256", typ: "JWT" })}.${base64url(
    { iat: now - 30, exp: now + 570, iss: String(github.appId), ...claims },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(signed)
    .sign(options.key ?? key)
    .toString("base64url");
  return `${signed}.${signature}`;
}

function asApp(
  token: string,
  scheme = "Bearer",
  path = "/app/installations/1/access_tokens",
): Promise<Response> {
  return fetch(`${github.url}${path}`, {
    method: path.endsWith("access_tokens") ? "POST" : "GET",
    headers: { authorization: `${scheme} ${token}` },
  });
}

async function mint(): Promise<string> {
  const answer = await asApp(jwt());
  expect(answer.status).toBe(201);
  return ((await answer.json()) as { token: string }).token;
}

function get(
  path: string,
  token: string,
  headers: Record<string, string> = {},
  scheme = "token",
): Promise<Response> {
  return fetch(`${github.url}${path}`, {
    headers: { authorization: `${scheme} ${token}`, ...headers },
  });
}

function graphql(token: string): Promise<Response> {
  return fetch(`${github.url}/graphql`, {
    method: "POST",
    headers: { authorization: `token ${token}` },
    body: JSON.stringify({
      query: "query Issues($ids: [ID!]!) { nodes(ids: $ids) { id } }",
      variables: { ids: [] },
    }),
  });
}

const issues = "/repos/someone/tracker/issues";

describe("a page's ETag", () => {
  it("answers 304 to another token of the installation that sends it, as GitHub was observed to tie no 304 to one user token", async () => {
    github.addIssue(github.addRepository("someone/tracker"));
    const first = await mint();
    const second = await mint();
    expect(second).not.toBe(first);
    const etag = (await get(issues, first)).headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect((await get(issues, second, { "if-none-match": etag })).status).toBe(
      304,
    );
  });

  it("answers 200 to a credential sent under another scheme, as GitHub's ETag was observed to name the scheme", async () => {
    github.addIssue(github.addRepository("someone/tracker"));
    const token = await mint();
    const etag = (await get(issues, token)).headers.get("etag") ?? "";
    const other = await get(issues, token, { "if-none-match": etag }, "Bearer");
    expect(other.status).toBe(200);
    expect(other.headers.get("etag")).not.toBe(etag);
    const again = await get(
      issues,
      token,
      { "if-none-match": other.headers.get("etag") ?? "" },
      "Bearer",
    );
    expect(again.status).toBe(304);
  });

  it("answers 200 to another media type, another page and a changed page", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const token = await mint();
    const etag = (await get(issues, token)).headers.get("etag") ?? "";
    const held = { "if-none-match": etag };
    expect(
      (
        await get(issues, token, {
          ...held,
          accept: "application/vnd.github.raw+json",
        })
      ).status,
    ).toBe(200);
    expect((await get(`${issues}?page=2`, token, held)).status).toBe(200);
    github.edit(issue, { title: "Changed" });
    expect((await get(issues, token, held)).status).toBe(200);
  });

  it("takes the weak form, a list and * for a match, as GitHub does", async () => {
    github.addIssue(github.addRepository("someone/tracker"));
    const token = await mint();
    const etag = (await get(issues, token)).headers.get("etag") ?? "";
    for (const held of [`W/${etag}`, `"other", ${etag}`, "*"]) {
      expect(
        (await get(issues, token, { "if-none-match": held })).status,
        held,
      ).toBe(304);
    }
    expect(
      (await get(issues, token, { "if-none-match": '"other"' })).status,
    ).toBe(200);
  });

  it("takes an installation token under either scheme GitHub accepts", async () => {
    github.addRepository("someone/tracker");
    const token = await mint();
    expect((await get(issues, token, {}, "bearer")).status).toBe(200);
    expect((await get(issues, `${token}x`, {}, "Bearer")).status).toBe(401);
  });
});

describe("the rate limit headers", () => {
  const carried = [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
  ];

  it("come with every answer, a 304 and a 404 among them", async () => {
    github.addIssue(github.addRepository("someone/tracker"));
    const token = await mint();
    const ok = await get(issues, token);
    const etag = ok.headers.get("etag") ?? "";
    for (const answer of [
      ok,
      await get(issues, token, { "if-none-match": etag }),
      await get("/repos/someone/missing", token),
      await asApp(jwt(), "Bearer", "/app"),
    ]) {
      for (const name of carried) {
        expect(
          answer.headers.get(name),
          `${String(answer.status)} ${name}`,
        ).not.toBeNull();
      }
      expect(Number(answer.headers.get("x-ratelimit-reset"))).toBeGreaterThan(
        Date.now() / 1000,
      );
    }
  });

  it("count REST and GraphQL separately, and name which", async () => {
    github.addIssue(github.addRepository("someone/tracker"));
    const token = await mint();
    const rest = await get(issues, token);
    expect(rest.headers.get("x-ratelimit-resource")).toBe("core");
    expect(rest.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(rest.headers.get("x-ratelimit-used")).toBe("1");
    const query = await graphql(token);
    expect(query.headers.get("x-ratelimit-resource")).toBe("graphql");
    expect(query.headers.get("x-ratelimit-remaining")).toBe("4999");
    const more = await get(issues, token);
    expect(more.headers.get("x-ratelimit-remaining")).toBe("4998");
    expect((await graphql(token)).headers.get("x-ratelimit-remaining")).toBe(
      "4998",
    );
  });

  it("count a 304 to an authorized request as nothing, and a 200 as one", async () => {
    github.addIssue(github.addRepository("someone/tracker"));
    const token = await mint();
    const first = await get(issues, token);
    const left = first.headers.get("x-ratelimit-remaining");
    const etag = first.headers.get("etag") ?? "";
    const unchanged = await get(issues, token, { "if-none-match": etag });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("x-ratelimit-remaining")).toBe(left);
    expect(
      (await get(issues, token)).headers.get("x-ratelimit-remaining"),
    ).toBe(String(Number(left) - 1));
  });

  it("belong to each installation, and the App has its own", async () => {
    github.installations.push({ id: 2, login: "another" });
    github.addRepository("another/other", { installation: 2 });
    github.addRepository("someone/tracker");
    const one = await mint();
    await get(issues, one);
    await get(issues, one);
    const answer = await asApp(
      jwt(),
      "Bearer",
      "/app/installations/2/access_tokens",
    );
    const two = ((await answer.json()) as { token: string }).token;
    expect(
      (await get("/repos/another/other", two)).headers.get(
        "x-ratelimit-remaining",
      ),
    ).toBe("4999");
    expect((await get(issues, one)).headers.get("x-ratelimit-remaining")).toBe(
      "4997",
    );
  });

  it("make a spent REST budget a 403 with the reset, and leave GraphQL its own", async () => {
    github.addRepository("someone/tracker");
    const token = await mint();
    github.exhaust("core");
    const refused = await get(issues, token);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /rate limit/i,
    );
    expect(refused.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(refused.headers.get("x-ratelimit-resource")).toBe("core");
    expect(refused.headers.get("x-ratelimit-reset")).toBe(
      String(github.budget("core").reset),
    );
    expect(refused.headers.get("retry-after")).toBeNull();
    const query = await graphql(token);
    expect(query.status).toBe(200);
    expect(
      ((await query.json()) as { errors?: unknown }).errors,
    ).toBeUndefined();
    expect(query.headers.get("x-ratelimit-remaining")).toBe("4999");
  });

  it("make a spent GraphQL budget an error under a 200 with the reset, and leave REST its own", async () => {
    github.addRepository("someone/tracker");
    const token = await mint();
    github.exhaust("graphql");
    const refused = await graphql(token);
    expect(refused.status).toBe(200);
    expect(
      ((await refused.json()) as { errors: { type: string }[] }).errors[0]
        ?.type,
    ).toBe("RATE_LIMITED");
    expect(refused.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(refused.headers.get("x-ratelimit-resource")).toBe("graphql");
    expect(refused.headers.get("x-ratelimit-reset")).toBe(
      String(github.budget("graphql").reset),
    );
    expect((await get(issues, token)).status).toBe(200);
  });

  it("are whole again once the reset has passed", async () => {
    github.addRepository("someone/tracker");
    const token = await mint();
    github.exhaust("core");
    github.budget("core").reset = Math.floor(Date.now() / 1000) - 1;
    const answer = await get(issues, token);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(Number(answer.headers.get("x-ratelimit-reset"))).toBeGreaterThan(
      Date.now() / 1000,
    );
  });

  it.each([403, 429] as const)(
    "come with the seconds to wait on a secondary limit answered %i",
    async (status) => {
      const repository = github.addRepository("someone/tracker");
      github.addIssue(repository);
      const token = await mint();
      github.writesLimited = { left: 1, status };
      const refused = await fetch(`${github.url}${issues}`, {
        method: "POST",
        headers: { authorization: `token ${token}` },
        body: JSON.stringify({ title: "New" }),
      });
      expect(refused.status).toBe(status);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(refused.headers.get("x-ratelimit-resource")).toBe("core");
      expect(
        Number(refused.headers.get("x-ratelimit-remaining")),
      ).toBeGreaterThan(0);
      expect(refused.headers.get("x-ratelimit-reset")).not.toBeNull();
    },
  );

  it("come with the seconds to wait on a GraphQL secondary limit", async () => {
    github.addRepository("someone/tracker");
    const token = await mint();
    github.mutationsLimited = 1;
    const refused = await fetch(`${github.url}/graphql`, {
      method: "POST",
      headers: { authorization: `token ${token}` },
      body: JSON.stringify({
        query: "mutation DeleteComment($id: ID!) { x }",
        variables: { id: "IC_1" },
      }),
    });
    expect(refused.status).toBe(200);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("x-ratelimit-resource")).toBe("graphql");
    expect(refused.headers.get("x-ratelimit-reset")).not.toBeNull();
  });

  it("show in what the stand-in records of a request", async () => {
    github.addRepository("someone/tracker");
    const token = await mint();
    github.exhaust("core");
    await get(issues, token);
    expect(github.asked.at(-1)).toMatchObject({
      status: 403,
      remaining: 0,
      limited: true,
    });
  });
});

describe("listing the comments of a repository", () => {
  async function ids(query: string): Promise<number[]> {
    const token = await mint();
    const answer = await get(
      `/repos/someone/tracker/issues/comments${query}`,
      token,
    );
    return ((await answer.json()) as { id: number }[]).map((one) => one.id);
  }

  function seed() {
    const issue = github.addIssue(github.addRepository("someone/tracker"));
    const [a, b, c] = ["a", "b", "c"].map((body) =>
      github.addComment(issue, body),
    );
    if (a === undefined || b === undefined || c === undefined)
      throw new Error("no comments");
    // Edited out of order, so created and updated order differ.
    github.editComment(b, "b again");
    github.editComment(a, "a again");
    return { a: a.id, b: b.id, c: c.id };
  }

  it("honors direction for either sort, and orders by creation, ascending, by default", async () => {
    const { a, b, c } = seed();
    expect(await ids("")).toEqual([a, b, c]);
    expect(await ids("?sort=created&direction=asc")).toEqual([a, b, c]);
    expect(await ids("?sort=created&direction=desc")).toEqual([c, b, a]);
    expect(await ids("?sort=updated")).toEqual([c, b, a]);
    expect(await ids("?sort=updated&direction=asc")).toEqual([c, b, a]);
    expect(await ids("?sort=updated&direction=desc")).toEqual([a, b, c]);
  });

  it("honors direction without a sort, as GitHub does though its documentation says it does not", async () => {
    const { a, b, c } = seed();
    expect(await ids("?direction=desc")).toEqual([c, b, a]);
  });
});

describe("GitHub's clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps to real time however few writes there are, and orders each write after the last and after the time it told", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const issue = github.addIssue(github.addRepository("someone/tracker"));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    const late = github.addComment(issue, "Late");
    expect(Date.parse(late.created_at)).toBe(
      Math.floor(Date.now() / 1000) * 1000,
    );
    const told = Date.parse(
      (await fetch(`${github.url}/app`)).headers.get("date") ?? "",
    );
    const next = github.addComment(issue, "Next");
    expect(told).toBeGreaterThanOrEqual(Date.parse(late.created_at));
    expect(Date.parse(next.created_at)).toBeGreaterThan(told);
  });

  it("runs behind the machine's by what a test asks", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    github.runBehind(60 * 60 * 1000);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    expect(Date.parse(github.now())).toBe(
      Math.floor((Date.now() - 60 * 60 * 1000) / 1000) * 1000,
    );
  });
});

describe("the App's JWT", () => {
  it("is accepted when RS256 signed with the App's key, for the App's id or client id, expiring within ten minutes", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await asApp(jwt())).status).toBe(201);
    expect((await asApp(jwt({ iss: github.appId }))).status).toBe(201);
    expect((await asApp(jwt({ iss: github.appClientId }))).status).toBe(201);
    expect((await asApp(jwt({ exp: now + 600 }))).status).toBe(201);
  });

  it("is refused when signed with another key, whatever its claims say", async () => {
    const other = appKey();
    const answer = await asApp(jwt({}, { key: other }));
    expect(answer.status).toBe(401);
    expect(((await answer.json()) as { message: string }).message).toMatch(
      /could not be decoded/,
    );
  });

  it("is refused when its claims were changed after it was signed", async () => {
    const [head = "", , signature = ""] = jwt().split(".");
    const now = Math.floor(Date.now() / 1000);
    const changed = base64url({
      iat: now - 30,
      exp: now + 570,
      iss: String(github.appId + 1),
    });
    expect((await asApp(`${head}.${changed}.${signature}`)).status).toBe(401);
  });

  it("is refused for another issuer, even signed with the App's key", async () => {
    expect((await asApp(jwt({ iss: "99999" }))).status).toBe(401);
    expect((await asApp(jwt({ iss: undefined }))).status).toBe(401);
  });

  it("is refused unless RS256", async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: "none" })}.${base64url({ iat: now - 30, exp: now + 570, iss: "12345" })}.`;
    expect((await asApp(unsigned)).status).toBe(401);
    expect((await asApp(jwt({}, { alg: "HS256" }))).status).toBe(401);
    expect((await asApp("not.a.jwt")).status).toBe(401);
    expect((await asApp("garbage")).status).toBe(401);
  });

  it("is refused when it expires past ten minutes, has expired, or was issued in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const far = await asApp(jwt({ exp: now + 601 }));
    expect(far.status).toBe(401);
    expect(((await far.json()) as { message: string }).message).toMatch(
      /'Expiration time' claim/,
    );
    expect((await asApp(jwt({ exp: now - 1 }))).status).toBe(401);
    expect((await asApp(jwt({ iat: now + 120 }))).status).toBe(401);
    expect((await asApp(jwt({ exp: "soon" }))).status).toBe(401);
  });

  it("is judged by GitHub's clock: issued in the future of a clock nine minutes behind it is refused, as is one expired by a clock eleven minutes ahead", async () => {
    github.clockAhead = -9 * 60;
    const behind = await asApp(jwt());
    expect(behind.status).toBe(401);
    expect(((await behind.json()) as { message: string }).message).toMatch(
      /'Issued at' claim/,
    );
    github.clockAhead = 9 * 60;
    expect((await asApp(jwt())).status).toBe(201);
    github.clockAhead = 11 * 60;
    const ahead = await asApp(jwt());
    expect(ahead.status).toBe(401);
    expect(((await ahead.json()) as { message: string }).message).toMatch(
      /'Expiration time' claim/,
    );
  });

  it("is sent as Bearer, as GitHub requires for a JWT", async () => {
    expect((await asApp(jwt(), "token")).status).toBe(401);
    expect((await asApp(jwt(), "bearer")).status).toBe(201);
  });

  it("is refused by every App route, and by all of them where no key was named", async () => {
    github.appPem = "";
    for (const path of [
      "/app",
      "/app/installations",
      "/app/installations/1/access_tokens",
    ]) {
      expect((await asApp(jwt(), "Bearer", path)).status, path).toBe(401);
    }
    github.appPem = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    expect((await asApp(jwt(), "Bearer", "/app")).status).toBe(401);
  });
});
