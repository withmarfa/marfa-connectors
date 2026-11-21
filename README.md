# plugins

WithMarfa's plugins for [Marfa](https://github.com/withmarfa/marfa). What an owner adds to a Marfa is a plugin: a connector, a family of common types with guidance on using them, or both. This repository holds the connectors, built from source today, and the kit and template they are built from. It will also hold the common type families: the first, Tickets, is on its way, and installing a plugin into a Marfa arrives with it.

## Connectors

A connector is a small process that holds a key to a Marfa instance. It registers itself, heartbeats, pulls from a vendor, receives what the vendor posts to its inbound endpoints, writes what it finds, by default into the instance's feed, under its own type, carries changes made in Marfa back to the vendor where it is meant to, and reports each run. A connector never puts what it reads from a vendor into the library on its own. It may name the library tier only for a row that belongs to something already in the library, such as the picture files of an entry the owner has kept; moving a vendor's row to the library is a person's or an app's act.

## What is here

- [`types/`](./types/README.md): empty for now. It will hold the common type families, one folder each, starting with Tickets.
- [`kit/`](./kit): the package `@withmarfa/connector`, which makes a connector a page of code.
- [`shared/`](./shared): private packages that related connectors share: Readwise's schemas and mappings, and the Google sign-in in [`shared/google`](./shared/google/README.md). They are never published.
- [`template/`](./template): what a new connector starts from. Its [README](./template/README.md) is the guide to writing one, minting its key, running it, and deploying it with launchd or Docker.
- [`connectors/`](./connectors): the connectors, one folder each, run and never published.
  - [`github`](./connectors/github/README.md): repositories, issues, discussions, comments, read-only pull requests and retained issue/comment files from a personal token or GitHub App, with relations, closing issues and checks; App runs carry issue, discussion and comment edits back.
  - [`todoist`](./connectors/todoist/README.md): a Todoist account's tasks, with changes carried back.
  - [`readwise`](./connectors/readwise/README.md): sources and complete highlights from one Readwise account, read only, with resumable export checkpoints.
  - [`readwise-reader`](./connectors/readwise-reader/README.md): Reader documents, highlights, retained content, and supported two-way edits, with independent registration and shared identities.
  - [`rss`](./connectors/rss/README.md): the entries of the feeds it is given, read only, and on request the pictures they point to, saved as files.
  - [`google-calendar`](./connectors/google-calendar/README.md): a Google account's calendars and events, with series, changed occurrences and cancellations, and changes to events carried back.
- [`connectors.json`](./connectors.json): the list of the connectors above, generated from each connector's own definition, for anything that needs to know which connectors exist, what they can write and whether they carry changes back by default. Each entry gives the connector's `directory`, `name`, `description`, `source`, `sourceName`, `sourceMark` (an Iconify icon ID), `types` (every type the connector can write under any of its settings, such as `rss.picture` for RSS when it saves pictures), `carriesBack` (whether it carries changes back in its default mode), `carriesBackCanBeTurnedOff` (whether a setting or mode switches that off, as GitHub's personal token and `GITHUB_READ_ONLY`, `TODOIST_READ_ONLY` and `READWISE_READER_INBOUND_ONLY` do) and `carriedTypes`, and leaves out a field its definition does not set. The list is the same whatever the environment of the person who generates it. Several connectors can share one `source`. `pnpm build`, then `pnpm connectors:list` regenerates it, and CI fails when it is out of date.
- [`scripts/`](./scripts): prepares the pinned Marfa server, holds the proof, which boots the pinned server and drives every connector against it, and holds the tests that guard the repository itself.

[`AGENTS.md`](./AGENTS.md) holds the rules the repository is worked under.

## Run a connector by hand

The connector runtime needs Node 22.12 or later. Repository tooling uses pnpm 11, which needs Node 22.13 or later. You also need Rust (for the `marfa` CLI), a Marfa server and a key for the connector.

The kit and proof use the published `@withmarfa/client` version pinned in their manifests and the lockfile. Install and build without a server checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
```

The proof server is independently pinned in `scripts/monorepo.commit`. Run `scripts/monorepo.sh` before `pnpm proof`. It downloads `marfa-server` from the Marfa release whose tag names that commit, checks it against the release's checksums and leaves it in `vendor/marfa-server`. The proof boots that server on a free port with a temporary database, claims the owner through its control socket, mints its keys there, uses the installed registry client against it, and stops it afterward. Set `MARFA_SERVER_BIN` to a `marfa-server` of your own to boot that instead.

A release server is built without test hooks, so it cannot shorten the connector hold, which two proof groups need. Run `scripts/monorepo.sh hooks` to build the pinned commit's server with test hooks into `vendor/marfa-server-hooks`, or set `MARFA_HOOKS_SERVER_BIN` to one you built. This needs Rust.

To run a connector against a server of your own, follow the Quick start in the Marfa repository's README, and use the `marfa` command line from the same release so its commands match the server.

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

`pnpm proof` boots the pinned server and proves each connector against it. `pnpm proof --shard 2/3` runs the second of three shards of the proof, each of which boots a server of its own; `scripts/proof/shards.ts` lists the groups and how long each takes.
