import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  appKey,
  GitHubStub,
  type Repository,
} from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "github_pat_stars_12345678";
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
  "in-thread",
  "in-collection",
  "references",
];

let key: string;
let marfa: ScriptedServer;
let github: GitHubStub;
/** The repositories the token lists as the person's own; any other it
 *  reaches only as a star. */
const reach = new Set<string>();

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
  github.personalToken = token;
  reach.clear();
  github.personalRepositories = new Set();
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

async function exec(
  env: Record<string, string>,
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
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

async function sync(extra: Record<string, string> = {}): Promise<string> {
  const result = await exec({ GITHUB_PERSONAL_TOKEN: token, ...extra });
  expect(result.code, result.output).toBe(0);
  return result.output;
}

async function syncWithApp(): Promise<string> {
  const result = await exec({
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: key,
    GITHUB_WEBHOOK_SECRET: "github-test-webhook-secret",
  });
  expect(result.code, result.output).toBe(0);
  return result.output;
}

function repositoryRow(repository: Repository) {
  const found = marfa.rows.find(
    (one) =>
      one.type === "github.repository" &&
      one.properties["github_id"] === repository.node,
  );
  if (found === undefined) throw new Error(`no row for ${repository.node}`);
  return found;
}

function held(repository: Repository) {
  return marfa.rows.find(
    (one) =>
      one.type === "github.repository" &&
      one.properties["github_id"] === repository.node,
  );
}

function listed(name: string, fields: Partial<Repository> = {}): Repository {
  const repository = github.addRepository(name, fields);
  reach.add(repository.node);
  github.personalRepositories = new Set(reach);
  return repository;
}

function unlist(repository: Repository): void {
  reach.delete(repository.node);
  github.personalRepositories = new Set(reach);
}

/** A repository the person has starred and no token collaborates on. */
function starOnly(name: string, fields: Partial<Repository> = {}) {
  const repository = github.addRepository(name, { private: false, ...fields });
  github.star(repository);
  return repository;
}

function starRequests(): number {
  return github.asked.filter((one) => one.path === "/user/starred").length;
}

function conditions(): Record<string, string> {
  return marfa.problems.get("github") ?? {};
}

function checks(name: string): number {
  return github.asked.filter((one) => one.path === `/repos/${name}`).length;
}

function changes(since: number): string[] {
  return marfa.log.slice(since).map((one) => one.event);
}

describe("starred repositories", { timeout: 60_000 }, () => {
  it("leaves every mark and row alone, and asks for no star, where GITHUB_STARS is false", async () => {
    const starred = starOnly("someone/starred");
    const tracker = listed("someone/tracker");
    github.star(tracker);
    await sync();
    expect(starRequests()).toBe(1);
    const at = repositoryRow(tracker).properties["starred_at"];
    expect(repositoryRow(starred).properties["starred"]).toBe(true);

    // Another process owns these stars now: this one's token lists none of them.
    github.unstar(starred);
    github.unstar(tracker);
    const before = marfa.log.length;
    for (let run = 0; run < 3; run += 1) await sync({ GITHUB_STARS: "false" });
    expect(starRequests()).toBe(1);
    expect(checks("someone/starred")).toBe(0);
    expect(repositoryRow(starred).state).toBe("active");
    expect(repositoryRow(starred).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).properties["starred_at"]).toBe(at);
    expect(conditions()).not.toHaveProperty("stars-unreadable");
    expect(changes(before)).not.toContain("item.state_changed");

    // The witness: the same world, read with stars on, does unmark and archive.
    await sync();
    await sync();
    expect(repositoryRow(starred).state).toBe("archived");
    expect(repositoryRow(tracker).properties["starred"]).toBe(false);
  });

  it("only unmarks a repository another process syncs, and archives only a row nothing syncs", async () => {
    // Process B syncs the organization with its own token and reads no stars;
    // process A reads the person's stars with a key that claims the source.
    const other = "github_pat_withmarfa_12345678";
    const synced = github.addRepository("org/x", { private: false });
    const issue = github.addIssue(synced);
    const own = github.addRepository("someone/own");
    const only = starOnly("someone/only");
    // Star-only under A first, then taken up by B.
    const later = starOnly("org/later");
    github.star(synced);
    const bSyncs = [synced];
    const asB = async (): Promise<void> => {
      marfa.keySource = "github";
      marfa.grants = {
        metadata_permissions: { types: "write", edge_types: "write" },
      };
      github.personalToken = other;
      github.personalRepositories = new Set(bSyncs.map((one) => one.node));
      const result = await exec({
        GITHUB_PERSONAL_TOKEN: other,
        GITHUB_REPOSITORIES: bSyncs
          .map((one) => `${one.owner}/${one.name}`)
          .join(","),
        GITHUB_STARS: "false",
      });
      expect(result.code, result.output).toBe(0);
    };
    const asA = async (): Promise<void> => {
      marfa.keySource = "github-someone";
      marfa.grants = {
        sources: ["github"],
        metadata_permissions: { types: "write", edge_types: "write" },
      };
      github.personalToken = token;
      github.personalRepositories = new Set([own.node]);
      const result = await exec({
        GITHUB_PERSONAL_TOKEN: token,
        GITHUB_REPOSITORIES: "someone/own",
      });
      expect(result.code, result.output).toBe(0);
    };
    await asB();
    await asA();
    expect(repositoryRow(synced).properties["starred"]).toBe(true);
    expect(repositoryRow(only).properties["starred"]).toBe(true);
    expect(repositoryRow(later).properties["synced"]).toBe(false);
    bSyncs.push(later);
    await asB();
    await asA();
    expect(repositoryRow(synced).properties["starred"]).toBe(true);
    expect(repositoryRow(later).properties["starred"]).toBe(true);
    expect(repositoryRow(later).properties["synced"]).toBe(true);
    const issueRow = marfa.rows.find(
      (one) => one.properties["github_id"] === issue.node,
    );
    if (issueRow === undefined) throw new Error("no issue row");

    github.unstar(synced);
    github.unstar(only);
    github.unstar(later);
    await asA();
    await asB();
    await asA();
    await asA();
    await asB();
    const row = repositoryRow(synced);
    expect(row.state).toBe("active");
    expect(row.properties["starred"]).toBe(false);
    expect(row.properties["synced"]).toBe(true);
    expect(marfa.byId(issueRow.id).state).toBe("active");
    expect(marfa.targetsOf(issueRow.id, "github.in-repository")).toEqual([
      row.id,
    ]);
    expect(repositoryRow(later).state).toBe("active");
    expect(repositoryRow(later).properties["starred"]).toBe(false);
    expect(repositoryRow(later).properties["synced"]).toBe(true);
    // The witness: a star-only row in the same world is archived.
    expect(repositoryRow(only).state).toBe("archived");
    expect(repositoryRow(only).properties["synced"]).toBe(false);
  });

  it("starts the count of misses again after a scheduled run that lists no stars", async () => {
    for (const between of [
      { GITHUB_STARS: "false" },
      { failing: "true" },
    ] as const) {
      const repository = starOnly(
        `someone/starred-${String(marfa.rows.length)}`,
      );
      await sync();
      github.unstar(repository);
      await sync();
      if ("failing" in between) {
        github.starsFailAt = { page: 1, status: 403 };
        await sync();
        github.starsFailAt = undefined;
      } else {
        await sync(between);
      }
      await sync();
      expect(repositoryRow(repository).state).toBe("active");
      expect(repositoryRow(repository).properties["starred"]).toBe(true);
      // The witness: one more listing that lacks it is the second miss.
      await sync();
      expect(repositoryRow(repository).state).toBe("archived");
    }
  });

  it("refuses a GITHUB_STARS that is not true or false", async () => {
    const result = await exec({
      GITHUB_PERSONAL_TOKEN: token,
      GITHUB_STARS: "no",
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("GITHUB_STARS must be true or false");
  });

  it("reads every page of stars, as repository rows marked starred and stamped", async () => {
    const stars = Array.from({ length: 205 }, (_, at) =>
      starOnly(`someone/starred-${String(at)}`),
    );
    await sync();
    expect(starRequests()).toBe(3);
    expect(
      marfa.rows.filter((one) => one.type === "github.repository"),
    ).toHaveLength(205);
    for (const repository of [stars[0], stars[100], stars[204]]) {
      if (repository === undefined) throw new Error("no star");
      const row = repositoryRow(repository);
      expect(row.state).toBe("active");
      expect(row.properties["starred"]).toBe(true);
      expect(row.properties["starred_at"]).toBe(
        github.stars.get(repository.node),
      );
      expect(row.properties["name"]).toBe(
        `${repository.owner}/${repository.name}`,
      );
    }
  }, 60_000);

  it("brings in a star-only repository as a repository row only", async () => {
    const repository = starOnly("someone/starred");
    github.addIssue(repository);
    github.addPullRequest(repository);
    await sync();
    expect(repositoryRow(repository).properties["starred"]).toBe(true);
    expect(
      marfa.rows.filter((one) => one.type !== "github.repository"),
    ).toEqual([]);
    expect(
      github.asked.filter((one) =>
        one.path.startsWith("/repos/someone/starred"),
      ),
    ).toEqual([]);
    expect(github.asked.filter((one) => one.path === "/graphql")).toEqual([]);
  });

  it("leaves out a private star the token cannot see, and shows it once the token can", async () => {
    const tracker = listed("someone/tracker");
    const secret = github.addRepository("someone/secret", { private: true });
    github.star(tracker);
    github.star(secret);
    await sync();
    expect(held(secret)).toBeUndefined();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);

    reach.add(secret.node);
    github.personalRepositories = new Set(reach);
    await sync();
    expect(repositoryRow(secret).properties["starred"]).toBe(true);
  });

  it("marks a repository both starred and listed, once, and still syncs its issues", async () => {
    const tracker = listed("someone/tracker");
    const issue = github.addIssue(tracker, { title: "Open" });
    github.star(tracker);
    await sync();
    const rows = marfa.rows.filter(
      (one) =>
        one.type === "github.repository" &&
        one.properties["github_id"] === tracker.node,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties["starred"]).toBe(true);
    expect(rows[0]?.properties["starred_at"]).toBe(
      github.stars.get(tracker.node),
    );
    expect(
      marfa.rows.find((one) => one.properties["github_id"] === issue.node)
        ?.properties["title"],
    ).toBe("Open");
  });

  it("marks a synced repository that is not starred as not starred", async () => {
    const tracker = listed("someone/tracker");
    await sync();
    const row = repositoryRow(tracker);
    expect(row.properties["starred"]).toBe(false);
    expect(row.properties["starred_at"] ?? null).toBeNull();
  });

  it("refuses an archive retried after a conflict, once another process has marked the row synced", async () => {
    const taken = starOnly("org/taken");
    const witness = starOnly("someone/witness");
    await sync();
    const id = repositoryRow(taken).id;

    github.unstar(taken);
    github.unstar(witness);
    await sync();
    // Another process takes the repository up between this run's last read
    // of the row and its archive, so the archive meets a version conflict.
    let raced = false;
    marfa.beforeAnswer = (request) => {
      if (
        !raced &&
        request.method === "POST" &&
        request.path.endsWith(`/${id}/transition`)
      ) {
        raced = true;
        marfa.edit(id, { synced: true });
      }
    };
    await sync();
    marfa.beforeAnswer = undefined;
    expect(raced).toBe(true);
    expect(repositoryRow(taken).state).toBe("active");
    expect(repositoryRow(taken).properties["synced"]).toBe(true);
    // The witness: a star-only row in the same run is archived.
    expect(repositoryRow(witness).state).toBe("archived");
  });

  it("archives a star-only repository when it is unstarred, and the same row returns when it is starred again", async () => {
    const repository = starOnly("someone/starred");
    const other = starOnly("someone/kept");
    await sync();
    const id = repositoryRow(repository).id;

    github.unstar(repository);
    await sync();
    expect(repositoryRow(repository).state).toBe("active");
    await sync();
    expect(repositoryRow(repository).state).toBe("archived");
    expect(repositoryRow(other).state).toBe("active");

    github.star(repository);
    await sync();
    const back = repositoryRow(repository);
    expect(back.id).toBe(id);
    expect(back.state).toBe("active");
    expect(back.properties["starred"]).toBe(true);
    expect(
      marfa.rows.filter(
        (one) =>
          one.type === "github.repository" &&
          one.properties["github_id"] === repository.node,
      ),
    ).toHaveLength(1);
  });

  it("marks a synced repository unstarred without archiving anything", async () => {
    const tracker = listed("someone/tracker");
    const issue = github.addIssue(tracker);
    github.star(tracker);
    await sync();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);

    const at = repositoryRow(tracker).properties["starred_at"];
    github.unstar(tracker);
    await sync();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).properties["starred_at"]).toBe(at);
    await sync();
    const row = repositoryRow(tracker);
    expect(row.state).toBe("active");
    expect(row.properties["starred"]).toBe(false);
    expect(row.properties["starred_at"] ?? null).toBeNull();
    expect(
      marfa.rows.find((one) => one.properties["github_id"] === issue.node)
        ?.state,
    ).toBe("active");
  });

  it("counts only complete listings in a row: a failed page neither archives nor counts as a miss", async () => {
    const stars = Array.from({ length: 105 }, (_, at) =>
      starOnly(`someone/starred-${String(at)}`),
    );
    await sync();
    const [gone, fresh] = [stars[0], starOnly("someone/new")];
    if (gone === undefined) throw new Error("no star");
    github.unstar(gone);

    github.starsFailAt = { page: 2, status: 403 };
    const output = await sync();
    expect(output).toContain("starred repositories");
    expect(conditions()).toHaveProperty("stars-unreadable");
    expect(repositoryRow(gone).state).toBe("active");
    expect(repositoryRow(gone).properties["starred"]).toBe(true);
    expect(held(fresh)).toBeUndefined();

    github.starsFailAt = undefined;
    await sync();
    expect(conditions()).not.toHaveProperty("stars-unreadable");
    expect(repositoryRow(gone).state).toBe("active");
    expect(repositoryRow(fresh).properties["starred"]).toBe(true);

    github.starsFailAt = { page: 2, status: 403 };
    await sync();
    expect(repositoryRow(gone).state).toBe("active");

    // The failed listing broke the run of complete ones, so this is the
    // first miss again, and the next is the second.
    github.starsFailAt = undefined;
    await sync();
    expect(repositoryRow(gone).state).toBe("active");
    await sync();
    expect(repositoryRow(gone).state).toBe("archived");
    expect(
      marfa.rows.filter(
        (one) => one.type === "github.repository" && one.state === "archived",
      ),
    ).toHaveLength(1);
  }, 90_000);

  it("keeps a star missed once, and forgets the miss when the star is listed again", async () => {
    const repository = starOnly("someone/starred");
    const tracker = listed("someone/tracker");
    github.star(tracker);
    await sync();

    github.unstar(repository);
    github.unstar(tracker);
    await sync();
    expect(repositoryRow(repository).state).toBe("active");
    expect(repositoryRow(repository).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);

    github.star(repository);
    github.star(tracker);
    await sync();
    github.unstar(repository);
    github.unstar(tracker);
    await sync();
    expect(repositoryRow(repository).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);

    await sync();
    expect(repositoryRow(repository).state).toBe("archived");
    expect(repositoryRow(tracker).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(false);
  }, 90_000);

  it("reads the repository before it archives a star, and archives on a 404 or a 200", async () => {
    const hidden = starOnly("someone/hidden");
    const open = starOnly("someone/open");
    await sync();
    github.unstar(hidden);
    github.unstar(open);
    hidden.hidden = true;
    await sync();
    expect(checks("someone/hidden")).toBe(0);
    expect(checks("someone/open")).toBe(0);

    await sync();
    expect(checks("someone/hidden")).toBe(1);
    expect(checks("someone/open")).toBe(1);
    expect(repositoryRow(hidden).state).toBe("archived");
    expect(repositoryRow(open).state).toBe("archived");
    expect(conditions()).not.toHaveProperty("stars-kept");
  });

  it("keeps a star-only row, and names the repository and the answer, when its owner refuses the token", async () => {
    const refusing = starOnly("someone/refusing");
    const other = starOnly("someone/other");
    await sync();
    github.personalRefused.set(refusing.node, 403);
    github.unstar(other);
    await sync();
    expect(repositoryRow(refusing).state).toBe("active");
    expect(repositoryRow(refusing).properties["starred"]).toBe(true);

    await sync();
    expect(checks("someone/refusing")).toBe(1);
    expect(repositoryRow(refusing).state).toBe("active");
    expect(repositoryRow(refusing).properties["starred"]).toBe(true);
    expect(repositoryRow(other).state).toBe("archived");
    expect(conditions()["stars-kept"]).toContain("someone/refusing");
    expect(conditions()["stars-kept"]).toContain("403");

    github.personalRefused.delete(refusing.node);
    github.unstar(refusing);
    await sync();
    expect(checks("someone/refusing")).toBe(2);
    expect(repositoryRow(refusing).state).toBe("archived");
    expect(conditions()).not.toHaveProperty("stars-kept");
  }, 90_000);

  it("keeps a star-only row on any other answer to the read, and names it", async () => {
    const repository = starOnly("someone/starred");
    await sync();
    github.personalRefused.set(repository.node, 451);
    await sync();
    await sync();
    expect(repositoryRow(repository).state).toBe("active");
    expect(conditions()["stars-kept"]).toContain("someone/starred");
    expect(conditions()["stars-kept"]).toContain("451");
  });

  it("keeps a failed read from touching a synced repository's mark", async () => {
    const tracker = listed("someone/tracker");
    github.star(tracker);
    await sync();
    github.starsFailAt = { page: 1, status: 403 };
    await sync();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).properties["starred_at"]).toBe(
      github.stars.get(tracker.node),
    );
  });

  it("never archives a star-only repository when another repository leaves the listing", async () => {
    const starred = starOnly("someone/starred");
    const tracker = listed("someone/tracker", { private: false });
    const issue = github.addIssue(tracker);
    await sync();
    expect(repositoryRow(starred).state).toBe("active");

    unlist(tracker);
    await sync();
    expect(
      marfa.rows.find((one) => one.properties["github_id"] === issue.node)
        ?.state,
    ).toBe("archived");
    expect(repositoryRow(tracker).state).toBe("archived");
    expect(repositoryRow(starred).state).toBe("active");
    expect(repositoryRow(starred).properties["starred"]).toBe(true);
  });

  it("keeps the row of a starred repository that leaves the listing, which a lost star then only unmarks", async () => {
    const tracker = listed("someone/tracker", { private: false });
    const issue = github.addIssue(tracker);
    github.star(tracker);
    await sync();
    const id = repositoryRow(tracker).id;

    const before = marfa.log.length;
    unlist(tracker);
    await sync();
    expect(
      marfa.log
        .slice(before)
        .filter(
          (one) =>
            "item" in one &&
            one.item.type === "github.repository" &&
            one.item.state === "archived",
        ),
    ).toEqual([]);
    expect(
      marfa.rows.find((one) => one.properties["github_id"] === issue.node)
        ?.state,
    ).toBe("archived");
    expect(repositoryRow(tracker).id).toBe(id);
    expect(repositoryRow(tracker).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    // Another process may still sync it, so the row keeps saying it is synced.
    expect(repositoryRow(tracker).properties["synced"]).toBe(true);

    github.unstar(tracker);
    await sync();
    await sync();
    expect(repositoryRow(tracker).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(false);
    expect(repositoryRow(tracker).properties["synced"]).toBe(true);
  });

  it("keeps the star mark of a paused repository, and unmarks it only once two listings lack the star", async () => {
    const tracker = listed("someone/tracker", { private: false });
    listed("someone/other", { private: false });
    github.star(tracker);
    await sync();
    const at = repositoryRow(tracker).properties["starred_at"];

    const paused = async () => {
      const result = await exec({
        GITHUB_PERSONAL_TOKEN: token,
        GITHUB_REPOSITORIES: "someone/other",
      });
      expect(result.code, result.output).toBe(0);
    };
    await paused();
    expect(repositoryRow(tracker).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).properties["starred_at"]).toBe(at);

    github.unstar(tracker);
    await paused();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    await paused();
    expect(repositoryRow(tracker).state).toBe("active");
    expect(repositoryRow(tracker).properties["starred"]).toBe(false);
    expect(repositoryRow(tracker).properties["starred_at"] ?? null).toBeNull();
  }, 90_000);

  it("archives an unstarred repository that leaves the listing", async () => {
    const tracker = listed("someone/tracker", { private: false });
    await sync();
    unlist(tracker);
    await sync();
    expect(repositoryRow(tracker).state).toBe("archived");
  });

  it("does not read stars for an App alone, and marks nothing", async () => {
    const repository = github.addRepository("someone/tracker");
    github.star(repository);
    const elsewhere = github.addRepository("someone/elsewhere", {
      installation: 99,
      private: false,
    });
    github.star(elsewhere);
    await syncWithApp();
    expect(starRequests()).toBe(0);
    const row = repositoryRow(repository);
    expect(row.properties["starred"] ?? null).toBeNull();
    expect(
      marfa.rows.filter((one) => one.type === "github.repository"),
    ).toHaveLength(1);
  });

  it("clears the marks of a repository on an App-only run, without reading the rows to carry them", async () => {
    const repository = github.addRepository("someone/tracker");
    github.star(repository);
    github.personalRepositories = new Set([repository.node]);
    await sync();
    expect(repositoryRow(repository).properties["starred"]).toBe(true);

    await syncWithApp();
    expect(repositoryRow(repository).properties["starred"] ?? null).toBeNull();
    expect(
      repositoryRow(repository).properties["starred_at"] ?? null,
    ).toBeNull();
  });

  it("writes nothing on a second run when nothing changed", async () => {
    const tracker = listed("someone/tracker");
    github.addIssue(tracker);
    github.star(tracker);
    starOnly("someone/starred");
    await sync();
    const before = marfa.log.length;
    await sync();
    expect(changes(before)).toEqual([]);
  });

  it("puts back an edit to the star fields, on a run that listed stars and on one that could not", async () => {
    const tracker = listed("someone/tracker");
    github.star(tracker);
    await sync();
    const at = repositoryRow(tracker).properties["starred_at"];

    marfa.edit(repositoryRow(tracker).id, { starred: false, starred_at: null });
    await sync();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
    expect(repositoryRow(tracker).properties["starred_at"]).toBe(at);

    marfa.edit(repositoryRow(tracker).id, { starred: false });
    github.starsFailAt = { page: 1, status: 403 };
    await sync();
    expect(repositoryRow(tracker).properties["starred"]).toBe(true);
  });

  it("holds the fields on a repository type the server held without them", async () => {
    const repository = starOnly("someone/starred");
    await sync();
    const stored = marfa.types.get("github.repository");
    if (stored === undefined) throw new Error("no stored type");
    const fields = { ...(stored["fields"] as Record<string, unknown>) };
    Reflect.deleteProperty(fields, "starred");
    Reflect.deleteProperty(fields, "starred_at");
    marfa.types.set("github.repository", { ...stored, fields });
    Reflect.deleteProperty(repositoryRow(repository).properties, "starred");
    Reflect.deleteProperty(repositoryRow(repository).properties, "starred_at");

    await sync();
    const served = marfa.types.get("github.repository")?.["fields"] as Record<
      string,
      unknown
    >;
    expect(Object.keys(served)).toEqual(
      expect.arrayContaining(["starred", "starred_at"]),
    );
    expect(repositoryRow(repository).properties["starred"]).toBe(true);
  });

  it("runs without the fields, naming the fix, where the key may not add them", async () => {
    const repository = starOnly("someone/starred");
    await sync();
    const stored = marfa.types.get("github.repository");
    if (stored === undefined) throw new Error("no stored type");
    const fields = { ...(stored["fields"] as Record<string, unknown>) };
    Reflect.deleteProperty(fields, "starred");
    Reflect.deleteProperty(fields, "starred_at");
    marfa.types.set("github.repository", { ...stored, fields });
    marfa.grants = { metadata_permissions: { edge_types: "write" } };

    const output = await sync();
    expect(output).toContain("starred_at");
    expect(repositoryRow(repository).state).toBe("active");
  });
});

