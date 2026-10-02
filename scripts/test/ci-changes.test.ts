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
      ["code", "proof"],
    ],
    ["a connector's test", ["connectors/github/test/read.test.ts"], ["code"]],
    [
      "a fixture the proof reads",
      ["connectors/rss/test/fixtures/atom.xml"],
      ["code", "proof"],
    ],
    ["the kit", ["kit/src/main.ts"], ["code", "proof"]],
    ["the kit's tests", ["kit/test/scripted-server.ts"], ["code"]],
    ["the template", ["template/connector/src/main.ts"], ["code", "proof"]],
    ["the template's image", ["template/Dockerfile"], []],
    ["the proof", ["scripts/proof/rss.ts"], ["code", "proof"]],
    ["the monorepo pin", ["scripts/monorepo.commit"], ["code", "proof"]],
    ["a repository test", ["scripts/test/tree.test.ts"], ["code"]],
    ["lint settings", ["eslint.config.js"], ["code"]],
    ["a dependency", ["pnpm-lock.yaml"], ["code", "proof"]],
    ["the workflow", [".github/workflows/ci.yml"], ["code", "proof"]],
    ["the classifier", ["scripts/ci-changes.ts"], ["code", "proof"]],
    ["a path no rule names", ["tools/new.ts"], ["code", "proof"]],
    [
      "documentation beside a test",
      ["README.md", "kit/test/main.test.ts"],
      ["code"],
    ],
    ["an empty change", [], ["code", "proof"]],
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
    });
    expect(jobs["proof"]?.needs).toBe("changes");
    expect(jobs["proof"]?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.proof != 'false') }}",
    );
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
      "scripts/monorepo.sh",
      "scripts/vendor-client.sh",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
    ]);
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
      "code=false\nproof=false\n",
    );
  });

  it("runs everything for an unreadable diff, an empty one and a push", () => {
    expect(outputs("pull_request", "invalid", docs)).toBe(
      "code=true\nproof=true\n",
    );
    expect(outputs("pull_request", docs, docs)).toBe("code=true\nproof=true\n");
    expect(outputs("push", base, docs)).toBe("code=true\nproof=true\n");
  });
});
