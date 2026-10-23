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

async function sync(): Promise<string> {
  const result = await exec({ GITHUB_PERSONAL_TOKEN: token });
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

function changes(since: number): string[] {
  return marfa.log.slice(since).map((one) => one.event);
}

describe("starred repositories", { timeout: 60_000 }, () => {
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

  it("archives a star-only repository when it is unstarred, and the same row returns when it is starred again", async () => {
    const repository = starOnly("someone/starred");
    const other = starOnly("someone/kept");
    await sync();
    const id = repositoryRow(repository).id;

    github.unstar(repository);
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

    github.unstar(tracker);
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

  it("archives nothing when a page of stars fails, and does so once the listing works", async () => {
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
    expect(repositoryRow(gone).state).toBe("active");
    expect(repositoryRow(gone).properties["starred"]).toBe(true);
    expect(held(fresh)).toBeUndefined();
    expect(
      marfa.rows.filter(
        (one) => one.type === "github.repository" && one.state === "archived",
      ),
    ).toEqual([]);

    github.starsFailAt = undefined;
    await sync();
    expect(repositoryRow(gone).state).toBe("archived");
    expect(repositoryRow(fresh).properties["starred"]).toBe(true);
  }, 60_000);

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

  it("keeps the row of a starred repository that leaves the listing, as a star-only row", async () => {
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

    github.unstar(tracker);
    await sync();
    expect(repositoryRow(tracker).state).toBe("archived");
  });

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
