import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { affected, classify, JOBS, RULES, type Job } from "../ci-changes.js";

const root = resolve(import.meta.dirname, "../..");

function runs(paths: string[]): Job[] {
  const answer = classify(paths);
  return JOBS.filter((job) => answer[job]);
}

describe("what a change runs beyond formatting and the scan", () => {
  it.each<[string, string[], Job[]]>([
    ["a README in a subfolder", ["connectors/todoist/README.md"], []],
    ["top-level documentation and the licence", ["README.md", "LICENSE"], []],
    ["agent settings", [".claude/settings.json"], []],
    [
      "a connector's source",
      ["connectors/todoist/src/main.ts"],
      ["code", "proof", "image"],
    ],
    ["a connector's test", ["connectors/github/test/read.test.ts"], ["code"]],
    [
      "a fixture the proof reads",
      ["connectors/rss/test/fixtures/atom.xml"],
      ["code", "proof", "image"],
    ],
    ["the kit", ["kit/src/main.ts"], ["code", "proof", "image"]],
    ["the kit's tests", ["kit/test/scripted-server.ts"], ["code"]],
    [
      "the template",
      ["template/connector/src/main.ts"],
      ["code", "proof", "image"],
    ],
    ["the template's image", ["template/Dockerfile"], ["image"]],
    ["the LaunchAgent example", ["template/launchd.plist.example"], ["image"]],
    ["what the image leaves out", [".dockerignore"], ["image"]],
    [
      "the script that reads the image's client",
      ["scripts/check-image-client.ts"],
      ["code", "image"],
    ],
    [
      "dependency and workflow settings",
      [".github/dependabot.yml", ".github/workflows/audit.yml"],
      [],
    ],
    ["the proof", ["scripts/proof/rss.ts"], ["code", "proof", "image"]],
    [
      "the monorepo pin",
      ["scripts/monorepo.commit"],
      ["code", "proof", "image"],
    ],
    ["a repository test", ["scripts/test/tree.test.ts"], ["code"]],
    ["lint settings", ["eslint.config.js"], ["code"]],
    ["a dependency", ["pnpm-lock.yaml"], ["code", "proof", "image"]],
    ["the workflow", [".github/workflows/ci.yml"], ["code", "proof", "image"]],
    [
      "the CodeQL workflow, which a test reads",
      [".github/workflows/codeql.yml"],
      ["code"],
    ],
    ["the classifier", ["scripts/ci-changes.ts"], ["code", "proof", "image"]],
    ["a path no rule names", ["tools/new.ts"], ["code", "proof", "image"]],
    [
      "documentation beside a test",
      ["README.md", "kit/test/main.test.ts"],
      ["code"],
    ],
    ["an empty change", [], ["code", "proof", "image"]],
  ])("%s", (_, paths, expected) => {
    expect(runs(paths)).toEqual(expected);
  });

  it("names every Markdown file as documentation", () => {
    const markdown = execFileSync("git", ["ls-files", "*.md"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown.filter((path) => affected(path).size > 0)).toEqual([]);
    // The witness: a path no rule names runs everything.
    expect(RULES.some(([pattern]) => pattern.test("tools/new.ts"))).toBe(false);
  });
});

interface Workflow {
  jobs: Record<
    string,
    {
      needs?: string;
      if?: string;
      outputs?: Record<string, string>;
      steps: { run?: string; if?: string }[];
    }
  >;
}

describe("each job reads its answer", () => {
  const { jobs } = parse(
    readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;

  it("runs Proof only when the classifier says so, and when it cannot tell", () => {
    expect(jobs["changes"]?.outputs).toEqual({
      code: "${{ steps.classify.outputs.code }}",
      proof: "${{ steps.classify.outputs.proof }}",
      image: "${{ steps.classify.outputs.image }}",
    });
    expect(jobs["proof"]?.needs).toBe("changes");
    expect(jobs["proof"]?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.proof != 'false') }}",
    );
  });

  it("runs Image only when the classifier says so, and when it cannot tell", () => {
    expect(jobs["image"]?.needs).toBe("changes");
    expect(jobs["image"]?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.image != 'false') }}",
    );
    const runs = (jobs["image"]?.steps ?? []).flatMap((step) => step.run ?? []);
    expect(runs.some((run) => run.includes("xmllint"))).toBe(true);
    expect(runs.some((run) => run.includes("docker build"))).toBe(true);
    expect(runs.some((run) => run.includes("check-image-client.ts"))).toBe(
      true,
    );
  });

  it("prepares the pinned server only for Proof and installs the registry client for Image", () => {
    const commands = (job: string) =>
      (jobs[job]?.steps ?? []).flatMap((step) => step.run ?? []);
    expect(commands("proof")).toContain("scripts/monorepo.sh");
    for (const job of ["checks", "image"]) {
      expect(commands(job)).not.toContain("scripts/monorepo.sh");
      expect(commands(job)).toContain("pnpm install --frozen-lockfile");
    }
    for (const job of ["checks", "proof", "image"]) {
      expect(
        commands(job).some((command) => command.includes("vendor-client")),
      ).toBe(false);
    }
  });

  it("formats and scans every change, and does the rest only for code", () => {
    const checks = jobs["checks"];
    expect(checks?.needs).toBe("changes");
    expect(checks?.if).toBe("${{ !cancelled() }}");
    const always = (checks?.steps ?? []).filter(
      (step) => step.run !== undefined && step.if === undefined,
    );
    expect(always.map((step) => step.run)).toEqual(["pnpm format:check"]);
    const light = (checks?.steps ?? []).filter(
      (step) => step.if === "${{ needs.changes.outputs.code == 'false' }}",
    );
    expect(light.map((step) => step.run)).toEqual([
      "pnpm install --frozen-lockfile --filter .",
      "pnpm exec vitest run scripts/test/tree.test.ts",
    ]);
    const full = (checks?.steps ?? []).filter(
      (step) => step.if === "${{ needs.changes.outputs.code != 'false' }}",
    );
    expect(full.map((step) => step.run)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
    ]);
  });
});

