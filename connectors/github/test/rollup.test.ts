import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { asInstallation, type App, type Client } from "../src/github.js";
import {
  checksUnreadable,
  listPullRequests,
  pullRequestsByNode,
  Rollup,
} from "../src/pulls.js";

let key: string;
let github: GitHubStub;
let app: App;
let conditions: string[];
let rollup: Rollup;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  github = await new GitHubStub().start();
  github.appPem = key;
  github.installations = [
    { id: 1, login: "someone" },
    { id: 2, login: "elsewhere" },
  ];
  app = { appId: "12345", privateKey: key, base: github.url };
  conditions = [];
  rollup = new Rollup({
    condition: (name) => {
      conditions.push(name);
    },
  });
});

afterEach(async () => {
  await github.stop();
});

const checks = {
  state: "SUCCESS",
  check_runs: { SUCCESS: 1 },
  statuses: {},
};

function client(installation: number, repositoryIds: number[]): Client {
  return asInstallation(
    app,
    installation,
    { access: "read", repositoryIds },
    () => undefined,
    new AbortController().signal,
  );
}

function tracker(installation = 1) {
  const repository = github.addRepository(
    installation === 1 ? "someone/tracker" : "elsewhere/tracker",
    { installation },
  );
  return { repository, octokit: client(installation, [repository.id]) };
}

const since = "2000-01-01";

describe("check rollups GitHub refuses a token", () => {
  it("reads a listing's pull requests whole, with their checks unknown, and names the condition", async () => {
    const { repository, octokit } = tracker();
    const first = github.addPullRequest(repository, { checks });
    const second = github.addPullRequest(repository, { checks });
    github.checksRefused.add(1);
    const found = await listPullRequests(
      octokit,
      repository.owner,
      repository.name,
      since,
      rollup,
    );
    expect(found.map((one) => one.node).sort()).toEqual(
      [first.node, second.node].sort(),
    );
    expect(found.find((one) => one.node === first.node)).toMatchObject({
      title: first.title,
    });
    for (const one of found) expect(one.checks).toBeUndefined();
    expect(conditions).toEqual([checksUnreadable]);
    expect(rollup.answered).toBe(false);
  });

  it("uses a nodes answer that also says a pull request is gone", async () => {
    const { repository, octokit } = tracker();
    const kept = github.addPullRequest(repository, { checks });
    github.checksRefused.add(1);
    const found = await pullRequestsByNode(
      octokit,
      ["PR_gone", kept.node],
      rollup,
    );
    expect(found.map((one) => one.node)).toEqual([kept.node]);
    expect(found[0]?.checks).toBeUndefined();
    expect(conditions).toEqual([checksUnreadable]);
  });

  it("still reads checks through an installation GitHub does not refuse", async () => {
    const refused = tracker(1);
    const open = tracker(2);
    github.addPullRequest(refused.repository, { checks });
    const there = github.addPullRequest(open.repository, { checks });
    github.checksRefused.add(1);
    await listPullRequests(
      refused.octokit,
      refused.repository.owner,
      refused.repository.name,
      since,
      rollup,
    );
    const found = await listPullRequests(
      open.octokit,
      open.repository.owner,
      open.repository.name,
      since,
      rollup,
    );
    expect(found.map((one) => one.node)).toEqual([there.node]);
    expect(found[0]?.checks).toEqual(checks);
    const byNode = await pullRequestsByNode(open.octokit, [there.node], rollup);
    expect(byNode[0]?.checks).toEqual(checks);
    expect(conditions).toEqual([checksUnreadable]);
    expect(rollup.answered).toBe(false);
  });

  it("asks a refused token for no rollup again in the same run", async () => {
    const { repository, octokit } = tracker();
    const pr = github.addPullRequest(repository, { checks });
    github.checksRefused.add(1);
    await pullRequestsByNode(octokit, [pr.node], rollup);
    const asked = (): number =>
      github.asked.filter((one) =>
        JSON.stringify(one.body).includes("statusCheckRollup"),
      ).length;
    const before = asked();
    const found = await pullRequestsByNode(octokit, [pr.node], rollup);
    expect(asked()).toBe(before);
    expect(found[0]?.checks).toBeUndefined();
    expect(conditions).toEqual([checksUnreadable]);
  });

  it("does not take a refusal of a pull request itself for one of its checks", async () => {
    const { repository, octokit } = tracker();
    const refused = github.addPullRequest(repository, { checks });
    const other = github.addPullRequest(repository, { checks });
    github.pullsForbidden.add(refused.node);
    await expect(
      pullRequestsByNode(octokit, [refused.node, other.node], rollup),
    ).rejects.toThrow();
    expect(conditions).toEqual([]);

    // The witness: the same pull requests, with the rollup refused instead.
    github.pullsForbidden.clear();
    github.checksRefused.add(1);
    await pullRequestsByNode(octokit, [refused.node, other.node], rollup);
    expect(conditions).toEqual([checksUnreadable]);
  });

  it("does not take a refusal of the repository for one of its checks", async () => {
    const { repository, octokit } = tracker();
    github.addPullRequest(repository, { checks });
    github.pullRepositoriesForbidden.add(repository.node);
    await expect(
      listPullRequests(
        octokit,
        repository.owner,
        repository.name,
        since,
        rollup,
      ),
    ).rejects.toThrow();
    expect(conditions).toEqual([]);
  });

  it("answers checks and clears nothing it was not asked", async () => {
    const { repository, octokit } = tracker();
    const pr = github.addPullRequest(repository, { checks });
    const found = await pullRequestsByNode(octokit, [pr.node], rollup);
    expect(found[0]?.checks).toEqual(checks);
    expect(rollup.answered).toBe(true);
    expect(conditions).toEqual([]);
  });
});
