# marfa-connectors

The connectors for Marfa: a small kit that makes a connector a page of code, a template to copy, and the connectors themselves, one folder each. A connector is a process with a key: it registers itself with an instance, heartbeats, pulls from its vendor, writes what it finds at the feed tier under its own type and source, and reports each run. It never writes to the vendor and never writes into library types; promoting is a person's or an app's act.

## Layout

- `kit/`: the package `@withmarfa/connector`, the only thing here that is imported.
- `template/`: what a new connector starts from.
- `connectors/<name>/`: one folder per connector, run and never published.
- `scripts/`: the pinned monorepo checkout, the client tarball, the proof harness, and the tests that hold the tree to the rules below.

## Commands

`scripts/monorepo.sh` fetches the monorepo at the commit `scripts/monorepo.commit` pins into `vendor/marfa` and installs it. `scripts/vendor-client.sh` packs `@withmarfa/client` from that checkout into `vendor/`, which the override in `pnpm-workspace.yaml` names. Both run before `pnpm install`. Then `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`. After a build, `pnpm proof` boots the pinned server and holds each connector to it.

## Secrets

A connector reads its secrets from the environment, and nothing here holds a value. A run by hand that needs one runs under `aic-infisical-run -- <command>` from the checkout, which reads `.infisical.json` and puts the values into the command's environment without printing them.

## Versions

- Every version is the previous one plus 0.0.1, whatever the size of the change. Numbering starts from 0: the first version is 0.0.1.
- A version exists only as a git tag, and tags are the maintainer's. Agents never create a tag or write a version into a file.

## In force

- American English in code, comments and commits. Scoped Conventional Commits (`feat(kit):`, `fix(rss):`).
- Feature branches and pull requests; never push `main`. A session merges its own pull request once every required check is green and its reviewers have run: squash, branch deleted.
- Every Actions workflow runs on the self-hosted runner pool, never on GitHub-hosted runners.
- No personal detail of any machine or person in this repository: no absolute paths, hostnames, account names or credentials. Configuration comes from the environment.
- Removed means gone: no shims, no aliases, no compatibility paths.
- A comment survives only if it explains a why the code cannot.
- TypeScript, strict, on Node 22 or later. The transport is `@withmarfa/client` and nothing else.
