import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import {
  asApp,
  asInstallation,
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
