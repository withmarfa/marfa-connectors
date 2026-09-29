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
import { markOf, unmarked } from "../src/entries.js";
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

    // Reopened in Marfa, then trashed: the trash closes it, the restore
    // reopens what the trash closed.
    marfa.edit(row(issue.node).id, { status: "pending" });
    await ok();
    expect(issue.state).toBe("open");
    marfa.trash(row(issue.node).id);
    await ok();
    expect(issue).toMatchObject({
      state: "closed",
      state_reason: "not_planned",
    });
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
      (one) => !one.deleted && unmarked(one.body) === "Keep this",
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
    // Marked, unseen on GitHub's page, so a retry finds what it made.
    expect(issue).toMatchObject({
      body: `From an agent\n\n${markOf(made.id)}`,
      labels: ["idea"],
      parent: parent.node,
      blocked_by: [blocker.node],
      app: true,
    });
    expect(marfa.byId(made.id).properties["github_id"]).toBe(issue?.node);
    expect(marfa.byId(made.id).properties["body"]).toBe("From an agent");
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
    const comment = github.comments.find(
      (one) => unmarked(one.body) === "From Marfa",
    );
    expect(comment?.issue).toBe(issue.node);
    expect(marfa.byId(made.id).properties["from"]).toBe(
      "marfa-connectors[bot]",
    );
    marfa.edit(made.id, { body: "From Marfa, edited" });
    await settled();
    expect(unmarked(comment?.body ?? "")).toBe("From Marfa, edited");
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
      github.comments.filter((one) => unmarked(one.body) === "Said once"),
    ).toHaveLength(1);
    expect(marfa.byId(said.id).properties["github_id"]).toBe(
      github.comments.find((one) => unmarked(one.body) === "Said once")?.node,
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

describe("what the adversarial review found", () => {
  for (const how of ["uninstalled", "refused", "hidden"] as const) {
    it(`keeps an edit made while the App's access is ${how} waiting, runs on, and carries it once access is back`, async () => {
      const issue = github.addIssue(repository, { title: "Before" });
      const comment = github.addComment(issue, "Said");
      const other = github.addRepository("someone/elsewhere", {
        installation: 2,
      });
      github.installations.push({ id: 2, login: "someone-else" });
      const beside = github.addIssue(other, { title: "Beside" });
      await ok();
      const installations = github.installations;
      if (how === "uninstalled") {
        github.installations = installations.filter((one) => one.id !== 1);
      }
      const [first] = installations;
      if (how === "refused" && first !== undefined) first.lost = true;
      if (how === "hidden") repository.hidden = true;
      marfa.edit(row(issue.node).id, { title: "Edited in Marfa" });
      marfa.edit(row(comment.node).id, { body: "Said, edited" });
      marfa.edit(row(beside.node).id, { title: "Beside, edited" });
      const output = await ok();
      expect(output).toContain("waits");
      expect(beside.title).toBe("Beside, edited");
      github.installations = installations;
      if (first !== undefined) first.lost = false;
      repository.hidden = false;
      await ok();
      expect([issue.title, comment.body]).toEqual([
        "Edited in Marfa",
        "Said, edited",
      ]);
    });
  }

  it("names a create whose answer was lost and whose row was trashed before the retry, and a trash of what GitHub made closes it", async () => {
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "Lost, then binned" },
      "github.issue",
      "person",
    );
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    marfa.trash(made.id);
    expect(await ok()).toContain("trashed before GitHub answered its create");
    const [onGitHub, ...more] = github.issues.filter(
      (one) => one.title === "Lost, then binned",
    );
    expect(more).toEqual([]);
    const theirs = row(onGitHub?.node ?? "");
    expect(theirs.id).not.toBe(made.id);
    marfa.trash(theirs.id);
    await ok();
    expect([onGitHub?.state, onGitHub?.state_reason]).toEqual([
      "closed",
      "not_planned",
    ]);
  });

  it("names a comment whose answer was lost and whose row was trashed before the retry, and a trash of what GitHub made deletes it", async () => {
    const issue = github.addIssue(repository);
    await ok();
    const said = marfa.insert(
      undefined,
      { body: "Said once", from: "someone" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(said.id, row(issue.node).id, "in-thread");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    marfa.trash(said.id);
    expect(await ok()).toContain("trashed before GitHub answered its create");
    const [onGitHub, ...more] = github.comments.filter(
      (one) => unmarked(one.body) === "Said once",
    );
    expect(more).toEqual([]);
    marfa.trash(row(onGitHub?.node ?? "").id);
    await ok();
    expect(onGitHub?.deleted).toBe(true);
  });

  it("links a lost create to its own issue where another row made one of the same title", async () => {
    await ok();
    const place = (title: string) => {
      const made = marfa.insert(undefined, { title }, "github.issue", "person");
      marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
      return made;
    };
    const first = place("Same");
    await ok();
    const second = place("Same");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    await ok();
    await ok();
    const made = github.issues.filter((one) => one.title === "Same");
    expect(made).toHaveLength(2);
    const links = [first.id, second.id].map((id) =>
      String(marfa.byId(id).properties["github_id"]),
    );
    expect(links.sort()).toEqual(made.map((one) => one.node).sort());
    expect(
      marfa.rows.filter((one) => one.properties["title"] === "Same"),
    ).toHaveLength(2);
  });

  it("finds what a lost create made though its title changed before the retry", async () => {
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "First name" },
      "github.issue",
      "person",
    );
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    marfa.edit(made.id, { title: "Second name" });
    await ok();
    await ok();
    expect(github.issues.map((one) => one.title)).toEqual(["Second name"]);
    expect(
      marfa.rows
        .filter((one) => one.type === "github.issue")
        .map((one) => one.id),
    ).toEqual([made.id]);
  });

  it("makes a restored comment once where the remake's answer was lost", async () => {
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Keep this");
    await ok();
    const id = row(comment.node).id;
    marfa.trash(id);
    await ok();
    marfa.restore(id);
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    await ok();
    await ok();
    expect(
      github.comments.filter(
        (one) => !one.deleted && unmarked(one.body) === "Keep this",
      ),
    ).toHaveLength(1);
    expect(
      marfa.rows
        .filter((one) => one.properties["body"] === "Keep this")
        .map((one) => one.state),
    ).toEqual(["active"]);
  });

  it("leaves a completed issue completed through a trash and a restore", async () => {
    const issue = github.addIssue(repository, {
      title: "Done",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(1),
    });
    await ok();
    const id = row(issue.node).id;
    marfa.trash(id);
    await ok();
    expect([issue.state, issue.state_reason]).toEqual(["closed", "completed"]);
    marfa.restore(id);
    await ok();
    expect([issue.state, issue.state_reason]).toEqual(["closed", "completed"]);
    expect(marfa.byId(id).properties["status"]).toBe("completed");
  });

  it("draws a blocker beside a field GitHub refuses", async () => {
    const child = github.addIssue(repository, { title: "Child" });
    const blocker = github.addIssue(repository, { title: "Blocker" });
    await ok();
    marfa.edit(row(child.node).id, { labels: ["x".repeat(60)] });
    marfa.drawEdge(
      row(child.node).id,
      row(blocker.node).id,
      "github.blocked-by",
    );
    await ok();
    expect(child.blocked_by).toEqual([blocker.node]);
    expect(marfa.targetsOf(row(child.node).id, "github.blocked-by")).toEqual([
      row(blocker.node).id,
    ]);
  });
});

