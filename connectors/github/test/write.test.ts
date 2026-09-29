import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  appKey,
  GitHubStub,
  type Issue,
  type Repository,
} from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
// Each test runs the connector several times over.
vi.setConfig({ testTimeout: 30_000 });
const built = resolve(import.meta.dirname, "../dist/main.js");

let key: string;
let marfa: ScriptedServer;
let github: GitHubStub;
let repository: Repository;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types: ["github.repository", "github.issue", "github.comment"],
    edges: [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "in-thread",
    ],
  }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
  repository = github.addRepository("someone/tracker");
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

async function ok(env: Record<string, string> = {}): Promise<string> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        GITHUB_APP_ID: String(github.appId),
        GITHUB_PRIVATE_KEY: key,
        GITHUB_WEBHOOK_SECRET: "github-test-webhook-secret",
        GITHUB_API_URL: github.url,
        ...env,
      },
    });
    return stderr;
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    throw new Error(`the run exited ${String(failed.code)}: ${failed.stderr}`, {
      cause: error,
    });
  }
}

function row(link: string) {
  const found = marfa.rows.find((one) => one.properties["github_id"] === link);
  if (found === undefined) throw new Error(`no row holds ${link}`);
  return found;
}

function written(): string[] {
  return github
    .writes()
    .map((one) =>
      one.path === "/graphql"
        ? String(
            /mutation (\w+)/.exec((one.body as { query: string }).query)?.[1],
          )
        : `${one.method} ${one.path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}`,
    );
}

/** A run, then another that must carry nothing: the first's writes are
 *  its own on the second. */
async function settled(env: Record<string, string> = {}): Promise<string> {
  const output = await ok(env);
  const before = github.writes().length;
  await ok(env);
  expect(github.writes().slice(before)).toEqual([]);
  return output;
}

describe("an issue changed in Marfa", () => {
  it("has its title, body, labels and assignees carried to GitHub, once", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    marfa.edit(row(issue.node).id, {
      title: "After",
      body: "Now with a body",
      labels: ["bug"],
      assignees: ["someone"],
    });
    await settled();
    expect(issue).toMatchObject({
      title: "After",
      body: "Now with a body",
      labels: ["bug"],
      assignees: ["someone"],
    });
    expect(written()).toEqual([`PATCH /issues/${String(issue.number)}`]);
  });

  it("closes as completed or not planned as its status says, and keeps a status GitHub cannot tell from open", async () => {
    const done = github.addIssue(repository, { title: "Done" });
    const dropped = github.addIssue(repository, { title: "Dropped" });
    const going = github.addIssue(repository, { title: "Going" });
    await ok();
    marfa.edit(row(done.node).id, { status: "completed" });
    marfa.edit(row(dropped.node).id, { status: "canceled" });
    marfa.edit(row(going.node).id, { status: "in_progress" });
    await settled();
    expect(done).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(dropped).toMatchObject({
      state: "closed",
      state_reason: "not_planned",
    });
    expect(going.state).toBe("open");
    expect(row(going.node).properties["status"]).toBe("in_progress");
    expect(row(dropped.node).properties["state_reason"]).toBe("not_planned");
  });

  it("goes to the later change where both sides changed the same field, and the run says so", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    marfa.edit(row(issue.node).id, { title: "From Marfa" });
    github.edit(issue, { title: "From GitHub" });
    const output = await ok();
    expect(issue.title).toBe("From GitHub");
    expect(row(issue.node).properties["title"]).toBe("From GitHub");
    expect(output).toContain("conflicts 1");
  });

  it("is put back and sent nowhere where the connector runs read only", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok({ GITHUB_READ_ONLY: "true" });
    marfa.edit(row(issue.node).id, { title: "From Marfa" });
    const output = await ok({ GITHUB_READ_ONLY: "true" });
    expect(github.writes()).toEqual([]);
    expect(row(issue.node).properties["title"]).toBe("Before");
    expect(output).toContain("put back");
  });
});

