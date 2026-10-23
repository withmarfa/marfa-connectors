import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { unmarked } from "../src/entries.js";
import {
  appKey,
  GitHubStub,
  type Discussion,
  type Repository,
} from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const bot = "marfa-connectors[bot]";
const personalToken = "github_pat_test_12345678";

let key: string;
let marfa: ScriptedServer;
let github: GitHubStub;
let repository: Repository;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types: [
      "github.repository",
      "github.issue",
      "github.comment",
      "github.file",
      "github.file.image",
      "github.pull_request",
      "github.discussion",
      "github.notification",
    ],
    edges: [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "github.relates-to",
      "github.duplicate-of",
      "github.closes",
      "github.closed-by",
      "parent-of",
      "references",
      "attached-to",
      "in-thread",
    ],
  }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
  github.appPem = key;
  repository = github.addRepository("someone/tracker");
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

async function once(env: Record<string, string | undefined> = {}) {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        GITHUB_APP_ID: String(github.appId),
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

async function ok(env: Record<string, string | undefined> = {}) {
  const result = await once(env);
  expect(result.code, result.output).toBe(0);
  return result.output;
}

/** A run, then another that must send GitHub nothing more. */
async function settled(env: Record<string, string | undefined> = {}) {
  const output = await ok(env);
  const before = github.writes().length;
  await ok(env);
  expect(github.writes().slice(before)).toEqual([]);
  return output;
}

function row(link: string) {
  const found = marfa.rows.find((one) => one.properties["github_id"] === link);
  if (found === undefined) throw new Error(`no row holds ${link}`);
  return found;
}

function links(link: string, type: string): unknown[] {
  return marfa
    .targetsOf(row(link).id, type)
    .map((target) => marfa.byId(target).properties["github_id"]);
}

/** The comment a reply answers: Marfa's `parent-of` runs from it to the reply. */
function parents(link: string): unknown[] {
  return marfa.edges
    .filter(
      (edge) =>
        edge.edge_type === "parent-of" && edge.target_id === row(link).id,
    )
    .map((edge) => marfa.byId(edge.source_id).properties["github_id"]);
}

function written(): string[] {
  return github
    .writes()
    .map((one) =>
      one.path === "/graphql"
        ? String(
            /mutation (\w+)/.exec((one.body as { query: string }).query)?.[1],
          )
        : `${one.method} ${one.path}`,
    );
}

function checkDue(): void {
  const state = marfa.states.get("github")?.["state"] as
    { repositories?: Record<string, Record<string, unknown>> } | undefined;
  for (const one of Object.values(state?.repositories ?? {})) {
    Reflect.deleteProperty(one, "checked");
  }
}

function made(title: string, extra: Record<string, unknown> = {}) {
  const item = marfa.insert(
    undefined,
    { title, body: "Made in Marfa", ...extra },
    "github.discussion",
    "person",
  );
  marfa.drawEdge(item.id, row(repository.node).id, "github.in-repository");
  return item;
}

describe("reading discussions", () => {
  it("brings in a discussion, its comments and its replies, and a second run writes nothing", async () => {
    const discussion = github.addDiscussion(repository, {
      title: "How do we ship?",
      body: "Ideas welcome.",
      category: "Ideas",
      answered: true,
      locked: true,
    });
    const first = github.addDiscussionComment(discussion, "Weekly.", "ana");
    const reply = github.addDiscussionComment(
      discussion,
      "Agreed.",
      "bo",
      first,
    );
    await ok();
    expect(row(discussion.node).type).toBe("github.discussion");
    expect(row(discussion.node).properties).toMatchObject({
      title: "How do we ship?",
      body: "Ideas welcome.",
      number: 1,
      repository: "someone/tracker",
      private: true,
      author: "someone",
      category: "Ideas",
      status: "open",
      answered: true,
      locked: true,
      url: "https://github.com/someone/tracker/discussions/1",
    });
    expect(links(discussion.node, "github.in-repository")).toEqual([
      repository.node,
    ]);
    expect(row(first.node).type).toBe("github.comment");
    expect(row(first.node).properties).toMatchObject({
      body: "Weekly.",
      from: "ana",
    });
    expect(links(first.node, "in-thread")).toEqual([discussion.node]);
    expect(parents(first.node)).toEqual([]);
    expect(links(reply.node, "in-thread")).toEqual([discussion.node]);
    expect(parents(reply.node)).toEqual([first.node]);
    const versions = marfa.rows.map((one) => one.version);
    await ok();
    expect(marfa.rows.map((one) => one.version)).toEqual(versions);
  });

  it("follows every page of comments and of replies", async () => {
    github.discussionPageSize = 2;
    const discussion = github.addDiscussion(repository);
    const comments = [1, 2, 3, 4, 5].map((at) =>
      github.addDiscussionComment(discussion, `Comment ${String(at)}`),
    );
    const replies = [1, 2, 3, 4, 5].map((at) =>
      github.addDiscussionComment(
        discussion,
        `Reply ${String(at)}`,
        "bo",
        comments[4] ?? null,
      ),
    );
    await ok();
    for (const one of [...comments, ...replies]) {
      expect(row(one.node).properties["body"]).toBe(one.body);
    }
    expect(parents(replies[4]?.node ?? "")).toEqual([comments[4]?.node]);
  });

  it("keeps a deleted comment that has replies as an empty row, and archives one deleted outright at the daily check", async () => {
    const discussion = github.addDiscussion(repository);
    const parent = github.addDiscussionComment(discussion, "Parent");
    github.addDiscussionComment(discussion, "Child", "bo", parent);
    const lone = github.addDiscussionComment(discussion, "Lone");
    await ok();
    github.removeDiscussionComment(parent);
    github.removeDiscussionComment(lone);
    checkDue();
    await ok();
    expect(row(parent.node).state).toBe("active");
    expect(row(parent.node).properties["body"]).toBe("");
    expect(row(parent.node).properties["from"]).toBe("ghost");
    expect(row(lone.node).state).toBe("archived");
  });

  it("follows a renamed category, and archives a discussion GitHub no longer returns at the daily check", async () => {
    const kept = github.addDiscussion(repository, { category: "Ideas" });
    const gone = github.addDiscussion(repository);
    const under = github.addDiscussionComment(gone, "Under it");
    await ok();
    github.editDiscussion(kept, { category: "General" });
    await ok();
    expect(row(kept.node).properties["category"]).toBe("General");
    gone.deleted = true;
    await ok();
    expect(row(gone.node).state).toBe("active");
    checkDue();
    await ok();
    expect(row(gone.node).state).toBe("archived");
    expect(row(under.node).state).toBe("archived");
    expect(row(kept.node).state).toBe("active");
  });

  it("finds a comment that did not move its discussion's time at the daily check", async () => {
    const discussion = github.addDiscussion(repository, {
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    github.addDiscussion(repository);
    await ok();
    const late = github.addDiscussionComment(discussion, "Late");
    await ok();
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === late.node),
    ).toBe(false);
    checkDue();
    await ok();
    expect(row(late.node).properties["body"]).toBe("Late");
  });

  it("finds an edit to a comment, which GitHub does not count as a change of its discussion, at the daily check", async () => {
    const discussion = github.addDiscussion(repository, {
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const comment = github.addDiscussionComment(discussion, "Before");
    await ok();
    github.editDiscussionComment(comment, "After");
    await ok();
    expect(row(comment.node).properties["body"]).toBe("Before");
    checkDue();
    await ok();
    expect(row(comment.node).properties["body"]).toBe("After");
  });

  it.each([true, false])(
    "leaves a discussion comment's upload link out of the attachment import (private: %s)",
    async (hidden) => {
      repository.private = hidden;
      const discussion = github.addDiscussion(repository);
      const comment = github.addDiscussionComment(
        discussion,
        "![Image](https://github.com/user-attachments/assets/01234567-89ab-4cde-8123-456789abcdef)",
      );
      await ok();
      await ok();
      expect(row(comment.node).state).toBe("active");
      expect(
        Object.keys(marfa.problems.get("github") ?? {}).filter((key) =>
          key.startsWith("github-files:"),
        ),
      ).toEqual([]);
    },
  );

  it("passes over a repository with Discussions off without a report", async () => {
    github.addDiscussion(repository);
    repository.discussionsOff = true;
    github.addIssue(repository);
    const output = await ok();
    expect(
      marfa.rows.filter((one) => one.type === "github.discussion"),
    ).toEqual([]);
    expect(output).not.toMatch(/discussion/i);
    expect(marfa.rows.some((one) => one.type === "github.issue")).toBe(true);
  });

  it("names a personal token Discussions refuses, and keeps the other kinds", async () => {
    github.personalToken = personalToken;
    github.personalNoDiscussions = true;
    github.addDiscussion(repository);
    const issue = github.addIssue(repository);
    const result = await once({
      GITHUB_PERSONAL_TOKEN: personalToken,
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Discussions");
    expect(row(issue.node).state).toBe("active");
    expect(marfa.rows.some((one) => one.type === "github.discussion")).toBe(
      false,
    );
  });

  it("names an App that has not accepted the Discussions permission, and keeps the other kinds", async () => {
    Reflect.deleteProperty(github.appPermissions, "discussions");
    github.addDiscussion(repository);
    const issue = github.addIssue(repository);
    const output = await ok();
    expect(output).toContain("Discussions");
    expect(row(issue.node).state).toBe("active");
    expect(marfa.rows.some((one) => one.type === "github.discussion")).toBe(
      false,
    );
  });
});

describe("a discussion changed in Marfa", () => {
  let discussion: Discussion;

  beforeEach(() => {
    discussion = github.addDiscussion(repository, {
      title: "Original",
      body: "Body",
    });
  });

  it("has its title and body carried to GitHub, once", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, { title: "New", body: "New body" });
    await settled();
    expect(discussion.title).toBe("New");
    expect(discussion.body).toBe("New body");
    expect(written()).toEqual(["UpdateDiscussion"]);
  });

  it.each(["resolved", "outdated", "duplicate"])(
    "closes as %s, and reopens",
    async (reason) => {
      await ok();
      marfa.edit(row(discussion.node).id, {
        status: "closed",
        state_reason: reason,
      });
      await settled();
      expect(discussion.state).toBe("closed");
      expect(discussion.state_reason).toBe(reason);
      expect(row(discussion.node).properties["state_reason"]).toBe(reason);
      marfa.edit(row(discussion.node).id, { status: "open" });
      await settled();
      expect(discussion.state).toBe("open");
      expect(written()).toEqual(["CloseDiscussion", "ReopenDiscussion"]);
    },
  );

  it("closes as resolved where the row names no reason", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, { status: "closed" });
    await settled();
    expect(discussion.state_reason).toBe("resolved");
  });

  it("puts back the category, answer and lock, and sends nothing", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, {
      category: "Ideas",
      answered: true,
      locked: true,
    });
    await settled();
    expect(row(discussion.node).properties).toMatchObject({
      category: "General",
      answered: false,
      locked: false,
    });
    expect(written()).toEqual([]);
  });

  it("is put back and sent nowhere where discussions are read only", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, { title: "New" });
    await settled({ GITHUB_READ_ONLY: "discussion" });
    expect(discussion.title).toBe("Original");
    expect(row(discussion.node).properties["title"]).toBe("Original");
    expect(written()).toEqual([]);
  });

  it("is carried while another kind is read only, and leaves its comments alone", async () => {
    const comment = github.addDiscussionComment(discussion, "Mine", bot);
    comment.app = true;
    await ok();
    marfa.edit(row(discussion.node).id, { title: "New" });
    marfa.edit(row(comment.node).id, { body: "Edited" });
    await settled({ GITHUB_READ_ONLY: "comment" });
    expect(discussion.title).toBe("New");
    expect(comment.body).toBe("Mine");
  });

  it("waits, truthfully, where its repository has Discussions turned off, and is carried when they are back", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, { title: "Edited in Marfa" });
    repository.discussionsOff = true;
    const output = await ok();
    expect(output).toContain("has its Discussions turned off");
    expect(output).not.toContain("GitHub no longer shows");
    expect(written()).toEqual([]);
    repository.discussionsOff = false;
    await ok();
    expect(discussion.title).toBe("Edited in Marfa");
  });

  it("is settled as gone, though its repository has Issues turned off, where GitHub shows it nowhere", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, { title: "Edited in Marfa" });
    repository.issuesOff = true;
    discussion.deleted = true;
    const output = await ok();
    expect(output).toContain("GitHub no longer shows");
    expect(output).not.toContain("so the changes to what is in it wait");
    expect(written()).toEqual([]);
  });

  it("is carried to the installation that shows it though another refuses the App", async () => {
    const far = github.addRepository("gone/away", { installation: 2 });
    github.installations.unshift({ id: 2, login: "gone" });
    github.addDiscussion(far);
    await ok();
    const [first] = github.installations;
    if (first !== undefined) first.lost = true;
    marfa.edit(row(discussion.node).id, { title: "Edited in Marfa" });
    await ok();
    expect(discussion.title).toBe("Edited in Marfa");
  });

  it("waits, and is not settled as gone, where the token that reads Discussions cannot be minted", async () => {
    await ok();
    marfa.edit(row(discussion.node).id, { title: "Edited in Marfa" });
    const [installation] = github.installations;
    if (installation !== undefined) installation.discussionsLost = true;
    const output = await ok();
    expect(output).toContain("the App's installation refused it");
    expect(output).not.toContain("GitHub no longer shows");
    expect(marfa.agreements.get(row(discussion.node).id)?.waiting).toBe(true);
    expect(written()).toEqual([]);
    if (installation !== undefined) installation.discussionsLost = false;
    await ok();
    expect(discussion.title).toBe("Edited in Marfa");
  });

  it("is carried to a later installation that shows it though the Discussions token of another cannot be minted", async () => {
    const far = github.addRepository("gone/away", { installation: 2 });
    github.installations.unshift({ id: 2, login: "gone" });
    github.addDiscussion(far);
    await ok();
    const [first] = github.installations;
    if (first !== undefined) first.discussionsLost = true;
    marfa.edit(row(discussion.node).id, { title: "Edited in Marfa" });
    await ok();
    expect(discussion.title).toBe("Edited in Marfa");
  });

  it("is put back through a personal token, which cannot write", async () => {
    github.personalToken = personalToken;
    const env = {
      GITHUB_PERSONAL_TOKEN: personalToken,
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    };
    await ok(env);
    marfa.edit(row(discussion.node).id, { title: "New" });
    await ok(env);
    expect(discussion.title).toBe("Original");
    expect(row(discussion.node).properties["title"]).toBe("Original");
    expect(written()).toEqual([]);
  });
});