describe("stars read with the notifications token", { timeout: 90_000 }, () => {
  const classic = "ghp_classic_notifications_12345678";
  /** No installation of the App reaches it, so it is a star and nothing else. */
  const elsewhere = { installation: 99 };

  beforeEach(() => {
    github.notifications.token = classic;
    github.notifications.pollInterval = 0;
  });

  async function syncWithClassic(
    env: Record<string, string> = {},
  ): Promise<string> {
    const result = await exec({
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: key,
      GITHUB_WEBHOOK_SECRET: "github-test-webhook-secret",
      GITHUB_NOTIFICATIONS_TOKEN: classic,
      ...env,
    });
    expect(result.code, result.output).toBe(0);
    return result.output;
  }

  function starListings(): (string | undefined)[] {
    return github.asked
      .filter((one) => one.path === "/user/starred")
      .map((one) => one.by);
  }

  it("lists the public stars with it when no personal token is set, beside the App's repositories", async () => {
    const synced = github.addRepository("someone/tracker", { private: false });
    const starred = starOnly("someone/starred", elsewhere);
    const secret = github.addRepository("someone/secret", { private: true });
    github.star(synced);
    github.star(secret);
    await syncWithClassic();
    expect(starListings()).toEqual(["classic"]);
    expect(repositoryRow(starred).properties["starred"]).toBe(true);
    expect(repositoryRow(synced).properties["starred"]).toBe(true);
    expect(held(secret)?.properties["starred"]).toBe(false);
  });

  it("lists with the personal token when both are set, and never with the notifications token", async () => {
    const tracker = listed("someone/tracker");
    const secret = listed("someone/secret", { private: true });
    github.star(tracker);
    github.star(secret);
    await exec({
      GITHUB_PERSONAL_TOKEN: token,
      GITHUB_NOTIFICATIONS_TOKEN: classic,
    }).then((result) => {
      expect(result.code, result.output).toBe(0);
    });
    expect(starListings()).toEqual(["personal"]);
    expect(repositoryRow(secret).properties["starred"]).toBe(true);
    expect(
      github.asked.filter(
        (one) => one.by === "classic" && one.path !== "/notifications",
      ),
    ).toEqual([]);
  });

  it("reads no stars where neither token is set, as before", async () => {
    github.star(github.addRepository("someone/tracker"));
    await syncWithApp();
    expect(starRequests()).toBe(0);
  });

  it("never archives or unmarks a private star it cannot see, and names it", async () => {
    const secretOnly = listed("someone/secret-only", { private: true });
    const secretSynced = listed("someone/secret-synced", { private: true });
    github.star(secretOnly);
    github.star(secretSynced);
    await sync();
    expect(repositoryRow(secretOnly).properties["starred"]).toBe(true);
    expect(repositoryRow(secretSynced).properties["starred"]).toBe(true);
    // The person's rows now come from the App, which still reaches
    // one of them; the other is a star and nothing else.
    secretOnly.installation = 99;

    for (let at = 0; at < 4; at += 1) await syncWithClassic();
    expect(repositoryRow(secretOnly).state).toBe("active");
    expect(repositoryRow(secretOnly).properties["starred"]).toBe(true);
    expect(repositoryRow(secretSynced).state).toBe("active");
    expect(repositoryRow(secretSynced).properties["starred"]).toBe(true);
    expect(conditions()["stars-kept"]).toContain("someone/secret-only");
  });

  it("makes no read of a private star-only row, which this token can only be answered 404", async () => {
    const secretOnly = listed("someone/secret-only", { private: true });
    github.star(secretOnly);
    await sync();
    secretOnly.installation = 99;
    for (let at = 0; at < 3; at += 1) await syncWithClassic();
    expect(checks("someone/secret-only")).toBe(0);
    expect(repositoryRow(secretOnly).state).toBe("active");
    expect(conditions()["stars-kept"]).toContain("someone/secret-only");
    // The witness: a public star-only row lacking a listing is read.
    const open = starOnly("someone/open", elsewhere);
    await syncWithClassic();
    github.unstar(open);
    await syncWithClassic();
    await syncWithClassic();
    expect(checks("someone/open")).toBe(1);
  });

  describe.each([
    ["synced", {}],
    ["star-only", { installation: 99 }],
  ])(
    "the star of a private %s repository that the personal token stops listing",
    (_kind, reach) => {
      it("stays marked through two runs with the notifications token and one personal miss, and goes on the second", async () => {
        const secret = listed("someone/secret", { private: true });
        github.star(secret);
        await sync();
        expect(repositoryRow(secret).properties["starred"]).toBe(true);
        Object.assign(secret, reach);
        github.unstar(secret);
        await syncWithClassic();
        await syncWithClassic();
        await sync();
        expect(repositoryRow(secret).state).toBe("active");
        expect(repositoryRow(secret).properties["starred"]).toBe(true);
        await sync();
        const row = held(secret);
        expect(
          row?.state === "archived" || row?.properties["starred"] === false,
        ).toBe(true);
      });
    },
  );

  it("does not count a miss under the notifications token as the first miss under the personal token", async () => {
    const open = starOnly("someone/open", elsewhere);
    await syncWithClassic();
    github.unstar(open);
    await syncWithClassic();
    expect(repositoryRow(open).state).toBe("active");
    await sync();
    expect(repositoryRow(open).state).toBe("active");
    expect(repositoryRow(open).properties["starred"]).toBe(true);
    await sync();
    expect(repositoryRow(open).state).toBe("archived");
  });

  it("archives a public star after two listings and a 200, and unmarks a public synced one", async () => {
    const open = starOnly("someone/open", elsewhere);
    const synced = github.addRepository("someone/tracker", { private: false });
    github.star(synced);
    await syncWithClassic();
    github.unstar(open);
    github.unstar(synced);
    await syncWithClassic();
    expect(repositoryRow(open).state).toBe("active");
    await syncWithClassic();
    expect(checks("someone/open")).toBe(1);
    expect(repositoryRow(open).state).toBe("archived");
    expect(repositoryRow(synced).properties["starred"]).toBe(false);
    expect(conditions()).not.toHaveProperty("stars-kept");
  });

  it("keeps a star-only row on a 404, which the notifications token also gets for a private repository", async () => {
    const gone = starOnly("someone/gone", elsewhere);
    await syncWithClassic();
    github.unstar(gone);
    gone.hidden = true;
    await syncWithClassic();
    await syncWithClassic();
    expect(checks("someone/gone")).toBe(1);
    expect(repositoryRow(gone).state).toBe("active");
    expect(repositoryRow(gone).properties["starred"]).toBe(true);
    expect(conditions()["stars-kept"]).toContain("someone/gone");
    expect(conditions()["stars-kept"]).toContain("404");
  });

  it("names a rejected notifications token and carries on with the other kinds", async () => {
    const tracker = github.addRepository("someone/tracker", { private: false });
    github.star(tracker);
    github.notifications.token = classic;
    await syncWithClassic({
      GITHUB_NOTIFICATIONS_TOKEN: "ghp_revoked_12345678",
    });
    expect(conditions()["stars-unreadable"]).toContain(
      "GITHUB_NOTIFICATIONS_TOKEN",
    );
    expect(held(tracker)?.state).toBe("active");
  });
});
