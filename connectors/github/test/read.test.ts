import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const types = ["github.repository", "github.issue", "github.comment"];
const connections = [
  "github.in-repository",
  "github.sub-issue-of",
  "github.blocked-by",
  "in-thread",
];

let key: string;
let marfa: ScriptedServer;
let github: GitHubStub;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types,
    edges: connections,
  }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

async function once(
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        GITHUB_APP_ID: "12345",
        GITHUB_PRIVATE_KEY: key,
        GITHUB_WEBHOOK_SECRET: "github-test-webhook-secret",
        GITHUB_API_URL: github.url,
        ...env,
      },
    });
    return { code: 0, output: stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, output: failed.stderr };
  }
}

async function ok(): Promise<string> {
  const { code, output } = await once();
  if (code !== 0) throw new Error(`the run exited ${String(code)}: ${output}`);
  return output;
}

function row(link: string) {
  const found = marfa.rows.find((one) => one.properties["github_id"] === link);
  if (found === undefined) throw new Error(`no row holds ${link}`);
  return found;
}

function links(from: string, edgeType: string): string[] {
  return marfa
    .targetsOf(row(from).id, edgeType)
    .map((id) => String(marfa.byId(id).properties["github_id"]));
}

function kept(): Record<string, Record<string, unknown>> {
  const state = marfa.states.get("github")?.["state"] as
    { repositories?: Record<string, Record<string, unknown>> } | undefined;
  return state?.repositories ?? {};
}

/** Makes the next run ask GitHub about what it no longer lists. */
function checkDue(): void {
  const document = marfa.states.get("github");
  const state = document?.["state"] as
    { repositories?: Record<string, Record<string, unknown>> } | undefined;
  for (const repository of Object.values(state?.repositories ?? {})) {
    Reflect.deleteProperty(repository, "checked");
  }
}

describe("a first sync", () => {
  it("writes the repositories, the issues open and closed within ninety days, their comments and their relations", async () => {
    const repository = github.addRepository("someone/tracker", {
      description: "Where things are tracked",
    });
    const elsewhere = github.addRepository("someone/elsewhere", {
      installation: 99,
      private: false,
    });
    const outside = github.addIssue(elsewhere, { title: "Outside" });
    const hidden = github.addRepository("someone/hidden", {
      installation: 99,
    });
    const secret = github.addIssue(hidden, { title: "Hidden" });
    const parent = github.addIssue(repository, {
      title: "Parent",
      body: "The whole of it",
      labels: ["bug", "p1"],
      assignees: ["someone"],
    });
    const child = github.addIssue(repository, {
      title: "Child",
      parent: parent.node,
    });
    const blocker = github.addIssue(repository, {
      title: "Blocker",
      state: "closed",
      state_reason: "not_planned",
      closed_at: github.ago(3),
      updated_at: github.ago(3),
    });
    const done = github.addIssue(repository, {
      title: "Done",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(10),
      updated_at: github.ago(10),
    });
    const old = github.addIssue(repository, {
      title: "Old",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(200),
      updated_at: github.ago(200),
    });
    github.addIssue(repository, { title: "A pull request", pull: true });
    child.blocked_by = [blocker.node, outside.node, secret.node];
    const orphan = github.addIssue(repository, {
      title: "Under an outside parent",
      parent: outside.node,
    });
    const comment = github.addComment(parent, "First!", "another");

    const output = await ok();
    expect(output).not.toContain("error");
    const repo = row(repository.node);
    expect(repo.type).toBe("github.repository");
    expect(repo.properties).toMatchObject({
      name: "someone/tracker",
      url: "https://github.com/someone/tracker",
      description: "Where things are tracked",
      private: true,
      archived_on_github: false,
    });
    const issues = marfa.rows.filter((one) => one.type === "github.issue");
    expect(issues.map((one) => one.properties["title"]).sort()).toEqual([
      "Blocker",
      "Child",
      "Done",
      "Parent",
      "Under an outside parent",
    ]);
    expect(row(parent.node).properties).toMatchObject({
      title: "Parent",
      body: "The whole of it",
      status: "pending",
      labels: ["bug", "p1"],
      assignees: ["someone"],
      number: parent.number,
      repository: "someone/tracker",
      author: "someone",
      url: `https://github.com/someone/tracker/issues/${String(parent.number)}`,
    });
    expect(row(blocker.node).properties).toMatchObject({
      status: "canceled",
      state_reason: "not_planned",
    });
    expect(row(done.node).properties).toMatchObject({
      status: "completed",
      state_reason: "completed",
    });
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === old.node),
    ).toBe(false);
    expect(links(child.node, "github.sub-issue-of")).toEqual([parent.node]);
    expect(links(child.node, "github.blocked-by")).toEqual([blocker.node]);
    expect(row(child.node).properties["blocked_by_urls"]).toEqual([
      `https://github.com/someone/elsewhere/issues/${String(outside.number)}`,
    ]);
    expect(links(orphan.node, "github.sub-issue-of")).toEqual([]);
    expect(row(orphan.node).properties["parent_url"]).toBe(
      `https://github.com/someone/elsewhere/issues/${String(outside.number)}`,
    );
    expect(links(parent.node, "github.in-repository")).toEqual([
      repository.node,
    ]);
    expect(row(comment.node).properties).toMatchObject({
      body: "First!",
      from: "another",
    });
    expect(links(comment.node, "in-thread")).toEqual([parent.node]);
    expect(links(comment.node, "github.in-repository")).toEqual([
      repository.node,
    ]);
    expect(marfa.edgeTypes.has("github.sub-issue-of")).toBe(true);
    expect(marfa.edgeTypes.get("in-thread")?.["id"]).toBe("in-thread");
  });
});