describe("a discussion made in Marfa", () => {
  beforeEach(async () => {
    github.addIssue(repository);
    await ok();
  });

  it("is created in the category it names, linked, with its repository", async () => {
    const item = made("From Marfa", { category: "Q&A" });
    await settled();
    const posted = github.discussions.find(
      (one) => unmarked(one.body) === "Made in Marfa",
    );
    expect(posted).toMatchObject({
      title: "From Marfa",
      category: "Q&A",
      user: bot,
    });
    expect(marfa.byId(item.id).properties).toMatchObject({
      github_id: posted?.node,
      author: bot,
      category: "Q&A",
      number: 1,
    });
  });

  it.each([
    ["names no category", undefined, "has no category"],
    ["names one the repository lacks", "Nope", "Nope"],
  ])(
    "that %s is declined with the categories there are",
    async (_, name, text) => {
      made("Lost", name === undefined ? {} : { category: name });
      const output = await ok();
      expect(github.discussions).toHaveLength(0);
      expect(output).toContain(text);
      expect(output).toContain("General, Ideas, Q&A");
      await ok();
      expect(written()).toEqual([]);
    },
  );

  it("is made once where a lost answer hides it from the next listing", async () => {
    const item = made("Once", { category: "General" });
    github.loseNextCreate = true;
    github.listLate = true;
    expect(await ok()).toContain("waits");
    await ok();
    expect(
      github.discussions.filter((one) => one.title === "Once"),
    ).toHaveLength(1);
    expect(marfa.byId(item.id).properties["github_id"]).toBe(
      github.discussions[0]?.node,
    );
  });
});

