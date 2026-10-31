/**
 * Which CI jobs a change can affect.
 *
 * `Checks` always formats every file and reads it for personal details, so
 * it runs for any change; `code` says whether it also builds, typechecks and
 * lints. `tests` says whether the unit tests run, and `scope` which of them.
 * `Proof` runs only when `proof` is true, and `Image`, which builds the
 * template's image and checks the launchd example, only when `image` is true.
 * A skipped job satisfies a required check where a workflow filtered out by
 * `paths` would leave it pending. A pull request is classified by its diff
 * against its base, and a push to `main` by its diff against the commit it
 * follows, but only when that commit had a green push run of `ci.yml`:
 * otherwise a commit that touches nothing a job reads would show green on top
 * of a commit that was never checked or was red. An empty diff, one that
 * cannot be read, a push that does not descend from the commit before it, a
 * schedule and a manual run answer `true` for every job and `all` for the
 * scope.
 *
 * A draft pull request runs only the quick checks: `Checks` without its
 * tests, so `tests`, `Proof` and `Image` answer `false` for it. `full` says
 * whether the rest runs, and is `false` only for a draft. Marking the pull
 * request ready for review starts a run that does, and so does every push
 * after.
 *
 * A path is matched against `RULES` in order and the first match names the
 * jobs it can affect. A path no rule matches affects every job. A path inside
 * one connector, and not its fixtures, also names that connector, and when
 * every path that runs the tests names one, `scope` lists that connector's
 * folders and the repository scan; any other path makes the scope `all`.
 * `scripts/test/ci-changes.test.ts` pins the rules.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const JOBS = ["code", "tests", "proof", "image"] as const;

export type Job = (typeof JOBS)[number];

const ALL: readonly Job[] = JOBS;

/** What the pattern's match says about the tests it runs: a connector. */
type Connector = (match: RegExpExecArray) => string | undefined;

const connectorOf: Connector = (match) => match[1];

/**
 * The files of `scripts/proof/` that a unit test imports, directly or through
 * another: a change to one runs the tests, which a change to the rest of the
 * proof does not. `scripts/test/ci-changes.test.ts` finds the same set in the
 * imports.
 */
export const proofFilesTestsReach = [
  "check",
  "checkpoint",
  "checkpoint-connector",
  "connector",
  "github-notifications-stub",
  "github-stub",
  "inbound-wait",
  "server",
  "shards",
  "todoist-stub",
];

