# marfa-connectors

The connectors for Marfa: a small kit that makes a connector a page of code, a template to copy, and the connectors themselves, one folder each. A connector is a process with a key: it registers itself with an instance, heartbeats, pulls from its vendor, reads what its vendor posts to its webhook endpoints, writes what it finds at the feed tier under its own type, carries changes made in Marfa back to the vendor where its brief says so, and reports each run. It writes to the vendor only through the kit's watch phase, and never writes into library types; promoting is a person's or an app's act.

## Layout

- `kit/`: the package `@withmarfa/connector`, the only thing here that is imported.
- `template/`: what a new connector starts from. `template/connector/` is copied to `connectors/<name>/`; beside it are its README, a LaunchAgent and a Dockerfile.
- `connectors/<name>/`: one folder per connector, run and never published.
- `scripts/`: the pinned proof-server preparation script, the proof harness, which builds a connector of its own on the kit, with the vendor stubs it shares with the connectors' tests, and tests that refuse a version in a manifest or a file holding one, a home directory, machine name or personal address, tracked build output, a package left out of the build, and a workflow job off standard GitHub-hosted runners.

## Commands

Use Node 22.13 or later for pnpm 11; the connector runtime supports Node 22.12 or later. `pnpm install --frozen-lockfile` installs the published client pinned exactly in the kit and scripts manifests. Then run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`. No server checkout is needed for those commands or image builds.

Before `pnpm proof`, run `scripts/monorepo.sh`. It fetches the server at `scripts/monorepo.commit` into `vendor/marfa` and installs it. After a connector build, the proof boots that server and uses the installed registry client against it.

Moving the server pin: write the commit into `scripts/monorepo.commit`, run `scripts/monorepo.sh`, and run the proof. A server-pin change alone does not change the client dependency or lockfile. Change the client explicitly in both consumer manifests and regenerate the lockfile when updating the SDK. `.github/workflows/pin-drift.yml` opens an issue weekly when the server pin is more than 50 commits behind `main`; it is not a check.

## Secrets

A connector reads its secrets from the environment, and nothing here holds a value.

## Versions

- Every version is the previous one plus 0.0.1, whatever the size of the change. Numbering starts from 0: the first version is 0.0.1.
- A version exists only as a git tag. A tag is created only when a release is called for, never on a session's own initiative, and no one writes a version into a file.

## Writing

- Public prose (README, docs, issues, pull requests) follows the Google developer documentation style guide, in American English, with docs organized by Diátaxis: tutorials, how-to guides, reference and explanation kept apart.
- Code comments follow the language's own conventions and survive only if they explain a why the code cannot; when in doubt, they go.

## In force

- American English in code, comments and commits. Scoped Conventional Commits (`feat(kit):`, `fix(rss):`).
- Feature branches and pull requests; never push `main`. A session merges its own pull request once every required check is green and the review its risk calls for is done, with that depth stated on the pull request: squash, branch deleted.
- Before closing, remove the worktrees you created once their branches are merged, with `git worktree remove`, and run `git worktree prune`; if git refuses one, report it rather than forcing it. Once the work is merged, bring the local `main` up to date (`git pull --ff-only` on `main`) so the next piece of work starts from it.
- This repository is public while development continues. Public visibility is not a release milestone.
- Every Actions workflow uses standard GitHub-hosted runners, never personal self-hosted runners or paid third-party runners. Never hold back a push or a check to ration runners; keep stacked changes in order and cancel superseded runs.
- `scripts/ci-changes.ts` decides what a pull request or a push to `main` runs: `Checks` always formats and scans every file, and it builds, lints and tests, `Proof` runs, and `Image` builds the template's image for the template and each connector, checks its client version, contract and runtime/type bytes against the frozen registry install and checks the LaunchAgent example, only for a change that can affect them. Markdown anywhere, the license and the settings and instructions under `.claude/`, `.agents/`, `.codex/` and `.githooks/` are documentation, and an unnamed path, a fixture, a workflow, an empty or unreadable diff, a schedule and a manual run run everything. A push to `main` is classified the same way, but only when the commit before it has a green `ci.yml` push run, and runs everything otherwise, so a documentation commit never shows green over one that was red or unchecked. A skipped job passes its required check; `scripts/test/ci-changes.test.ts` pins the rules. A draft runs only `Checks` without its tests; marking it ready for review, and every push after, runs everything. The last job, `Full CI`, waits for every other job and fails if any failed or was cancelled. On a draft it is named `Draft CI`, so the required `Full CI` stays expected, and blocks a merge, until the run that marking it ready starts has finished; skipped jobs therefore cannot let a pull request merge in the moment between marking it ready and the first full run. `Full CI` and `Pull request description` are the required checks, since a merge waits only on required checks; `.github/workflows/audit.yml`, the dependency audit, which runs weekly, by hand and on a lockfile change, is not.
- `.github/workflows/codeql.yml` analyzes a push to `main` and a pull request that is not a draft, and the whole tree once a week, unless a change is only Markdown, the license, `.claude/`, `.agents/`, `.codex/`, `.githooks/` or `.github/ISSUE_TEMPLATE/`. It is not a required check, so a `paths-ignore` filter starts no run at all for documentation; `scripts/test/ci-changes.test.ts` pins it.
- Every action is pinned by commit with its tag in a comment, and the Dockerfile's base image by digest; Dependabot keeps them current and `scripts/test/tree.test.ts` refuses one that is not.
- No personal detail of any machine or person in this repository: no absolute paths, hostnames, account names or credentials. Configuration comes from the environment.
- Removed means gone: no shims, no aliases, no compatibility paths.
- TypeScript, strict, on Node 22 or later. The transport is `@withmarfa/client` and nothing else.
