import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { apiVersion, numbersIn, runsOf } from "../src/github.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const types = [
  "github.repository",
  "github.issue",
  "github.comment",
  "github.file",
  "github.file.image",
  "github.pull_request",
  "github.discussion",
  "github.notification",
  "github.repository_file",
  "github.directory",
];
const connections = [
  "github.in-repository",
  "github.sub-issue-of",
  "github.blocked-by",
  "github.relates-to",
  "github.duplicate-of",
  "attached-to",
  "github.closes",
  "github.closed-by",
  "parent-of",
  "references",
  "in-thread",
  "in-collection",
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
  github.appPem = key;
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

async function once(
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        GITHUB_APP_ID: "12345",
        GITHUB_PRIVATE_KEY: key,
        GITHUB_WEBHOOK_SECRET: "github-test-webhook-secret",
        ...github.settings,
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

function forgetPrivate(): void {
  for (const one of marfa.rows)
    Reflect.deleteProperty(one.properties, "private");
  for (const held of marfa.agreements.values()) {
    const record = held.record as {
      vendor?: Record<string, unknown>;
      marfa?: Record<string, unknown>;
    };
    Reflect.deleteProperty(record.vendor ?? {}, "private");
    Reflect.deleteProperty(record.marfa ?? {}, "private");
  }
  for (const one of Object.values(kept()))
    Reflect.deleteProperty(one, "private");
}

/** GitHub's hour is spent by the first repository's read, though the
 *  installation's repositories were listed before it. */
function spendAtRead(): void {
  github.onAsked = (one) => {
    if (one.path.startsWith("/repos/")) github.exhaust("core");
  };
}

function checkDue(): void {
  const document = marfa.states.get("github");
  const state = document?.["state"] as
    { repositories?: Record<string, Record<string, unknown>> } | undefined;
  for (const repository of Object.values(state?.repositories ?? {})) {
    Reflect.deleteProperty(repository, "checked");
  }
}

describe("a first sync", () => {
  it("keeps a finished repository when the next repository fails", async () => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    github.addIssue(first);
    github.addIssue(second);
    github.readFailure = second.name;
    const failed = await once();
    expect(failed.code, failed.output).toBe(1);
    expect(kept()[first.node]?.["comments"]).toBeDefined();
    expect(kept()[second.node]?.["comments"]).toBeUndefined();
    github.readFailure = undefined;
    github.asked = [];
    await ok();
    expect(
      github.asked
        .filter((one) => one.path === "/repos/someone/first/issues")
        .map((one) => one.status),
    ).toEqual([304, 304]);
    expect(kept()[second.node]?.["comments"]).toBeDefined();
  });

  it("keeps only acknowledged repository progress after a refused issue", async () => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    const refused = github.addIssue(first);
    github.addIssue(second);
    marfa.entryRefusals.set(refused.node, {
      status: 400,
      code: "type_mismatch",
      message: "type moved",
    });
    const result = await once();
    expect(result.output).toContain(
      "progress could not be saved (row-refused)",
    );
    expect(kept()[first.node]).toBeUndefined();
    expect(kept()[second.node]?.["comments"]).toBeDefined();
    marfa.entryRefusals.clear();
    await ok();
    expect(row(refused.node).state).toBe("active");
    expect(kept()[first.node]?.["comments"]).toBeDefined();
  });

  it("reloads a checkpoint whose acknowledgment was uncertain without rolling it back", async () => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    github.addIssue(first);
    github.addIssue(second);
    marfa.stateAnswer = { value: {} };
    const result = await once();
    expect(result.code, result.output).toBe(1);
    expect(kept()[first.node]?.["comments"]).toBeDefined();
    expect(kept()[second.node]).toBeUndefined();
    expect(
      github.asked.some((one) => one.path === "/repos/someone/second/issues"),
    ).toBe(false);
    marfa.stateAnswer = undefined;
    await ok();
    expect(kept()[second.node]?.["comments"]).toBeDefined();
  });

  it("keeps a completed repository across a long GitHub reset", async () => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    github.addIssue(first);
    github.addIssue(second);
    github.onAsked = (one) => {
      if (one.path === "/repos/someone/second/issues") github.exhaust("core");
    };
    const result = await once();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("someone/second waits for the next run");
    expect(kept()[first.node]?.["comments"]).toBeDefined();
    expect(kept()[second.node]).toBeUndefined();
    github.onAsked = undefined;
    github.refill("core");
    await ok();
    expect(kept()[second.node]?.["comments"]).toBeDefined();
  });

  it.each([
    [500, "goes on to the next request", true],
    [499, "stops before the next request", false],
  ])("with %i REST requests left, %s", async (left, _title, continues) => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    github.addIssue(first);
    github.addIssue(second);
    let reported = -1;
    github.onAsked = (one) => {
      if (reported < 0) {
        if (one.path !== "/repos/someone/second/issues") return;
        reported = github.asked.indexOf(one);
      }
      // From the second repository's listing on, each request is counted
      // and its answer says `left`.
      github.budget("core").remaining = left + 1;
    };
    const output = await ok();
    const later = github.asked
      .slice(reported + 1)
      .filter((one) => !one.path.startsWith("/app") && one.path !== "/graphql");
    expect(reported).toBeGreaterThan(-1);
    expect(github.asked[reported]?.remaining).toBe(left);
    // GitHub never refused a request, so nothing but the reserve can have
    // stopped the run, and it stopped with the budget still in hand.
    expect(github.asked.filter((one) => one.limited)).toEqual([]);
    expect(later.length > 0).toBe(continues);
    expect(output.includes("someone/second waits")).toBe(!continues);
    expect(kept()[first.node]?.["comments"]).toBeDefined();
    expect(kept()[second.node]?.["comments"] !== undefined).toBe(continues);
    if (!continues) {
      expect(github.budget("core").remaining).toBe(left);
      github.onAsked = undefined;
      github.refill("core");
      await ok();
      expect(kept()[second.node]?.["comments"]).toBeDefined();
    }
  });

  it("stops a run that began with a little over the reserve at the reserve, not at zero, and finishes it next run", async () => {
    const first = github.addRepository("someone/first");
    const second = github.addRepository("someone/second");
    github.addIssue(first);
    github.addIssue(second);
    github.budget("core").remaining = 503;
    const output = await ok();
    expect(output).toContain("wait for the next run");
    expect(github.asked.filter((one) => one.limited)).toEqual([]);
    expect(github.budget("core").remaining).toBe(499);
    expect(Object.keys(kept()).length).toBeLessThan(2);
    github.refill("core");
    await ok();
    expect(
      marfa.rows.filter((one) => one.type === "github.issue"),
    ).toHaveLength(2);
    expect(Object.keys(kept())).toHaveLength(2);
  });

  it.each([
    [500, true],
    [499, false],
  ])(
    "counts GraphQL apart from REST: with %i GraphQL points left, more GraphQL is asked: %s, and an independent repository finishes",
    async (left, continues) => {
      const first = github.addRepository("someone/first");
      github.installations.push({ id: 2, login: "another" });
      const second = github.addRepository("another/second", {
        installation: 2,
      });
      const empty = github.addRepository("someone/empty");
      github.addIssue(first);
      github.addIssue(second);
      // The first GraphQL request is counted, so its answer says `left`.
      github.budget("graphql").remaining = left + 1;
      const output = await ok();
      const queries = github.asked.filter(
        (one) =>
          one.path === "/graphql" &&
          (one.body as { variables: { owner?: string } }).variables.owner ===
            "someone",
      );
      expect(github.asked.filter((one) => one.limited)).toEqual([]);
      expect(queries.length > 1).toBe(continues);
      expect(output.includes("another/second waits")).toBe(false);
      expect(kept()[first.node]?.["comments"]).toBeUndefined();
      expect(kept()[second.node]?.["comments"]).toBeDefined();
      expect(kept()[empty.node]?.["comments"]).toBeUndefined();
      expect(github.budget("core").remaining).toBeGreaterThan(4000);
      if (!continues) {
        expect(queries).toHaveLength(1);
        expect(github.budget("graphql").remaining).toBe(left);
      }
    },
  );

  it("keeps saved repositories and their warnings when metadata is rate limited while another installation finishes", async () => {
    const first = github.addRepository("someone/first");
    const firstIssue = github.addIssue(first);
    await ok();
    const before = structuredClone(kept()[first.node]);
    const document = marfa.states.get("github");
    if (document === undefined) throw new Error("no saved connector state");
    marfa.problems.set("github", {
      [`repository-unreadable:${first.node}`]: "Earlier warning",
    });
    github.installations.push({ id: 2, login: "another" });
    const second = github.addRepository("another/second", { installation: 2 });
    github.addIssue(second);
    github.exhaust("core", 1);
    const output = await ok();
    expect(output).toContain("someone's repositories");
    expect(kept()[first.node]).toEqual(before);
    expect(row(firstIssue.node).state).toBe("active");
    expect(marfa.problems.get("github")).toHaveProperty(
      `repository-unreadable:${first.node}`,
      "Earlier warning",
    );
    expect(kept()[second.node]?.["comments"]).toBeDefined();
    expect(output).not.toContain("can no longer be read");
  });

  it.each([
    ["active", "active"],
    ["archived", "active"],
    ["active", "archived"],
    ["archived", "archived"],
  ])(
    "retains a deferred installation as a relation target without reading it (target %s, source %s)",
    async (targetState, sourceState) => {
      const first = github.addRepository("someone/first", { private: false });
      const blocker = github.addIssue(first);
      github.installations.push({ id: 2, login: "another" });
      const second = github.addRepository("another/second", {
        installation: 2,
        private: false,
      });
      const blocked = github.addIssue(second);
      blocked.blocked_by = [blocker.node];
      const child = github.addIssue(second);
      child.parent = blocker.node;
      await ok();
      expect(links(blocked.node, "github.blocked-by")).toEqual([blocker.node]);
      if (targetState === "archived")
        marfa.transition(row(blocker.node).id, "archived");
      if (sourceState === "archived") {
        blocked.deleted = true;
        child.deleted = true;
        checkDue();
        await ok();
        expect(row(blocked.node).state).toBe("archived");
        expect(row(child.node).state).toBe("archived");
        blocked.deleted = false;
        child.deleted = false;
      }
      const unseen = github.addIssue(first);
      blocked.blocked_by.push(unseen.node);
      blocked.parent = unseen.node;
      github.exhaust("core", 1);
      github.edit(blocked, { title: "Changed" });
      github.edit(child, { title: "Changed child" });
      github.asked = [];
      await ok();
      expect(links(blocked.node, "github.blocked-by")).toEqual([blocker.node]);
      expect(row(blocker.node).state).toBe(targetState);
      expect(row(blocked.node).state).toBe("active");
      expect(row(child.node).state).toBe("active");
      expect(links(child.node, "github.sub-issue-of")).toEqual([blocker.node]);
      expect(row(child.node).properties["parent_url"] ?? null).toBeNull();
      expect(row(blocked.node).properties["blocked_by_urls"]).toEqual([
        `https://github.com/someone/first/issues/${String(unseen.number)}`,
      ]);
      expect(row(blocked.node).properties["parent_url"]).toBe(
        `https://github.com/someone/first/issues/${String(unseen.number)}`,
      );
      expect(
        github.asked.filter((one) =>
          one.path.startsWith("/repos/someone/first/"),
        ),
      ).toEqual([]);
    },
  );
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

