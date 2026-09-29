import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { apiVersion, numbersIn, runsOf } from "../src/github.js";

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

  it("whose App is uninstalled changes nothing and says so", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await ok();
    github.installations = [];
    const output = await ok();
    expect(output).toContain("can no longer be read through the App");
    expect(row(repository.node).state).toBe("active");
    expect(row(issue.node).state).toBe("active");
  });

  it("with its issues turned off changes nothing and says so", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await ok();
    repository.issuesOff = true;
    checkDue();
    const { code, output } = await once();
    expect(code).toBe(0);
    expect(output).toContain("has its issues turned off");
    expect(row(issue.node).state).toBe("active");
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

describe("the App's key and its tokens", () => {
  it("never reach a log or a report, even where GitHub's answer quotes a token", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    github.echoCredentials = true;
    const { code, output } = await once();
    expect(code).toBe(1);
    expect(output).toContain("broken for token [redacted]");
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(output).not.toContain("ghs_stub_");
    expect(JSON.stringify(marfa.runs)).not.toContain("ghs_stub_");
  }, 30_000);
});

describe("a larger repository", () => {
  it("is listed page by page, and a parent drawn on GitHub for a child on a page that did not change is taken", async () => {
    const repository = github.addRepository("someone/tracker");
    const issues = Array.from({ length: 150 }, (_, at) =>
      github.addIssue(repository, { title: `Issue ${String(at + 1)}` }),
    );
    await ok();
    expect(
      marfa.rows.filter((one) => one.type === "github.issue"),
    ).toHaveLength(150);
    const child = issues[2];
    const parent = issues[139];
    if (child === undefined || parent === undefined) throw new Error("none");
    child.parent = parent.node;
    const asked = github.asked.length;
    await ok();
    const pages = github.asked
      .slice(asked)
      .filter((one) => one.query.includes("state=open"));
    expect(pages.map((one) => one.status)).toEqual([304, 200]);
    expect(links(child.node, "github.sub-issue-of")).toEqual([parent.node]);
  });

  it("reads its comments on the first sync in one listing, not issue by issue", async () => {
    const repository = github.addRepository("someone/tracker");
    for (let at = 0; at < 5; at += 1) {
      github.addComment(github.addIssue(repository), `Comment ${String(at)}`);
    }
    await ok();
    expect(
      github.asked.filter((one) => /\/issues\/\d+\/comments$/.test(one.path)),
    ).toEqual([]);
    expect(
      marfa.rows.filter((one) => one.type === "github.comment"),
    ).toHaveLength(5);
  });

  it("keeps each page's numbers as runs, so its state stays small", () => {
    expect(runsOf([5, 1, 2, 3, 7, 8, 3])).toBe("1-3,5,7-8");
    expect(numbersIn("1-3,5,7-8")).toEqual([1, 2, 3, 5, 7, 8]);
    expect(numbersIn(runsOf([]))).toEqual([]);
  });
});

describe("what the adversarial review found", () => {
  it("reads past a full first page of changed comments, so a burst never stalls the cursor", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Hello");
    await ok();
    for (let at = 0; at < 150; at += 1) {
      github.addComment(issue, `Burst ${String(at)}`);
    }
    await ok();
    const after = github.addComment(issue, "After");
    await ok();
    await ok();
    expect(row(after.node).properties["body"]).toBe("After");
  }, 60_000);

  it("takes a child detached on GitHub, on a page that did not change", async () => {
    const repository = github.addRepository("someone/tracker");
    const issues = Array.from({ length: 150 }, (_, at) =>
      github.addIssue(repository, { title: `Issue ${String(at + 1)}` }),
    );
    const child = issues[2];
    const parent = issues[139];
    if (child === undefined || parent === undefined) throw new Error("none");
    child.parent = parent.node;
    await ok();
    expect(links(child.node, "github.sub-issue-of")).toEqual([parent.node]);
    child.parent = null;
    await ok();
    expect(links(child.node, "github.sub-issue-of")).toEqual([]);
  }, 60_000);

  it("takes a child detached from a parent in another repository", async () => {
    const one = github.addRepository("someone/one");
    const two = github.addRepository("someone/two");
    const parent = github.addIssue(one, { title: "Parent" });
    const child = github.addIssue(two, { title: "Child", parent: parent.node });
    await ok();
    child.parent = null;
    await ok();
    expect(links(child.node, "github.sub-issue-of")).toEqual([]);
  }, 60_000);

  it("takes an edit to a comment Marfa holds on an issue that left the window", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, {
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(5),
      updated_at: github.ago(5),
    });
    const comment = github.addComment(issue, "Before");
    comment.updated_at = github.ago(5);
    issue.updated_at = github.ago(5);
    await ok();
    issue.updated_at = github.ago(120);
    row(issue.node).properties["github_updated_at"] = issue.updated_at;
    github.editComment(comment, "After");
    await ok();
    expect(row(comment.node).properties["body"]).toBe("After");
  }, 60_000);

  it("fails a run GitHub's rate limit refuses, rather than calling it lost access", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    await ok();
    github.rateLimited = true;
    const { code, output } = await once();
    expect(code).toBe(1);
    expect(output).not.toContain("so its rows are left as they are");
  }, 60_000);

  it("leaves repositories for the next run once the hourly limit runs low, keeping what it did", async () => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    github.addIssue(first);
    github.addIssue(second);
    github.rateRemaining = 100;
    const output = await ok();
    expect(output).toContain("wait for the next run");
    github.rateRemaining = 4999;
    await ok();
    expect(
      marfa.rows.filter((one) => one.type === "github.issue"),
    ).toHaveLength(2);
    expect(Object.keys(kept())).toHaveLength(2);
  }, 60_000);

  it("brings in an old issue newly blocked by one in the window, and an old parent, connected", async () => {
    const repository = github.addRepository("someone/tracker");
    const old = (title: string) =>
      github.addIssue(repository, {
        title,
        state: "closed",
        state_reason: "completed",
        closed_at: github.ago(200),
        updated_at: github.ago(200),
      });
    const blocked = old("Old, blocked");
    const parent = old("Old parent");
    const listed = github.addIssue(repository, { title: "Listed" });
    blocked.blocked_by = [listed.node];
    listed.parent = parent.node;
    await ok();
    expect(links(blocked.node, "github.blocked-by")).toEqual([listed.node]);
    expect(links(listed.node, "github.sub-issue-of")).toEqual([parent.node]);
  }, 60_000);

  it("keeps a public issue outside the installation as an address, never a row", async () => {
    const repository = github.addRepository("someone/tracker");
    const outside = github.addRepository("someone/public", {
      installation: 99,
      private: false,
    });
    const blocker = github.addIssue(outside, { title: "Public blocker" });
    const listed = github.addIssue(repository, { title: "Listed" });
    listed.blocked_by = [blocker.node];
    await ok();
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === blocker.node),
    ).toBe(false);
    expect(row(listed.node).properties["blocked_by_urls"]).toEqual([
      `https://github.com/someone/public/issues/${String(blocker.number)}`,
    ]);
  }, 60_000);
});

