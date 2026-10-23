import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  appKey,
  GitHubStub,
  type Issue,
  type Repository,
} from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const secret = "github-test-webhook-secret";
const key = appKey();

let marfa: ScriptedServer;
let github: GitHubStub;

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types: [
      "github.repository",
      "github.issue",
      "github.comment",
      "github.discussion",
      "github.file",
      "github.file.image",
      "github.pull_request",
    ],
    edges: [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "github.relates-to",
      "github.duplicate-of",
      "attached-to",
      "github.closes",
      "github.closed-by",
      "in-thread",
      "parent-of",
    ],
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

function env(): Record<string, string | undefined> {
  return {
    PATH: process.env["PATH"],
    MARFA_API_URL: marfa.url,
    MARFA_API_KEY: marfa.key,
    GITHUB_APP_ID: String(github.appId),
    GITHUB_PRIVATE_KEY: key,
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_API_URL: github.url,
  };
}

async function once(): Promise<string> {
  const { stderr } = await run("node", [built, "--once"], { env: env() });
  return stderr;
}

function deliver(event: string, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  marfa.deliver(body, [
    ["Content-Type", "application/json"],
    ["X-GitHub-Event", event],
    ["X-GitHub-Delivery", crypto.randomUUID()],
    [
      "X-Hub-Signature-256",
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    ],
  ]);
}