describe("a run after", () => {
  it("costs nothing where nothing changed: every listing answers 304, and nothing is written", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Hello");
    await ok();
    // The run after a first sync learns the comment listing's ETag.
    await ok();
    const before = marfa.rows.map((one) => one.version);
    const asked = github.asked.length;
    await ok();
    const listings = github.asked
      .slice(asked)
      .filter((one) => one.path.startsWith("/repos/"));
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((one) => one.status === 304)).toBe(true);
    expect(
      github.asked.slice(asked).some((one) => one.path === "/graphql"),
    ).toBe(false);
    expect(marfa.rows.map((one) => one.version)).toEqual(before);
  });

  it("takes a blocker swapped on GitHub, which moves no issue's time", async () => {
    const repository = github.addRepository("someone/tracker");
    const blocked = github.addIssue(repository, { title: "Blocked" });
    const first = github.addIssue(repository, { title: "First" });
    const second = github.addIssue(repository, { title: "Second" });
    blocked.blocked_by = [first.node];
    await ok();
    expect(links(blocked.node, "github.blocked-by")).toEqual([first.node]);
    blocked.blocked_by = [second.node];
    await ok();
    expect(links(blocked.node, "github.blocked-by")).toEqual([second.node]);
  });

  it("takes a new comment, which moves its issue's time, and an edited one", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const first = github.addComment(issue, "One");
    await ok();
    const second = github.addComment(issue, "Two");
    github.editComment(first, "One, edited");
    await ok();
    expect(row(first.node).properties["body"]).toBe("One, edited");
    expect(row(second.node).properties["body"]).toBe("Two");
    expect(row(issue.node).properties["github_updated_at"]).toBe(
      issue.updated_at,
    );
  });

  it("brings in the comments of an issue that comes back into the window", async () => {
    const repository = github.addRepository("someone/tracker");
    const old = github.addIssue(repository, {
      title: "Old",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(200),
      updated_at: github.ago(200),
    });
    const early = github.addComment(old, "Long ago");
    old.updated_at = github.ago(200);
    early.updated_at = github.ago(200);
    await ok();
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === old.node),
    ).toBe(false);
    github.edit(old, {
      state: "open",
      state_reason: "reopened",
      closed_at: null,
    });
    await ok();
    expect(row(old.node).properties["status"]).toBe("pending");
    expect(row(early.node).properties["body"]).toBe("Long ago");
  });
});

