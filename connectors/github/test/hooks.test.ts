import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Delivery } from "@withmarfa/connector";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { hints } from "../src/hooks.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const secret = "github-test-webhook-secret";

let key: string;
let marfa: ScriptedServer;
let github: GitHubStub;

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
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

function env(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    ...extra,
    PATH: process.env["PATH"],
    MARFA_URL: marfa.url,
    MARFA_KEY: marfa.key,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: key,
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_API_URL: github.url,
  };
}

async function once(): Promise<void> {
  await run("node", [built, "--once"], { env: env() });
}

/** A delivery as GitHub posts one, signed with `signedWith`. */
function deliver(
  event: string,
  payload: Record<string, unknown>,
  signedWith = secret,
): void {
  const body = JSON.stringify(payload);
  marfa.deliver(body, [
    ["Content-Type", "application/json"],
    ["X-GitHub-Event", event],
    ["X-GitHub-Delivery", crypto.randomUUID()],
    [
      "X-Hub-Signature-256",
      `sha256=${createHmac("sha256", signedWith).update(body).digest("hex")}`,
    ],
  ]);
}

function row(link: string) {
  const found = marfa.rows.find((one) => one.properties["github_id"] === link);
  if (found === undefined) throw new Error(`no row holds ${link}`);
  return found;
}

