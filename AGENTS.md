# marfa-connectors

The connectors for Marfa: a small kit that makes a connector a page of code, a template to copy, and the connectors themselves, one folder each. A connector is a process with a key: it registers itself with an instance, heartbeats, pulls from its vendor, writes what it finds at the feed tier under its own type and source, and reports each run. It never writes to the vendor and never writes into library types; promoting is a person's or an app's act.

## Layout

- `kit/`: the package `@withmarfa/connector`, the only thing here that is imported.
- `template/`: what a new connector starts from.
- `connectors/<name>/`: one folder per connector, run and never published.
- `scripts/`: the client tarball and the proof harness.

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