describe("what a row says of its repository's visibility", () => {
  it("says on each issue and comment whether its repository is private", async () => {
    const hidden = github.addRepository("someone/hidden", { private: true });
    const shown = github.addRepository("someone/shown", { private: false });
    const inHidden = github.addIssue(hidden, { title: "In hidden" });
    const inShown = github.addIssue(shown, { title: "In shown" });
    const hiddenSaid = github.addComment(inHidden, "Quiet");
    const shownSaid = github.addComment(inShown, "Loud");
    await ok();
    expect(row(inHidden.node).properties["private"]).toBe(true);
    expect(row(hiddenSaid.node).properties["private"]).toBe(true);
    expect(row(inShown.node).properties["private"]).toBe(false);
    expect(row(shownSaid.node).properties["private"]).toBe(false);
  });

  it("follows a change of the repository's visibility, in rows GitHub did not change", async () => {
    const repository = github.addRepository("someone/tracker", {
      private: true,
    });
    const open = github.addIssue(repository, { title: "Open" });
    const done = github.addIssue(repository, {
      title: "Done",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(10),
      updated_at: github.ago(10),
    });
    const comment = github.addComment(open, "Words");
    await ok();
    await ok();
    repository.private = false;
    repository.updated_at = github.now();
    const output = await ok();
    for (const node of [open.node, done.node, comment.node]) {
      expect(row(node).properties["private"]).toBe(false);
    }
    expect(row(repository.node).properties["private"]).toBe(false);
    expect(output).toContain("updated 4");
    repository.private = true;
    repository.updated_at = github.now();
    await ok();
    for (const node of [open.node, done.node, comment.node]) {
      expect(row(node).properties["private"]).toBe(true);
    }
  });

  it("keeps visibility unchanged while polling relationships and checks", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Words");
    await ok();
    await ok();
    const asked = github.asked.length;
    await ok();
    expect(
      github.asked.slice(asked).some((one) => one.path === "/graphql"),
    ).toBe(true);
  });

  it("fills rows read before the field existed, once", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Words");
    await ok();
    forgetPrivate();
    await ok();
    expect(row(issue.node).properties["private"]).toBe(true);
    expect(row(comment.node).properties["private"]).toBe(true);
    expect(Object.values(kept())[0]?.["private"]).toBe(true);
  });

  it("leaves a trashed issue in the bin on the first run after the field arrives, as GitHub's listing names it again", async () => {
    const repository = github.addRepository("someone/tracker");
    const trashed = github.addIssue(repository, { title: "Trashed" });
    const other = github.addIssue(repository, { title: "Other" });
    await ok();
    marfa.trash(row(trashed.node).id);
    await ok();
    forgetPrivate();
    github.edit(other, { title: "Other, edited" });
    await ok();
    expect(row(trashed.node).state).toBe("trashed");
    expect(row(other.node).properties["private"]).toBe(true);
  });

  it("leaves a trashed issue in the bin when its repository changes visibility, and marks it once it is restored", async () => {
    const repository = github.addRepository("someone/tracker");
    const trashed = github.addIssue(repository, { title: "Trashed" });
    const other = github.addIssue(repository, { title: "Other" });
    await ok();
    marfa.trash(row(trashed.node).id);
    await ok();
    repository.private = false;
    repository.updated_at = github.now();
    github.edit(other, { title: "Other, edited" });
    await ok();
    expect(row(trashed.node).state).toBe("trashed");
    expect(row(other.node).properties["private"]).toBe(false);
    marfa.restore(row(trashed.node).id);
    await ok();
    expect(row(trashed.node).state).toBe("active");
    expect(row(trashed.node).properties["private"]).toBe(false);
  });

  it("marks the rows of a repository the App can no longer read as private", async () => {
    const repository = github.addRepository("someone/tracker", {
      private: false,
    });
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Words");
    await ok();
    expect(row(issue.node).properties["private"]).toBe(false);
    github.installations = [];
    await ok();
    expect(row(issue.node).properties["private"]).toBe(true);
    expect(row(comment.node).properties["private"]).toBe(true);
  });

  it("marks the rows of a repository with its issues turned off from its visibility", async () => {
    const repository = github.addRepository("someone/tracker", {
      private: true,
    });
    const issue = github.addIssue(repository);
    await ok();
    repository.issuesOff = true;
    repository.private = false;
    repository.updated_at = github.now();
    checkDue();
    await ok();
    expect(row(issue.node).properties["private"]).toBe(false);
  });
});