async function until(holds: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Runs the connector on its schedule, taking deliveries every second,
 *  while `body` acts, from the end of its first run. */
async function watching(
  body: () => Promise<void>,
  extra: Record<string, string> = {},
): Promise<void> {
  const child = spawn("node", [built, "--every", "1h", "--look-every", "1s"], {
    env: env(extra),
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

function kept(): unknown {
  return structuredClone(marfa.states.get("github")?.["state"]);
}

function listings(): string[] {
  return github.asked
    .filter((one) => one.method === "GET" && one.path.startsWith("/repos/"))
    .map((one) => one.path);
}

describe("a delivery's hints", () => {
  const delivery = (event: string, payload: unknown): Delivery => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    return {
      id: "d",
      endpointId: "e",
      receivedAt: "2026-09-29T00:00:00Z",
      headers: [["X-GitHub-Event", event]],
      header: (name) =>
        name.toLowerCase() === "x-github-event" ? event : undefined,
      query: "",
      body,
    };
  };

  it("name the issues and comments each event carries, by node id", () => {
    expect(
      hints(
        delivery("issues", {
          action: "transferred",
          issue: { node_id: "I_1" },
          changes: { new_issue: { node_id: "I_2" } },
        }),
      ),
    ).toEqual([
      { type: "github.issue", id: "I_1" },
      { type: "github.issue", id: "I_2" },
    ]);
    expect(
      hints(
        delivery("issue_comment", {
          action: "deleted",
          comment: { node_id: "IC_1" },
          issue: { node_id: "I_1" },
        }),
      ),
    ).toEqual([
      { type: "github.comment", id: "IC_1" },
      { type: "github.issue", id: "I_1" },
    ]);
    expect(
      hints(
        delivery("sub_issues", {
          action: "sub_issue_added",
          sub_issue: { node_id: "I_1" },
          parent_issue: { node_id: "I_2" },
        }),
      ),
    ).toEqual([
      { type: "github.issue", id: "I_1" },
      { type: "github.issue", id: "I_2" },
    ]);
    expect(
      hints(
        delivery("issue_dependencies", {
          action: "blocked_by_removed",
          blocked_issue: { node_id: "I_1" },
          blocking_issue: { node_id: "I_2" },
        }),
      ),
    ).toEqual([
      { type: "github.issue", id: "I_1" },
      { type: "github.issue", id: "I_2" },
    ]);
  });

  it("name nothing for a pull request's comment or an event not read", () => {
    expect(
      hints(
        delivery("issue_comment", {
          comment: { node_id: "IC_1" },
          issue: { node_id: "PR_1", pull_request: {} },
        }),
      ),
    ).toEqual([]);
    expect(hints(delivery("ping", { zen: "Keep it simple" }))).toEqual([]);
  });

  it("ask for everything where what is synced changed", () => {
    for (const event of [
      "installation",
      "installation_repositories",
      "repository",
    ]) {
      expect(hints(delivery(event, {}))).toBe("everything");
    }
  });
});

describe("a delivery", () => {
  it("signed with the App's webhook secret is processed, and one signed otherwise rejected", async () => {
    github.addRepository("someone/tracker");
    deliver("ping", { zen: "Speak like a human" });
    deliver("ping", { zen: "Forged" }, "a guess");
    await once();
    expect(marfa.deliveries.map((one) => one.outcome)).toEqual([
      "processed",
      "rejected",
    ]);
  });
});

describe("a run for deliveries", () => {
  it("writes an issue edited on GitHub within seconds, asking GitHub for it by node id alone, and leaves the cursors as they were", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, { title: "Before" });
    const other = github.addIssue(repository, { title: "Untouched" });
    await watching(async () => {
      // The first run for deliveries also reads what the scheduled run wrote.
      deliver("ping", {});
      await until(() => marfa.runs.length > 1, "the first run for deliveries");
      const before = kept();
      github.asked.length = 0;
      github.edit(issue, { title: "After" });
      github.edit(other, { title: "Not named" });
      deliver("issues", { action: "edited", issue: { node_id: issue.node } });
      await until(
        () => row(issue.node).properties["title"] === "After",
        "the edit being written",
      );
      expect(row(other.node).properties["title"]).toBe("Untouched");
      expect(listings()).toEqual([]);
      expect(kept()).toEqual(before);
    });
  });

  it("writes a comment made on GitHub into its issue's thread, and the issue's new activity with it", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await watching(async () => {
      const comment = github.addComment(issue, "Seen on GitHub");
      deliver("issue_comment", {
        action: "created",
        comment: { node_id: comment.node },
        issue: { node_id: issue.node },
      });
      // Connections are written as the run ends, after its rows.
      await until(
        () =>
          marfa.rows.some(
            (one) =>
              one.properties["github_id"] === comment.node &&
              marfa.targetsOf(one.id, "in-thread").length > 0,
          ),
        "the comment being written in its thread",
      );
      expect(
        marfa
          .targetsOf(row(comment.node).id, "in-thread")
          .map((id) => marfa.byId(id).properties["github_id"]),
      ).toEqual([issue.node]);
      expect(row(issue.node).properties["github_updated_at"]).toBe(
        issue.updated_at,
      );
    });
  });

  it("draws a sub-issue drawn on GitHub, with a parent Marfa did not hold", async () => {
    const repository = github.addRepository("someone/tracker");
    const parent = github.addIssue(repository, {
      title: "Old parent",
      state: "closed",
      state_reason: "completed",
      closed_at: github.ago(200),
      updated_at: github.ago(200),
    });
    const child = github.addIssue(repository);
    await watching(async () => {
      expect(
        marfa.rows.some((one) => one.properties["github_id"] === parent.node),
      ).toBe(false);
      child.parent = parent.node;
      deliver("sub_issues", {
        action: "parent_issue_added",
        sub_issue: { node_id: child.node },
        parent_issue: { node_id: parent.node },
      });
      await until(
        () =>
          marfa.rows.some(
            (one) =>
              one.properties["github_id"] === child.node &&
              marfa.targetsOf(one.id, "github.sub-issue-of").length === 1,
          ),
        "the parent being drawn",
      );
      expect(row(parent.node).properties["title"]).toBe("Old parent");
    });
  });

  it("archives a comment and an issue GitHub deleted, and leaves one GitHub still has", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const kept = github.addIssue(repository);
    const comment = github.addComment(kept, "Deleted soon");
    await watching(async () => {
      issue.deleted = true;
      comment.deleted = true;
      deliver("issues", { action: "deleted", issue: { node_id: issue.node } });
      deliver("issue_comment", {
        action: "deleted",
        comment: { node_id: comment.node },
        issue: { node_id: kept.node },
      });
      await until(
        () =>
          row(issue.node).state === "archived" &&
          row(comment.node).state === "archived",
        "the deletions being archived",
      );
      expect(row(kept.node).state).toBe("active");
    });
  });

  it("carries an edit made in Marfa between scheduled runs, reading only that issue first", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository, { title: "On GitHub" });
    await watching(async () => {
      deliver("ping", {});
      await until(() => marfa.runs.length > 1, "the first run for deliveries");
      github.asked.length = 0;
      marfa.edit(row(issue.node).id, { title: "Edited in Marfa" });
      await until(
        () => issue.title === "Edited in Marfa",
        "the edit being carried",
      );
      expect(
        listings().filter(
          (path) => !path.endsWith(`/issues/${String(issue.number)}`),
        ),
      ).toEqual([]);
    });
  });

  it("changes nothing where a named issue's installation lost access", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    await watching(async () => {
      const runs = marfa.runs.length;
      const [installation] = github.installations;
      if (installation !== undefined) installation.lost = true;
      deliver("issues", { action: "edited", issue: { node_id: issue.node } });
      await until(() => marfa.runs.length > runs, "the run for it");
      expect(row(issue.node).state).toBe("active");
    });
  });
});