describe("a trash", () => {
  it("closes the issue as not planned, stays, comes back on GitHub's activity, and a restore reopens it", async () => {
    const issue = github.addIssue(repository, { title: "Maybe" });
    await ok();
    marfa.trash(row(issue.node).id);
    await settled();
    expect(issue).toMatchObject({
      state: "closed",
      state_reason: "not_planned",
    });
    expect(row(issue.node).state).toBe("trashed");
    github.addComment(issue, "Actually, still wanted");
    const output = await ok();
    expect(row(issue.node).state).toBe("active");
    expect(output).toContain("brought back");
    // Brought back by GitHub: its close stands, which the row says.
    expect(row(issue.node).properties["status"]).toBe("canceled");

    marfa.trash(row(issue.node).id);
    await ok();
    marfa.restore(row(issue.node).id);
    await settled();
    expect(issue).toMatchObject({ state: "open", state_reason: "reopened" });
  });

  it("of a comment deletes it on GitHub, and a restore makes it again in its issue's thread", async () => {
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Keep this");
    await ok();
    marfa.trash(row(comment.node).id);
    await settled();
    expect(comment.deleted).toBe(true);
    const id = row(comment.node).id;
    marfa.restore(id);
    await settled();
    const again = github.comments.find(
      (one) => !one.deleted && one.body === "Keep this",
    );
    expect(again?.issue).toBe(issue.node);
    expect(marfa.byId(id).properties["github_id"]).toBe(again?.node);
  });
});

describe("a row made in Marfa", () => {
  it("becomes an issue in the repository it names, linked to it, with its relations", async () => {
    const parent = github.addIssue(repository, { title: "Parent" });
    const blocker = github.addIssue(repository, { title: "Blocker" });
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "Made in Marfa", body: "From an agent", labels: ["idea"] },
      "github.issue",
      "person",
    );
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    marfa.drawEdge(made.id, row(parent.node).id, "github.sub-issue-of");
    marfa.drawEdge(made.id, row(blocker.node).id, "github.blocked-by");
    await settled();
    const issue = github.issues.find((one) => one.title === "Made in Marfa");
    expect(issue).toMatchObject({
      body: "From an agent",
      labels: ["idea"],
      parent: parent.node,
      blocked_by: [blocker.node],
      app: true,
    });
    expect(marfa.byId(made.id).properties["github_id"]).toBe(issue?.node);
    expect(marfa.byId(made.id).properties["number"]).toBe(issue?.number);
  });

  it("naming no repository is not sent, and the run says why; drawing one sends it", async () => {
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "Nowhere yet" },
      "github.issue",
      "person",
    );
    const output = await ok();
    expect(github.writes()).toEqual([]);
    expect(output).toContain("names no repository the App reads");
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    await ok();
    expect(github.issues.some((one) => one.title === "Nowhere yet")).toBe(true);
  });

  it("as a comment in an issue's thread is posted there, and its edit follows", async () => {
    const issue = github.addIssue(repository);
    await ok();
    const made = marfa.insert(
      undefined,
      { body: "From Marfa", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(made.id, row(issue.node).id, "in-thread");
    await settled();
    const comment = github.comments.find((one) => one.body === "From Marfa");
    expect(comment?.issue).toBe(issue.node);
    expect(marfa.byId(made.id).properties["from"]).toBe(
      "marfa-connectors[bot]",
    );
    marfa.edit(made.id, { body: "From Marfa, edited" });
    await settled();
    expect(comment?.body).toBe("From Marfa, edited");
  });
});