/** First match wins. */
export const RULES: readonly (readonly [RegExp, readonly Job[], Connector?])[] =
  [
    // What decides what runs is proven on everything it decides, and a change
    // to any workflow runs everything.
    [/^scripts\/ci-changes\.ts$/, ALL],
    [/^\.github\/workflows\//, ALL],
    [/^\.github\//, []],

    // A fixture is test input, and the proof reads the RSS connector's.
    [/(^|\/)(fixtures|__fixtures__|testdata)\//, ALL],
    // Markdown, the licence, settings and the instructions for agents are read
    // only by Prettier and the personal-detail scan, which `Checks` runs for
    // every change.
    [/\.md$/i, []],
    [
      /^(LICENSE|\.(claude|agents|codex|githooks)\/.*|\.gitignore|\.prettierignore)$/,
      [],
    ],

    // The proof runs every connector from what `pnpm build` makes, and the
    // build leaves tests out. A test of one connector runs that connector's.
    [/^connectors\/([a-z0-9-]+)\/test\//, ["code", "tests"], connectorOf],
    [/^(kit|shared\/[^/]+)\/test\//, ["code", "tests"]],
    [
      /^scripts\/(test\/|no-skipped-tests\.ts$|retried-tests\.ts$|check-pr-description\.ts$)/,
      ["code", "tests"],
    ],
    // The proof is built and linted like the rest of the code. Its stubs and
    // helpers are also what the unit tests import; its scenarios are not.
    [
      new RegExp(`^scripts/proof/(${proofFilesTestsReach.join("|")})\\.ts$`),
      ["code", "tests", "proof"],
    ],
    [/^scripts\/proof\//, ["code", "proof"]],
    // The image copies the tree, so a source or dependency change, which runs
    // every job, reaches it too. These only the image and its checks read.
    [
      /^(template\/(Dockerfile|launchd\.plist\.example)|\.dockerignore)$/,
      ["image"],
    ],
    [/^scripts\/check-image-client\.ts$/, ["code", "tests", "image"]],
    [
      /^(eslint\.config\.js|vitest\.config\.ts|tsconfig\.check\.json)$/,
      ["code", "tests"],
    ],
    // Anything else in one connector. A connector depends on the kit and on
    // `shared/`, and nothing depends on a connector, which
    // `scripts/test/ci-changes.test.ts` checks.
    [/^connectors\/([a-z0-9-]+)\//, ALL, connectorOf],
  ];

/** The jobs one changed path can affect, and the connector it is inside. */
export function affected(path: string): {
  jobs: Set<Job>;
  connector: string | undefined;
} {
  for (const [pattern, jobs, connector] of RULES) {
    const match = pattern.exec(path);
    if (match) return { jobs: new Set(jobs), connector: connector?.(match) };
  }
  return { jobs: new Set<Job>(ALL), connector: undefined };
}

/** Each job's answer for a set of changed paths, and the tests' scope. */
export type Answer = Record<Job, boolean> & { scope: string };

/** Each job's answer for a set of changed paths. An empty set runs everything. */
export function classify(paths: readonly string[]): Answer {
  const jobs = new Set<Job>(paths.length === 0 ? ALL : []);
  const connectors = new Set<string>();
  let everything = paths.length === 0;
  for (const path of paths) {
    const found = affected(path);
    for (const job of found.jobs) jobs.add(job);
    if (found.jobs.has("tests")) {
      if (found.connector === undefined) everything = true;
      else connectors.add(found.connector);
    }
  }
  const scope =
    everything || connectors.size === 0
      ? "all"
      : [...connectors]
          .sort()
          .map((name) => `connectors/${name}/`)
          .concat("scripts/test/tree.test.ts")
          .join(" ");
  return {
    ...(Object.fromEntries(JOBS.map((job) => [job, jobs.has(job)])) as Record<
      Job,
      boolean
    >),
    scope,
  };
}

/** What a draft pull request still runs, whatever it changes. */
export function forDraft(answer: Answer): Answer {
  return { ...answer, tests: false, proof: false, image: false };
}

/** What one event changed, and what it takes to trust the diff. */
interface Change {
  base: string;
  head: string;
  draft: boolean;
  /** A push is classified only after a commit with a green run. */
  push: boolean;
}

interface PullRequestEvent {
  pull_request: {
    draft?: boolean;
    base: { sha: string };
    head: { sha: string };
  };
}

interface PushEvent {
  before: string;
  after: string;
}

/** The change a pull request or push run is for, or `undefined` for any other event. */
function readChange(): Change | undefined {
  const name = process.env["GITHUB_EVENT_NAME"];
  if (name !== "pull_request" && name !== "push") return undefined;
  const event = JSON.parse(
    readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8"),
  ) as PullRequestEvent & PushEvent;
  if (name === "push") {
    return { base: event.before, head: event.after, draft: false, push: true };
  }
  return {
    base: event.pull_request.base.sha,
    head: event.pull_request.head.sha,
    draft: event.pull_request.draft === true,
    push: false,
  };
}

/**
 * Throws unless the push fast-forwards from a commit that had a green push run
 * of this workflow on `main`, so that the skip of a job never lets a commit
 * look green on top of one that was red, cancelled or never run.
 */
function assertPreviousGreen(base: string, head: string): void {
  execFileSync("git", ["merge-base", "--is-ancestor", base, head], {
    stdio: "ignore",
  });
  const runs = execFileSync(
    "gh",
    [
      "api",
      `repos/${process.env["GITHUB_REPOSITORY"] ?? ""}/actions/workflows/ci.yml/runs?head_sha=${base}&event=push&branch=main&status=success&per_page=1`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const count = (JSON.parse(runs) as { total_count?: unknown }).total_count;
  if (typeof count !== "number" || count < 1) {
    throw new Error("The commit before the push has no green run");
  }
}

/** The changed paths. */
function changedPaths({ base, head, push }: Change): string[] {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error("Missing commit IDs");
  }
  if (push) assertPreviousGreen(base, head);
  // No rename detection, so moving code into a documentation path still
  // counts the deletion of its original path. NULs keep unusual names whole.
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let answer: Answer = classify([]);
  let draft = false;
  try {
    const change = readChange();
    if (change !== undefined) {
      draft = change.draft;
      answer = classify(changedPaths(change));
    }
  } catch {
    // An unreadable diff must never turn a code change into a skipped job.
    console.log("Could not classify the change; running every job.");
  }
  if (draft) answer = forDraft(answer);
  const lines =
    JOBS.map((job) => `${job}=${String(answer[job])}\n`).join("") +
    `full=${String(!draft)}\nscope=${answer.scope}\n`;
  appendFileSync(process.env["GITHUB_OUTPUT"] ?? "", lines);
  process.stdout.write(lines);
}