/**
 * Whether a workflow's `paths` filter pattern matches a path, as Actions reads
 * it: `**` crosses folders, and `**` followed by a slash matches none too.
 */
function filterMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("**/")
    .map((part) =>
      part
        .split("**")
        .map((piece) =>
          piece
            .split("*")
            .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
        )
        .join(".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`).test(path);
}

describe("CodeQL", () => {
  const { on } = parse(
    readFileSync(join(root, ".github", "workflows", "codeql.yml"), "utf8"),
  ) as {
    on: {
      push?: unknown;
      pull_request?: { branches?: string[]; "paths-ignore"?: string[] };
      schedule?: { cron: string }[];
    };
  };
  const ignored = on.pull_request?.["paths-ignore"] ?? [];
  const skips = (path: string) =>
    ignored.some((pattern) => filterMatches(pattern, path));

  it("analyzes every push to main and once a week, and a pull request unless it changes only documentation or agent settings", () => {
    expect(on.push).toEqual({ branches: ["main"] });
    expect(on.pull_request).toEqual({
      branches: ["main"],
      "paths-ignore": ["**/*.md", "LICENSE", ".claude/**"],
    });
    expect(on.schedule).toHaveLength(1);
    expect(on.schedule?.[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
  });

  it("skips what the classifier also reads as documentation, and no code in a language it analyzes", () => {
    for (const path of [
      "README.md",
      "connectors/todoist/README.md",
      "LICENSE",
      ".claude/settings.json",
    ]) {
      expect(skips(path), path).toBe(true);
      expect(affected(path).size, path).toBe(0);
    }
    for (const path of [
      ".github/workflows/ci.yml",
      "kit/src/main.ts",
      "connectors/rss/test/fixtures/atom.xml",
      "eslint.config.js",
      "pnpm-lock.yaml",
    ]) {
      expect(skips(path), path).toBe(false);
    }
  });
});

describe("the classifier as CI runs it", () => {
  const script = join(root, "scripts", "ci-changes.ts");
  const directory = mkdtempSync(join(tmpdir(), "connectors-ci-paths-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  let base = "";
  let docs = "";

  beforeAll(() => {
    git("init", "-q");
    git("config", "user.email", "fixture@example.com");
    git("config", "user.name", "CI Fixture");
    git("config", "commit.gpgsign", "false");
    git("commit", "-q", "--allow-empty", "-m", "base");
    base = git("rev-parse", "HEAD");
    writeFileSync(join(directory, "README.md"), "Words\n");
    git("add", "README.md");
    git("commit", "-qm", "docs");
    docs = git("rev-parse", "HEAD");
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function outputs(event: string, from: string, to: string): string {
    const eventPath = join(directory, "event.json");
    const output = join(directory, "output");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { base: { sha: from }, head: { sha: to } },
      }),
    );
    writeFileSync(output, "");
    execFileSync(process.execPath, [script], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
      },
    });
    return readFileSync(output, "utf8");
  }

  it("skips the code checks and the proof for documentation", () => {
    expect(outputs("pull_request", base, docs)).toBe(
      "code=false\nproof=false\nimage=false\n",
    );
  });

  it("runs everything for an unreadable diff, an empty one and a push", () => {
    expect(outputs("pull_request", "invalid", docs)).toBe(
      "code=true\nproof=true\nimage=true\n",
    );
    expect(outputs("pull_request", docs, docs)).toBe(
      "code=true\nproof=true\nimage=true\n",
    );
    expect(outputs("push", base, docs)).toBe(
      "code=true\nproof=true\nimage=true\n",
    );
  });
});
