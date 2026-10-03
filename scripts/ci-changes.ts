/**
 * Which CI jobs a pull request's changes can affect.
 *
 * `Checks` always formats every file and reads it for personal details, so
 * it runs for any change; `code` says whether it also builds, typechecks, lints and runs every test. `Proof` runs only
 * when `proof` is true, and `Image`, which builds the template's image and
 * checks the launchd example, only when `image` is true. A skipped job
 * satisfies a required check where a workflow filtered out by `paths` would
 * leave it pending. A push to `main`, an empty diff and one that cannot be
 * read answer `true` for every job.
 *
 * A draft pull request runs only the quick checks: `Checks` without its
 * tests, so `Proof` and `Image` answer `false` for it. `full` says whether
 * the rest runs, and is `false` only for a draft. Marking the pull request
 * ready for review starts a run that does, and so does every push after.
 *
 * A path is matched against `RULES` in order and the first match names the
 * jobs it can affect. A path no rule matches affects every job.
 * `scripts/test/ci-changes.test.ts` pins the rules.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const JOBS = ["code", "proof", "image"] as const;

export type Job = (typeof JOBS)[number];

const ALL: readonly Job[] = JOBS;

/** First match wins. */
export const RULES: readonly (readonly [RegExp, readonly Job[]])[] = [
  // What decides what runs is proven on everything it decides.
  [/^scripts\/ci-changes\.ts$/, ALL],
  [/^\.github\/workflows\/ci\.yml$/, ALL],
  // A test pins when CodeQL runs.
  [/^\.github\/workflows\/codeql\.yml$/, ["code"]],
  [/^\.github\//, []],

  // A fixture is test input, and the proof reads the RSS connector's.
  [/(^|\/)(fixtures|__fixtures__|testdata)\//, ALL],
  // Markdown, the licence and settings are read only by Prettier and the
  // personal-detail scan, which `Checks` runs for every change.
  [/\.md$/i, []],
  [/^(LICENSE|\.claude\/.*|\.gitignore|\.prettierignore)$/, []],

  // The proof runs every connector from what `pnpm build` makes, and the
  // build leaves tests out.
  [/^(kit|connectors\/[^/]+)\/test\//, ["code"]],
  [/^scripts\/(test\/|no-skipped-tests\.ts$)/, ["code"]],
  // The image copies the tree, so a source or dependency change, which runs
  // every job, reaches it too. These only the image and its checks read.
  [
    /^(template\/(Dockerfile|launchd\.plist\.example)|\.dockerignore)$/,
    ["image"],
  ],
  [/^scripts\/check-image-client\.ts$/, ["code", "image"]],
  [/^(eslint\.config\.js|vitest\.config\.ts|tsconfig\.check\.json)$/, ["code"]],
];

/** The jobs one changed path can affect. */
export function affected(path: string): Set<Job> {
  const rule = RULES.find(([pattern]) => pattern.test(path));
  return new Set<Job>(rule ? rule[1] : ALL);
}

/** Each job's answer for a set of changed paths. An empty set runs everything. */
export function classify(paths: readonly string[]): Record<Job, boolean> {
  const jobs = new Set<Job>(paths.length === 0 ? ALL : []);
  for (const path of paths) {
    for (const job of affected(path)) jobs.add(job);
  }
  return Object.fromEntries(JOBS.map((job) => [job, jobs.has(job)])) as Record<
    Job,
    boolean
  >;
}

/** What a draft pull request still runs, whatever it changes. */
export function forDraft(answer: Record<Job, boolean>): Record<Job, boolean> {
  return { ...answer, proof: false, image: false };
}

interface PullRequestEvent {
  pull_request: {
    draft?: boolean;
    base: { sha: string };
    head: { sha: string };
  };
}

/** The event of a pull request run, or `undefined` for any other event. */
function pullRequestEvent(): PullRequestEvent | undefined {
  if (process.env["GITHUB_EVENT_NAME"] !== "pull_request") return undefined;
  return JSON.parse(
    readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8"),
  ) as PullRequestEvent;
}

/** The pull request's changed paths. */
function changedPaths(event: PullRequestEvent): string[] {
  const base = event.pull_request.base.sha;
  const head = event.pull_request.head.sha;
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error("Missing commit IDs");
  }
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
  let answer = classify([]);
  let draft = false;
  try {
    const event = pullRequestEvent();
    if (event !== undefined) {
      draft = event.pull_request.draft === true;
      answer = classify(changedPaths(event));
    }
  } catch {
    // An unreadable diff must never turn a code change into a skipped job.
    console.log("Could not classify the change; running every job.");
  }
  if (draft) answer = forDraft(answer);
  const lines =
    JOBS.map((job) => `${job}=${String(answer[job])}\n`).join("") +
    `full=${String(!draft)}\n`;
  appendFileSync(process.env["GITHUB_OUTPUT"] ?? "", lines);
  process.stdout.write(lines);
}