describe("a run's report", () => {
  it("counts each row of a first run once, the comments among them", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "One");
    github.addComment(issue, "Two");
    await ok();
    expect(marfa.runs[0]?.summary).toContain(
      "created 4, updated 0, archived 0, unchanged 0",
    );
  });

  it("does not write a comment new in a run again at the daily check", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "One");
    await ok();
    github.addComment(issue, "Two");
    checkDue();
    await ok();
    expect(marfa.runs[1]?.summary).toContain(
      "created 1, updated 1, archived 0, unchanged 2",
    );
  });
});

describe("a comment cursor", () => {
  it("starts from GitHub's clock, not the machine's", async () => {
    github.runBehind(60 * 60 * 1000);
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Early");
    await ok();
    const { since } = Object.values(kept())[0]?.["comments"] as {
      since: string;
    };
    expect(Date.parse(since)).toBeLessThan(Date.now() - 30 * 60 * 1000);
    github.editComment(comment, "Edited");
    await ok();
    expect(row(comment.node).properties["body"]).toBe("Edited");
  });
});

describe("a run after", () => {
  it("keeps REST conditional and writes nothing while polling relationships and checks", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Hello");
    await ok();
    await ok();
    const before = marfa.rows.map((one) => one.version);
    const asked = github.asked.length;
    await ok();
    const listings = github.asked
      .slice(asked)
      .filter((one) => one.path.startsWith("/repos/"));
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((one) => one.status === 304)).toBe(true);
    expect(listings.length).toBeGreaterThan(1);
    // A 304 to an authorized request spends none of the hour's budget.
    expect(new Set(listings.map((one) => one.remaining)).size).toBe(1);
    expect(
      github.asked.slice(asked).some((one) => one.path === "/graphql"),
    ).toBe(true);
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
    const away = github.addRepository("stranger/private", {
      installation: 99,
      private: true,
    });
    await ok();
    github.transfer(moved, away);
    hidden.repository = "R_nowhere";
    checkDue();
    const output = await ok();
    expect(row(moved.node).state).toBe("archived");
    expect(output).toContain(
      "was moved to a repository the App cannot read, so its row here is archived",
    );
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

function conditions(): Record<string, string> {
  return marfa.problems.get("github") ?? {};
}

function envelope(): Record<string, unknown> {
  const value = marfa.states.get("github");
  if (value === undefined) throw new Error("no connector state");
  return value;
}

function installation() {
  const value = github.installations[0];
  if (value === undefined) throw new Error("no installation");
  return value;
}

function seedConditions(values: Record<string, string>): void {
  marfa.problems.set("github", { ...conditions(), ...values });
}

describe("read check coverage", () => {
  it("keeps disabled-issues evidence from an inaccessible installation while clearing a reached installation", async () => {
    github.installations.push({ id: 2, login: "another" });
    const a = github.addRepository("someone/a", { issuesOff: true });
    const b = github.addRepository("another/b", {
      installation: 2,
      issuesOff: true,
    });
    await ok();
    expect(conditions()).toHaveProperty(`issues-off:${a.node}`);
    expect(conditions()).toHaveProperty(`issues-off:${b.node}`);
    a.issuesOff = false;
    b.issuesOff = false;
    installation().lost = true;
    github.asked = [];
    const output = await ok();
    expect(conditions()).toHaveProperty(`issues-off:${a.node}`);
    expect(conditions()).not.toHaveProperty(`issues-off:${b.node}`);
    expect(output).not.toContain(
      `cleared: someone/a has its issues turned off`,
    );
    expect(output).toContain(`cleared: another/b has its issues turned off`);
    expect(
      github.asked.filter((request) =>
        request.path.includes("/repos/someone/a/issues"),
      ),
    ).toEqual([]);
    installation().lost = false;
    await ok();
    expect(conditions()).not.toHaveProperty(`issues-off:${a.node}`);
  });

  it("retains unread metadata even when no repository progress was saved", async () => {
    github.installations.push({ id: 2, login: "another" });
    const a = github.addRepository("someone/a", { issuesOff: true });
    const b = github.addRepository("another/b", {
      installation: 2,
      issuesOff: true,
    });
    await ok();
    (envelope()["state"] as Record<string, unknown>)["repositories"] = {};
    a.issuesOff = false;
    b.issuesOff = false;
    installation().lost = true;
    await ok();
    expect(conditions()).toHaveProperty(`issues-off:${a.node}`);
    expect(conditions()).not.toHaveProperty(`issues-off:${b.node}`);
    installation().lost = false;
    await ok();
    expect(conditions()).not.toHaveProperty(`issues-off:${a.node}`);
  });

  it("preserves excluded identities unknown to saved progress", async () => {
    const repository = github.addRepository("someone/tracker", {
      issuesOff: true,
    });
    await ok();
    (envelope()["state"] as Record<string, unknown>)["repositories"] = {};
    const result = await once({ GITHUB_REPOSITORIES: "someone/other" });
    expect(result.code, result.output).toBe(0);
    expect(conditions()).toHaveProperty(`issues-off:${repository.node}`);
    repository.issuesOff = false;
    await ok();
    expect(conditions()).not.toHaveProperty(`issues-off:${repository.node}`);
  });

  it.each(["unsettled", "reserve", "paused", "disabled"] as const)(
    "reaches metadata while preserving body evidence for a %s repository",
    async (skip) => {
      const repository = github.addRepository("someone/tracker", {
        issuesOff: true,
      });
      await ok();
      seedConditions({
        [`repository-unreadable:${repository.node}`]: "old body refusal",
        "issue-missing:unlinked": "old unlinked issue",
      });
      repository.issuesOff = skip === "disabled";
      if (skip === "unsettled") {
        const document = envelope();
        (document["state"] as Record<string, unknown>)["unsettled"] = [
          repository.node,
        ];
      }
      if (skip === "reserve") github.budget("core").remaining = 100;
      github.asked = [];
      const result = await once(
        skip === "paused" ? { GITHUB_REPOSITORIES: "someone/other" } : {},
      );
      expect(result.code, result.output).toBe(0);
      expect(conditions()).toHaveProperty(
        `repository-unreadable:${repository.node}`,
        "old body refusal",
      );
      expect(conditions()).toHaveProperty(
        "issue-missing:unlinked",
        "old unlinked issue",
      );
      expect(conditions()[`issues-off:${repository.node}`] !== undefined).toBe(
        skip === "disabled",
      );
      expect(
        github.asked.filter((request) =>
          request.path.includes("/repos/someone/tracker/issues"),
        ),
      ).toEqual([]);
    },
  );

  it.each(["unsettled", "clock-skew", "suspended"] as const)(
    "preserves unread evidence after %s",
    async (skip) => {
      const repository = github.addRepository("someone/tracker");
      await ok();
      seedConditions({
        [`issues-off:${repository.node}`]: "old metadata",
        [`repository-unreadable:${repository.node}`]: "old body",
        "issue-moved:unlinked": "old moved",
        "rate-limit-reserve": "old reserve",
        "clock-skew": "old clock",
      });
      if (skip === "unsettled")
        (envelope()["state"] as Record<string, unknown>)["unsettled"] = ["*"];
      if (skip === "clock-skew") github.clockAhead = 3600;
      if (skip === "suspended") installation().suspended = true;
      github.asked = [];
      await ok();
      expect(conditions()).toHaveProperty(
        `issues-off:${repository.node}`,
        "old metadata",
      );
      expect(conditions()).toHaveProperty(
        `repository-unreadable:${repository.node}`,
        "old body",
      );
      expect(conditions()).toHaveProperty("issue-moved:unlinked", "old moved");
      expect(conditions()).toHaveProperty("rate-limit-reserve", "old reserve");
      if (skip === "unsettled")
        expect(conditions()).toHaveProperty("clock-skew", "old clock");
      expect(
        github.asked.filter((request) =>
          request.path.includes("/repos/someone/tracker/issues"),
        ),
      ).toEqual([]);
    },
  );

  it("keeps later checks after clock skew without undoing completed repository checks", async () => {
    github.installations.push({ id: 2, login: "another" });
    const a = github.addRepository("someone/a");
    const b = github.addRepository("another/b", { installation: 2 });
    await ok();
    seedConditions({
      [`repository-unreadable:${a.node}`]: "A body",
      [`repository-unreadable:${b.node}`]: "B body",
    });
    github.asked = [];
    Object.defineProperty(github, "clockAhead", {
      get: () =>
        github.asked.some(
          (request) => request.path === "/repos/someone/a/issues/comments",
        )
          ? 3600
          : 0,
      configurable: true,
    });
    await ok();
    expect(conditions()).not.toHaveProperty(`repository-unreadable:${a.node}`);
    expect(conditions()).toHaveProperty(
      `repository-unreadable:${b.node}`,
      "B body",
    );
    expect(conditions()).toHaveProperty("clock-skew");
  });

  it("retains unread body evidence while reporting a rate-limited read", async () => {
    const repository = github.addRepository("someone/tracker");
    await ok();
    seedConditions({
      [`issues-off:${repository.node}`]: "metadata problem",
      [`repository-unreadable:${repository.node}`]: "body problem",
    });
    spendAtRead();
    const result = await once();
    expect(result.code, result.output).toBe(0);
    expect(conditions()).not.toHaveProperty(`issues-off:${repository.node}`);
    expect(conditions()).toHaveProperty(
      `repository-unreadable:${repository.node}`,
      "body problem",
    );
    expect(result.output).toContain("waits for the next run");
  });

  it("updates body refusal evidence without clearing unseen issue checks", async () => {
    const repository = github.addRepository("someone/tracker");
    await ok();
    seedConditions({
      [`repository-unreadable:${repository.node}`]: "old body",
      "issue-missing:unlinked": "old missing",
    });
    repository.hidden = true;
    await ok();
    expect(conditions()[`repository-unreadable:${repository.node}`]).toContain(
      "answered 404",
    );
    expect(conditions()).toHaveProperty(
      "issue-missing:unlinked",
      "old missing",
    );
  });

  it("clears completed conditional repository reads without claiming unperformed issue evidence", async () => {
    const repository = github.addRepository("someone/tracker");
    await ok();
    seedConditions({
      [`repository-unreadable:${repository.node}`]: "old body",
      "issue-missing:unlinked": "old missing",
    });
    github.asked = [];
    await ok();
    expect(conditions()).not.toHaveProperty(
      `repository-unreadable:${repository.node}`,
    );
    expect(conditions()).toHaveProperty(
      "issue-missing:unlinked",
      "old missing",
    );
    expect(github.asked.some((request) => request.status === 304)).toBe(true);
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

  describe("shared with a second process", () => {
    const peerToken = "github_pat_peer_12345678";
    const grants = {
      metadata_permissions: { types: "write", edge_types: "write" },
    };

    /** A second process: its own key, which claims the source `github`, and
     *  its own personal token, so it keeps its own agreements. */
    async function asPeer(): Promise<void> {
      const app = github.personalToken;
      const reached = github.personalRepositories;
      marfa.keySource = "github-peer";
      marfa.grants = { ...grants, sources: ["github"] };
      github.personalToken = peerToken;
      github.personalRepositories = new Set(
        github.repositories.map((one) => one.node),
      );
      try {
        const { code, output } = await once({
          GITHUB_PERSONAL_TOKEN: peerToken,
          GITHUB_APP_ID: undefined,
          GITHUB_PRIVATE_KEY: undefined,
          GITHUB_WEBHOOK_SECRET: undefined,
          GITHUB_STARS: "false",
        });
        if (code !== 0)
          throw new Error(`the peer exited ${String(code)}: ${output}`);
      } finally {
        marfa.keySource = "github";
        marfa.grants = grants;
        github.personalToken = app;
        github.personalRepositories = reached;
      }
    }

    /** Both processes have read the repository; then the second goes on to
     *  write an issue and a comment of its own. */
    async function shared() {
      const repository = github.addRepository("someone/tracker");
      const own = github.addIssue(repository);
      const mine = github.addComment(own, "Mine");
      await ok();
      const theirs = github.addIssue(repository);
      const reply = github.addComment(theirs, "Theirs");
      await asPeer();
      return { repository, own, mine, theirs, reply };
    }

    it(
      "leaves the rows it did not write and the repository row they sit under, and archives the rows it wrote",
      { timeout: 60_000 },
      async () => {
        const { repository, own, mine, theirs, reply } = await shared();
        repository.installation = 2;
        const output = await ok();
        expect(output).toContain("was taken out of the App's installation");
        expect(output).toContain("that this process did not archive");
        expect(row(own.node).state).toBe("archived");
        expect(row(mine.node).state).toBe("archived");
        expect(row(theirs.node).state).toBe("active");
        expect(row(reply.node).state).toBe("active");
        expect(row(repository.node).state).toBe("active");
      },
    );

    it(
      "archives the same rows and the repository row where no other process has written under it",
      { timeout: 60_000 },
      async () => {
        const repository = github.addRepository("someone/tracker");
        const own = github.addIssue(repository);
        const mine = github.addComment(own, "Mine");
        await ok();
        await asPeer();
        repository.installation = 2;
        await ok();
        expect(row(own.node).state).toBe("archived");
        expect(row(mine.node).state).toBe("archived");
        expect(row(repository.node).state).toBe("archived");
      },
    );

    it(
      "leaves a row it wrote but holds no agreement for",
      { timeout: 60_000 },
      async () => {
        const repository = github.addRepository("someone/tracker");
        const lost = github.addIssue(repository);
        const kept = github.addIssue(repository);
        await ok();
        marfa.agreements.delete(row(lost.node).id);
        repository.installation = 2;
        await ok();
        expect(row(lost.node).state).toBe("active");
        expect(row(kept.node).state).toBe("archived");
        expect(row(repository.node).state).toBe("active");
      },
    );

    it(
      "leaves a row a person linked to the repository by hand",
      { timeout: 60_000 },
      async () => {
        const repository = github.addRepository("someone/tracker");
        const own = github.addIssue(repository);
        await ok();
        const made = marfa.insert(
          undefined,
          { title: "By hand" },
          "github.issue",
          "person",
        );
        marfa.drawEdge(
          made.id,
          row(repository.node).id,
          "github.in-repository",
        );
        repository.installation = 2;
        await ok();
        expect(row(own.node).state).toBe("archived");
        expect(marfa.rows.find((one) => one.id === made.id)?.state).toBe(
          "active",
        );
        expect(row(repository.node).state).toBe("active");
      },
    );

    it(
      "keeps the repository's progress while a row under it is active, and archives its row on a later run once none is",
      { timeout: 90_000 },
      async () => {
        const { repository, theirs, reply } = await shared();
        repository.installation = 2;
        await ok();
        expect(row(repository.node).state).toBe("active");
        expect(kept()[repository.node]?.["leaving"]).toBe(true);
        await ok();
        expect(row(repository.node).state).toBe("active");
        expect(kept()[repository.node]?.["leaving"]).toBe(true);

        marfa.transition(row(reply.node).id, "archived");
        marfa.transition(row(theirs.node).id, "archived");
        const output = await ok();
        expect(output).toContain("was taken out of the App's installation");
        expect(row(repository.node).state).toBe("archived");
        expect(kept()[repository.node]).toBeUndefined();

        const before = marfa.log.length;
        await ok();
        expect(marfa.log.slice(before).map((one) => one.event)).not.toContain(
          "item.state_changed",
        );
        expect(row(repository.node).state).toBe("archived");
      },
    );

    it(
      "does not hold back a purge in a repository the App still reads while it keeps the one taken out",
      { timeout: 90_000 },
      async () => {
        const other = github.addRepository("someone/other");
        const issue = github.addIssue(other);
        const comment = github.addComment(
          issue,
          "Said",
          "marfa-connectors[bot]",
        );
        comment.app = true;
        const { repository } = await shared();
        repository.installation = 2;
        await ok();
        expect(kept()[repository.node]).toBeDefined();

        const id = row(comment.node).id;
        comment.deleted = true;
        marfa.purgeById(id);
        const output = await ok();
        expect(output).toContain("GitHub no longer shows what");
        expect(output).not.toContain("is out of the App's reach");
        expect(row(repository.node).state).toBe("active");
        expect(kept()[repository.node]).toBeDefined();
        expect(await ok()).not.toContain("is out of the App's reach");
      },
    );

    it(
      "reads the repository again, and no longer as leaving, when it is added back",
      { timeout: 90_000 },
      async () => {
        const { repository } = await shared();
        repository.installation = 2;
        await ok();
        expect(kept()[repository.node]?.["leaving"]).toBe(true);
        repository.installation = 1;
        await ok();
        expect(kept()[repository.node]).toBeDefined();
        expect(kept()[repository.node]?.["leaving"]).toBeUndefined();
        expect(row(repository.node).state).toBe("active");
      },
    );

    it("changes nothing when it runs again", { timeout: 60_000 }, async () => {
      const { repository, theirs, reply } = await shared();
      repository.installation = 2;
      await ok();
      const before = marfa.log.length;
      await ok();
      await ok();
      expect(marfa.log.slice(before).map((one) => one.event)).not.toContain(
        "item.state_changed",
      );
      expect(row(theirs.node).state).toBe("active");
      expect(row(reply.node).state).toBe("active");
      expect(row(repository.node).state).toBe("active");
    });
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
  });
});

function mints(): unknown[] {
  return github.asked
    .filter((one) => one.path.endsWith("/access_tokens") && one.status === 201)
    .map((one) => one.body);
}

describe("the installation tokens", () => {
  it("reach only the synced repositories and only read their issues, past the one that lists the installation's repositories", async () => {
    const tracker = github.addRepository("someone/tracker");
    const other = github.addRepository("someone/other");
    const child = github.addIssue(tracker, { title: "Child" });
    const parent = github.addIssue(other, { title: "Parent" });
    child.parent = parent.node;
    const { code, output } = await once({
      GITHUB_REPOSITORIES: "someone/tracker",
    });
    expect(code, output).toBe(0);
    expect(mints()).toEqual([
      expect.objectContaining({ permissions: { metadata: "read" } }),
      expect.objectContaining({
        repository_ids: [tracker.id],
        permissions: {
          issues: "read",
          pull_requests: "read",
          checks: "read",
          statuses: "read",
          metadata: "read",
        },
      }),
      expect.objectContaining({
        repository_ids: [tracker.id],
        permissions: { discussions: "read", metadata: "read" },
      }),
    ]);
    expect(mints()[0]).not.toHaveProperty("repository_ids");
    expect(row(child.node).properties["parent_url"] ?? null).toBeNull();
    expect(links(child.node, "github.sub-issue-of")).toEqual([]);
  });

  it("reach a repository left out once synced, so relations to its issues stay, and read only", async () => {
    const tracker = github.addRepository("someone/tracker");
    const other = github.addRepository("someone/other");
    const child = github.addIssue(tracker, { title: "Child" });
    const parent = github.addIssue(other, { title: "Parent" });
    child.parent = parent.node;
    await ok();
    const before = mints().length;
    const { code, output } = await once({
      GITHUB_REPOSITORIES: "someone/tracker",
      GITHUB_READ_ONLY: "true",
    });
    expect(code, output).toBe(0);
    expect(mints().slice(before)).toEqual([
      expect.objectContaining({ permissions: { metadata: "read" } }),
      expect.objectContaining({
        repository_ids: [tracker.id, other.id],
        permissions: {
          issues: "read",
          pull_requests: "read",
          checks: "read",
          statuses: "read",
          metadata: "read",
        },
      }),
      expect.objectContaining({
        repository_ids: [tracker.id],
        permissions: { discussions: "read", metadata: "read" },
      }),
    ]);
    expect(links(child.node, "github.sub-issue-of")).toEqual([parent.node]);
  });

  it("name a repository paused before its id was recorded, which the next run records", async () => {
    const tracker = github.addRepository("someone/tracker");
    const other = github.addRepository("someone/other");
    await ok();
    for (const one of Object.values(kept())) {
      Reflect.deleteProperty(one, "id");
    }
    const { code, output } = await once({
      GITHUB_REPOSITORIES: "someone/tracker",
    });
    expect(code, output).toBe(0);
    expect(kept()[other.node]).toMatchObject({ paused: true, id: other.id });
    expect(kept()[tracker.node]?.["id"]).toBe(tracker.id);
  });

  it("are replaced when GitHub revokes one mid-run, and the request sent again", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Said");
    github.revokeAfter = 3;
    const { code, output } = await once();
    expect(code, output).toBe(0);
    expect(output).not.toContain("answered 401");
    expect(output).not.toContain("refused it");
    expect(row(issue.node).state).toBe("active");
    expect(row(comment.node).state).toBe("active");
    expect(mints()).toHaveLength(4);
  });

  it("are not asked for while this machine's clock is more than ten minutes from GitHub's, which the run names, changing nothing", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    github.clockAhead = 60 * 60;
    const { code, output } = await once();
    expect(code, output).toBe(0);
    expect(output).toContain("past the 10 minutes the connector allows for");
    expect(marfa.rows).toEqual([]);
    expect(mints()).toEqual([]);
  });

  it("are minted though this machine's clock is out of step with GitHub's", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.clockAhead = -9 * 60;
    const { code, output } = await once();
    expect(code, output).toBe(0);
    expect(output).not.toContain("refused it");
    expect(row(issue.node).state).toBe("active");
  });
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
  });

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
  });

  it("takes a child detached from a parent in another repository", async () => {
    const one = github.addRepository("someone/one");
    const two = github.addRepository("someone/two");
    const parent = github.addIssue(one, { title: "Parent" });
    const child = github.addIssue(two, { title: "Child", parent: parent.node });
    await ok();
    child.parent = null;
    await ok();
    expect(links(child.node, "github.sub-issue-of")).toEqual([]);
  });

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
  });

  it("reports a rate-limited read as waiting, rather than calling it lost access", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    await ok();
    spendAtRead();
    const { code, output } = await once();
    expect(code, output).toBe(0);
    expect(output).toContain("waits for the next run");
    expect(output).not.toContain("so its rows are left as they are");
  });

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
  });

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
  });
});