describe("what the webhooks review found", () => {
  it("leaves a named comment where its repository is listed but does not read", async () => {
    const repository = github.addRepository("someone/tracker");
    const issue = github.addIssue(repository);
    const comment = github.addComment(issue, "Still here");
    await watching(async () => {
      const runs = marfa.runs.length;
      repository.hidden = true;
      deliver("issue_comment", {
        action: "edited",
        comment: { node_id: comment.node },
        issue: { node_id: issue.node },
      });
      await until(() => marfa.runs.length > runs, "the run for it");
      expect(row(comment.node).state).toBe("active");
      expect(row(issue.node).state).toBe("active");
    });
  });

  it("writes an issue named in a repository added since the last whole read under that repository", async () => {
    github.addRepository("someone/tracker");
    await watching(async () => {
      const runs = marfa.runs.length;
      const added = github.addRepository("someone/added");
      const issue = github.addIssue(added, { title: "New" });
      deliver("issues", { action: "opened", issue: { node_id: issue.node } });
      await until(() => marfa.runs.length > runs, "the run for it");
      expect(
        marfa.targetsOf(row(issue.node).id, "github.in-repository"),
      ).toEqual([row(added.node).id]);
    });
  });

  it("asks Marfa nothing more where a named parent sits outside the sync", async () => {
    const repositories = Array.from({ length: 5 }, (_, n) =>
      github.addRepository(`someone/r${String(n)}`),
    );
    const outside = github.addRepository("stranger/public", {
      installation: 99,
      private: false,
    });
    const parent = github.addIssue(outside);
    const [first] = repositories;
    if (first === undefined) throw new Error("no repository");
    const child = github.addIssue(first);
    await watching(async () => {
      deliver("ping", {});
      await until(() => marfa.runs.length > 1, "the first run for deliveries");
      const runs = marfa.runs.length;
      const before = marfa.requests.length;
      child.parent = parent.node;
      deliver("sub_issues", {
        action: "parent_issue_added",
        sub_issue: { node_id: child.node },
        parent_issue: { node_id: parent.node },
      });
      await until(() => marfa.runs.length > runs, "the run for it");
      const linked = marfa.requests
        .slice(before)
        .filter(
          (one) =>
            one.method === "GET" &&
            one.path === "/items" &&
            [...one.query.keys()].some((key) => key.startsWith("edge")),
        );
      expect(linked).toEqual([]);
      expect(String(row(child.node).properties["parent_url"])).toContain(
        "stranger/public/issues/",
      );
    });
  });
});

describe("a delivery for a repository GITHUB_REPOSITORIES leaves out", () => {
  it("writes nothing", async () => {
    github.addRepository("someone/tracker");
    const outside = github.addRepository("someone/elsewhere");
    await watching(
      async () => {
        const runs = marfa.runs.length;
        const issue = github.addIssue(outside, { title: "Left out" });
        deliver("issues", { action: "opened", issue: { node_id: issue.node } });
        await until(() => marfa.runs.length > runs, "the run for it");
        expect(
          marfa.rows.some((one) => one.properties["github_id"] === issue.node),
        ).toBe(false);
      },
      { GITHUB_REPOSITORIES: "someone/tracker" },
    );
  });
});
