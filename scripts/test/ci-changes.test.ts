import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  affected,
  classify,
  forDraft,
  JOBS,
  proofFilesTestsReach,
  RULES,
  type Job,
} from "../ci-changes.js";

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
    ["Codex's settings", [".codex/config.toml"], []],
    ["a skill's script", [".agents/skills/x/helper.py"], []],
    ["a Git hook", [".githooks/pre-push"], []],
    ["an issue template", [".github/ISSUE_TEMPLATE/bug.yml"], []],
    [
      "a fixture under agent files, which a test could read",
      [".agents/skills/x/fixtures/input.json"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "a file that only looks like an agent directory",
      ["kit/src/.agents/helper.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "agent files beside a kit change",
      [".agents/skills/x/helper.py", "kit/src/main.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "a connector's source",
      ["connectors/todoist/src/main.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "a connector's test",
      ["connectors/github/test/read.test.ts"],
      ["code", "tests"],
    ],
    [
      "a fixture the proof reads",
      ["connectors/rss/test/fixtures/atom.xml"],
      ["code", "tests", "proof", "image"],
    ],
    ["the kit", ["kit/src/main.ts"], ["code", "tests", "proof", "image"]],
    ["the kit's tests", ["kit/test/scripted-server.ts"], ["code", "tests"]],
    [
      "a shared package's source",
      ["shared/google/src/google.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "a shared package's test",
      ["shared/google/test/google.test.ts"],
      ["code", "tests"],
    ],
    [
      "the template",
      ["template/connector/src/main.ts"],
      ["code", "tests", "proof", "image"],
    ],
    ["the template's image", ["template/Dockerfile"], ["image"]],
    ["the LaunchAgent example", ["template/launchd.plist.example"], ["image"]],
    ["what the image leaves out", [".dockerignore"], ["image"]],
    [
      "the script that reads the image's client",
      ["scripts/check-image-client.ts"],
      ["code", "tests", "image"],
    ],
    ["dependency settings", [".github/dependabot.yml"], []],
    [
      "a workflow no job of ci.yml reads",
      [".github/workflows/audit.yml"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "a scenario of the proof, which no unit test imports",
      ["scripts/proof/rss.ts"],
      ["code", "proof"],
    ],
    [
      "the list of the proof's groups, which a unit test imports",
      ["scripts/proof/shards.ts"],
      ["code", "tests", "proof"],
    ],
    [
      "a stub the proof shares with the unit tests",
      ["scripts/proof/github-stub.ts"],
      ["code", "tests", "proof"],
    ],
    [
      "one connector's source",
      ["connectors/rss/src/main.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "the monorepo pin",
      ["scripts/monorepo.commit"],
      ["code", "tests", "proof", "image"],
    ],
    ["a repository test", ["scripts/test/tree.test.ts"], ["code", "tests"]],
    ["lint settings", ["eslint.config.js"], ["code", "tests"]],
    ["a dependency", ["pnpm-lock.yaml"], ["code", "tests", "proof", "image"]],
    [
      "the workflow",
      [".github/workflows/ci.yml"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "the CodeQL workflow, which a test reads",
      [".github/workflows/codeql.yml"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "the description check's workflow, which a test reads",
      [".github/workflows/pr-description.yml"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "the description check",
      ["scripts/check-pr-description.ts"],
      ["code", "tests"],
    ],
    [
      "the classifier",
      ["scripts/ci-changes.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "a path no rule names",
      ["tools/new.ts"],
      ["code", "tests", "proof", "image"],
    ],
    [
      "documentation beside a test",
      ["README.md", "kit/test/main.test.ts"],
      ["code", "tests"],
    ],
    ["an empty change", [], ["code", "tests", "proof", "image"]],
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
    expect(markdown.filter((path) => affected(path).jobs.size > 0)).toEqual([]);
    // The witness: a path no rule names runs everything.
    expect(RULES.some(([pattern]) => pattern.test("tools/new.ts"))).toBe(false);
  });
});

interface Workflow {
  jobs: Record<
    string,
    {
      name?: string;
      needs?: string | string[];
      if?: string;
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps: { run?: string; if?: string; env?: Record<string, string> }[];
    }
  >;
}

describe("which unit tests a change runs", () => {
  const tree = "scripts/test/tree.test.ts";

  it.each<[string, string[], string]>([
    [
      "one connector's source",
      ["connectors/github/src/main.ts"],
      `connectors/github/ ${tree}`,
    ],
    [
      "one connector's tests",
      ["connectors/github/test/read.test.ts"],
      `connectors/github/ ${tree}`,
    ],
    [
      "two connectors",
      ["connectors/todoist/src/main.ts", "connectors/github/src/main.ts"],
      `connectors/github/ connectors/todoist/ ${tree}`,
    ],
    ["the kit", ["kit/src/main.ts"], "all"],
    [
      "the kit beside a connector",
      ["connectors/github/src/main.ts", "kit/src/main.ts"],
      "all",
    ],
    ["a shared package", ["shared/google/src/google.ts"], "all"],
    [
      "a fixture inside a connector",
      ["connectors/rss/test/fixtures/a.xml"],
      "all",
    ],
    ["the template", ["template/connector/src/main.ts"], "all"],
    ["a dependency", ["pnpm-lock.yaml"], "all"],
    ["a path no rule names", ["tools/new.ts"], "all"],
    ["an empty change", [], "all"],
    [
      "a connector and the proof, which the tests do not read",
      ["connectors/rss/src/main.ts", "scripts/proof/rss.ts"],
      `connectors/rss/ ${tree}`,
    ],
    [
      "a connector and a stub the tests import",
      ["connectors/github/src/main.ts", "scripts/proof/github-stub.ts"],
      "all",
    ],
    [
      "a connector beside documentation",
      ["connectors/rss/src/main.ts", "README.md"],
      `connectors/rss/ ${tree}`,
    ],
  ])("%s", (_, paths, scope) => {
    expect(classify(paths).scope).toBe(scope);
  });

  it("runs no tests, with the scope of all, for documentation and for the proof alone", () => {
    for (const paths of [["README.md"], ["scripts/proof/rss.ts"]]) {
      const answer = classify(paths);
      expect(answer.tests).toBe(false);
      expect(answer.scope).toBe("all");
    }
  });

  it("only narrows to a connector no other package depends on", () => {
    const packages = [
      "kit",
      "template/connector",
      ...readdirSync(join(root, "shared")).map((name) => `shared/${name}`),
      ...readdirSync(join(root, "connectors")).map(
        (name) => `connectors/${name}`,
      ),
    ];
    const names = new Map<string, string>();
    const manifests = new Map<string, Record<string, unknown>>();
    for (const folder of packages) {
      const manifest = JSON.parse(
        readFileSync(join(root, folder, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      manifests.set(folder, manifest);
      names.set(folder, String(manifest["name"]));
    }
    const connectors = packages.filter((folder) =>
      folder.startsWith("connectors/"),
    );
    expect(connectors.length).toBeGreaterThan(0);
    for (const folder of connectors) {
      const name = names.get(folder);
      for (const [other, manifest] of manifests) {
        const wanted = {
          ...(manifest["dependencies"] as object | undefined),
          ...(manifest["devDependencies"] as object | undefined),
        };
        expect(Object.keys(wanted), `${other} uses ${folder}`).not.toContain(
          name,
        );
      }
      // The witness: a package that is used is found as one.
      expect(
        Object.keys(manifests.get(folder)?.["dependencies"] ?? {}),
      ).toContain("@withmarfa/connector");
    }
  });

  it("names every file of the proof that a unit test imports, directly or through another", () => {
    const proof = join(root, "scripts", "proof");
    const importsOf = (file: string): string[] =>
      [
        ...readFileSync(file, "utf8").matchAll(/from "(\.[^"]*?)\.js"/g),
      ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    const reached = new Set<string>();
    const visit = (name: string): void => {
      if (reached.has(name)) return;
      reached.add(name);
      for (const next of importsOf(join(proof, `${name}.ts`))) {
        if (next.startsWith("./")) visit(next.slice(2));
      }
    };
    const tests = [
      ...readdirSync(join(root, "scripts", "test")).map((name) =>
        join(root, "scripts", "test", name),
      ),
      ...["kit", "connectors", "shared", "template"].flatMap((top) =>
        execFileSync("git", ["ls-files", `${top}/**/test/*.ts`], {
          cwd: root,
          encoding: "utf8",
        })
          .split("\n")
          .filter(Boolean)
          .map((path) => join(root, path)),
      ),
    ].filter((file) => file.endsWith(".ts"));
    for (const file of tests) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /from "[^"]*\/proof\/([a-z-]+)\.js"/g,
      )) {
        if (match[1] !== undefined) visit(match[1]);
      }
    }
    // The witness: the test of the stub does read the stub.
    expect(reached.has("github-stub")).toBe(true);
    expect([...reached].sort()).toEqual([...proofFilesTestsReach].sort());
  });
});

describe("what a draft runs", () => {
  it("leaves the proof and the image for ready for review, and Checks to the diff", () => {
    for (const paths of [["kit/src/main.ts"], ["README.md"], []]) {
      const answer = classify(paths);
      expect(forDraft(answer)).toEqual({
        ...answer,
        tests: false,
        proof: false,
        image: false,
      });
    }
  });
});

describe("each job reads its answer", () => {
  const { jobs } = parse(
    readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
  ) as Workflow;
  const commands = (job: string) =>
    (jobs[job]?.steps ?? []).flatMap((step) => step.run ?? []);

  it("lets the classifier ask which runs of this workflow succeeded", () => {
    expect(jobs["changes"]?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    const classify = (jobs["changes"]?.steps ?? []).find(
      (step) => step.run === "node scripts/ci-changes.ts",
    );
    expect(classify?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });

  it("publishes every answer the classifier gives", () => {
    expect(jobs["changes"]?.outputs).toEqual(
      Object.fromEntries(
        ["code", "tests", "proof", "image", "full", "scope"].map((name) => [
          name,
          `\${{ steps.classify.outputs.${name} }}`,
        ]),
      ),
    );
  });

  it("runs Proof only when the classifier says so, and when it cannot tell", () => {
    expect(jobs["proof"]?.needs).toBe("changes");
    expect(jobs["proof"]?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.proof != 'false') }}",
    );
  });

  it("runs the tests for a pull request that is not a draft, and when the classifier cannot tell", () => {
    expect(jobs["tests"]?.needs).toBe("changes");
    expect(jobs["tests"]?.if).toBe(
      "${{ !cancelled() && needs.changes.outputs.full != 'false' && (needs.changes.result != 'success' || needs.changes.outputs.tests != 'false') }}",
    );
  });

  it("runs Image only when the classifier says so, and when it cannot tell", () => {
    expect(jobs["image"]?.needs).toBe("changes");
    expect(jobs["image"]?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.image != 'false') }}",
    );
    const runs = commands("image");
    expect(runs.some((run) => run.includes("xmllint"))).toBe(true);
    expect(runs.some((run) => run.includes("docker build"))).toBe(true);
    expect(runs.some((run) => run.includes("check-image-client.ts"))).toBe(
      true,
    );
  });

  it("prepares the pinned server only for Proof and installs the registry client for the rest", () => {
    expect(commands("proof")).toContain("scripts/monorepo.sh");
    for (const job of ["checks", "tests", "image"]) {
      expect(commands(job)).not.toContain("scripts/monorepo.sh");
      expect(commands(job)).toContain("pnpm install --frozen-lockfile");
    }
    for (const job of ["checks", "tests", "proof", "image"]) {
      expect(
        commands(job).some((command) => command.includes("vendor-client")),
      ).toBe(false);
    }
  });

  it("makes Checks the quick job: formats and scans every change, and does the rest only for code", () => {
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
    const code = (checks?.steps ?? []).filter(
      (step) => step.if === "${{ needs.changes.outputs.code != 'false' }}",
    );
    expect(code.map((step) => step.run)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
    ]);
    // The tests moved to their own job, which Checks no longer holds.
    expect(commands("checks")).not.toContain("pnpm test");
  });

  it("never fails Checks for being a draft", () => {
    const steps = jobs["checks"]?.steps ?? [];
    expect(
      steps.some((step) => step.if?.includes("pull_request.draft") === true),
    ).toBe(false);
  });

  it("shards the tests and the proof, each shard on its own, with the count from the matrix", () => {
    for (const name of ["tests", "proof"]) {
      const job = parseJobs()[name];
      expect(job?.strategy?.["fail-fast"], name).toBe(false);
      expect(job?.strategy?.matrix?.shard, name).toEqual([1, 2, 3]);
    }
    expect(commands("proof")).toContain(
      "pnpm proof --shard ${{ matrix.shard }}/${{ strategy.job-total }}",
    );
    const test = (jobs["tests"]?.steps ?? []).find((step) =>
      step.run?.includes("vitest run"),
    );
    expect(test?.env).toEqual({
      SCOPE: "${{ needs.changes.outputs.scope }}",
      SHARD: "${{ matrix.shard }}/${{ strategy.job-total }}",
    });
    expect(test?.run).toContain('--shard "${SHARD}"');
    expect(test?.run).toContain("--passWithNoTests");
  });

  it("passes the classifier's scope to a shell through the environment, never into a script", () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps) {
        expect(step.run ?? "", name).not.toContain("outputs.scope");
      }
    }
  });

  it("holds each job to about twice its time", () => {
    const limits = Object.fromEntries(
      Object.entries(parseJobs()).map(([name, job]) => [
        name,
        job["timeout-minutes"],
      ]),
    );
    expect(limits).toEqual({
      changes: 5,
      checks: 10,
      tests: 12,
      proof: 20,
      image: 10,
      stop: 5,
      gate: 5,
    });
  });

  it("ends the slow jobs after a failed Checks on a pull request, and never on main", () => {
    const stop = jobs["stop"];
    expect(stop?.needs).toBe("checks");
    expect(stop?.if).toBe(
      "${{ always() && github.event_name == 'pull_request' && needs.checks.result == 'failure' }}",
    );
    expect(stop?.permissions).toEqual({ actions: "write" });
    expect(commands("stop")).toEqual(['gh run cancel "${GITHUB_RUN_ID}"']);
  });

  it("waits for every job but the one that cancels, before Full CI reports, and names it Full CI only for a run that ran everything", () => {
    const gate = jobs["gate"];
    expect(gate?.name).toBe(
      "${{ github.event.pull_request.draft && 'Draft CI' || 'Full CI' }}",
    );
    expect([gate?.needs ?? []].flat().sort()).toEqual(
      Object.keys(jobs)
        .filter((job) => job !== "gate" && job !== "stop")
        .sort(),
    );
    expect(gate?.if).toBe(
      "${{ !cancelled() || needs.checks.result == 'failure' }}",
    );
    expect(gate?.steps.map((step) => step.env)).toEqual([
      { RESULTS: "${{ join(needs.*.result, ' ') }}" },
    ]);
  });

  it.each<[string, boolean]>([
    ["success success success success success", true],
    ["success success success skipped skipped", true],
    ["success failure skipped skipped skipped", false],
    ["failure success success success success", false],
    ["success success cancelled success success", false],
    ["success failure cancelled cancelled cancelled", false],
    ["success success success failure success", false],
  ])("Full CI for the results %s passes: %s", (results, passes) => {
    const script = jobs["gate"]?.steps[0]?.run ?? "";
    let status = 0;
    try {
      execFileSync("sh", ["-c", script], {
        env: { ...process.env, RESULTS: results },
        stdio: "ignore",
      });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status === 0).toBe(passes);
  });
});