describe("a comment on a discussion", () => {
  let discussion: Discussion;

  beforeEach(() => {
    discussion = github.addDiscussion(repository);
  });

  // The client's throttle holds each write a second apart across several runs: about 29 seconds, against a 30 second default.
  it("made in Marfa is posted in its discussion, and a reply under the comment it answers, and edits and deletes follow", async () => {
    await ok();
    const top = marfa.insert(
      undefined,
      { body: "From Marfa", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(top.id, row(discussion.node).id, "in-thread");
    await settled();
    const posted = github.discussionComments.find(
      (one) => unmarked(one.body) === "From Marfa",
    );
    expect(posted).toMatchObject({ discussion: discussion.node, parent: null });
    const reply = marfa.insert(
      undefined,
      { body: "Replying", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(reply.id, row(discussion.node).id, "in-thread");
    marfa.drawEdge(top.id, reply.id, "parent-of");
    await settled();
    expect(
      github.discussionComments.find(
        (one) => unmarked(one.body) === "Replying",
      ),
    ).toMatchObject({ parent: posted?.node });
    marfa.edit(top.id, { body: "From Marfa, edited" });
    await settled();
    expect(unmarked(posted?.body ?? "")).toBe("From Marfa, edited");
    marfa.trash(top.id);
    await settled();
    expect(posted?.blanked).toBe(true);
    expect(marfa.byId(top.id).state).toBe("trashed");
    expect(written()).toEqual([
      "AddDiscussionComment",
      "AddDiscussionComment",
      "UpdateDiscussionComment",
      "DeleteDiscussionComment",
    ]);
  }, 60_000);

  // Each write waits a second behind the one before it, as in the test above.
  it("trashed with replies sends one delete, and the replies the bin took with it send none", async () => {
    await ok();
    const top = marfa.insert(
      undefined,
      { body: "Parent", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(top.id, row(discussion.node).id, "in-thread");
    await settled();
    const parent = github.discussionComments.find(
      (one) => unmarked(one.body) === "Parent",
    );
    const reply = marfa.insert(
      undefined,
      { body: "Ours", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(reply.id, row(discussion.node).id, "in-thread");
    marfa.drawEdge(top.id, reply.id, "parent-of");
    await settled();
    const ours = github.discussionComments.find(
      (one) => unmarked(one.body) === "Ours",
    );
    const theirs = github.addDiscussionComment(
      discussion,
      "Theirs",
      "bo",
      parent ?? null,
    );
    await settled();
    expect(parents(theirs.node)).toEqual([parent?.node]);
    expect(written()).toEqual(["AddDiscussionComment", "AddDiscussionComment"]);

    marfa.trash(top.id);
    const trashed = await settled();
    expect(written().slice(2)).toEqual(["DeleteDiscussionComment"]);
    expect(parent?.blanked).toBe(true);
    for (const id of [top.id, reply.id, row(theirs.node).id]) {
      expect(marfa.byId(id).state).toBe("trashed");
    }
    expect(ours?.deleted).toBeUndefined();
    expect(theirs.deleted).toBeUndefined();
    expect(trashed).not.toContain("stays there though it is in the bin");

    marfa.restore(top.id);
    await settled();
    for (const id of [top.id, reply.id, row(theirs.node).id]) {
      expect(marfa.byId(id).state).toBe("active");
    }
    expect(written().slice(3)).toEqual([]);

    marfa.trash(reply.id);
    await settled();
    expect(written().slice(3)).toEqual(["DeleteDiscussionComment"]);
    expect(ours?.deleted).toBe(true);
  }, 90_000);

  it("trashed with replies, but written by someone else, stays on GitHub with its replies, and sends nothing", async () => {
    const theirs = github.addDiscussionComment(discussion, "Theirs");
    await ok();
    const reply = marfa.insert(
      undefined,
      { body: "Ours", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(reply.id, row(discussion.node).id, "in-thread");
    marfa.drawEdge(row(theirs.node).id, reply.id, "parent-of");
    await settled();
    expect(written()).toEqual(["AddDiscussionComment"]);

    marfa.trash(row(theirs.node).id);
    const trashed = await settled();
    expect(written()).toEqual(["AddDiscussionComment"]);
    expect(trashed).toContain("so it stays there though it is in the bin");
    expect(theirs.blanked).toBeUndefined();
    expect(marfa.byId(reply.id).state).toBe("trashed");

    marfa.restore(row(theirs.node).id);
    await settled();
    expect(marfa.byId(reply.id).state).toBe("active");
    expect(written()).toEqual(["AddDiscussionComment"]);
  }, 60_000);

  it("made in Marfa is posted once where a lost answer hides it from the next listing", async () => {
    await ok();
    const top = marfa.insert(
      undefined,
      { body: "Once", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(top.id, row(discussion.node).id, "in-thread");
    github.loseNextCreate = true;
    github.listLate = true;
    expect(await ok()).toContain("waits");
    await ok();
    const posted = github.discussionComments.filter(
      (one) => unmarked(one.body) === "Once",
    );
    expect(posted).toHaveLength(1);
    expect(marfa.byId(top.id).properties["github_id"]).toBe(posted[0]?.node);
    expect(written()).toEqual(["AddDiscussionComment"]);
  });

  it("made in Marfa waits, truthfully, where its repository has Discussions turned off, and is posted when they are back", async () => {
    await ok();
    const top = marfa.insert(
      undefined,
      { body: "While they are off", from: "me" },
      "github.comment",
      "person",
    );
    marfa.drawEdge(top.id, row(discussion.node).id, "in-thread");
    repository.discussionsOff = true;
    const output = await ok();
    expect(output).toContain("has its Discussions turned off");
    expect(output).not.toContain("GitHub no longer shows");
    expect(marfa.agreements.get(top.id)?.waiting).toBe(true);
    expect(written()).toEqual([]);
    repository.discussionsOff = false;
    await ok();
    expect(
      github.discussionComments.some(
        (one) => unmarked(one.body) === "While they are off",
      ),
    ).toBe(true);
  });

  it("someone else wrote keeps its text and its place: an edit and a bin are put back, and the run says so", async () => {
    const theirs = github.addDiscussionComment(discussion, "Said");
    await ok();
    marfa.edit(row(theirs.node).id, { body: "Said, edited in Marfa" });
    const edited = await settled();
    expect(theirs.body).toBe("Said");
    expect(row(theirs.node).properties["body"]).toBe("Said");
    expect(edited).toContain("its edit in Marfa is not sent");
    marfa.trash(row(theirs.node).id);
    const binned = await settled();
    expect(theirs.deleted).toBeUndefined();
    expect(binned).toContain("so it stays there though it is in the bin");
    expect(written()).toEqual([]);
  });
});
