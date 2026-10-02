/**
 * Which CI jobs a pull request's changes can affect.
 *
 * `Checks` always formats every file and reads it for personal details, so
 * it runs for any change; `code` says whether it also fetches the pinned
 * monorepo, builds, typechecks, lints and runs every test. `Proof` runs only
 * when `proof` is true, and a skipped job satisfies a required check where a
 * workflow filtered out by `paths` would leave it pending. A push to `main`,
 * an empty diff and one that cannot be read answer `true` for every job.
 *
 * A path is matched against `RULES` in order and the first match names the
 * jobs it can affect. A path no rule matches affects every job.
 * `scripts/test/ci-changes.test.ts` pins the rules.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const JOBS = ["code", "proof"] as const;

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
  [
    /^(LICENSE|\.claude\/.*|\.gitignore|\.prettierignore|\.dockerignore|\.infisical\.json)$/,
    [],
  ],

  // The proof runs every connector from what `pnpm build` makes, and the
  // build leaves tests out.
  [/^(kit|connectors\/[^/]+)\/test\//, ["code"]],
  [/^scripts\/(test\/|no-skipped-tests\.ts$)/, ["code"]],
  [/^template\/(Dockerfile|launchd\.plist\.example)$/, []],
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
  return { code: jobs.has("code"), proof: jobs.has("proof") };
}

/** The pull request's changed paths, or `undefined` for any other event. */
function changedPaths(): string[] | undefined {
  if (process.env["GITHUB_EVENT_NAME"] !== "pull_request") return undefined;
  const event = JSON.parse(
    readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8"),
  ) as { pull_request: { base: { sha: string }; head: { sha: string } } };
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
  try {
    const paths = changedPaths();
    if (paths !== undefined) answer = classify(paths);
  } catch {
    // An unreadable diff must never turn a code change into a skipped job.
    console.log("Could not classify the change; running every job.");
  }
  const lines = JOBS.map((job) => `${job}=${String(answer[job])}\n`).join("");
  appendFileSync(process.env["GITHUB_OUTPUT"] ?? "", lines);
  process.stdout.write(lines);
}
