import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { markOf, unmarked } from "../src/entries.js";
import {
  appKey,
  GitHubStub,
  type Issue,
  type Repository,
} from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
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

const bot = "marfa-connectors[bot]";

function ours(issue: Issue, body: string) {
  const made = github.addComment(issue, body, bot);
  made.app = true;
  return made;
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

function writeMints(after: number): unknown[] {
  return github.asked
    .slice(after)
    .filter(
      (one) =>
        one.path.endsWith("/access_tokens") &&
        (one.body as { permissions?: { issues?: string } } | undefined)
          ?.permissions?.issues === "write",
    )
    .map((one) => one.body);
}

async function settled(env: Record<string, string> = {}): Promise<string> {
  const output = await ok(env);
  const before = github.writes().length;
  await ok(env);
  expect(github.writes().slice(before)).toEqual([]);
  return output;
}

describe("an issue changed in Marfa", () => {
  it("is carried with a token that names its own repository by id, and may write only issues", async () => {
    github.addRepository("someone/other");
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    const before = github.asked.length;
    marfa.edit(row(issue.node).id, { title: "After" });
    await ok();
    expect(issue.title).toBe("After");
    expect(writeMints(before)).toEqual([
      {
        repository_ids: [repository.id],
        permissions: { issues: "write", metadata: "read" },
      },
    ]);
  });

  it("is carried with a token that names the repository at the other end of a relation it draws too", async () => {
    const other = github.addRepository("someone/other");
    const child = github.addIssue(repository, { title: "Child" });
    const blocker = github.addIssue(other, { title: "Blocker" });
    await ok();
    const before = github.asked.length;
    marfa.drawEdge(
      row(child.node).id,
      row(blocker.node).id,
      "github.blocked-by",
    );
    await ok();
    expect(child.blocked_by).toEqual([blocker.node]);
    expect(writeMints(before)).toContainEqual({
      repository_ids: [repository.id, other.id],
      permissions: { issues: "write", metadata: "read" },
    });
    for (const minted of writeMints(before)) {
      expect([[repository.id], [repository.id, other.id]]).toContainEqual(
        (minted as { repository_ids: number[] }).repository_ids,
      );
    }
  });

  it("is carried with a token that never names a paused repository", async () => {
    const other = github.addRepository("someone/other");
    const child = github.addIssue(repository, { title: "Child" });
    const blocker = github.addIssue(other, { title: "Blocker" });
    await ok();
    const only = { GITHUB_REPOSITORIES: "someone/tracker" };
    await ok(only);
    const before = github.asked.length;
    marfa.edit(row(child.node).id, { title: "Child, edited" });
    marfa.drawEdge(
      row(child.node).id,
      row(blocker.node).id,
      "github.blocked-by",
    );
    const output = await ok(only);
    expect(child.title).toBe("Child, edited");
    expect(child.blocked_by).toEqual([]);
    expect(output).toContain("left out by GITHUB_REPOSITORIES");
    expect(writeMints(before)).toEqual([
      {
        repository_ids: [repository.id],
        permissions: { issues: "write", metadata: "read" },
      },
    ]);
  });

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
  it("leaves an issue closed as a duplicate a duplicate through a trash and a restore", async () => {
    const issue = github.addIssue(repository, {
      title: "Twice",
      state: "closed",
      state_reason: "duplicate",
      closed_at: github.ago(1),
      updated_at: github.ago(1),
    });
    await ok();
    expect(row(issue.node).properties["status"]).toBe("canceled");
    marfa.trash(row(issue.node).id);
    await settled();
    marfa.restore(row(issue.node).id);
    await settled();
    expect(issue).toMatchObject({ state: "closed", state_reason: "duplicate" });
    expect(written()).toEqual([]);
  });

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
    expect(row(issue.node).properties["status"]).toBe("canceled");

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

  it("of a comment the App wrote deletes it on GitHub, and a restore makes it again in its issue's thread", async () => {
    const issue = github.addIssue(repository);
    const comment = ours(issue, "Keep this");
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

describe("a comment someone else wrote on GitHub", () => {
  it("keeps its text there: an edit in Marfa is put back, and the run says so", async () => {
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Said");
    await ok();
    marfa.edit(row(comment.node).id, { body: "Said, edited in Marfa" });
    const output = await settled();
    expect(comment.body).toBe("Said");
    expect(row(comment.node).properties["body"]).toBe("Said");
    expect(output).toContain("its edit in Marfa is not sent");
    expect(written()).toEqual([]);
  });

  it("stays on GitHub when its row is binned, which stays binned, and a restore brings the row back", async () => {
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Keep this");
    await ok();
    const id = row(comment.node).id;
    marfa.trash(id);
    const output = await settled();
    expect(comment.deleted).toBeUndefined();
    expect(marfa.byId(id).state).toBe("trashed");
    expect(output).toContain("so it stays there though it is in the bin");
    marfa.restore(id);
    await settled();
    expect(marfa.byId(id).state).toBe("active");
    expect(github.comments.filter((one) => !one.deleted)).toHaveLength(1);
    expect(written()).toEqual([]);
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
    const other = github.addRepository("another/elsewhere");
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
    expect(output).toContain(made.id);
    expect(output).toContain("GitHub refused the new issue in someone/tracker");
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
    github.listLate = true;
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
    github.listLate = true;
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
      const comment = ours(issue, "Said");
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
    github.listLate = true;
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
    github.listLate = true;
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
    github.listLate = true;
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
    github.listLate = true;
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
    const comment = ours(issue, "Keep this");
    await ok();
    const id = row(comment.node).id;
    marfa.trash(id);
    await ok();
    marfa.restore(id);
    github.loseNextCreate = true;
    github.listLate = true;
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
    github.listLate = true;
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

  it("does not ask GitHub again for a comment's remake it refused, and makes it once the row changes", async () => {
    const issue = github.addIssue(repository);
    const comment = ours(issue, "Keep this");
    await ok();
    const id = row(comment.node).id;
    marfa.trash(id);
    await ok();
    repository.archived = true;
    marfa.restore(id);
    expect(await ok()).toContain("Repository was archived");
    repository.archived = false;
    const before = github.writes().length;
    await ok();
    expect(github.writes().slice(before)).toEqual([]);
    marfa.edit(id, { body: "Keep this, again" });
    await ok();
    expect(
      github.comments.filter(
        (one) => !one.deleted && unmarked(one.body) === "Keep this, again",
      ),
    ).toHaveLength(1);
  });
});

describe("a repository GITHUB_REPOSITORIES leaves out", () => {
  it("holds a change made in Marfa to its rows until it is named again", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    marfa.edit(row(issue.node).id, { title: "Edited while left out" });
    const output = await ok({ GITHUB_REPOSITORIES: "someone/other" });
    expect(output).toContain(
      "1 change waits: someone/tracker is left out by GITHUB_REPOSITORIES",
    );
    expect(issue.title).toBe("Before");
    await ok({ GITHUB_REPOSITORIES: "someone/tracker" });
    expect(issue.title).toBe("Edited while left out");
  });

  it("says once how many changes wait on it, and stops once they are carried", async () => {
    const first = github.addIssue(repository, { title: "First" });
    const second = github.addIssue(repository, { title: "Second" });
    await ok();
    marfa.edit(row(first.node).id, { title: "First, edited" });
    marfa.edit(row(second.node).id, { title: "Second, edited" });
    const output = await ok({ GITHUB_REPOSITORIES: "someone/other" });
    expect(output).toContain(
      "2 changes wait: someone/tracker is left out by GITHUB_REPOSITORIES",
    );
    expect(output.match(/changes? waits?:/g)).toHaveLength(1);
    const back = await ok({ GITHUB_REPOSITORIES: "someone/tracker" });
    expect(back).toContain("cleared: 2 changes wait: someone/tracker");
    expect([first.title, second.title]).toEqual([
      "First, edited",
      "Second, edited",
    ]);
  });

  it("takes no relation to its issues, and says why", async () => {
    const elsewhere = github.addRepository("someone/elsewhere");
    const child = github.addIssue(repository, { title: "Child" });
    const parent = github.addIssue(elsewhere, { title: "Parent" });
    await ok();
    const only = { GITHUB_REPOSITORIES: "someone/tracker" };
    await ok(only);
    marfa.drawEdge(
      row(child.node).id,
      row(parent.node).id,
      "github.sub-issue-of",
    );
    const output = await ok(only);
    expect(output).toContain(
      "someone/elsewhere is left out by GITHUB_REPOSITORIES",
    );
    expect(child.parent).toBeNull();
    expect(marfa.targetsOf(row(child.node).id, "github.sub-issue-of")).toEqual(
      [],
    );
  });
});

describe("a repository left out and then renamed on GitHub", () => {
  it("still holds a change made in Marfa to its rows, and takes no relation to them", async () => {
    const elsewhere = github.addRepository("someone/elsewhere");
    const issue = github.addIssue(elsewhere, { title: "Before" });
    const child = github.addIssue(repository, { title: "Child" });
    await ok();
    const only = { GITHUB_REPOSITORIES: "someone/tracker" };
    await ok(only);
    elsewhere.name = "renamed";
    await ok(only);
    marfa.edit(row(issue.node).id, { title: "Edited while left out" });
    marfa.drawEdge(
      row(child.node).id,
      row(issue.node).id,
      "github.sub-issue-of",
    );
    const output = await ok(only);
    expect(output).toContain(
      "1 change waits: someone/elsewhere is left out by GITHUB_REPOSITORIES",
    );
    expect(issue.title).toBe("Before");
    expect(child.parent).toBeNull();
    await ok({ GITHUB_REPOSITORIES: "someone/tracker someone/renamed" });
    expect(issue.title).toBe("Edited while left out");
  });
});

describe("where a write lands", () => {
  function byHand(properties: Record<string, unknown>) {
    return marfa.insert(
      undefined,
      { title: "By hand", ...properties },
      "github.issue",
      "person",
    );
  }

  it("is never an issue a row made by hand names, as the end of a relation", async () => {
    const elsewhere = github.addRepository("someone/elsewhere");
    const outside = github.addIssue(elsewhere, { title: "Outside" });
    const child = github.addIssue(repository, { title: "Child" });
    const only = { GITHUB_REPOSITORIES: "someone/tracker" };
    await ok(only);
    const named = byHand({
      github_id: outside.node,
      repository: "someone/tracker",
      number: outside.number,
    });
    marfa.drawEdge(row(child.node).id, named.id, "github.blocked-by");
    marfa.drawEdge(row(child.node).id, named.id, "github.sub-issue-of");
    await ok(only);
    await ok(only);
    expect(child.blocked_by).toEqual([]);
    expect(child.parent).toBeNull();
    expect(written()).toEqual([]);
  });

  it("is never the thread a row made by hand names, for a comment", async () => {
    const target = github.addIssue(repository, { title: "Target" });
    await ok();
    const named = byHand({
      github_id: "I_unknown",
      repository: "someone/tracker",
      number: target.number,
    });
    const said = marfa.insert(
      undefined,
      { body: "Posted where?", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(said.id, named.id, "in-thread");
    const output = await ok();
    await ok();
    expect(github.comments).toEqual([]);
    expect(output).toContain(`${said.id} is not sent to the vendor until`);
  });

  it("is the issue the row was agreed for when its number and repository are edited before a trash", async () => {
    const kept = github.addIssue(repository, { title: "Kept" });
    const binned = github.addIssue(repository, { title: "Binned" });
    const elsewhere = github.addRepository("someone/elsewhere");
    const far = github.addIssue(elsewhere, { title: "Far" });
    await ok();
    const id = row(binned.node).id;
    marfa.edit(id, { number: kept.number });
    marfa.trash(id);
    await ok();
    expect(kept.state).toBe("open");
    expect([binned.state, binned.state_reason]).toEqual([
      "closed",
      "not_planned",
    ]);
    const other = row(kept.node).id;
    marfa.edit(other, { repository: "someone/elsewhere", number: far.number });
    marfa.trash(other);
    await ok();
    expect(far.state).toBe("open");
    expect(kept.state).toBe("closed");
  });

  function quiet(issue: Issue): void {
    Object.assign(issue, {
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(200),
      updated_at: github.ago(200),
    });
  }

  it("follows a repository renamed on GitHub where another takes its old name", async () => {
    const issue = github.addIssue(repository, { title: "Original" });
    await ok();
    quiet(issue);
    repository.name = "tracker-old";
    const reused = github.addRepository("someone/tracker");
    const decoy = github.addIssue(reused, { title: "Decoy" });
    await ok();
    marfa.edit(row(issue.node).id, { title: "Edited in Marfa" });
    await ok();
    expect(issue.title).toBe("Edited in Marfa");
    expect(decoy.title).toBe("Decoy");
  });

  it("follows an issue transferred to another repository the App reads", async () => {
    const other = github.addRepository("someone/other");
    const issue = github.addIssue(repository, { title: "Original" });
    const comment = ours(issue, "Said");
    await ok();
    quiet(issue);
    Object.assign(issue, { repository: other.node, number: 7 });
    marfa.edit(row(issue.node).id, { title: "Edited in Marfa" });
    marfa.edit(row(comment.node).id, { body: "Said, edited" });
    await ok();
    expect(issue.title).toBe("Edited in Marfa");
    expect(comment.body).toBe("Said, edited");
  });

  it("holds a change waiting, and says so, where GitHub shows the App nothing the row is linked to", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    repository.hidden = true;
    marfa.edit(row(issue.node).id, { title: "After" });
    const output = await ok();
    expect(output).toContain(
      `GitHub shows the App nothing ${row(issue.node).id} is linked to, and a repository the connector syncs is out of its reach, so the change waits`,
    );
    repository.hidden = false;
    await ok();
    expect(issue.title).toBe("After");
  });
});

describe("a delete GitHub answers as not found", () => {
  it("is not taken as done while the comment is still there: the trash waits, and lands once GitHub takes it", async () => {
    const issue = github.addIssue(repository);
    const comment = ours(issue, "Stays");
    await ok();
    github.deletesRefused = true;
    const id = row(comment.node).id;
    marfa.trash(id);
    const output = await ok();
    expect(comment.deleted).toBeUndefined();
    expect(output).toContain(`its trash waits`);
    expect(marfa.agreements.get(id)?.waiting).toBe(true);
    github.deletesRefused = false;
    await settled();
    expect(comment.deleted).toBe(true);
    expect(marfa.agreements.get(id)?.waiting).toBe(false);
  });
});

describe("a target GitHub no longer has", () => {
  it("takes an edit of a deleted issue as not sent, names it, and settles", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    const id = row(issue.node).id;
    issue.deleted = true;
    marfa.edit(id, { title: "After" });
    const output = await settled();
    expect(output).toContain(`GitHub no longer shows what ${id} is linked to`);
    expect(marfa.agreements.get(id)?.waiting).toBe(false);
  });

  it("takes a restore of a deleted issue as not sent, names it, and settles", async () => {
    const issue = github.addIssue(repository, { title: "Binned" });
    await ok();
    const id = row(issue.node).id;
    marfa.trash(id);
    await ok();
    issue.deleted = true;
    marfa.restore(id);
    const output = await settled();
    expect(output).toContain(`GitHub no longer shows what ${id} is linked to`);
    expect(marfa.agreements.get(id)?.waiting).toBe(false);
  });

  it("takes an edit of a deleted comment as not sent, names it, and settles", async () => {
    const issue = github.addIssue(repository);
    const comment = ours(issue, "Said");
    await ok();
    const id = row(comment.node).id;
    comment.deleted = true;
    marfa.edit(id, { body: "Said, edited" });
    const output = await settled();
    expect(output).toContain(`GitHub no longer shows what ${id} is linked to`);
    expect(marfa.agreements.get(id)?.waiting).toBe(false);
  });
});

describe("telling a target GitHub dropped from one out of reach", () => {
  it("waits for a binned row whose repository text names another repository that reads", async () => {
    const other = github.addRepository("someone/other");
    github.addIssue(other, { title: "Elsewhere" });
    const issue = github.addIssue(repository, { title: "Binned" });
    await ok();
    const id = row(issue.node).id;
    marfa.edit(id, { repository: "someone/other" });
    marfa.trash(id);
    repository.hidden = true;
    const output = await ok();
    expect(output).toContain("waits");
    expect(output).not.toContain("GitHub no longer shows");
    expect(marfa.agreements.get(id)?.waiting).toBe(true);
    repository.hidden = false;
    await ok();
    expect([issue.state, issue.state_reason]).toEqual([
      "closed",
      "not_planned",
    ]);
  });

  it("waits where the repository went out of reach and another took its name", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    const id = row(issue.node).id;
    repository.name = "tracker-old";
    repository.hidden = true;
    github.addRepository("someone/tracker");
    marfa.edit(id, { title: "After" });
    const output = await ok();
    expect(output).not.toContain("GitHub no longer shows");
    expect(marfa.agreements.get(id)?.waiting).toBe(true);
    repository.hidden = false;
    await ok();
    expect(issue.title).toBe("After");
  });
});

describe("an installation that refuses the App", () => {
  it("does not hold back a write to a repository under another", async () => {
    const lost = github.addRepository("gone/away", { installation: 2 });
    github.installations.unshift({ id: 2, login: "gone" });
    github.addIssue(lost, { title: "Unreachable" });
    const issue = github.addIssue(repository, { title: "Home" });
    await ok();
    const [first] = github.installations;
    if (first !== undefined) first.lost = true;
    const said = marfa.insert(
      undefined,
      { body: "Posted beside a lost installation", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(said.id, row(issue.node).id, "in-thread");
    await ok();
    expect(
      github.comments.some((one) =>
        one.body.startsWith("Posted beside a lost installation"),
      ),
    ).toBe(true);
  });
});

describe("a create GitHub made but answered with a server error", () => {
  it("is found at once and linked, made once, and the run goes on", async () => {
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
    await settled();
    const said = marfa.insert(
      undefined,
      { body: "Said once", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(said.id, row(issue.node).id, "in-thread");
    github.loseNextCreate = true;
    await settled();
    const issues = github.issues.filter((one) => one.title === "Made once");
    const comments = github.comments.filter(
      (one) => unmarked(one.body) === "Said once",
    );
    expect([issues.length, comments.length]).toEqual([1, 1]);
    expect(marfa.byId(made.id).properties["github_id"]).toBe(issues[0]?.node);
    expect(marfa.byId(said.id).properties["github_id"]).toBe(comments[0]?.node);
  });
});

describe("a change GitHub does not take", () => {
  it("is not taken as agreed when refused: it is not asked again as it stands, and lands whole once the row changes", async () => {
    const archived = github.addRepository("someone/old", { archived: true });
    const stuck = github.addIssue(archived, { title: "Stuck" });
    await ok();
    const id = row(stuck.node).id;
    marfa.edit(id, { title: "Stuck, edited" });
    const output = await ok();
    expect(output).toContain("Repository was archived");
    const before = github.writes().length;
    await ok();
    expect(github.writes().slice(before)).toEqual([]);
    expect(marfa.byId(id).properties["title"]).toBe("Stuck, edited");
    archived.archived = false;
    marfa.edit(id, { body: "Now with a body" });
    await ok();
    expect([stuck.title, stuck.body]).toEqual([
      "Stuck, edited",
      "Now with a body",
    ]);
  });

  it("waits, rather than settling as gone, where the repository turned issues off", async () => {
    const issue = github.addIssue(repository, { title: "Before" });
    await ok();
    const id = row(issue.node).id;
    repository.issuesOff = true;
    marfa.edit(id, { title: "After" });
    const output = await ok();
    expect(output).not.toContain("GitHub no longer shows");
    expect(marfa.agreements.get(id)?.waiting).toBe(true);
    repository.issuesOff = false;
    await ok();
    expect(issue.title).toBe("After");
  });

  it("does not post again under the App a comment whose author in Marfa is not the one GitHub gave", async () => {
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Theirs");
    await ok();
    const id = row(comment.node).id;
    marfa.edit(id, { from: bot });
    marfa.trash(id);
    await ok();
    comment.deleted = true;
    marfa.restore(id);
    marfa.refuseNext(`PATCH /items/${id}`, 409, "version_conflict");
    const output = await ok();
    expect(github.comments.filter((one) => !one.deleted)).toEqual([]);
    expect(output).toContain("waits");
  });
});