describe("relations drawn in Marfa", () => {
  let child: Issue;
  let parent: Issue;

  beforeEach(() => {
    parent = github.addIssue(repository, { title: "Parent" });
    child = github.addIssue(repository, { title: "Child" });
  });

  it("reach GitHub, and their removal too", async () => {
    await ok();
    marfa.drawEdge(
      row(child.node).id,
      row(parent.node).id,
      "github.sub-issue-of",
    );
    marfa.drawEdge(
      row(child.node).id,
      row(parent.node).id,
      "github.blocked-by",
    );
    await settled();
    expect(child.parent).toBe(parent.node);
    expect(child.blocked_by).toEqual([parent.node]);
    for (const edge of marfa.edges.filter(
      (one) => one.source_id === row(child.node).id,
    )) {
      if (edge.edge_type !== "github.in-repository") marfa.removeEdge(edge.id);
    }
    await settled();
    expect(child.parent).toBeNull();
    expect(child.blocked_by).toEqual([]);
  });

  it("that GitHub refuses are taken back in Marfa, and the run says why", async () => {
    const other = github.addRepository("another/tracker");
    const outsider = github.addIssue(other, { title: "Elsewhere" });
    await ok();
    marfa.drawEdge(
      row(child.node).id,
      row(outsider.node).id,
      "github.sub-issue-of",
    );
    const output = await ok();
    expect(child.parent).toBeNull();
    expect(marfa.targetsOf(row(child.node).id, "github.sub-issue-of")).toEqual(
      [],
    );
    expect(output).toContain("same owner");
  });

  it("put the repository back where a person moves an issue in Marfa", async () => {
    const other = github.addRepository("someone/other");
    await ok();
    const edge = marfa.edges.find(
      (one) =>
        one.source_id === row(child.node).id &&
        one.edge_type === "github.in-repository",
    );
    marfa.removeEdge(edge?.id ?? "");
    marfa.drawEdge(
      row(child.node).id,
      row(other.node).id,
      "github.in-repository",
    );
    const output = await ok();
    expect(github.writes()).toEqual([]);
    expect(marfa.targetsOf(row(child.node).id, "github.in-repository")).toEqual(
      [row(repository.node).id],
    );
    expect(output).toContain("put back");
  });
});

describe("what the write review found", () => {
  it("takes GitHub's refusal of one row as a condition, and the run goes on", async () => {
    const archived = github.addRepository("someone/old", { archived: true });
    const stuck = github.addIssue(archived, { title: "Stuck" });
    const other = github.addIssue(repository, { title: "Other" });
    await ok();
    marfa.edit(row(stuck.node).id, { title: "Stuck, edited" });
    github.edit(other, { title: "Other, edited on GitHub" });
    const output = await ok();
    expect(output).toContain("GitHub refused the change");
    expect(stuck.title).toBe("Stuck");
    expect(row(other.node).properties["title"]).toBe("Other, edited on GitHub");
  });

  it("names a create GitHub refuses, and leaves it unsent", async () => {
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "Labelled", labels: ["x".repeat(60)] },
      "github.issue",
      "person",
    );
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    const output = await ok();
    expect(output).toContain(`GitHub refused ${made.id}`);
    expect(github.issues.some((one) => one.title === "Labelled")).toBe(false);
  });

  it("finds an issue and a comment a lost answer made, and makes no second", async () => {
    const issue = github.addIssue(repository, { title: "Home" });
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "Made once" },
      "github.issue",
      "person",
    );
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    await ok();
    expect(
      github.issues.filter((one) => one.title === "Made once"),
    ).toHaveLength(1);
    const said = marfa.insert(
      undefined,
      { body: "Said once", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(said.id, row(issue.node).id, "in-thread");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    await ok();
    expect(
      github.comments.filter((one) => one.body === "Said once"),
    ).toHaveLength(1);
    expect(marfa.byId(said.id).properties["github_id"]).toBe(
      github.comments.find((one) => one.body === "Said once")?.node,
    );
  });

  it("carries an edit made beside an archive, and does not reopen an issue restored from archive", async () => {
    const issue = github.addIssue(repository, {
      title: "Done",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(1),
    });
    await ok();
    const id = row(issue.node).id;
    marfa.edit(id, { title: "Done, renamed" });
    marfa.transition(id, "archived");
    await ok();
    expect(issue.title).toBe("Done, renamed");
    marfa.transition(id, "active");
    await ok();
    expect(issue).toMatchObject({ state: "closed", state_reason: "completed" });
  });

  it("names an assignee GitHub would not assign", async () => {
    const issue = github.addIssue(repository);
    await ok();
    marfa.edit(row(issue.node).id, { assignees: ["someone", "nobody-here"] });
    const output = await ok();
    expect(issue.assignees).toEqual(["someone"]);
    expect(output).toContain("GitHub did not assign nobody-here");
  });
});
