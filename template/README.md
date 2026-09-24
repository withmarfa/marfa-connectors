# A new connector

A connector is one file, `src/main.ts`: what the connector is, and what one run reads from its vendor. The kit, `@withmarfa/connector`, does the rest:

- registers the connector on every start;
- checks its type against the instance's;
- compares what the run found with the rows already written, and writes only what changed;
- heartbeats, keeps the connector's state, and reports each run.

## Start one

1. Copy this folder to `connectors/<name>/` and set `name` in its `package.json` to `<name>`.
2. In `src/main.ts`, name the connector, its source and its type, declare the environment it needs, and write `run`.
3. `pnpm install && pnpm build`.

What a run has to hand:

- **`upsert(entries)`**: each entry is a `source_id`, its properties and its `occurred_at`. Put the vendor account inside the `source_id`, as `<account>:<id>`, so two accounts under one source never share a row. A property that is absent or `null` is cleared from the row.
- **`archive(sourceIds)`**: for what the vendor deleted. A row is archived, never trashed, and a row a person trashed is never touched.
- **`state.get` and `state.set`**: a small value kept between runs, such as a sync token. It is kept only when every write in the run landed. The file is safe to lose: losing it costs a full read and never a duplicate.
- **`log.condition(key, message)`**: something that lasts across runs, such as a vendor refusing the token. It is reported on the first run it appears.
- **`signal`**: hand it to `fetch`, so a stop is prompt.
- **`env`**: the values the connector declared. A `secret` or `required` value that is missing stops the start, and a secret never reaches a log line or a report.

A connector reads from its vendor and never writes to it, and it writes only its own type at the feed tier. Promoting a row into the library is a person's or an app's act.

## The key

One key per connector per account, minted with the `marfa` binary by a credential that holds `keys.mint`:

```bash
marfa keys create --label <name> --source <name> --type-permission <type>=write --metadata-permission types=write --default-tier feed
```

- `--source <name>`: the connector's source, which every row it writes carries.
- `--type-permission <type>=write`: reach on the connector's own type and on nothing else.
- `--metadata-permission types=write`: lets it register its type on its first start. Leave it out for a type the instance already ships.
- `--default-tier feed`: puts what it writes in the feed.

"One key per connector per account" means a second account's key carries its own source and claims the connector's. A key's own source is unique among live keys, so the second key takes `<name>-<account>` as its own and claims `<name>`, which the kit names on every write:

```bash
marfa keys create --label <name>-<account> --source <name>-<account> --claim <name> --type-permission <type>=write --default-tier feed
```

Granting a claim takes a credential that holds that source itself, such as the operator key.

## Run it

The environment is `MARFA_URL`, `MARFA_KEY`, `MARFA_STATE_DIR` and whatever `env` declares.

- **`node dist/main.js --once`**: one run, then exit, for launchd, cron or a scheduled container. Exit codes: `0` for a run that succeeded or a clean stop, `1` for a failed run or a start that could not complete, `2` for a missing or malformed setting.
- **`node dist/main.js --every 15m`**: a long-lived process. Runs never overlap, and the heartbeat has its own one-minute timer. A failed run is reported, and the next waits twice as long, up to eight intervals. SIGTERM stops it cleanly.

### launchd

`launchd.plist.example` runs the connector `--once` every fifteen minutes. Copy it to `~/Library/LaunchAgents/`, give it a label and the real paths, and load it with `launchctl bootstrap gui/$(id -u) <plist>`. Its `ProgramArguments` start the connector under a secrets tool, so the key and the vendor's token never sit in the plist.

### A container

`Dockerfile` builds an image that runs one connector `--every 15m`. Build it from the repository root, once `scripts/monorepo.sh` and `scripts/vendor-client.sh` have packed the client:

```bash
docker build -f template/Dockerfile --build-arg CONNECTOR=<name> -t <name> .
```

Pass the environment with `-e`. The image sets `MARFA_STATE_DIR` itself and needs no volume.
