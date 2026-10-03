# marfa-connectors

Connectors for [Marfa](https://github.com/withmarfa/marfa). A connector is a small process that holds a key to a Marfa instance. It registers itself, heartbeats, pulls from a vendor, receives what the vendor posts to its webhook endpoints, writes what it finds into the instance's feed under its own type, carries changes made in Marfa back to the vendor where it is meant to, and reports each run. A connector never writes into library types; promoting a row is a person's or an app's act.

## What is here

- [`kit/`](./kit): the package `@withmarfa/connector`, which makes a connector a page of code. It is the only package here that is imported.
- [`template/`](./template): what a new connector starts from. Its [README](./template/README.md) is the guide to writing one, minting its key, running it, and deploying it with launchd or Docker.
- [`connectors/`](./connectors): the connectors, one folder each, run and never published.
  - [`github`](./connectors/github/README.md): repositories, issues and comments from a GitHub App, with their relations, and changes carried back to issues and comments.
  - [`todoist`](./connectors/todoist/README.md): a Todoist account's tasks, with changes carried back.
  - `rss`: the entries of the feeds it is given, read only.
- [`scripts/`](./scripts): fetches the pinned Marfa monorepo and packs its client, holds the proof, which boots the pinned server and drives every connector against it, and holds the tests that guard the repository itself.

[`AGENTS.md`](./AGENTS.md) holds the rules the repository is worked under.

## Run a connector by hand

You need Node 22.12 or later, pnpm, Rust (for the `marfa` command), a Marfa server and a key for the connector.

The server and its client are pinned in `scripts/monorepo.commit`. Fetch that commit, pack its client, and build:

```bash
scripts/monorepo.sh
scripts/vendor-client.sh
pnpm install
pnpm build
```

The client is packed from the pinned server because the registry client serves contract version 3 while this server serves 0. Remove the tarball override and `scripts/vendor-client.sh` when a published client serves the same contract as the pinned server.

`scripts/monorepo.sh` leaves a checkout of the Marfa monorepo in `vendor/marfa`. Build its server and boot a throwaway one, which exports the server's address as `MARFA_TEST_URL`, a working key as `MARFA_TEST_KEY`, and an operator key for connector report inspection as `MARFA_TEST_OPERATOR_KEY`, and stop it afterward:

```bash
(cd vendor/marfa && pnpm --filter "@withmarfa/server..." build)
env_text="$(vendor/marfa/core/scripts/server-up.sh)" && eval "${env_text}"
vendor/marfa/core/scripts/server-down.sh "${MARFA_SERVER_ENV}"
```

That first key holds every permission, so it is for minting the connector's key, and a connector refuses to run on it.

To use a server of your own, follow the Quick start in the Marfa repository's README. Either way you need the `marfa` command-line tool, built from the same checkout so its commands match the server:

```bash
cargo install --locked --path vendor/marfa/core/marfa-cli
```

Point `marfa` at the server with `MARFA_API_URL` and `MARFA_API_KEY`, and mint the connector's own key with `marfa keys create`, as [the template's README](./template/README.md#the-key) describes. Then run the connector once with the connector's key:

```bash
export MARFA_URL=<the server's address>
export MARFA_KEY=<the connector's key>
node connectors/<name>/dist/main.js --once
```

A connector also reads the settings its own README names, such as a vendor token.

The two programs name their settings differently, so it is easy to set the wrong pair:

| Program             | Server address  | Key             |
| ------------------- | --------------- | --------------- |
| a connector         | `MARFA_URL`     | `MARFA_KEY`     |
| the `marfa` command | `MARFA_API_URL` | `MARFA_API_KEY` |

A connector keeps no file and holds no secret of its own: its state is on the instance, and its secrets come from the environment.

## Check the repository

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm proof
```

`pnpm proof` boots the pinned server and proves each connector against it.
