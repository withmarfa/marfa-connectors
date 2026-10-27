import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  GitHubStub,
  type Repository,
} from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "github_pat_files_12345678";
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

let marfa: ScriptedServer;
let github: GitHubStub;
let repository: Repository;

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types,
    edges: connections,
  }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
  github.personalToken = token;
  repository = github.addRepository("someone/agents", {
    files: new Map<string, string | Buffer>([
      ["runbooks/development.md", "# Development\n"],
      ["runbooks/access.md", "# Access\n"],
      ["skills/skills/review/SKILL.md", "# Review\n"],
      ["skills/skills/review/script.sh", "echo\n"],
      ["skills/skills/plan/SKILL.markdown", "# Plan\n"],
      ["README.md", "# Agents\n"],
    ]),
  });
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
});

const setting = "someone/agents:runbooks,skills/skills";

async function exec(
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        GITHUB_API_URL: github.url,
        GITHUB_PERSONAL_TOKEN: token,
        GITHUB_FILES: setting,
        ...env,
      },
    });
    return { code: 0, output: stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, output: failed.stderr };
  }
}

async function sync(env: Record<string, string> = {}): Promise<string> {
  const result = await exec(env);
  expect(result.code, result.output).toBe(0);
  return result.output;
}

function key(path: string): string {
  return `${repository.node}:${path}`;
}

function file(path: string) {
  return marfa.rows.find(
    (one) =>
      one.type === "github.repository_file" && one.source_id === key(path),
  );
}

function folder(path: string) {
  return marfa.rows.find(
    (one) =>
      one.type === "github.directory" && one.source_id === key(`${path}/`),
  );
}

function rowsOf(type: string) {
  return marfa.rows.filter((one) => one.type === type);
}

function targets(from: string, edgeType: string): string[] {
  return marfa.edges
    .filter((one) => one.source_id === from && one.edge_type === edgeType)
    .map((one) => one.target_id);
}

function gitReads(): number {
  return github.asked.filter((one) => one.path.includes("/git/")).length;
}

function conditions(): Record<string, string> {
  return marfa.problems.get("github") ?? {};
}

function files(): Map<string, string | Buffer> {
  const held = repository.files;
  if (held === undefined) throw new Error("no files");
  return held;
}