describe("what GitHub no longer lists", () => {
  it("is archived where GitHub says the issue was deleted, at once, or the comment is gone, at the daily check", async () => {
    const repository = github.addRepository("someone/tracker");
    const stays = github.addIssue(repository, { title: "Stays" });
    const goes = github.addIssue(repository, { title: "Goes" });
    const comment = github.addComment(stays, "Goes too");
    await ok();
    goes.deleted = true;
    comment.deleted = true;
    await ok();
    // The deletion changed the listing: the issue is asked about at once.
    expect(row(goes.node).state).toBe("archived");
    expect(row(comment.node).state).toBe("active");
    checkDue();
    await ok();
    expect(row(comment.node).state).toBe("archived");
    expect(row(stays.node).state).toBe("active");
  });

  it("archives an issue moved to another repository and says where, and leaves one answering 404", async () => {
    const repository = github.addRepository("someone/tracker");
    const moved = github.addIssue(repository, { title: "Moved" });
    const hidden = github.addIssue(repository, { title: "Hidden" });
    await ok();
    moved.moved = true;
    hidden.repository = "R_nowhere";
    checkDue();
    const output = await ok();
    expect(row(moved.node).state).toBe("archived");
    expect(output).toContain("was moved to another repository");
    expect(row(hidden.node).state).toBe("active");
    expect(output).toContain("answered 404 though its repository reads");
  });

  it("leaves a closed issue quiet since before the window, which it no longer lists", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, {
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(5),
      updated_at: github.ago(5),
    });
    await ok();
    // Four months pass: the row as last written, and GitHub's listing
    // no longer reaching back to it.
    issue.updated_at = github.ago(120);
    row(issue.node).properties["github_updated_at"] = issue.updated_at;
    checkDue();
    const asked = github.asked.length;
    await ok();
    expect(row(issue.node).state).toBe("active");
    expect(
      github.asked
        .slice(asked)
        .some((one) => one.path.endsWith(`/issues/${String(issue.number)}`)),
    ).toBe(false);
  });
});

describe("a repository", () => {
  it("taken out of the installation has its rows archived, and they come back when it is added again", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Hello");
    await ok();
    repository.installation = 2;
    const output = await ok();
    expect(output).toContain("was taken out of the App's installation");
    expect(row(repository.node).state).toBe("archived");
    expect(row(issue.node).state).toBe("archived");
    expect(row(comment.node).state).toBe("archived");
    expect(kept()[repository.node]).toBeUndefined();
    repository.installation = 1;
    await ok();
    expect(row(repository.node).state).toBe("active");
    expect(row(issue.node).state).toBe("active");
    expect(row(comment.node).state).toBe("active");
  });

  it("whose installation refuses the App changes nothing and says so", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await ok();
    const installation = github.installations[0];
    if (installation !== undefined) installation.lost = true;
    const output = await ok();
    expect(output).toContain("refused it");
    expect(row(repository.node).state).toBe("active");
    expect(row(issue.node).state).toBe("active");
    expect(kept()[repository.node]).toBeDefined();
  });

  it("listed but answering 404 changes nothing and says so", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await ok();
    repository.hidden = true;
    const output = await ok();
    expect(output).toContain("is listed for the App but answered 404");
    expect(row(issue.node).state).toBe("active");
  });
});

describe("the App's key", () => {
  it("is never written to a log or a report, nor is any token", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    const output = await ok();
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(output).not.toContain("ghs_stub_");
    expect(JSON.stringify(marfa.runs)).not.toContain("ghs_stub_");
  });
});
