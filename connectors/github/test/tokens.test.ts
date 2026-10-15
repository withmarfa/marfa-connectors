import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import {
  asApp,
  asInstallation,
  asPersonalToken,
  ClockSkew,
  RateLimitWaiting,
  rateLimited,
  type App,
} from "../src/github.js";

let key: string;
let github: GitHubStub;
let app: App;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  github = await new GitHubStub().start();
  github.appPem = key;
  // One per test: the process keeps a signer, and its clock, per App.
  app = { appId: "12345", privateKey: key, base: github.url };
});

afterEach(async () => {
  await github.stop();
});

function mints(): number {
  return github.asked.filter((one) => one.path.endsWith("/access_tokens"))
    .length;
}

function reader(signal = new AbortController().signal) {
  const repository = github.addRepository("someone/tracker");
  return {
    repository,
    octokit: asInstallation(
      app,
      1,
      { access: "read", repositoryIds: [repository.id] },
      () => undefined,
      signal,
    ),
  };
}

describe("an installation token", () => {
  it("preserves GraphQL errors with malformed budget headers", async () => {
    const { octokit } = reader();
    const budget = github.budget("graphql");
    budget.remaining = Number.NaN;
    budget.reset = Number.NaN;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = github.asked.filter(
        (one) => one.path === "/graphql",
      ).length;
      await expect(
        octokit.graphql(
          "query Issues($ids: [ID!]!) { nodes(ids: $ids) { id } }",
          { ids: ["unknown"] },
        ),
      ).rejects.toThrow("GraphQL Rate Limit Exceeded");
      expect(
        github.asked.filter((one) => one.path === "/graphql").length,
      ).toBeGreaterThan(before);
    }
  });
  it("counts plain GraphQL throttling errors before another request", async () => {
    const { octokit } = reader();
    github.exhaust("graphql");
    await expect(
      octokit.graphql(
        "query Issues($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        { ids: ["unknown"] },
      ),
    ).rejects.toThrow();
    await expect(
      octokit.graphql(
        "query Issues($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        { ids: ["unknown"] },
      ),
    ).rejects.toBeInstanceOf(RateLimitWaiting);
    expect(github.asked.filter((one) => one.path === "/graphql")).toHaveLength(
      1,
    );
  });

  it("shares the REST reserve with metadata tokens and retries only after the real reset", async () => {
    const { octokit } = reader();
    const reset = Math.floor(Date.now() / 1000) + 2;
    Object.assign(github.budget("core"), { remaining: 100, reset });
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "someone",
      repo: "tracker",
    });
    const metadata = asInstallation(
      app,
      1,
      { access: "list" },
      () => undefined,
      new AbortController().signal,
    );
    await expect(
      metadata.request("GET /installation/repositories"),
    ).rejects.toBeInstanceOf(RateLimitWaiting);
    expect(
      github.asked.filter((one) => one.path === "/installation/repositories"),
    ).toHaveLength(0);
    await new Promise((done) =>
      setTimeout(done, reset * 1000 - Date.now() + 20),
    );
    const response = await metadata.request("GET /installation/repositories");
    expect(response.status).toBe(200);
    expect(
      github.asked.filter((one) => one.path === "/installation/repositories"),
    ).toHaveLength(1);
  });

  it("waits out a primary limit that resets within a minute, then asks again", async () => {
    const { octokit } = reader();
    Object.assign(github.budget("core"), {
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 2,
    });
    const answer = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "someone",
      repo: "tracker",
    });
    expect(answer.status).toBe(200);
    expect(
      github.asked
        .filter((one) => one.path === "/repos/someone/tracker")
        .map((one) => one.status),
    ).toEqual([403, 200]);
  });

  it("does not wait out a primary limit that resets in an hour", async () => {
    const { octokit } = reader();
    github.exhaust("core");
    const error = await octokit
      .request("GET /repos/{owner}/{repo}", {
        owner: "someone",
        repo: "tracker",
      })
      .catch((caught: unknown) => caught);
    expect(rateLimited(error)).toBe(true);
    expect(
      github.asked.filter((one) => one.path === "/repos/someone/tracker"),
    ).toHaveLength(1);
  });

  it("is minted, as the first request the App signs, though GitHub's clock is minutes behind", async () => {
    const { octokit } = reader();
    github.clockAhead = -9 * 60;
    const answer = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "someone",
      repo: "tracker",
    });
    expect(answer.status).toBe(200);
    expect(
      github.asked.filter((one) => one.path.endsWith("/access_tokens")),
    ).toMatchObject([{ status: 401 }, { status: 201 }]);
  });

  it("is not asked for where GitHub's clock is past ten minutes from this one", async () => {
    const { octokit } = reader();
    github.clockAhead = -11 * 60;
    await expect(
      octokit.request("GET /repos/{owner}/{repo}", {
        owner: "someone",
        repo: "tracker",
      }),
    ).rejects.toBeInstanceOf(ClockSkew);
    expect(mints()).toBe(1);
  });

  it("is minted under the run's signal, so a run stopped mints nothing", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const { octokit } = reader(stopped.signal);
    await expect(
      octokit.request("GET /repos/{owner}/{repo}", {
        owner: "someone",
        repo: "tracker",
      }),
    ).rejects.toThrow();
    expect(mints()).toBe(0);
  });
});