function parseJobs() {
  return (
    parse(
      readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          "timeout-minutes"?: number;
          strategy?: {
            "fail-fast"?: boolean;
            matrix?: { shard?: number[] };
          };
        }
      >;
    }
  ).jobs;
}

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

describe("concurrency", () => {
  const group = (name: string) =>
    (
      parse(readFileSync(join(root, ".github", "workflows", name), "utf8")) as {
        concurrency: { group: string; "cancel-in-progress": string };
      }
    ).concurrency;

  it.each(["ci.yml", "codeql.yml"])(
    "%s keeps a draft apart from a ready pull request, and never cancels a push to main",
    (name) => {
      const { group: expression, "cancel-in-progress": cancel } = group(name);
      expect(expression).toContain(
        "github.event.pull_request.draft && 'draft' || 'ready'",
      );
      expect(expression).toContain("|| github.run_id }}");
      expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
    },
  );
});

describe("CodeQL", () => {
  const { on, jobs } = parse(
    readFileSync(join(root, ".github", "workflows", "codeql.yml"), "utf8"),
  ) as {
    on: {
      push?: unknown;
      pull_request?: {
        branches?: string[];
        types?: string[];
        "paths-ignore"?: string[];
      };
      schedule?: { cron: string }[];
    };
    jobs: Record<string, { if?: string }>;
  };
  const ignored = on.pull_request?.["paths-ignore"] ?? [];
  const skips = (path: string) =>
    ignored.some((pattern) => filterMatches(pattern, path));
  const instructions = [
    "**/*.md",
    "LICENSE",
    ".claude/**",
    ".agents/**",
    ".codex/**",
    ".githooks/**",
    ".github/ISSUE_TEMPLATE/**",
  ];

  it("analyzes a pull request or a push to main unless it changes only documentation or agent instructions, and the whole tree once a week", () => {
    expect(on.push).toEqual({
      branches: ["main"],
      "paths-ignore": instructions,
    });
    expect(on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
      "paths-ignore": instructions,
    });
    expect(on.schedule).toHaveLength(1);
    expect(on.schedule?.[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
  });

  it("analyzes a draft only once it is marked ready for review", () => {
    expect(jobs["analyze"]?.if).toBe("${{ !github.event.pull_request.draft }}");
  });

  it("skips what the classifier also reads as documentation, and no code in a language it analyzes", () => {
    for (const path of [
      "README.md",
      "connectors/todoist/README.md",
      "LICENSE",
      ".claude/settings.json",
      ".agents/skills/x/helper.py",
      ".codex/config.toml",
      ".githooks/pre-push",
      ".github/ISSUE_TEMPLATE/bug.yml",
    ]) {
      expect(skips(path), path).toBe(true);
      expect(affected(path).jobs.size, path).toBe(0);
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
  const bin = join(directory, "bin");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  /** Writes each path (a `from=>to` pair moves one) and commits, returning the commit. */
  const commit = (message: string, ...paths: string[]) => {
    for (const path of paths) {
      const [from, to] = path.split("=>");
      if (to !== undefined && from !== undefined) {
        mkdirSync(dirname(join(directory, to)), { recursive: true });
        git("mv", from, to);
      } else {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        appendFileSync(join(directory, path), `${message}\n`);
        git("add", path);
      }
    }
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  let base = "";
  let docs = "";
  let agents = "";
  let code = "";
  let workflow = "";
  let moved = "";
  let elsewhere = "";

  beforeAll(() => {
    git("init", "-q");
    git("config", "user.email", "fixture@example.com");
    git("config", "user.name", "CI Fixture");
    git("config", "commit.gpgsign", "false");
    base = commit("base");
    docs = commit("docs", "README.md");
    agents = commit(
      "agents",
      "AGENTS.md",
      ".agents/skills/x/helper.py",
      ".codex/config.toml",
      ".githooks/pre-push",
    );
    code = commit("code", "kit/src/main.ts");
    workflow = commit("workflow", ".github/workflows/audit.yml");
    moved = commit("move", "kit/src/main.ts=>.agents/skills/x/main.ts");
    git("checkout", "-q", "-b", "elsewhere", base);
    elsewhere = commit("documentation on a line without the code", "NOTES.md");
    // A stand-in for the API: FAKE_RUNS is the count of green runs it reports.
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      '#!/usr/bin/env bash\necho "$*" >>"$FAKE_GH_LOG"\n[[ "$FAKE_RUNS" == error ]] && exit 1\necho "{\\"total_count\\": $FAKE_RUNS}"\n',
      { mode: 0o755 },
    );
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function outputs(
    event: string,
    from: string,
    to: string,
    options: { draft?: boolean; runs?: string } = {},
  ): string {
    const eventPath = join(directory, "event.json");
    const output = join(directory, "output");
    writeFileSync(
      eventPath,
      JSON.stringify(
        event === "push"
          ? { before: from, after: to }
          : {
              pull_request: {
                base: { sha: from },
                head: { sha: to },
                draft: options.draft,
              },
            },
      ),
    );
    writeFileSync(output, "");
    writeFileSync(join(directory, "gh.log"), "");
    execFileSync(process.execPath, [script], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        FAKE_GH_LOG: join(directory, "gh.log"),
        FAKE_RUNS: options.runs ?? "1",
        GITHUB_REPOSITORY: "example/repository",
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
      },
      stdio: "ignore",
    });
    return readFileSync(output, "utf8");
  }

  const skipped =
    "code=false\ntests=false\nproof=false\nimage=false\nfull=true\nscope=all\n";
  const everything =
    "code=true\ntests=true\nproof=true\nimage=true\nfull=true\nscope=all\n";

  it("skips the code checks and the proof for documentation", () => {
    expect(outputs("pull_request", base, docs)).toBe(skipped);
  });

  it("skips them for agent files alone, and runs them for the code beside them", () => {
    expect(outputs("pull_request", docs, agents)).toBe(skipped);
    expect(outputs("pull_request", agents, code)).toBe(everything);
    expect(outputs("pull_request", base, code)).toBe(everything);
  });

  it("runs everything for a workflow, and for a move of code into an agent directory", () => {
    expect(outputs("pull_request", code, workflow)).toBe(everything);
    expect(outputs("pull_request", workflow, moved)).toBe(everything);
  });

  it("runs only the quick checks for a draft, whatever the diff, and all of them once it is ready", () => {
    expect(outputs("pull_request", base, docs, { draft: true })).toBe(
      "code=false\ntests=false\nproof=false\nimage=false\nfull=false\nscope=all\n",
    );
    expect(outputs("pull_request", "invalid", docs, { draft: true })).toBe(
      "code=true\ntests=false\nproof=false\nimage=false\nfull=false\nscope=all\n",
    );
    expect(outputs("pull_request", base, docs, { draft: false })).toBe(skipped);
  });

  it("runs everything for an unreadable diff and an empty one", () => {
    expect(outputs("pull_request", "invalid", docs)).toBe(everything);
    expect(outputs("pull_request", docs, docs)).toBe(everything);
    expect(outputs("push", docs, docs)).toBe(everything);
  });

  it("classifies a push after a commit with a green run, as a pull request is", () => {
    expect(outputs("push", base, docs)).toBe(skipped);
    expect(outputs("push", docs, agents, { runs: "3" })).toBe(skipped);
    expect(outputs("push", agents, code)).toBe(everything);
    expect(outputs("push", code, workflow)).toBe(everything);
    expect(outputs("push", workflow, moved)).toBe(everything);
  });

  it("asks which push runs of ci.yml on main succeeded for the commit before the push", () => {
    outputs("push", base, docs);
    const asked = readFileSync(join(directory, "gh.log"), "utf8");
    expect(asked).toContain("actions/workflows/ci.yml/runs?");
    expect(asked).toContain(`head_sha=${base}&`);
    expect(asked).toContain("event=push&branch=main&status=success");
    outputs("pull_request", base, docs);
    expect(readFileSync(join(directory, "gh.log"), "utf8")).toBe("");
  });

  it("runs everything for a push when the commit before it has no green run, or that cannot be told", () => {
    expect(outputs("push", base, docs, { runs: "0" })).toBe(everything);
    expect(outputs("push", base, docs, { runs: "error" })).toBe(everything);
    expect(outputs("push", base, docs, { runs: '"many"' })).toBe(everything);
  });

  it("runs everything for a push that is not a fast-forward, a new branch and a bad commit", () => {
    expect(outputs("push", code, elsewhere)).toBe(everything);
    expect(outputs("push", "0".repeat(40), docs)).toBe(everything);
    expect(outputs("push", "invalid", docs)).toBe(everything);
  });

  it("runs everything for a schedule and a manual run", () => {
    expect(outputs("schedule", base, docs)).toBe(everything);
    expect(outputs("workflow_dispatch", base, docs)).toBe(everything);
  });
});