describe("repository files", { timeout: 60_000 }, () => {
  it("mirrors the Markdown files under each path as notes, in nested directory collections", async () => {
    await sync();
    expect(
      rowsOf("github.repository_file")
        .map((one) => one.properties["path"])
        .sort(),
    ).toEqual([
      "runbooks/access.md",
      "runbooks/development.md",
      "skills/skills/plan/SKILL.markdown",
      "skills/skills/review/SKILL.md",
    ]);
    expect(
      rowsOf("github.directory")
        .map((one) => one.properties["path"])
        .sort(),
    ).toEqual([
      "runbooks",
      "skills/skills",
      "skills/skills/plan",
      "skills/skills/review",
    ]);
    const review = file("skills/skills/review/SKILL.md");
    expect(review?.properties).toMatchObject({
      title: "review",
      body: "# Review\n",
      repository: "someone/agents",
      url: "https://github.com/someone/agents/blob/main/skills/skills/review/SKILL.md",
      private: true,
    });
    expect(file("runbooks/access.md")?.properties["title"]).toBe("access");
    expect(folder("skills/skills")?.properties["title"]).toBe("skills");
    expect(folder("skills/skills/review")?.properties["url"]).toBe(
      "https://github.com/someone/agents/tree/main/skills/skills/review",
    );
    expect(targets(review?.id ?? "", "in-collection")).toEqual([
      folder("skills/skills/review")?.id,
    ]);
    expect(
      targets(folder("skills/skills")?.id ?? "", "parent-of").sort(),
    ).toEqual(
      [folder("skills/skills/plan")?.id, folder("skills/skills/review")?.id]
        .map(String)
        .sort(),
    );
    // Two collections at the top: neither path's root sits under the other.
    expect(
      marfa.edges.filter(
        (one) =>
          one.edge_type === "parent-of" &&
          one.target_id === folder("runbooks")?.id,
      ),
    ).toEqual([]);
    expect(conditions()).toEqual({});
  });

  it("reads an unchanged branch with one request and writes nothing", async () => {
    await sync();
    const events = marfa.log.length;
    const reads = gitReads();
    await sync();
    expect(gitReads() - reads).toBe(1);
    expect(marfa.log.length).toBe(events);
  });

  it("puts back an edit made in Marfa, whatever GITHUB_READ_ONLY says", async () => {
    await sync();
    const row = file("runbooks/access.md");
    if (row === undefined) throw new Error("no row");
    marfa.edit(row.id, { body: "Edited in Marfa", title: "Mine" });
    await sync({ GITHUB_READ_ONLY: "false" });
    expect(file("runbooks/access.md")?.properties).toMatchObject({
      body: "# Access\n",
      title: "access",
    });
  });

  it("updates the item of a file changed on GitHub", async () => {
    await sync();
    const before = file("runbooks/access.md");
    files().set("runbooks/access.md", "# Access, revised\n");
    await sync();
    const after = file("runbooks/access.md");
    expect(after?.id).toBe(before?.id);
    expect(after?.properties["body"]).toBe("# Access, revised\n");
  });

  it("keeps the item of a file moved or renamed, and of a directory renamed with it", async () => {
    await sync();
    const before = file("skills/skills/review/SKILL.md");
    const directory = folder("skills/skills/review");
    files().delete("skills/skills/review/SKILL.md");
    files().delete("skills/skills/review/script.sh");
    files().set("skills/skills/critique/SKILL.md", "# Review\n");
    const access = file("runbooks/access.md");
    files().delete("runbooks/access.md");
    files().set("runbooks/permissions.md", "# Access\n");
    await sync();
    const moved = file("skills/skills/critique/SKILL.md");
    expect(moved?.id).toBe(before?.id);
    expect(moved?.state).toBe("active");
    expect(moved?.properties["title"]).toBe("critique");
    expect(folder("skills/skills/critique")?.id).toBe(directory?.id);
    expect(targets(moved?.id ?? "", "in-collection")).toEqual([directory?.id]);
    expect(file("runbooks/permissions.md")?.id).toBe(access?.id);
    expect(
      rowsOf("github.repository_file").filter((one) => one.state !== "active"),
    ).toEqual([]);
  });

  it("archives a removed file, and a directory it leaves empty", async () => {
    await sync();
    files().delete("skills/skills/plan/SKILL.markdown");
    files().delete("runbooks/access.md");
    await sync();
    expect(file("skills/skills/plan/SKILL.markdown")?.state).toBe("archived");
    expect(file("runbooks/access.md")?.state).toBe("archived");
    expect(folder("skills/skills/plan")?.state).toBe("archived");
    expect(folder("runbooks")?.state).toBe("active");
    expect(file("runbooks/development.md")?.state).toBe("active");
  });

  it("archives nothing from a truncated tree, and says so", async () => {
    await sync();
    files().delete("runbooks/access.md");
    repository.treeTruncated = true;
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(conditions()[`files-unlisted:${repository.node}`]).toContain(
      "cut the tree",
    );
    repository.treeTruncated = false;
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("archived");
    expect(conditions()).toEqual({});
  });

  it("names a path that does not exist and archives nothing under it", async () => {
    await sync();
    for (const path of [...files().keys()])
      if (path.startsWith("runbooks/")) files().delete(path);
    await sync({ GITHUB_FILES: "someone/agents:runbooks,skills/skills,nope" });
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(conditions()[`files-missing:${repository.node}`]).toContain(
      "someone/agents:nope, someone/agents:runbooks",
    );
    expect(file("skills/skills/review/SKILL.md")?.state).toBe("active");
  });

  it("skips a file too large or not UTF-8, names it, and syncs the rest", async () => {
    files().set("runbooks/huge.md", "x".repeat(600 * 1024));
    files().set("runbooks/latin.md", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await sync();
    expect(file("runbooks/huge.md")).toBeUndefined();
    expect(file("runbooks/latin.md")).toBeUndefined();
    expect(file("runbooks/access.md")?.state).toBe("active");
    const said = conditions()[`files-skipped:${repository.node}`];
    expect(said).toContain("runbooks/huge.md (over 512 KiB)");
    expect(said).toContain("runbooks/latin.md");
    // The next run reads the same tree, so it keeps the condition.
    await sync();
    expect(conditions()[`files-skipped:${repository.node}`]).toBe(said);
  });

  it("follows a renamed default branch", async () => {
    await sync();
    repository.branch = "trunk";
    await sync();
    expect(file("runbooks/access.md")?.properties["url"]).toBe(
      "https://github.com/someone/agents/blob/trunk/runbooks/access.md",
    );
    expect(file("runbooks/access.md")?.state).toBe("active");
  });

  it("names a refusal of the repository's contents and archives nothing", async () => {
    await sync();
    github.personalNoContents = true;
    files().delete("runbooks/access.md");
    files().set("runbooks/new.md", "# New\n");
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(file("runbooks/new.md")).toBeUndefined();
    expect(conditions()[`files-unlisted:${repository.node}`]).toContain(
      "contents=read",
    );
    github.personalNoContents = false;
    repository.contentsRefused = 404;
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(conditions()[`files-unlisted:${repository.node}`]).toContain(
      "GitHub answered 404",
    );
  });

  it("names a repository the run does not sync, and leaves a paused one unread", async () => {
    await sync({ GITHUB_FILES: `${setting} someone/elsewhere:docs` });
    expect(conditions()["files-unsynced:someone/elsewhere"]).toContain(
      "does not sync",
    );
    github.addRepository("someone/other");
    const reads = gitReads();
    files().delete("runbooks/access.md");
    await sync({ GITHUB_REPOSITORIES: "someone/other" });
    expect(gitReads()).toBe(reads);
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(conditions()["files-unsynced:someone/agents"]).toContain(
      "GITHUB_REPOSITORIES leaves out",
    );
  });

  it("archives the files of a repository taken out of the sync", async () => {
    await sync();
    expect(rowsOf("github.repository_file")).toHaveLength(4);
    expect(rowsOf("github.directory")).toHaveLength(4);
    github.personalRepositories = new Set();
    await sync();
    expect(
      rowsOf("github.repository_file").map((one) => one.state),
    ).not.toContain("active");
    expect(rowsOf("github.directory").map((one) => one.state)).not.toContain(
      "active",
    );
  });

  it("leaves a trashed directory in the bin, and the files in it in place", async () => {
    await sync();
    const skills = folder("skills/skills");
    if (skills === undefined) throw new Error("no row");
    marfa.trash(skills.id);
    expect(folder("skills/skills/review")?.state).toBe("trashed");
    files().set("skills/skills/review/SKILL.md", "# Review, revised\n");
    await sync();
    expect(folder("skills/skills")?.state).toBe("trashed");
    expect(folder("skills/skills/review")?.state).toBe("trashed");
    expect(file("skills/skills/review/SKILL.md")?.state).toBe("active");
    expect(file("skills/skills/review/SKILL.md")?.properties["body"]).toBe(
      "# Review, revised\n",
    );
  });

  it("leaves a trashed file in the bin unread, and brings it up to date after a restore and the next change", async () => {
    await sync();
    const access = file("runbooks/access.md");
    if (access === undefined) throw new Error("no row");
    marfa.trash(access.id);
    files().set("runbooks/access.md", "# Access, revised\n");
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("trashed");
    expect(file("runbooks/access.md")?.properties["body"]).toBe("# Access\n");
    marfa.restore(access.id);
    files().set("runbooks/new.md", "# New\n");
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(file("runbooks/access.md")?.properties["body"]).toBe(
      "# Access, revised\n",
    );
  });

  it("marks the files and directories of a paused repository private when it turns private", async () => {
    repository.private = false;
    github.addRepository("someone/other");
    await sync();
    expect(file("runbooks/access.md")?.properties["private"]).toBe(false);
    expect(folder("runbooks")?.properties["private"]).toBe(false);
    repository.private = true;
    await sync({ GITHUB_REPOSITORIES: "someone/other" });
    expect(
      [...rowsOf("github.repository_file"), ...rowsOf("github.directory")].map(
        (one) => one.properties["private"],
      ),
    ).toEqual(Array<boolean>(8).fill(true));
  });

  it("archives the file renamed onto the path of an archived one, and updates that one", async () => {
    await sync();
    const access = file("runbooks/access.md");
    files().delete("runbooks/access.md");
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("archived");
    files().delete("runbooks/development.md");
    files().set("runbooks/access.md", "# Development\n");
    await sync();
    const at = rowsOf("github.repository_file").filter(
      (one) => one.properties["path"] === "runbooks/access.md",
    );
    expect(at.map((one) => [one.id, one.state])).toEqual([
      [access?.id, "active"],
    ]);
    expect(at[0]?.properties["body"]).toBe("# Development\n");
    expect(file("runbooks/development.md")?.state).toBe("archived");
    // A later change to the branch reads no blob of the file again.
    const blobs = () =>
      github.asked.filter((one) => one.path.includes("/git/blobs/")).length;
    const before = blobs();
    files().set("runbooks/new.md", "# New\n");
    await sync();
    expect(blobs() - before).toBe(1);
  });

  it("archives the file renamed onto the path of a trashed one, and leaves that one in the bin unread", async () => {
    await sync();
    const access = file("runbooks/access.md");
    if (access === undefined) throw new Error("no row");
    marfa.trash(access.id);
    files().delete("runbooks/development.md");
    files().set("runbooks/access.md", "# Development\n");
    await sync();
    expect(file("runbooks/access.md")?.state).toBe("trashed");
    expect(file("runbooks/development.md")?.state).toBe("archived");
    const blobs = () =>
      github.asked.filter((one) => one.path.includes("/git/blobs/")).length;
    const before = blobs();
    files().set("runbooks/new.md", "# New\n");
    await sync();
    expect(blobs() - before).toBe(1);
  });

  it("keeps a directory that holds only a skipped file with a row", async () => {
    await sync();
    files().set("runbooks/access.md", "x".repeat(600 * 1024));
    files().delete("runbooks/development.md");
    await sync();
    expect(file("runbooks/development.md")?.state).toBe("archived");
    expect(file("runbooks/access.md")?.state).toBe("active");
    expect(folder("runbooks")?.state).toBe("active");
  });

  it("reads the tree again after a truncated read, so a revert is not missed", async () => {
    await sync();
    files().set("runbooks/access.md", "# Access, revised\n");
    repository.treeTruncated = true;
    await sync();
    expect(file("runbooks/access.md")?.properties["body"]).toBe(
      "# Access, revised\n",
    );
    files().set("runbooks/access.md", "# Access\n");
    repository.treeTruncated = false;
    await sync();
    expect(file("runbooks/access.md")?.properties["body"]).toBe("# Access\n");
  });

  it("refuses a malformed setting at the start, naming the entry", async () => {
    for (const value of [
      "someone/agents",
      "someone/agents:",
      "someone/agents:../up",
      "agents:docs",
    ]) {
      const result = await exec({ GITHUB_FILES: value });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`GITHUB_FILES holds ${value},`);
    }
  });
});