describe("the App's own requests", () => {
  it("refuse a clock past ten minutes from GitHub's, as the library's correction would take it", async () => {
    github.clockAhead = 11 * 60;
    await expect(
      asApp(app, new AbortController().signal).request(
        "GET /app/installations",
      ),
    ).rejects.toBeInstanceOf(ClockSkew);
  });
});

describe("a personal access token", () => {
  const personalToken = "github_pat_test_12345678";

  beforeEach(() => {
    github.personalToken = personalToken;
  });

  it("is accepted as Bearer auth and lists user repositories", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    const repos = (await octokit.paginate("GET /user/repos", {
      affiliation: "owner,collaborator,organization_member",
      per_page: 100,
    })) as { node_id: string }[];
    expect(repos.map((r) => r.node_id)).toContain(repository.node);
  });

  it("returns 401 with GitHub's body when the token is wrong", async () => {
    const octokit = asPersonalToken(
      "wrong_token_12345678",
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    const error = await octokit
      .request("GET /user/repos", { per_page: 100 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    const asked = github.asked.find((one) => one.path === "/user/repos");
    expect(asked?.status).toBe(401);
  });

  it("calls the secret callback with the token before each request", async () => {
    const repository = github.addRepository("someone/tracker");
    const seen: string[] = [];
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      (v) => seen.push(v),
      new AbortController().signal,
    );
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "someone",
      repo: "tracker",
    });
    expect(seen).toContain(personalToken);
    // The repository was reachable without an installation token.
    expect(
      github.asked.find((one) => one.path === "/repos/someone/tracker")?.status,
    ).toBe(200);
    void repository;
  });

  it("sends Bearer authorization, not the token scheme", async () => {
    github.addRepository("someone/tracker");
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    await octokit.request("GET /user/repos", { per_page: 100 });
    expect(github.asked.find((one) => one.path === "/user/repos")?.status).toBe(
      200,
    );
    // Stub only accepts the token for /user/repos if it matches personalToken
    // and the authorization header starts with "Bearer ".
    expect(
      github.asked
        .filter((one) => one.path === "/user/repos")
        .every((one) => one.status === 200),
    ).toBe(true);
  });

  it("tracks its rate-limit budget by a fingerprint, not the token itself", async () => {
    const repository = github.addRepository("someone/tracker");
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    github.budget("core", 0).remaining = 499;
    await octokit.request("GET /repos/{owner}/{repo}", {
      owner: "someone",
      repo: "tracker",
    });
    await expect(
      octokit.request("GET /repos/{owner}/{repo}", {
        owner: "someone",
        repo: "tracker",
      }),
    ).rejects.toBeInstanceOf(RateLimitWaiting);
    void repository;
  });

  it("accepts the personal token for GraphQL queries", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    const result = (await octokit.graphql(
      "query Issues($ids: [ID!]!) { nodes(ids: $ids) { id } }",
      { ids: [issue.node] },
    )) as { nodes: { id: string }[] };
    expect(result.nodes[0]?.id).toBe(issue.node);
  });

  it("shares a token's reserve across clients and keeps another token independent", async () => {
    const make = (token: string) =>
      asPersonalToken(
        token,
        github.url,
        () => undefined,
        new AbortController().signal,
      );
    github.budget("core", 0).remaining = 499;
    await make(personalToken).request("GET /user/repos");
    await expect(
      make(personalToken).request("GET /user/repos"),
    ).rejects.toBeInstanceOf(RateLimitWaiting);
    github.personalToken = "another-personal-token";
    github.refill("core", 0);
    await expect(
      make(github.personalToken).request("GET /user/repos"),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("blocks REST writes and GraphQL mutations before GitHub receives them", async () => {
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    await expect(
      octokit.request("POST /repos/someone/tracker/issues", { title: "New" }),
    ).rejects.toThrow("read only");
    await expect(
      octokit.graphql(
        "mutation Create { createIssue(input: {}) { issue { id } } }",
      ),
    ).rejects.toThrow("read only");
    expect(github.asked).toEqual([]);
  });

  it("keeps GraphQL budgets separate from the token's REST reserve", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const octokit = asPersonalToken(
      personalToken,
      github.url,
      () => undefined,
      new AbortController().signal,
    );
    github.budget("core", 0).remaining = 499;
    await octokit.request("GET /user/repos");
    await expect(
      octokit.graphql(
        "query Issues($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        { ids: [issue.node] },
      ),
    ).resolves.toMatchObject({ nodes: [{ id: issue.node }] });
    await expect(octokit.request("GET /user/repos")).rejects.toBeInstanceOf(
      RateLimitWaiting,
    );
  });
});