describe("a comment a run missed", () => {
  it("is written at the daily check", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Seen");
    await ok();
    await ok();
    // Shown late by GitHub, under a time before the run's cursor.
    const late = github.addComment(issue, "Late");
    late.updated_at = github.ago(1);
    late.created_at = late.updated_at;
    await ok();
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === late.node),
    ).toBe(false);
    checkDue();
    await ok();
    expect(row(late.node).properties["body"]).toBe("Late");
  });
});

describe("a bot", () => {
  it("is named the same whether REST or GraphQL answered", async () => {
    const repository = github.addRepository("someone/tracker");
    const old = github.addIssue(repository, {
      title: "Old, by a bot",
      user: "dependabot[bot]",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(200),
      updated_at: github.ago(200),
    });
    const listed = github.addIssue(repository, {
      title: "Listed, by a bot",
      user: "dependabot[bot]",
    });
    listed.blocked_by = [old.node];
    await ok();
    expect(row(old.node).properties["author"]).toBe("dependabot[bot]");
    expect(row(listed.node).properties["author"]).toBe("dependabot[bot]");
  });
});

describe("every request to GitHub", () => {
  it("names the REST version the connector is written against", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Said");
    await ok();
    expect(github.asked.length).toBeGreaterThan(0);
    expect(new Set(github.asked.map((one) => one.version))).toEqual(
      new Set([apiVersion]),
    );
  });
});

describe("GITHUB_REPOSITORIES", () => {
  it("keeps the sync to the repositories it names, by name or owner, in any case", async () => {
    const kept = github.addRepository("someone/Tracker");
    const other = github.addRepository("someone/elsewhere");
    const theirs = github.addRepository("team/anything");
    const mine = github.addIssue(kept, { title: "Kept" });
    const left = github.addIssue(other, { title: "Left out" });
    const all = github.addIssue(theirs, { title: "An owner's" });
    const { code } = await once({
      GITHUB_REPOSITORIES: "someone/tracker, TEAM/*",
    });
    expect(code).toBe(0);
    expect(row(mine.node).state).toBe("active");
    expect(row(all.node).state).toBe("active");
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === left.node),
    ).toBe(false);
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === other.node),
    ).toBe(false);
  });

  it("archives a repository's rows once it is left out, and brings them back when it is named again", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Said");
    await ok();
    const { output } = await once({ GITHUB_REPOSITORIES: "someone/other" });
    expect(output).toContain(
      "someone/tracker is no longer among GITHUB_REPOSITORIES",
    );
    expect(
      [repository.node, issue.node, comment.node].map((one) => row(one).state),
    ).toEqual(["archived", "archived", "archived"]);
    await once({ GITHUB_REPOSITORIES: "someone/tracker" });
    expect(row(issue.node).state).toBe("active");
  });

  it("names an entry no installation shows", async () => {
    github.addRepository("someone/tracker");
    const { code, output } = await once({
      GITHUB_REPOSITORIES: "someone/tracker someone/renamed",
    });
    expect(code).toBe(0);
    expect(output).toContain(
      "GITHUB_REPOSITORIES names someone/renamed, which no installation of the App shows",
    );
  });

  it("refuses a malformed entry before anything runs", async () => {
    github.addRepository("someone/tracker");
    const { code, output } = await once({ GITHUB_REPOSITORIES: "tracker" });
    expect(code).not.toBe(0);
    expect(output).toContain("each is owner/repo or owner/*");
    expect(marfa.rows).toEqual([]);
  });
});
