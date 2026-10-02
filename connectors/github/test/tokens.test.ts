import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { asApp, asInstallation, ClockSkew, type App } from "../src/github.js";

let key: string;
let github: GitHubStub;
let app: App;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  github = await new GitHubStub().start();
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