async function until(holds: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Runs the connector as a service, past its first read, then hands over to
 *  the body, which delivers webhooks to it. */
async function watching(body: () => Promise<void>): Promise<void> {
  const child = spawn("node", [built, "--every", "1h", "--look-every", "1s"], {
    env: env(),
    stdio: "ignore",
  });
  const exited = new Promise<void>((done) =>
    child.once("exit", () => {
      done();
    }),
  );
  try {
    await until(() => marfa.runs.length > 0, "the scheduled run");
    await body();
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

function row(link: string) {
  const found = marfa.rows.find((one) => one.properties["github_id"] === link);
  if (found === undefined) throw new Error(`no row holds ${link}`);
  return found;
}

function rowsOf(type: string) {
  return marfa.rows.filter((one) => one.type === type);
}

function connected(from: string, type: string, to: string): boolean {
  return (
    marfa.targetsOf(row(from).id, type).includes(row(to).id) ||
    marfa.targetsOf(row(to).id, type).includes(row(from).id)
  );
}

function lastWrites(after: number): string[] {
  return marfa.log
    .slice(after)
    .filter((one) => /^item\.(created|updated|archived)$/.test(one.event))
    .map((one) => one.event);
}

let source: Repository;
let target: Repository;

/** Source and target as the connector lists them: in the order given. */
function repositories(sourceFirst: boolean): void {
  if (sourceFirst) {
    source = github.addRepository("someone/source");
    target = github.addRepository("someone/target");
  } else {
    target = github.addRepository("someone/target");
    source = github.addRepository("someone/source");
  }
}

describe("a transferred issue", () => {
  it.each([
    ["the source is read first", true],
    ["the target is read first", false],
  ])(
    "stays one item, with its comments and connections, when %s",
    async (_, sourceFirst) => {
      repositories(sourceFirst);
      const parent = github.addIssue(source, { title: "Parent" });
      const blocker = github.addIssue(source, { title: "Blocker" });
      const sibling = github.addIssue(source, { title: "Related" });
      const moving = github.addIssue(source, {
        title: "Moving",
        body: "Text",
        parent: parent.node,
        blocked_by: [blocker.node],
        relates_to: [sibling.node],
      });
      sibling.relates_to = [moving.node];
      github.addComment(moving, "First", "alice");
      github.addComment(moving, "Second", "bob");
      await once();
      const issueId = row(moving.node).id;
      const commentIds = github.comments
        .filter((one) => one.issue === moving.node)
        .map((one) => row(one.node).id);
      const rows = rowsOf("github.issue").length;
      const comments = rowsOf("github.comment").length;

      const moved = github.transfer(moving, target);
      const output = await once();

      expect(row(moved.node).id).toBe(issueId);
      expect(row(moved.node).state).toBe("active");
      expect(row(moved.node).properties).toMatchObject({
        number: moved.number,
        repository: "someone/target",
        title: "Moving",
        body: "Text",
        url: `https://github.com/someone/target/issues/${String(moved.number)}`,
      });
      expect(rowsOf("github.issue")).toHaveLength(rows);
      expect(rowsOf("github.comment")).toHaveLength(comments);
      expect(
        rowsOf("github.issue").every((one) => one.state === "active"),
      ).toBe(true);
      expect(
        github.comments
          .filter((one) => one.issue === moved.node)
          .map((one) => row(one.node).id),
      ).toEqual(commentIds);
      expect(
        marfa.targetsOf(row(moved.node).id, "github.in-repository"),
      ).toEqual([row(target.node).id]);
      expect(connected(moved.node, "github.sub-issue-of", parent.node)).toBe(
        true,
      );
      expect(connected(moved.node, "github.blocked-by", blocker.node)).toBe(
        true,
      );
      expect(connected(moved.node, "github.relates-to", sibling.node)).toBe(
        true,
      );
      expect(
        marfa.targetsOf(row(moved.node).id, "github.sub-issue-of"),
      ).toEqual([row(parent.node).id]);
      expect(output).not.toContain("was moved to another repository");
      expect(github.writes()).toEqual([]);

      const before = marfa.log.length;
      await once();
      expect(lastWrites(before)).toEqual([]);
    },
    120_000,
  );

  it.each([
    ["the source is read first", true],
    ["the target is read first", false],
  ])(
    "follows the old address of an issue nothing else names when %s",
    async (_, sourceFirst) => {
      repositories(sourceFirst);
      const moving = github.addIssue(source, { title: "Alone" });
      github.addComment(moving, "Said", "alice");
      await once();
      const issueId = row(moving.node).id;
      const commentId = rowsOf("github.comment")[0]?.id;

      const moved = github.transfer(moving, target);
      await once();

      expect(row(moved.node).id).toBe(issueId);
      expect(rowsOf("github.issue")).toHaveLength(1);
      expect(rowsOf("github.comment")).toHaveLength(1);
      expect(rowsOf("github.comment")[0]?.id).toBe(commentId);
      expect(rowsOf("github.comment")[0]?.state).toBe("active");
    },
  );

  it.each([
    ["opened, then transferred", ["opened", "transferred"]],
    ["transferred, then opened", ["transferred", "opened"]],
  ])(
    "stays one item when the webhooks arrive %s",
    async (_, order) => {
      repositories(true);
      const moving = github.addIssue(source, { title: "Moving" });
      github.addComment(moving, "Said", "alice");
      await watching(async () => {
        const issueId = row(moving.node).id;
        const commentId = row(
          github.comments.find((one) => one.issue === moving.node)?.node ?? "",
        ).id;
        const moved = github.transfer(moving, target);
        const sent = github.transferDeliveries(moving, moved);
        for (const action of order) {
          deliver("issues", sent[action as "opened" | "transferred"]);
        }
        await until(
          () => marfa.deliveries.every((one) => one.outcome === "processed"),
          "the deliveries",
        );
        await until(
          () =>
            marfa.rows.some(
              (one) => one.properties["github_id"] === moved.node,
            ),
          "the rekey",
        );
        expect(row(moved.node).id).toBe(issueId);
        expect(rowsOf("github.issue")).toHaveLength(1);
        expect(rowsOf("github.issue")[0]?.state).toBe("active");
        expect(
          row(
            github.comments.find((one) => one.issue === moved.node)?.node ?? "",
          ).id,
        ).toBe(commentId);
        expect(rowsOf("github.comment")).toHaveLength(1);
        expect(rowsOf("github.comment")[0]?.state).toBe("active");
        expect(row(moved.node).properties["number"]).toBe(moved.number);
      });
    },
    60_000,
  );

  it("comes in once from outside the installation", async () => {
    repositories(true);
    const outside = github.addRepository("stranger/elsewhere", {
      installation: 99,
      private: false,
    });
    const arriving = github.addIssue(outside, { title: "Arriving" });
    github.addComment(arriving, "Said", "alice");
    await once();
    expect(rowsOf("github.issue")).toHaveLength(0);

    const moved = github.transfer(arriving, target);
    await once();
    await once();

    expect(rowsOf("github.issue")).toHaveLength(1);
    expect(row(moved.node).state).toBe("active");
    expect(rowsOf("github.comment")).toHaveLength(1);
  });

  it("comes in once from outside the installation by its one webhook", async () => {
    repositories(true);
    const outside = github.addRepository("stranger/elsewhere", {
      installation: 99,
      private: false,
    });
    const arriving = github.addIssue(outside, { title: "Arriving" });
    await watching(async () => {
      const moved = github.transfer(arriving, target);
      deliver("issues", github.transferDeliveries(arriving, moved).opened);
      await until(
        () =>
          marfa.rows.some((one) => one.properties["github_id"] === moved.node),
        "the new row",
      );
      expect(rowsOf("github.issue")).toHaveLength(1);
    });
  });

  it("is archived, and says where, when it goes to a repository the App cannot read", async () => {
    repositories(true);
    const moving = github.addIssue(source, { title: "Leaving" });
    const staying = github.addIssue(source, { title: "Staying" });
    const closed = github.addRepository("stranger/private", {
      installation: 99,
      private: true,
    });
    await once();
    github.transfer(moving, closed);
    const output = await once();
    expect(row(moving.node).state).toBe("archived");
    expect(row(staying.node).state).toBe("active");
    expect(output).toContain(
      "was moved to a repository the App cannot read, so its row here is archived",
    );
    expect(rowsOf("github.issue")).toHaveLength(2);
  });

  it("carries a waiting edit to the issue in its new repository", async () => {
    repositories(true);
    const moving = github.addIssue(source, { title: "Original" });
    const comment = github.addComment(moving, "Said", "marfa-connectors[bot]");
    comment.app = true;
    await once();
    const moved = github.transfer(moving, target);
    marfa.edit(row(moving.node).id, { title: "Edited in Marfa" });
    await once();
    expect(moved.title).toBe("Edited in Marfa");
    expect(moving.title).toBe("Original");
    expect(row(moved.node).properties["title"]).toBe("Edited in Marfa");
    expect(rowsOf("github.issue")).toHaveLength(1);
    expect(
      github
        .writes()
        .every((one) => one.path.startsWith(`/repos/someone/target/`)),
    ).toBe(true);
    expect(github.writes()).not.toHaveLength(0);
  });

  it("keeps two issues with one title and one time apart", async () => {
    repositories(true);
    const at = "2026-01-01T00:00:00Z";
    const first = github.addIssue(source, {
      title: "Same",
      created_at: at,
      updated_at: at,
    });
    const second = github.addIssue(source, {
      title: "Same",
      created_at: at,
      updated_at: at,
    });
    await once();
    const firstId = row(first.node).id;
    const secondId = row(second.node).id;

    // Only the second moves, so the first, which answers 200, is not it.
    const movedSecond = github.transfer(second, target);
    await once();
    expect(row(movedSecond.node).id).toBe(secondId);
    expect(row(first.node).id).toBe(firstId);
    expect(row(first.node).state).toBe("active");

    // Both move: each follows its own address.
    const movedFirst = github.transfer(first, target);
    await once();
    expect(row(movedFirst.node).id).toBe(firstId);
    expect(row(movedSecond.node).id).toBe(secondId);
    expect(rowsOf("github.issue")).toHaveLength(2);
  });

  it("is not matched to a row by its title alone", async () => {
    repositories(true);
    const at = "2026-01-01T00:00:00Z";
    const stays = github.addIssue(source, {
      title: "Same",
      created_at: at,
      updated_at: at,
    });
    const other = github.addRepository("someone/third");
    const away = github.addIssue(other, {
      title: "Same",
      created_at: at,
      updated_at: at,
    });
    await once();
    // Neither repository's row answers with a move to the new issue.
    const moved: Issue = github.transfer(away, target);
    const stub = github.issues.find((one) => one.node === away.node);
    if (stub !== undefined) delete stub.movedTo;
    await once();
    // Its timeline shows a transfer from a repository Marfa holds a row of,
    // and no old address confirms it, so it waits.
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === moved.node),
    ).toBe(false);
    // Once a full window has passed with no proof, it is a new issue, and
    // not the row of either of the others that share its title and time.
    const state = marfa.states.get("github")?.["state"] as
      | {
          repositories?: Record<string, Record<string, Record<string, string>>>;
        }
      | undefined;
    const waiting = state?.repositories?.[target.node]?.["waiting"];
    if (waiting === undefined) throw new Error("nothing waits");
    waiting[moved.node] = earlier(3);
    await once();
    expect(row(stays.node).state).toBe("active");
    expect(rowsOf("github.issue").length).toBeGreaterThanOrEqual(3);
    expect(row(moved.node).id).not.toBe(row(stays.node).id);
  }, 120_000);
});

function conditions(): Record<string, string> {
  return Object.assign({}, ...marfa.problems.values()) as Record<
    string,
    string
  >;
}

/** A time well before the transfer window, as an old issue has. */
function earlier(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

describe("a transferred issue whose transfer record is late", () => {
  /** An issue made long ago, with a comment the App may carry back. */
  function oldIssue(title: string) {
    const moving = github.addIssue(source, {
      title,
      created_at: earlier(60),
    });
    const said = github.addComment(moving, "Said", "marfa-connectors[bot]");
    said.app = true;
    // A comment changes the issue; the issue was last changed long ago.
    moving.updated_at = earlier(59);
    return { moving, said };
  }

  it.each([
    ["opened, then transferred, the event missing", true, false],
    ["transferred, then opened, the event missing", false, false],
    ["opened, then transferred, the event shown first", true, true],
    ["transferred, then opened, the event shown first", false, true],
  ])(
    "stays one item, with its edits, when the webhooks arrive %s",
    async (_, openedFirst, showing) => {
      repositories(true);
      const { moving, said } = oldIssue("Original");
      await watching(async () => {
        const issueId = row(moving.node).id;
        const commentId = row(said.node).id;
        const moved = github.transfer(moving, target, {
          late: true,
          showing,
        });
        const sent = github.transferDeliveries(moving, moved);
        const delivered = async (action: "opened" | "transferred") => {
          const before = marfa.deliveries.length;
          deliver("issues", sent[action]);
          await until(
            () =>
              marfa.deliveries.length === before + 1 &&
              marfa.deliveries.every((one) => one.outcome === "processed"),
            "the delivery",
          );
        };
        if (openedFirst) {
          // GitHub has not recorded the transfer: the new issue waits.
          await delivered("opened");
          expect(
            marfa.rows.some(
              (one) => one.properties["github_id"] === moved.node,
            ),
          ).toBe(false);
          expect(rowsOf("github.issue")).toHaveLength(1);
        }
        github.settleTransfers();
        marfa.edit(issueId, { title: "Edited in Marfa" });
        marfa.edit(commentId, { body: "Comment edited in Marfa" });
        await delivered("transferred");
        if (!openedFirst) await delivered("opened");
        const copy = github.comments.find(
          (one) => one.issue === moved.node && one.deleted !== true,
        );
        await until(
          () => moved.title === "Edited in Marfa" && copy?.body !== "Said",
          "the edits to reach GitHub",
        );
        expect(
          rowsOf("github.issue").filter((one) => one.state === "active"),
        ).toHaveLength(1);
        expect(rowsOf("github.issue")).toHaveLength(1);
        expect(row(moved.node).id).toBe(issueId);
        expect(rowsOf("github.comment")).toHaveLength(1);
        expect(row(copy?.node ?? "").id).toBe(commentId);
        expect(copy?.body).toBe("Comment edited in Marfa");
        expect(conditions()).toEqual({});
      });
    },
    60_000,
  );

  it.each([
    ["the event missing", false],
    ["the event shown first", true],
  ])(
    "waits for the next scheduled run, then keeps the item and its comment, with %s",
    async (_, showing) => {
      repositories(false);
      const { moving, said } = oldIssue("Original");
      await once();
      const issueId = row(moving.node).id;
      const commentId = row(said.node).id;

      const moved = github.transfer(moving, target, { late: true, showing });
      await once();

      // Written by no run yet: no second row, and no copy of the comment.
      expect(rowsOf("github.issue")).toHaveLength(1);
      expect(rowsOf("github.comment")).toHaveLength(1);
      expect(marfa.byId(issueId).state).toBe("active");
      expect(conditions()).toEqual({});

      github.settleTransfers();
      marfa.edit(issueId, { title: "Edited in Marfa" });
      await once();

      expect(row(moved.node).id).toBe(issueId);
      expect(rowsOf("github.issue")).toHaveLength(1);
      expect(rowsOf("github.issue")[0]?.state).toBe("active");
      const copy = github.comments.find(
        (one) => one.issue === moved.node && one.deleted !== true,
      );
      expect(row(copy?.node ?? "").id).toBe(commentId);
      expect(rowsOf("github.comment")).toHaveLength(1);
      expect(moved.title).toBe("Edited in Marfa");
      expect(conditions()).toEqual({});

      const before = marfa.log.length;
      await once();
      expect(lastWrites(before)).toEqual([]);
    },
    120_000,
  );

  it("writes a new issue at once", async () => {
    repositories(true);
    await once();
    const fresh = github.addIssue(target, { title: "Brand new" });
    await once();
    expect(row(fresh.node).state).toBe("active");
    expect(row(fresh.node).properties["title"]).toBe("Brand new");
  });

  it.each([
    ["the target is read first", false],
    ["the source is read first", true],
  ])(
    "keeps both items, and says why, where the record lags past the window and %s",
    async (_, sourceFirst) => {
      repositories(sourceFirst);
      const { moving, said } = oldIssue("Original");
      await once();
      const olderId = row(moving.node).id;
      const olderComment = row(said.node).id;
      const moved = github.transfer(moving, target, { lagging: true });
      // Changed longer ago than the window: the wait is over.
      moved.updated_at = earlier(10);
      await once();

      if (sourceFirst) {
        // The old address is followed before the new issue is listed.
        expect(row(moved.node).id).toBe(olderId);
        expect(rowsOf("github.issue")).toHaveLength(1);
        expect(conditions()).toEqual({});
        return;
      }
      const copy = github.comments.find(
        (one) => one.issue === moved.node && one.deleted !== true,
      );
      const newerId = row(moved.node).id;
      const newerComment = row(copy?.node ?? "").id;
      expect(newerId).not.toBe(olderId);
      expect(rowsOf("github.issue").map((one) => one.state)).toEqual([
        "active",
        "active",
      ]);
      expect(marfa.byId(olderId).properties["github_id"]).toBe(moving.node);
      const issueCondition = conditions()[`duplicate:${olderId}`];
      expect(issueCondition).toContain(olderId);
      expect(issueCondition).toContain(newerId);
      expect(issueCondition).toContain("transferred");
      const commentCondition = conditions()[`duplicate:${olderComment}`];
      expect(commentCondition).toContain(olderComment);
      expect(commentCondition).toContain(newerComment);
      expect(rowsOf("github.comment").map((one) => one.state)).toEqual([
        "active",
        "active",
      ]);

      const before = marfa.log.length;
      await once();
      expect(lastWrites(before)).toEqual([]);
      expect(rowsOf("github.issue").map((one) => one.state)).toEqual([
        "active",
        "active",
      ]);
    },
    120_000,
  );

  /** The daily check is due again in every repository. */
  function checkDue(): void {
    const state = marfa.states.get("github")?.["state"] as
      { repositories?: Record<string, Record<string, unknown>> } | undefined;
    for (const repository of Object.values(state?.repositories ?? {})) {
      Reflect.deleteProperty(repository, "checked");
    }
  }

  async function duplicated() {
    repositories(false);
    const { moving, said } = oldIssue("Original");
    await once();
    const olderId = row(moving.node).id;
    const olderComment = row(said.node).id;
    const moved = github.transfer(moving, target, { lagging: true });
    moved.updated_at = earlier(10);
    await once();
    const copy = github.comments.find(
      (one) => one.issue === moved.node && one.deleted !== true,
    );
    const newerId = row(moved.node).id;
    const newerComment = row(copy?.node ?? "").id;
    expect(Object.keys(conditions()).sort()).toEqual(
      [`duplicate:${olderId}`, `duplicate:${olderComment}`].sort(),
    );
    return { olderId, newerId, olderComment, newerComment };
  }

  it("keeps the duplicate condition while both rows stand, or while only the newer is archived", async () => {
    const { olderId, newerId, olderComment } = await duplicated();
    checkDue();
    await once();
    expect(conditions()).toHaveProperty(`duplicate:${olderId}`);
    expect(conditions()).toHaveProperty(`duplicate:${olderComment}`);

    // The older row cannot take the newer issue's key, which its row holds,
    // so archiving the newer row resolves nothing.
    marfa.transition(newerId, "archived");
    checkDue();
    await once();
    expect(conditions()).toHaveProperty(`duplicate:${olderId}`);
    expect(marfa.byId(olderId).state).toBe("active");
  }, 120_000);

  it("clears the duplicate condition once the older rows are archived", async () => {
    const { olderId, newerId } = await duplicated();
    marfa.transition(olderId, "archived");
    checkDue();
    await once();
    expect(
      Object.keys(conditions()).filter((key) => key.startsWith("duplicate:")),
    ).toEqual([]);
    expect(marfa.byId(newerId).state).toBe("active");
    expect(marfa.byId(olderId).state).toBe("archived");
  }, 120_000);

  it("clears a moved, missing or duplicate condition whose cause is gone, and keeps one it did not check", async () => {
    repositories(true);
    const issue = github.addIssue(source, { title: "Fine" });
    const comment = github.addComment(issue, "Said", "alice");
    await once();
    marfa.problems.set("github", {
      [`issue-moved:${issue.node}`]: "moved, though it answers",
      [`issue-missing:${issue.node}`]: "missing, though it answers",
      [`duplicate:${row(issue.node).id}`]: "a duplicate, though it is not",
      [`duplicate:${row(comment.node).id}`]: "a comment duplicate",
      "issue-missing:I_unknown": "an issue this read never held",
      "duplicate:unknown-row": "a row this read never held",
    });
    checkDue();
    await once();
    expect(conditions()).toEqual({
      "issue-missing:I_unknown": "an issue this read never held",
      "duplicate:unknown-row": "a row this read never held",
    });
  }, 120_000);

  it("keeps the edit of a comment waiting after its issue moved, and archives no issue it was not told of", async () => {
    repositories(true);
    const { moving, said } = oldIssue("Original");
    await watching(async () => {
      const issueId = row(moving.node).id;
      const commentId = row(said.node).id;
      const moved = github.transfer(moving, target);
      // The only thing that names the old comment is the edit waiting in it.
      marfa.edit(commentId, { body: "Comment edited in Marfa" });
      const copy = github.comments.find(
        (one) => one.issue === moved.node && one.deleted !== true,
      );
      await until(
        () => copy?.body === "Comment edited in Marfa",
        "the edit to reach GitHub",
      );
      expect(row(copy?.node ?? "").id).toBe(commentId);
      expect(row(copy?.node ?? "").state).toBe("active");
      expect(row(moved.node).id).toBe(issueId);
      expect(rowsOf("github.issue")).toHaveLength(1);
      expect(rowsOf("github.comment")).toHaveLength(1);
      expect(conditions()).toEqual({});
    });
  }, 60_000);

  it("does not say it archived an issue it was not told of", async () => {
    repositories(true);
    const outside = github.addRepository("stranger/private", {
      installation: 99,
      private: true,
    });
    const { moving, said } = oldIssue("Leaving");
    await watching(async () => {
      const issueId = row(moving.node).id;
      const commentId = row(said.node).id;
      const runs = marfa.runs.length;
      github.transfer(moving, outside);
      marfa.edit(commentId, { body: "Comment edited in Marfa" });
      // The run's conditions are recorded when it ends.
      await until(
        () =>
          marfa.byId(commentId).state === "archived" &&
          marfa.runs.length > runs,
        "the comment row to be archived and the run to end",
      );
      expect(marfa.byId(issueId).state).toBe("active");
      expect(
        Object.keys(conditions()).filter((one) => one.startsWith("issue-")),
      ).toEqual([]);
    });
  }, 60_000);

  it.each([
    ["opened", "the transfer check"],
    ["opened", "the old address"],
    ["transferred", "the old address"],
  ] as const)(
    "writes no new row for an issue a %s delivery names while a rate limit stops %s",
    async (action, limited) => {
      repositories(true);
      const { moving, said } = oldIssue("Original");
      let issueId = "";
      let commentId = "";
      let moved: Issue | undefined;
      await watching(async () => {
        issueId = row(moving.node).id;
        commentId = row(said.node).id;
        const copy = github.transfer(moving, target);
        moved = copy;
        const address = `/repos/someone/source/issues/${String(moving.number)}`;
        github.onAsked = (asked) => {
          if (
            limited === "the transfer check" &&
            asked.path === "/graphql" &&
            JSON.stringify(asked.body).includes("query Transfers")
          ) {
            github.exhaust("graphql");
          }
          if (limited === "the old address" && asked.path === address) {
            github.exhaust("core");
          }
        };
        const runs = marfa.runs.length;
        deliver("issues", github.transferDeliveries(moving, copy)[action]);
        await until(
          () => github.asked.some((one) => one.limited === true),
          "the rate limit",
        );
        await until(() => marfa.runs.length > runs, "the run to end");

        expect(
          marfa.rows.some((one) => one.properties["github_id"] === copy.node),
        ).toBe(false);
        expect(rowsOf("github.issue")).toHaveLength(1);
        expect(rowsOf("github.comment")).toHaveLength(1);
      });

      // The delivery is kept, and read again once the budget is back.
      github.onAsked = undefined;
      github.refill("graphql");
      github.refill("core");
      await once();
      const node = moved?.node ?? "";
      expect(row(node).id).toBe(issueId);
      expect(rowsOf("github.issue")).toHaveLength(1);
      expect(
        row(
          github.comments.find(
            (one) => one.issue === node && one.deleted !== true,
          )?.node ?? "",
        ).id,
      ).toBe(commentId);
      expect(rowsOf("github.comment")).toHaveLength(1);
    },
    60_000,
  );

  it("archives the row of an issue that moved out of reach, with its true reason", async () => {
    repositories(true);
    const moving = github.addIssue(source, { title: "Leaving" });
    const outside = github.addRepository("stranger/private", {
      installation: 99,
      private: true,
    });
    await watching(async () => {
      const id = row(moving.node).id;
      const moved = github.transfer(moving, outside);
      deliver("issues", github.transferDeliveries(moving, moved).transferred);
      await until(
        () =>
          marfa.byId(id).state === "archived" &&
          conditions()[`issue-moved:${moving.node}`] !== undefined,
        "the row to be archived and the condition raised",
      );
      const gone = Object.entries(conditions()).filter(([key]) =>
        key.startsWith("issue-"),
      );
      expect(gone.map(([key]) => key)).toEqual([`issue-moved:${moving.node}`]);
      expect(gone[0]?.[1]).toContain("a repository the App cannot read");
    });
  }, 60_000);
});

describe("an issue that waits for its transfer record on a first sync", () => {
  function waited(): Record<string, string> | undefined {
    const state = marfa.states.get("github")?.["state"] as
      { repositories?: Record<string, Record<string, unknown>> } | undefined;
    return state?.repositories?.[source.node]?.["waiting"] as
      Record<string, string> | undefined;
  }

  function listed(): Record<string, unknown> {
    const state = marfa.states.get("github")?.["state"] as
      { repositories?: Record<string, Record<string, unknown>> } | undefined;
    return state?.repositories?.[source.node] ?? {};
  }

  function commentReads(): number {
    return github.asked.filter((one) =>
      /\/issues\/\d+\/comments$/.test(one.path),
    ).length;
  }

  it("records the listing as read, waits one window at most, then writes it as a new issue", async () => {
    repositories(true);
    const quiet = github.addIssue(source, { title: "Quiet" });
    github.addComment(quiet, "Hello", "alice");
    const busy = github.addIssue(source, {
      title: "Busy",
      created_at: earlier(60),
    });
    github.addComment(busy, "Said", "alice");
    const touch = (): void => {
      busy.updated_at = earlier(0.5);
    };
    touch();

    await once();
    expect(row(quiet.node).state).toBe("active");
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === busy.node),
    ).toBe(false);
    expect(Object.keys(waited() ?? {})).toEqual([busy.node]);
    expect(listed()["open"]).toBeDefined();

    // Another change inside the window: it keeps waiting, and nothing already
    // read is read again.
    touch();
    github.asked = [];
    await once();
    expect(
      marfa.rows.some((one) => one.properties["github_id"] === busy.node),
    ).toBe(false);
    expect(commentReads()).toBe(0);

    // A full window on, with no proof of a transfer: it is a new issue.
    const first = waited();
    if (first === undefined) throw new Error("nothing waits");
    first[busy.node] = earlier(3);
    touch();
    await once();
    expect(row(busy.node).state).toBe("active");
    expect(rowsOf("github.issue")).toHaveLength(2);
    expect(rowsOf("github.comment")).toHaveLength(2);
    expect(waited()).toBeUndefined();

    const before = marfa.log.length;
    await once();
    expect(lastWrites(before)).toEqual([]);
  }, 120_000);
});
