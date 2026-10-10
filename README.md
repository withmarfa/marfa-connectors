# marfa-connectors

Connectors for [Marfa](https://github.com/withmarfa/marfa). A connector is a small process that holds a key to a Marfa instance. It registers itself, heartbeats, pulls from a vendor, receives what the vendor posts to its webhook endpoints, writes what it finds into the instance's feed under its own type, carries changes made in Marfa back to the vendor where it is meant to, and reports each run. A connector never writes into library types; promoting a row is a person's or an app's act.

## What is here

- [`kit/`](./kit): the package `@withmarfa/connector`, which makes a connector a page of code. It is the only package here that is imported.
- [`template/`](./template): what a new connector starts from. Its [README](./template/README.md) is the guide to writing one, minting its key, running it, and deploying it with launchd or Docker.
- [`connectors/`](./connectors): the connectors, one folder each, run and never published.
  - [`github`](./connectors/github/README.md): repositories, issues and comments from a GitHub App, with their relations, and changes carried back to issues and comments.
  - [`todoist`](./connectors/todoist/README.md): a Todoist account's tasks, with changes carried back.
  - [`rss`](./connectors/rss/README.md): the entries of the feeds it is given, read only.
- [`scripts/`](./scripts): prepares the pinned Marfa server, holds the proof, which boots the pinned server and drives every connector against it, and holds the tests that guard the repository itself.

[`AGENTS.md`](./AGENTS.md) holds the rules the repository is worked under.

## Run a connector by hand

The connector runtime needs Node 22.12 or later. Repository tooling uses pnpm 11, which needs Node 22.13 or later. You also need Rust (for the `marfa` CLI), a Marfa server and a key for the connector.

The kit and proof use the published `@withmarfa/client` version pinned in their manifests and the lockfile. Install and build without a server checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
```

The proof server is independently pinned in `scripts/monorepo.commit`. Run `scripts/monorepo.sh` before `pnpm proof`; it prepares only the server checkout, and the proof uses the installed registry client.

`scripts/monorepo.sh` leaves a checkout of the Marfa monorepo in `vendor/marfa`. Build its server and boot a throwaway one, which exports the server's address as `MARFA_TEST_URL`, an ordinary working key as `MARFA_TEST_KEY`, and the private socket as `MARFA_TEST_SOCKET`. The launcher claims the owner through that socket, and the proof uses it to mint a separate ordinary key with `connectors.manage` and `keys.manage` for report inspection and key administration. It narrows the working key to the seven existing permissions, removing management access. Stop the server afterward:

```bash
scripts/monorepo.sh
(cd vendor/marfa && pnpm --filter "@withmarfa/server..." build)
env_text="$(vendor/marfa/core/scripts/server-up.sh)" && eval "${env_text}"
vendor/marfa/core/scripts/server-down.sh "${MARFA_SERVER_ENV}"
```

That first key holds every permission, so it is for minting the connector's key, and a connector refuses to run on it.

To use a server of your own, follow the Quick start in the Marfa repository's README. Either way you need the `marfa` command-line tool, built from the same checkout so its commands match the server:

```bash
cargo install --locked --path vendor/marfa/core/marfa-cli
```

Mint the connector's own key with `marfa keys create`, as [the template's README](./template/README.md#the-key) describes. Then run the connector once with the connector's key:

```bash
export MARFA_API_URL=<the server's address>
export MARFA_API_KEY=<the connector's key>
node connectors/<name>/dist/main.js --once
```

A connector also reads the settings its own README names, such as a vendor token.

The CLI and a connector read the server's address and the key from the same two settings, `MARFA_API_URL` and `MARFA_API_KEY`. A connector's key is its own, so set the connector's key in the connector's environment, not the one you use for the CLI.

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
