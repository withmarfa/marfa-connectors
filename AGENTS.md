# marfa-connectors

The connectors for Marfa: a small kit that makes a connector a page of code, a template to copy, and the connectors themselves, one folder each. A connector is a process with a key: it registers itself with an instance, heartbeats, pulls from its vendor, reads what its vendor posts to its webhook endpoints, writes what it finds at the feed tier under its own type, carries changes made in Marfa back to the vendor where its brief says so, and reports each run. It writes to the vendor only through the kit's watch phase, and never writes into library types; promoting is a person's or an app's act.

## Layout

- `kit/`: the package `@withmarfa/connector`, the only thing here that is imported.
- `template/`: what a new connector starts from. `template/connector/` is copied to `connectors/<name>/`; beside it are its README, a LaunchAgent and a Dockerfile.
- `connectors/<name>/`: one folder per connector, run and never published.
- `scripts/`: the scripts that fetch the pinned monorepo and pack the client into `vendor/`, the proof harness, which builds a connector of its own on the kit, with the vendor stubs it shares with the connectors' tests, and tests that refuse a version in a manifest or a file holding one, a home directory, machine name or personal address, tracked build output, a package left out of the build, and a workflow job off standard GitHub-hosted runners.

## Commands

`scripts/monorepo.sh` fetches the monorepo at the commit `scripts/monorepo.commit` pins into `vendor/marfa` and installs it. `scripts/vendor-client.sh` packs `@withmarfa/client` from that checkout into `vendor/withmarfa-client.tar`, which the override in `pnpm-workspace.yaml` names. Both run before `pnpm install`. Then `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`. After a build, `pnpm proof` boots the pinned server and proves against it.

Moving the pin: write the commit into `scripts/monorepo.commit`, run both scripts, then `pnpm install --no-frozen-lockfile`, since the lockfile holds the packed client's integrity, and commit the lockfile with the pin.

## Secrets

A connector reads its secrets from the environment, and nothing here holds a value. `.infisical.json` maps this repository to its Infisical project, environment and path, so a run by hand that needs a secret takes it from there with `aic-infisical-run -- <command>` from the checkout, which puts the values into the command's environment without printing them.

- Independent pull requests and hosted jobs may run concurrently. Do not delay pushes or verification to ration a personal runner pool. Keep dependency order for stacked changes and cancel superseded PR runs.

## Versions

- Every version is the previous one plus 0.0.1, whatever the size of the change. Numbering starts from 0: the first version is 0.0.1.
- A version exists only as a git tag. A tag is created only when a release is called for, never on a session's own initiative, and no one writes a version into a file.

## In force

- American English in code, comments and commits. Scoped Conventional Commits (`feat(kit):`, `fix(rss):`).
- Feature branches and pull requests; never push `main`. A session merges its own pull request once every required check is green and the review its risk calls for is done, with that depth stated on the pull request: squash, branch deleted.
- Before closing, remove the worktrees you created once their branches are merged, with `git worktree remove`, and run `git worktree prune`; if git refuses one, report it rather than forcing it.
- This repository is public while development continues. Public visibility is not a release milestone.
- Every Actions workflow uses standard GitHub-hosted runners, never personal self-hosted runners or paid third-party runners.
- `scripts/ci-changes.ts` decides what a pull request runs: `Checks` always formats and scans every file, and it builds, lints and tests, and `Proof` runs, only for a change that can affect them. Markdown anywhere is documentation, and an unnamed path or a push runs everything. A skipped job passes its required check; `scripts/test/ci-changes.test.ts` pins the rules.
- No personal detail of any machine or person in this repository: no absolute paths, hostnames, account names or credentials. Configuration comes from the environment.
- Removed means gone: no shims, no aliases, no compatibility paths.
- A comment survives only if it explains a why the code cannot; when in doubt, it goes.
- TypeScript, strict, on Node 22 or later. The transport is `@withmarfa/client` and nothing else.
