import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
const run = promisify(execFile);
const key = appKey();
let marfa: ScriptedServer;
let github: GitHubStub;
const types = [
  "github.repository",
  "github.issue",
  "github.comment",
  "github.pull_request",
  "github.discussion",
  "github.notification",
  "github.file",
  "github.file.image",
];
const edges = [
  "github.in-repository",
  "github.sub-issue-of",
  "github.blocked-by",
  "github.relates-to",
  "github.duplicate-of",
  "github.closes",
  "github.closed-by",
  "parent-of",
  "references",
  "in-thread",
  "attached-to",
];
beforeEach(async () => {
  marfa = await new ScriptedServer("github", { types, edges }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
  github.appPem = key;
});
afterEach(async () => {
  await marfa.stop();
  await github.stop();
});
async function once(env: Record<string, string | undefined> = {}) {
  try {
    const result = await run(
      "node",
      [resolve(import.meta.dirname, "../dist/main.js"), "--once"],
      {
        env: {
          PATH: process.env["PATH"],
          MARFA_API_URL: marfa.url,
          MARFA_API_KEY: marfa.key,
          GITHUB_APP_ID: "12345",
          GITHUB_PRIVATE_KEY: key,
          GITHUB_WEBHOOK_SECRET: "test-secret",
          GITHUB_API_URL: github.url,
          ...env,
        },
      },
    );
    return { code: 0, output: result.stderr };
  } catch (error) {
    const result = error as { code: number; stderr: string };
    return { code: result.code, output: result.stderr };
  }
}
async function ok(env: Record<string, string | undefined> = {}) {
  const result = await once(env);
  expect(result.code, result.output).toBe(0);
  return result.output;
}
function row(id: string) {
  const result = marfa.rows.find((one) => one.properties["github_id"] === id);
  if (result === undefined) throw new Error(`No row for ${id}`);
  return result;
}
function links(id: string, type: string) {
  return marfa
    .targetsOf(row(id).id, type)
    .map((target) => marfa.byId(target).properties["github_id"]);
}
describe("pull request reading", () => {
  it("widens the existing repository connection before importing pull requests", async () => {
    marfa.edgeTypes.set("github.in-repository", {
      id: "github.in-repository",
      label: "In repository",
      cardinality: "many-to-one",
      source_type_constraints: ["github.issue", "github.comment"],
      target_type_constraints: ["github.repository"],
      cascade_on_delete: "orphan",
      property_schema: {},
      written_at: "source",
      shipped: false,
    });
    const repo = github.addRepository("someone/upgraded");
    const pr = github.addPullRequest(repo);
    await ok();
    expect(row(pr.node).type).toBe("github.pull_request");
    expect(links(pr.node, "github.in-repository")).toEqual([repo.node]);
    expect(
      marfa.requestsTo("POST", "/edge-types").filter((request) => {
        const body = request.body as Record<string, unknown>;
        return body["id"] === "github.in-repository";
      }),
    ).toMatchObject([{ body: { evolve_constraints: true } }]);
  });

  it("reads tasks, API closing references and the actual closing pull request", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo, { state: "closed" });
    const unrelated = github.addIssue(repo);
    const pr = github.addPullRequest(repo, {
      body: `Closes #${String(unrelated.number)}`,
      pr_state: "merged",
      merged_at: github.now(),
      closing_issues: [issue.node],
      checks: {
        state: "SUCCESS",
        check_runs: { COMPLETED: 2 },
        statuses: { SUCCESS: 1, PENDING: 0 },
      },
    });
    issue.closed_by = pr.node;
    const abandoned = github.addPullRequest(repo, {
      pr_state: "closed",
      closed_at: github.now(),
    });
    const ancient = github.addPullRequest(repo, {
      pr_state: "closed",
      updated_at: "2000-01-01T00:00:00Z",
      closed_at: "2000-01-01T00:00:00Z",
    });
    const oldOpen = github.addPullRequest(repo, {
      updated_at: "2000-01-01T00:00:00Z",
    });
    await ok();
    expect(row(pr.node).type).toBe("github.pull_request");
    expect(row(pr.node).properties).toMatchObject({
      status: "completed",
      pr_state: "merged",
      draft: false,
      base_branch: "main",
      head_branch: "change",
      checks: {
        state: "SUCCESS",
        check_runs: { COMPLETED: 2 },
        statuses: { SUCCESS: 1 },
      },
    });
    expect(row(abandoned.node).properties["status"]).toBe("canceled");
    expect(row(oldOpen.node).properties["status"]).toBe("pending");
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === ancient.node),
    ).toBe(false);
    expect(links(pr.node, "github.closes")).toEqual([issue.node]);
    expect(links(issue.node, "github.closed-by")).toEqual([pr.node]);
    expect(links(unrelated.node, "github.closed-by")).toEqual([]);
  });
  it("distinguishes a closing reference from the actual closer and keeps an external closer URL", async () => {
    const repo = github.addRepository("someone/tracker");
    const manual = github.addIssue(repo, { state: "closed" });
    const closed = github.addIssue(repo, { state: "closed" });
    const linked = github.addPullRequest(repo, {
      closing_issues: [manual.node],
    });
    const outside = github.addRepository("stranger/public", {
      installation: 99,
      private: false,
    });
    const external = github.addPullRequest(outside, {
      pr_state: "merged",
      merged_at: github.now(),
    });
    closed.closed_by = external.node;
    await ok();
    expect(links(linked.node, "github.closes")).toEqual([manual.node]);
    expect(links(manual.node, "github.closed-by")).toEqual([]);
    expect(links(closed.node, "github.closed-by")).toEqual([]);
    expect(row(closed.node).properties["closed_by_url"]).toBe(
      `https://github.com/stranger/public/pull/${String(external.number)}`,
    );
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === external.node),
    ).toBe(false);
  });
  it("restores pull request edits and connections while issues remain writable", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo);
    const another = github.addIssue(repo);
    const pr = github.addPullRequest(repo, { closing_issues: [issue.node] });
    await ok();
    marfa.edit(row(pr.node).id, {
      title: "Edited",
      body: "Edited",
      status: "completed",
      number: 999,
      repository: "elsewhere/wrong",
      private: false,
      author: "wrong",
      pr_state: "merged",
      draft: true,
      merged_at: "2000-01-01T00:00:00Z",
      base_branch: "wrong",
      head_branch: "wrong",
      checks: { state: "FAILURE" },
      github_updated_at: "2000-01-01T00:00:00Z",
      url: "https://example.com/wrong",
      completed_at: "2000-01-01T00:00:00Z",
    });
    const edge = marfa.edges.find((one) => one.edge_type === "github.closes");
    if (edge === undefined) throw new Error("No closing edge");
    marfa.removeEdge(edge.id);
    marfa.drawEdge(row(pr.node).id, row(another.node).id, "github.closes");
    marfa.edit(row(issue.node).id, { title: "Writable issue" });
    await ok();
    expect(row(pr.node).properties).toMatchObject({
      title: pr.title,
      status: "pending",
      number: pr.number,
      repository: "someone/tracker",
      private: true,
      author: "someone",
      pr_state: "open",
      draft: false,
      base_branch: "main",
      head_branch: "change",
      github_updated_at: pr.updated_at,
    });
    for (const field of ["body", "checks", "merged_at"])
      expect(row(pr.node).properties[field]).toBeUndefined();
    expect(links(pr.node, "github.closes")).toEqual([issue.node]);
    expect(issue.title).toBe("Writable issue");
    expect(github.writes().every((one) => one.path.includes("/issues/"))).toBe(
      true,
    );
  });
  it("accepts the pull_request kind while issues and comments remain writable", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo);
    const pr = github.addPullRequest(repo);
    const comment = github.addComment(issue, "Before", "marfa-connectors[bot]");
    comment.app = true;
    const env = { GITHUB_READ_ONLY: "pull_request" };
    await ok(env);
    marfa.edit(row(issue.node).id, { title: "After" });
    marfa.edit(row(comment.node).id, { body: "After" });
    marfa.edit(row(pr.node).id, { title: "Local edit" });
    await ok(env);
    expect(issue.title).toBe("After");
    expect(comment.body).toBe("After");
    expect(row(pr.node).properties["title"]).toBe(pr.title);
    expect(github.writes()).toHaveLength(2);
  });
  it("keeps pull requests and closing links read-only with a personal token", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo);
    const pr = github.addPullRequest(repo, { closing_issues: [issue.node] });
    github.personalToken = "github_pat_pull_test";
    const env = {
      GITHUB_PERSONAL_TOKEN: github.personalToken,
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
      GITHUB_READ_ONLY: "false",
    };
    await ok(env);
    marfa.edit(row(pr.node).id, { title: "Local edit" });
    marfa.edit(row(issue.node).id, { title: "Local issue edit" });
    const edge = marfa.edges.find((one) => one.edge_type === "github.closes");
    if (edge === undefined) throw new Error("No closing edge");
    marfa.removeEdge(edge.id);
    await ok(env);
    expect(row(pr.node).properties["title"]).toBe(pr.title);
    expect(row(issue.node).properties["title"]).toBe(issue.title);
    expect(links(pr.node, "github.closes")).toEqual([issue.node]);
    expect(github.writes()).toEqual([]);
    expect(github.asked.some((one) => one.path.startsWith("/app"))).toBe(false);
  });
  describe("a personal token without the Checks permission", () => {
    const personal = "github_pat_no_checks";
    const env = {
      GITHUB_PERSONAL_TOKEN: personal,
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    };
    const queries = (): number =>
      github.asked.filter(
        (one) =>
          one.path === "/graphql" &&
          JSON.stringify(one.body).includes("statusCheckRollup"),
      ).length;
    function problems(): Record<string, string> {
      return marfa.problems.get("github") ?? {};
    }

    it("writes each pull request with no check summary, and names the condition once", async () => {
      github.personalToken = personal;
      github.personalChecksError = "FORBIDDEN";
      const repo = github.addRepository("someone/tracker");
      const first = github.addPullRequest(repo, {
        checks: { state: "SUCCESS", check_runs: { SUCCESS: 1 }, statuses: {} },
      });
      const second = github.addPullRequest(repo);
      await ok(env);
      expect(row(first.node).properties["title"]).toBe(first.title);
      expect(row(second.node).state).toBe("active");
      expect(row(first.node).properties["checks"] ?? null).toBeNull();
      expect(Object.keys(problems())).toContain("checks-unreadable");
      // Two lists (open, then closed) ask once; the refusal turns it off.
      expect(queries()).toBe(1);

      github.personalChecksError = undefined;
      await ok(env);
      expect(problems()).not.toHaveProperty("checks-unreadable");
      expect(row(first.node).properties["checks"]).toMatchObject({
        state: "SUCCESS",
      });
    });

    it("still fails the run on any other GraphQL error", async () => {
      github.personalToken = personal;
      github.personalChecksError = "SERVICE_UNAVAILABLE";
      const repo = github.addRepository("someone/tracker");
      github.addPullRequest(repo);
      const result = await once(env);
      expect(result.code).not.toBe(0);
      expect(Object.keys(problems())).not.toContain("checks-unreadable");
    });
  });
  it("polls checks without updated_at changes and preserves exact versions on no-op reruns", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const pr = github.addPullRequest(repo, { closing_issues: [a.node] });
    await ok();
    pr.closing_issues = [b.node];
    pr.checks = {
      state: "PENDING",
      check_runs: { IN_PROGRESS: 1 },
      statuses: {},
    };
    await ok();
    expect(row(pr.node).properties["checks"]).toEqual(pr.checks);
    expect(links(pr.node, "github.closes")).toEqual([b.node]);
    const versions = marfa.rows.map((one) => one.version);
    const edgeIds = marfa.edges.map((one) => one.id);
    await ok();
    expect(marfa.rows.map((one) => one.version)).toEqual(versions);
    expect(marfa.edges.map((one) => one.id)).toEqual(edgeIds);
    expect(github.writes()).toEqual([]);
  });
  it("reads every pull request and closing-reference page", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const first = github.addPullRequest(repo, {
      closing_issues: [a.node, b.node],
    });
    const second = github.addPullRequest(repo);
    github.pullPageSize = 1;
    github.closingPageSize = 1;
    await ok();
    expect(links(first.node, "github.closes")).toEqual([a.node, b.node]);
    expect(row(second.node).type).toBe("github.pull_request");
  });
  it("reads pull requests when the repository has issues disabled", async () => {
    const repo = github.addRepository("someone/tracker", { issuesOff: true });
    const pr = github.addPullRequest(repo);
    await ok();
    expect(row(pr.node).type).toBe("github.pull_request");
  });
  it.each([false, true])(
    "keeps a refused repository's progress and reads healthy pull requests (issues disabled: %s)",
    async (issuesOff) => {
      const denied = github.addRepository("someone/denied", { issuesOff });
      const healthy = github.addRepository("someone/healthy");
      const held = github.addPullRequest(denied, { title: "Before" });
      const changed = github.addPullRequest(healthy, { title: "Before" });
      await ok();
      const saved = () => {
        const state = marfa.states.get("github")?.["state"] as
          { repositories?: Record<string, unknown> } | undefined;
        return structuredClone(state?.repositories?.[denied.node]);
      };
      const progress = saved();
      const unreadable = `${issuesOff ? "pull-requests-unreadable" : "repository-unreadable"}:${denied.node}`;
      const oldBody = `repository-unreadable:${denied.node}`;
      const oldPulls = `pull-requests-unreadable:${denied.node}`;
      marfa.problems.set("github", {
        ...marfa.problems.get("github"),
        [oldPulls]: "Earlier pull request listing refusal",
        ...(issuesOff && { [oldBody]: "Earlier issue body refusal" }),
      });
      held.title = "Unread change";
      held.updated_at = github.now();
      changed.title = "Healthy change";
      changed.updated_at = github.now();
      github.pullListsRefused.add(denied.node);
      const result = await once();
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("someone/denied");
      expect(result.output).toContain("403");
      expect(marfa.problems.get("github")?.[unreadable]).toContain("403");
      if (issuesOff)
        expect(marfa.problems.get("github")?.[oldBody]).toBe(
          "Earlier issue body refusal",
        );
      expect(row(held.node).properties["title"]).toBe("Before");
      expect(row(held.node).state).toBe("active");
      expect(saved()).toEqual(progress);
      expect(row(changed.node).properties["title"]).toBe("Healthy change");
      expect(github.writes()).toEqual([]);
      github.pullListsRefused.clear();
      await ok();
      expect(row(held.node).properties["title"]).toBe("Unread change");
      expect(marfa.problems.get("github")).not.toHaveProperty(unreadable);
      expect(marfa.problems.get("github")).not.toHaveProperty(oldPulls);
      if (issuesOff) {
        expect(marfa.problems.get("github")?.[oldBody]).toBe(
          "Earlier issue body refusal",
        );
        denied.issuesOff = false;
        await ok();
      }
      expect(marfa.problems.get("github")).not.toHaveProperty(oldBody);
      expect(github.writes()).toEqual([]);
    },
  );
  it("keeps prior data when GitHub returns no repository for a pull request listing", async () => {
    const repo = github.addRepository("someone/tracker");
    const pr = github.addPullRequest(repo);
    await ok();
    const version = row(pr.node).version;
    github.missingPullRepository = true;
    const failed = await once();
    expect(failed.code).toBe(1);
    expect(row(pr.node).version).toBe(version);
    expect(row(pr.node).state).toBe("active");
  });
});