describe("what the fix review found", () => {
  it("keeps a create and an edit waiting through GitHub's secondary limit, and carries them after", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    const made = marfa.insert(
      undefined,
      { title: "Made in Marfa" },
      "github.issue",
      "person",
    );
    marfa.drawEdge(made.id, row(repository.node).id, "github.in-repository");
    marfa.edit(row(issue.node).id, { title: "After" });
    github.writesLimited = { left: 100, status: 403 };
    expect(await ok()).toContain("waits");
    github.writesLimited = undefined;
    await ok();
    expect(issue.title).toBe("After");
    expect(
      github.issues.filter((one) => one.title === "Made in Marfa"),
    ).toHaveLength(1);
  });

  it("keeps a relation waiting through GitHub's GraphQL limit, and the run goes on", async () => {
    const child = github.addIssue(repository, { title: "Child" });
    const blocker = github.addIssue(repository, { title: "Blocker" });
    await ok();
    github.mutationsLimited = 100;
    marfa.drawEdge(
      row(child.node).id,
      row(blocker.node).id,
      "github.blocked-by",
    );
    expect(await ok()).toContain("waits");
    github.mutationsLimited = 0;
    await ok();
    expect(child.blocked_by).toEqual([blocker.node]);
  });

  it("keeps a restore from the bin waiting while the repository is out of reach", async () => {
    const issue = github.addIssue(repository, { title: "Open one" });
    await ok();
    const id = row(issue.node).id;
    marfa.trash(id);
    await ok();
    repository.hidden = true;
    marfa.restore(id);
    expect(await ok()).toContain("waits");
    repository.hidden = false;
    await ok();
    expect(issue.state).toBe("open");
  });

  it("never takes another row's lost create for a create still waiting", async () => {
    await ok();
    github.writesLimited = { left: 100, status: 429, title: "Row A" };
    const first = marfa.insert(
      undefined,
      { title: "Row A" },
      "github.issue",
      "person",
    );
    marfa.drawEdge(first.id, row(repository.node).id, "github.in-repository");
    await ok();
    const second = marfa.insert(
      undefined,
      { title: "Row B", body: "B's own words" },
      "github.issue",
      "person",
    );
    marfa.drawEdge(second.id, row(repository.node).id, "github.in-repository");
    github.loseNextCreate = true;
    await expect(ok()).rejects.toThrow();
    const made = github.issues.find((one) => one.title === "Row B");
    github.writesLimited = undefined;
    await ok();
    await ok();
    expect(made?.title).toBe("Row B");
    expect(marfa.byId(second.id).properties["github_id"]).toBe(made?.node);
    expect(marfa.byId(first.id).properties["github_id"]).not.toBe(made?.node);
    expect(github.issues.map((one) => one.title).sort()).toEqual([
      "Row A",
      "Row B",
    ]);
  });

  it("keeps a comment's remake waiting where GitHub refuses it, and makes it once it may", async () => {
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Keep this");
    await ok();
    const id = row(comment.node).id;
    marfa.trash(id);
    await ok();
    repository.archived = true;
    marfa.restore(id);
    await ok();
    repository.archived = false;
    await ok();
    expect(
      github.comments.filter(
        (one) => !one.deleted && unmarked(one.body) === "Keep this",
      ),
    ).toHaveLength(1);
  });
});
