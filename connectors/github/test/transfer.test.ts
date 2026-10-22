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
    expect(output).toContain("was moved to another repository");
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
    const first = github.addIssue(source, { title: "Same", created_at: at });
    const second = github.addIssue(source, { title: "Same", created_at: at });
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
    const stays = github.addIssue(source, { title: "Same", created_at: at });
    const other = github.addRepository("someone/third");
    const away = github.addIssue(other, { title: "Same", created_at: at });
    await once();
    // Neither repository's row answers with a move to the new issue.
    const moved: Issue = github.transfer(away, target);
    const stub = github.issues.find((one) => one.node === away.node);
    if (stub !== undefined) delete stub.movedTo;
    await once();
    expect(row(stays.node).state).toBe("active");
    expect(rowsOf("github.issue").length).toBeGreaterThanOrEqual(2);
    expect(row(moved.node).id).not.toBe(row(stays.node).id);
  });
});