describe("a comment a run missed", () => {
  it("is written at the daily check", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    github.addComment(issue, "Seen");
    await ok();
    await ok();
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

  it("leaves a repository's rows as they are once it is left out, reads nothing of it, and takes it up again when it is named again", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, { title: "Before" });
    const comment = github.addComment(issue, "Said");
    await ok();
    github.edit(issue, { title: "Changed while left out" });
    const { output } = await once({ GITHUB_REPOSITORIES: "someone/other" });
    expect(output).toContain(
      "someone/tracker is left out by GITHUB_REPOSITORIES, so its rows are left as they are",
    );
    expect(
      [repository.node, issue.node, comment.node].map((one) => row(one).state),
    ).toEqual(["active", "active", "active"]);
    expect(row(issue.node).properties["title"]).toBe("Before");
    await once({ GITHUB_REPOSITORIES: "someone/trakcer" });
    expect(row(issue.node).state).toBe("active");
    await once({ GITHUB_REPOSITORIES: "someone/tracker" });
    expect(row(issue.node).properties["title"]).toBe("Changed while left out");
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

describe("GITHUB_REPOSITORIES entries", () => {
  it("take owners GitHub allows, underscores and all", async () => {
    const repository = github.addRepository("mona_octo/tracker");
    const issue = github.addIssue(repository);
    const { code } = await once({ GITHUB_REPOSITORIES: "mona_octo/*" });
    expect(code).toBe(0);
    expect(row(issue.node).state).toBe("active");
  });
});

describe("a relation to an issue in a repository left out", () => {
  it("stays while the other end changes, and after it is named again", async () => {
    const tracker = github.addRepository("someone/tracker");
    const other = github.addRepository("someone/other");
    const child = github.addIssue(tracker, { title: "Child" });
    const parent = github.addIssue(other, { title: "Parent" });
    child.parent = parent.node;
    await ok();
    const parentRow = row(parent.node).id;
    const only = { GITHUB_REPOSITORIES: "someone/tracker" };
    await once(only);
    github.edit(child, { title: "Child, edited" });
    await once(only);
    expect(marfa.targetsOf(row(child.node).id, "github.sub-issue-of")).toEqual([
      parentRow,
    ]);
    await ok();
    expect(marfa.targetsOf(row(child.node).id, "github.sub-issue-of")).toEqual([
      parentRow,
    ]);
  }, 60_000);
});

// Helper: run the connector with a personal token instead of App credentials.
async function onceWithToken(
  token: string,
  extra: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        GITHUB_PERSONAL_TOKEN: token,
        ...github.settings,
        ...extra,
      },
    });
    return { code: 0, output: stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, output: failed.stderr };
  }
}

