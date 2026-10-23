import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
const run = promisify(execFile);
const key = appKey();
const token = "ghp_notifications_test_token_0123456789";
let marfa: ScriptedServer;
let github: GitHubStub;
const types = [
  "github.repository",
  "github.issue",
  "github.comment",
  "github.pull_request",
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
  "github.notification-of",
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
  github.notifications.token = token;
  // Due again at once, so a run reads unless a test is about the interval.
  github.notifications.pollInterval = 0;
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
          GITHUB_NOTIFICATIONS_TOKEN: token,
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
function held(type = "github.notification") {
  return marfa.rows.filter((one) => one.type === type);
}
function links(id: string, type: string) {
  return marfa
    .targetsOf(row(id).id, type)
    .map((target) => marfa.byId(target).properties["github_id"]);
}
function listings() {
  return github.asked.filter(
    (one) => one.method === "GET" && one.path === "/notifications",
  );
}
function conditions(): Record<string, string> {
  return marfa.problems.get("github") ?? {};
}
interface Saved {
  modified?: string;
  polled: string;
  interval: number;
  checked: string;
  key: string;
}
function saved(): Saved {
  const state = marfa.states.get("github")?.["state"] as
    { notifications?: Saved } | undefined;
  if (state?.notifications === undefined) throw new Error("No saved progress");
  return state.notifications;
}
/** Moves the saved moments back, as time passing would. */
function age(seconds: number, field: "polled" | "checked"): void {
  const progress = saved();
  progress[field] = new Date(
    Date.parse(progress[field]) - seconds * 1000,
  ).toISOString();
}

describe("notifications", () => {
  it("reads a thread as a read-only message and connects it to the issue it concerns", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo, { title: "An issue" });
    const pr = github.addPullRequest(repo, { title: "A change" });
    const thread = github.notifications.add(
      repo,
      { type: "Issue", title: issue.title, number: issue.number },
      { reason: "mention" },
    );
    const review = github.notifications.add(
      repo,
      { type: "PullRequest", title: pr.title, number: pr.number },
      { reason: "review_requested", unread: false, last_read_at: github.now() },
    );
    const commit = github.notifications.add(repo, {
      type: "Commit",
      title: "A commit",
      sha: "0123456789abcdef0123456789abcdef01234567",
    });
    const release = github.notifications.add(repo, {
      type: "Release",
      title: "v1",
    });
    await ok();
    expect(row(thread.id).type).toBe("github.notification");
    expect(row(thread.id).properties).toMatchObject({
      github_id: thread.id,
      body: "An issue",
      from: "someone/tracker",
      reason: "mention",
      unread: true,
      subject_type: "Issue",
      url: `https://github.com/someone/tracker/issues/${String(issue.number)}`,
      private: true,
      github_updated_at: thread.updated_at,
    });
    expect(row(thread.id).properties["last_read_at"]).toBeUndefined();
    expect(row(review.id).properties).toMatchObject({
      reason: "review_requested",
      unread: false,
      subject_type: "PullRequest",
      url: `https://github.com/someone/tracker/pull/${String(pr.number)}`,
      last_read_at: review.last_read_at,
    });
    expect(row(commit.id).properties["url"]).toBe(
      "https://github.com/someone/tracker/commit/0123456789abcdef0123456789abcdef01234567",
    );
    expect(row(release.id).properties["url"]).toBeUndefined();
    expect(links(thread.id, "github.notification-of")).toEqual([issue.node]);
    expect(links(review.id, "github.notification-of")).toEqual([pr.node]);
    expect(links(commit.id, "github.notification-of")).toEqual([]);
    expect(conditions()).toEqual({});
  });

  it("puts back an edit made in Marfa", async () => {
    const repo = github.addRepository("someone/tracker");
    const thread = github.notifications.add(repo, {
      type: "Issue",
      title: "Original",
      number: 1,
    });
    await ok();
    marfa.edit(row(thread.id).id, {
      body: "Edited",
      reason: "assign",
      unread: false,
    });
    expect(row(thread.id).properties["body"]).toBe("Edited");
    await ok();
    expect(row(thread.id).properties).toMatchObject({
      body: "Original",
      reason: "subscribed",
      unread: true,
    });
    expect(github.writes()).toEqual([]);
  });

  it("reads every page of the listing", async () => {
    const repo = github.addRepository("someone/tracker");
    const made = Array.from({ length: 5 }, (_, at) =>
      github.notifications.add(repo, {
        type: "Issue",
        title: `Issue ${String(at)}`,
        number: at + 1,
      }),
    );
    github.notifications.pageSize = 2;
    await ok();
    expect(
      held()
        .map((one) => one.properties["github_id"])
        .sort(),
    ).toEqual(made.map((one) => one.id).sort());
    expect(listings().map((one) => one.status)).toEqual([200, 200, 200]);
  });

  it("answers an unchanged listing with a 304 and writes nothing", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo);
    const thread = github.notifications.add(repo, {
      type: "Issue",
      title: issue.title,
      number: issue.number,
    });
    await ok();
    expect(listings().map((one) => one.status)).toEqual([200]);
    expect(saved().modified).toBeDefined();
    const versions = marfa.rows.map((one) => one.version);
    const edgeIds = marfa.edges.map((one) => one.id);
    await ok();
    expect(listings().map((one) => one.status)).toEqual([200, 304]);
    expect(marfa.rows.map((one) => one.version)).toEqual(versions);
    expect(marfa.edges.map((one) => one.id)).toEqual(edgeIds);
    expect(row(thread.id).state).toBe("active");
    // The witness: a change on GitHub is not missed by that 304.
    github.notifications.change(thread, { unread: false });
    await ok();
    expect(listings().map((one) => one.status)).toEqual([200, 304, 200]);
    expect(row(thread.id).properties["unread"]).toBe(false);
  });

  it("writes nothing when a full read finds the same threads", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo);
    github.notifications.add(repo, {
      type: "Issue",
      title: issue.title,
      number: issue.number,
    });
    await ok();
    const versions = marfa.rows.map((one) => one.version);
    const edgeIds = marfa.edges.map((one) => one.id);
    // A day on, the listing is read whole again whatever it last said.
    age(25 * 60 * 60, "checked");
    await ok();
    expect(listings().map((one) => one.status)).toEqual([200, 200]);
    expect(marfa.rows.map((one) => one.version)).toEqual(versions);
    expect(marfa.edges.map((one) => one.id)).toEqual(edgeIds);
  });

  it("follows a reason that changes", async () => {
    const repo = github.addRepository("someone/tracker");
    const thread = github.notifications.add(
      repo,
      { type: "Issue", title: "An issue", number: 1 },
      { reason: "subscribed" },
    );
    await ok();
    expect(row(thread.id).properties["reason"]).toBe("subscribed");
    github.notifications.change(thread, {
      reason: "mention",
      unread: false,
      last_read_at: github.now(),
    });
    await ok();
    expect(row(thread.id).properties).toMatchObject({
      reason: "mention",
      unread: false,
      last_read_at: thread.last_read_at,
      github_updated_at: thread.updated_at,
    });
    expect(held()).toHaveLength(1);
  });

  it("writes a thread for a repository that is not synced, connected to nothing", async () => {
    const synced = github.addRepository("someone/tracker");
    const issue = github.addIssue(synced);
    const stranger = github.addRepository("stranger/public", {
      installation: 99,
      private: false,
    });
    const outside = github.notifications.add(stranger, {
      type: "Issue",
      title: "Elsewhere",
      number: 7,
    });
    const unknown = github.notifications.add(synced, {
      type: "Issue",
      title: "Not in the sync",
      number: issue.number + 100,
    });
    const inside = github.notifications.add(synced, {
      type: "Issue",
      title: issue.title,
      number: issue.number,
    });
    await ok();
    expect(row(outside.id).properties).toMatchObject({
      from: "stranger/public",
      private: false,
      url: "https://github.com/stranger/public/issues/7",
    });
    expect(links(outside.id, "github.notification-of")).toEqual([]);
    expect(links(unknown.id, "github.notification-of")).toEqual([]);
    // The witness: the same kind of thread, for an issue the sync holds.
    expect(links(inside.id, "github.notification-of")).toEqual([issue.node]);
    expect(
      marfa.rows.filter((one) => one.type === "github.repository"),
    ).toHaveLength(1);
  });

  it.each([
    ["a token without the notifications scope", "scope"],
    ["a token GitHub rejects", "rejected"],
  ])(
    "raises a condition for %s while the other kinds carry on",
    async (_name, fault) => {
      const repo = github.addRepository("someone/tracker");
      const issue = github.addIssue(repo, { title: "Still syncs" });
      const thread = github.notifications.add(repo, {
        type: "Issue",
        title: issue.title,
        number: issue.number,
      });
      await ok();
      expect(row(thread.id).state).toBe("active");
      if (fault === "scope") github.notifications.scopes = ["repo:status"];
      else github.notifications.token = "ghp_another_account_token_012345";
      github.notifications.change(thread, { unread: false });
      github.edit(issue, { title: "Renamed on GitHub" });
      github.addIssue(repo, { title: "A new one" });
      await ok();
      expect(conditions()).toHaveProperty(["notifications-refused"]);
      expect(conditions()["notifications-refused"]).toContain(
        "GITHUB_NOTIFICATIONS_TOKEN",
      );
      if (fault === "scope")
        expect(conditions()["notifications-refused"]).toContain(
          "notifications",
        );
      expect(JSON.stringify(conditions())).not.toContain(token);
      // The other kinds went on, and the thread already held was kept.
      expect(row(issue.node).properties["title"]).toBe("Renamed on GitHub");
      expect(
        marfa.rows.filter((one) => one.type === "github.issue"),
      ).toHaveLength(2);
      expect(row(thread.id)).toMatchObject({
        state: "active",
        properties: { unread: true },
      });
      // The witness: the condition clears once the token is right again.
      github.notifications.scopes = ["notifications"];
      github.notifications.token = token;
      await ok();
      expect(conditions()).toEqual({});
      expect(row(thread.id).properties["unread"]).toBe(false);
    },
  );

  it("waits for the next run when the rate limit is spent, and the other kinds carry on", async () => {
    const repo = github.addRepository("someone/tracker");
    github.addIssue(repo, { title: "Syncs" });
    const thread = github.notifications.add(repo, {
      type: "Issue",
      title: "Waits",
      number: 1,
    });
    github.exhaust("core", -1);
    await ok();
    expect(conditions()).toHaveProperty(["notifications-rate-limit"]);
    expect(held()).toEqual([]);
    expect(marfa.rows.some((one) => one.type === "github.issue")).toBe(true);
    github.refill("core", -1);
    await ok();
    expect(conditions()).toEqual({});
    expect(row(thread.id).state).toBe("active");
  });

  it("holds a failure it did not expect to a condition", async () => {
    const repo = github.addRepository("someone/tracker");
    github.addIssue(repo);
    github.notifications.add(repo, { type: "Issue", title: "T", number: 1 });
    github.notifications.failing = {
      status: 422,
      message: "Validation Failed",
    };
    await ok();
    expect(conditions()["notifications-failed"]).toContain("422");
    expect(held()).toEqual([]);
    expect(marfa.rows.some((one) => one.type === "github.issue")).toBe(true);
    github.notifications.failing = undefined;
    await ok();
    expect(conditions()).toEqual({});
    expect(held()).toHaveLength(1);
  });

  it("reads only the repositories GITHUB_REPOSITORIES names, and the rest when it is widened", async () => {
    const tracker = github.addRepository("someone/tracker");
    const other = github.addRepository("someone/other");
    const inside = github.notifications.add(tracker, {
      type: "Issue",
      title: "Inside",
      number: 1,
    });
    const outside = github.notifications.add(other, {
      type: "Issue",
      title: "Outside",
      number: 1,
    });
    const stranger = github.addRepository("stranger/public", {
      installation: 99,
    });
    const elsewhere = github.notifications.add(stranger, {
      type: "Issue",
      title: "Elsewhere",
      number: 1,
    });
    await ok({ GITHUB_REPOSITORIES: "someone/tracker" });
    expect(held().map((one) => one.properties["github_id"])).toEqual([
      inside.id,
    ]);
    // Nothing changed on GitHub, yet the wider setting reads what it left out.
    await ok({ GITHUB_REPOSITORIES: "someone/*, stranger/public" });
    expect(
      held()
        .map((one) => one.properties["github_id"])
        .sort(),
    ).toEqual([inside.id, outside.id, elsewhere.id].sort());
    // Narrowed again, what was read is left as it is, not archived.
    await ok({ GITHUB_REPOSITORIES: "someone/tracker" });
    expect(held().every((one) => one.state === "active")).toBe(true);
    expect(held()).toHaveLength(3);
  });

  it("reads nothing and reports nothing without the token", async () => {
    const repo = github.addRepository("someone/tracker");
    github.addIssue(repo);
    github.notifications.add(repo, { type: "Issue", title: "T", number: 1 });
    await ok({ GITHUB_NOTIFICATIONS_TOKEN: undefined });
    expect(listings()).toEqual([]);
    expect(held()).toEqual([]);
    expect(conditions()).toEqual({});
    expect(marfa.rows.some((one) => one.type === "github.issue")).toBe(true);
    // The witness: with the token the same listing is read.
    await ok();
    expect(listings()).toHaveLength(1);
    expect(held()).toHaveLength(1);
  });

  it("clears its condition when the token is taken away", async () => {
    const repo = github.addRepository("someone/tracker");
    github.addIssue(repo);
    github.notifications.add(repo, { type: "Issue", title: "T", number: 1 });
    github.notifications.scopes = [];
    await ok();
    expect(conditions()).toHaveProperty(["notifications-refused"]);
    await ok({ GITHUB_NOTIFICATIONS_TOKEN: undefined });
    expect(conditions()).toEqual({});
  });

  it("archives a thread GitHub no longer returns, and only on a read that listed it whole", async () => {
    const repo = github.addRepository("someone/tracker");
    const kept = github.notifications.add(repo, {
      type: "Issue",
      title: "Stays",
      number: 1,
    });
    const gone = github.notifications.add(repo, {
      type: "Issue",
      title: "Done",
      number: 2,
    });
    await ok();
    // A 304 says nothing about what is missing.
    await ok();
    expect(listings().map((one) => one.status)).toEqual([200, 304]);
    expect(row(gone.id).state).toBe("active");
    github.notifications.remove(gone);
    await ok();
    expect(row(gone.id).state).toBe("archived");
    expect(row(kept.id).state).toBe("active");
    // It comes back as the same row when GitHub lists it again.
    github.notifications.threads.push(gone);
    github.notifications.change(gone, { unread: true });
    await ok();
    expect(row(gone.id).state).toBe("active");
    expect(held()).toHaveLength(2);
  });

  it("archives nothing when a later page of the listing fails", async () => {
    const repo = github.addRepository("someone/tracker");
    const threads = Array.from({ length: 5 }, (_, at) =>
      github.notifications.add(repo, {
        type: "Issue",
        title: `Issue ${String(at)}`,
        number: at + 1,
      }),
    );
    github.notifications.pageSize = 2;
    await ok();
    const first = threads[0];
    if (first === undefined) throw new Error("No thread");
    github.notifications.remove(first);
    github.notifications.failing = {
      status: 422,
      message: "Validation Failed",
      page: 2,
    };
    await ok();
    expect(held().every((one) => one.state === "active")).toBe(true);
    expect(conditions()).toHaveProperty(["notifications-failed"]);
    // The witness: the same listing, whole, archives it.
    github.notifications.failing = undefined;
    await ok();
    expect(row(first.id).state).toBe("archived");
  });

  it("obeys X-Poll-Interval and asks again only once it has passed", async () => {
    const repo = github.addRepository("someone/tracker");
    github.addIssue(repo);
    const thread = github.notifications.add(repo, {
      type: "Issue",
      title: "T",
      number: 1,
    });
    github.notifications.pollInterval = 600;
    await ok();
    expect(saved().interval).toBe(600);
    expect(listings()).toHaveLength(1);
    github.notifications.change(thread, { unread: false });
    // Two minutes on, a minute's interval would be up; GitHub said ten.
    age(120, "polled");
    await ok();
    expect(listings()).toHaveLength(1);
    expect(row(thread.id).properties["unread"]).toBe(true);
    expect(marfa.rows.some((one) => one.type === "github.issue")).toBe(true);
    age(10 * 60, "polled");
    await ok();
    expect(listings()).toHaveLength(2);
    expect(row(thread.id).properties["unread"]).toBe(false);
  });

  it("reads beside a personal token, which stays read only", async () => {
    const repo = github.addRepository("someone/tracker");
    const issue = github.addIssue(repo);
    const thread = github.notifications.add(repo, {
      type: "Issue",
      title: issue.title,
      number: issue.number,
    });
    github.personalToken = "github_pat_notifications_test";
    await ok({
      GITHUB_PERSONAL_TOKEN: github.personalToken,
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    });
    expect(links(thread.id, "github.notification-of")).toEqual([issue.node]);
    expect(github.writes()).toEqual([]);
    expect(
      github.asked.some(
        (one) => one.path === "/notifications" && one.method !== "GET",
      ),
    ).toBe(false);
  });

  it("takes notification among the kinds GITHUB_READ_ONLY names", async () => {
    const repo = github.addRepository("someone/tracker");
    const thread = github.notifications.add(repo, {
      type: "Issue",
      title: "T",
      number: 1,
    });
    await ok({ GITHUB_READ_ONLY: "notification" });
    expect(row(thread.id).state).toBe("active");
    const refused = await once({ GITHUB_READ_ONLY: "issue,nonsense" });
    expect(refused.code).toBe(2);
    expect(refused.output).toContain("notification");
  });
});