describe("a personal access token run", () => {
  const personalToken = "github_pat_test_12345678";

  beforeEach(() => {
    github.personalToken = personalToken;
  });

  it("syncs repositories and issues visible to the token", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, { title: "Token issue" });
    const result = await onceWithToken(personalToken);
    expect(result.code, result.output).toBe(0);
    expect(row(issue.node).properties["title"]).toBe("Token issue");
  });

  it("fails the run with a clear message when the token is rejected (401), and does not archive rows", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    // Sync first with a valid token to populate rows.
    await onceWithToken(personalToken);
    expect(marfa.rows.some((r) => r.type === "github.repository")).toBe(true);
    // Now run with a wrong token.
    const result = await onceWithToken("wrong_token_12345678");
    expect(result.code).toBe(1);
    expect(result.output).toContain("GITHUB_PERSONAL_TOKEN");
    expect(result.output).not.toContain("wrong_token");
    // Rows must not be archived.
    expect(
      marfa.rows.filter(
        (r) => r.type === "github.repository" && r.state === "active",
      ),
    ).toHaveLength(1);
  });

  it("redacts a token echoed by GitHub from logs and failed-run reports", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    github.echoCredentials = true;
    const result = await onceWithToken(personalToken);
    expect(result.code).toBe(1);
    expect(result.output).toContain("broken for Bearer [redacted]");
    expect(result.output).not.toContain(personalToken);
    expect(JSON.stringify(marfa.runs)).not.toContain(personalToken);
    expect(JSON.stringify(marfa.runs)).toContain("[redacted]");
  });

  it.each(["soon", "-1", "1.5"])(
    "refuses a GITHUB_REQUEST_SPACING_MS of %j, which is not a whole number of milliseconds",
    async (spacing) => {
      const result = await once({ GITHUB_REQUEST_SPACING_MS: spacing });
      expect(result.code).toBe(2);
      expect(result.output).toContain(
        "GITHUB_REQUEST_SPACING_MS must be a whole number of milliseconds",
      );
    },
  );

  it("refuses to start when both App settings and token are set", async () => {
    const result = await once({
      GITHUB_PERSONAL_TOKEN: personalToken,
      // once() already sets GITHUB_APP_ID and GITHUB_PRIVATE_KEY
    });
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/one of|either/i);
  });

  it("refuses to start when neither App settings nor token are set", async () => {
    try {
      const { stderr } = await run("node", [built, "--once"], {
        env: {
          PATH: process.env["PATH"],
          MARFA_API_URL: marfa.url,
          MARFA_API_KEY: marfa.key,
          ...github.settings,
        },
      });
      throw new Error(`expected exit 2 but exited 0: ${stderr}`);
    } catch (error) {
      const failed = error as { code: number; stderr: string };
      expect(failed.code).toBe(2);
      expect(failed.stderr).toMatch(/GITHUB_APP_ID|GITHUB_PERSONAL_TOKEN/);
    }
  });

  it("narrows repositories by GITHUB_REPOSITORIES when using a token", async () => {
    const tracker = github.addRepository("someone/tracker");
    const other = github.addRepository("someone/other");
    github.addIssue(tracker);
    github.addIssue(other);
    const result = await onceWithToken(personalToken, {
      GITHUB_REPOSITORIES: "someone/tracker",
    });
    expect(result.code, result.output).toBe(0);
    expect(
      marfa.rows.filter((r) => r.type === "github.repository"),
    ).toHaveLength(1);
    expect(
      marfa.rows.find((r) => r.properties["github_id"] === tracker.node),
    ).toBeDefined();
  });

  it("refuses to start when GITHUB_READ_ONLY names an unknown kind", async () => {
    const result = await onceWithToken(personalToken, {
      GITHUB_READ_ONLY: "unknown-kind",
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain("unknown-kind");
  });

  it("refuses to start with the App when GITHUB_READ_ONLY names an unknown kind", async () => {
    const result = await once({ GITHUB_READ_ONLY: "issue,unknown-kind" });
    expect(result.code).toBe(2);
    expect(result.output).toContain(
      "GITHUB_READ_ONLY holds an unknown kind (unknown-kind)",
    );
  });

  it("does not carry issues when GITHUB_READ_ONLY=issue", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, { title: "Original" });
    await onceWithToken(personalToken);
    // Edit the issue in Marfa; with issue read-only, the edit is put back.
    const issueRow = row(issue.node);
    marfa.edit(issueRow.id, { title: "Edited in Marfa" });
    const result = await onceWithToken(personalToken, {
      GITHUB_READ_ONLY: "issue",
    });
    expect(result.code, result.output).toBe(0);
    // The issue on GitHub is unchanged.
    expect(issue.title).toBe("Original");
    expect(github.writes()).toHaveLength(0);
    expect(row(issue.node).properties["title"]).toBe("Original");
  });

  it("keeps token runs read only without GITHUB_READ_ONLY and uses no App or webhook API", async () => {
    marfa.endpoints = [];
    const repository = github.addRepository("someone/tracker", {
      installation: 99,
    });
    const issue = github.addIssue(repository, { title: "Original" });
    const comment = github.addComment(issue, "Original comment");
    const first = await onceWithToken(personalToken);
    expect(first.code, first.output).toBe(0);
    marfa.edit(row(issue.node).id, { title: "Local edit" });
    marfa.edit(row(comment.node).id, { body: "Local comment edit" });
    const second = await onceWithToken(personalToken);
    expect(second.code, second.output).toBe(0);
    expect(row(issue.node).properties["title"]).toBe("Original");
    expect(row(comment.node).properties["body"]).toBe("Original comment");
    expect(github.writes()).toHaveLength(0);
    expect(github.asked.some((one) => one.path.startsWith("/app"))).toBe(false);
    expect(marfa.endpoints).toEqual([]);
    expect(second.output).not.toContain("no inbound endpoint");
  });

  it("keeps an unchanged second token run from writing rows", async () => {
    const repository = github.addRepository("someone/tracker");
    github.addIssue(repository);
    await onceWithToken(personalToken);
    const before = marfa.log.length;
    const result = await onceWithToken(personalToken);
    expect(result.code, result.output).toBe(0);
    expect(
      marfa.log.slice(before).filter((one) => one.event === "item.updated"),
    ).toEqual([]);
  });

  it("does not remake a restored issue that is gone from GitHub under a personal token", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await onceWithToken(personalToken);
    marfa.trash(row(issue.node).id);
    marfa.restore(row(issue.node).id);
    issue.deleted = true;
    const result = await onceWithToken(personalToken);
    expect(result.code, result.output).toBe(0);
    expect(github.writes()).toHaveLength(0);
    expect(github.issues).toHaveLength(1);
  });

  it("fails a token revoked during a repository read without pausing or archiving its rows", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await onceWithToken(personalToken);
    const previous = structuredClone(kept());
    github.onAsked = (asked) => {
      if (asked.path.endsWith("/issues"))
        github.personalToken = "replacement-token";
    };
    const result = await onceWithToken(personalToken);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("GITHUB_PERSONAL_TOKEN");
    expect(result.output).not.toContain(personalToken);
    expect(row(issue.node).state).toBe("active");
    expect(kept()).toEqual(previous);
  });

  it("names a missing permission and keeps reading a healthy repository", async () => {
    const first = github.addRepository("someone/denied");
    const second = github.addRepository("someone/healthy");
    const held = github.addIssue(first);
    const healthy = github.addIssue(second);
    await onceWithToken(personalToken);
    github.personalDenied = new Map([[first.node, "issues=read"]]);
    github.edit(healthy, { title: "Changed" });
    const result = await onceWithToken(personalToken);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("issues=read");
    expect(row(held.node).state).toBe("active");
    expect(row(healthy.node).properties["title"]).toBe("Changed");
  });

  it("fails when every token repository refuses the required permission", async () => {
    const repository = github.addRepository("someone/denied");
    github.addIssue(repository);
    github.personalDenied = new Map([[repository.node, "issues=read"]]);
    const result = await onceWithToken(personalToken);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("issues=read");
  });

  it.each([false, true])(
    "refreshes privacy after a denied read without advancing body cursors; healthy repository: %s",
    async (healthy) => {
      const repository = github.addRepository("someone/tracker", {
        private: false,
      });
      const issue = github.addIssue(repository);
      const comment = github.addComment(issue, "Original body");
      if (healthy) github.addIssue(github.addRepository("someone/healthy"));
      const first = await onceWithToken(personalToken);
      expect(first.code, first.output).toBe(0);
      expect(row(issue.node).properties["private"]).toBe(false);
      expect(row(comment.node).properties["private"]).toBe(false);
      const before = structuredClone(kept()[repository.node]);
      repository.private = true;
      github.personalDenied.set(repository.node, "issues=read");
      const result = await onceWithToken(personalToken);
      expect(result.code, result.output).toBe(healthy ? 0 : 1);
      for (const node of [repository.node, issue.node, comment.node])
        expect(row(node).properties["private"]).toBe(true);
      expect(row(comment.node).properties["body"]).toBe("Original body");
      expect(kept()[repository.node]).toEqual({ ...before, private: true });
      expect(result.output).toContain("issues=read");
    },
  );
});

it("accounts for unsigned uploads through the App without changing Markdown", async () => {
  const repository = github.addRepository("someone/files");
  const body = "[Note](https://github.com/user-attachments/files/1/note.txt)";
  const issue = github.addIssue(repository, { body });
  issue.bodyHTML =
    '<a href="https://github.com/user-attachments/files/1/note.txt">Note</a>';
  await ok();
  expect(row(issue.node).properties["body"]).toBe(body);
  expect(JSON.stringify(row(issue.node).properties["github_files"])).toContain(
    "did not sign",
  );
  const before = marfa.rows.map((row) => ({
    id: row.id,
    version: row.version,
  }));
  await ok();
  expect(
    marfa.rows.map((row) => ({ id: row.id, version: row.version })),
  ).toEqual(before);
});
