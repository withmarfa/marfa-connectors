# A new connector

A connector is a small folder: `src/main.ts`, what the connector is and what one run reads from its vendor, beside the type it writes and any helpers its vendor needs. The kit, `@withmarfa/connector`, does the rest:

- registers the connector on every start;
- checks its type against the instance's;
- compares what the run found with the rows already written, and writes only what changed;
- heartbeats, keeps the connector's state, and reports each run.

## Start one

1. `cp -R template/connector connectors/<name>`, and set `name` in its `package.json` to `<name>`. The folder sits at a connector's depth, so its paths hold once copied.
2. Add `{ "path": "connectors/<name>" }` to the references in the root `tsconfig.json`. Until it is there, the tree test fails `pnpm test`, since the build would skip the connector.
3. Replace `src/example.item.json` with the type the connector writes, and in `src/main.ts` name the connector, its source and that type, declare the environment it needs, and write `run`. Where the vendor's rows read as a core type, such as a task or a bookmark, the type names that core type as its `parent` and adds only the vendor's own fields, and `run` writes the core type's fields under the core type's names; `compatible_with` is not used.
4. `test/connector.test.ts` runs the example as a process against a scripted server and a stub vendor. Rewrite it for yours.
5. `pnpm install && pnpm build && pnpm test`.

What a run has to hand:

- **`upsert(entries)`**: each entry is a `source_id`, its properties and its `occurred_at`. Put the vendor account inside the `source_id`, as `<account>:<id>`, so two accounts under one source never share a row. A property that is absent or `null` is cleared from the row.
- **`archive(keys)`**: for what the vendor deleted, by natural key, or by the vendor's id where the connector declares a link. A row is archived, never trashed, and a row a person trashed is never touched.
- **`state.get` and `state.set`**: a small value kept between runs, such as a sync token. It is kept only when every write in the run landed, in a file in `MARFA_STATE_DIR` named for the key's own source, so two accounts' connectors can share the directory. The state is a cache: losing it costs a full read and never a duplicate, and a trashed row stays in the bin. Nothing remembers a row a person purged, so the vendor's copy is written again the next time the vendor sends it, as it does after the state is lost; a two-way connector carries the purge to the vendor, and does not write the copy back while that purge is pending. Keep `MARFA_STATE_DIR` on a disk that lasts, or every run is a full read.
- **`log.condition(key, message)`**: something that lasts across runs but lets the run go on, such as a feed that stopped answering among several. It is reported on the first run it appears. What stops the run, such as a vendor refusing the token, is thrown instead, and fails the run.
- **`signal`**: hand it to `fetch`, so a stop is prompt.
- **`env`**: the values the connector declared. A `secret` or `required` value that is missing stops the start, and a secret never reaches a log line or a report. A secret that holds a list, such as several addresses, is also kept out part by part, where each part is set apart by whitespace or commas and is at least eight characters long. A value the connector can tell is wrong on sight, such as a malformed address, is refused by throwing from `checkEnv`, which stops the start the same way.

A connector writes only its own type at the feed tier. Promoting a row into the library is a person's or an app's act. A connector reads from its vendor; one that is asked to also carries changes made in Marfa back to it, as the next section describes, and never anything else.

## Carrying changes back

A two-way connector declares two more things, and the kit's watch phase does the rest:

- **`link`**: the property on the type that holds the vendor's own id for a row. With a link, every row of the type is the connector's to read and write, whoever created it and under whatever source: an entry finds its row by the link first and by its natural key second, `archive` takes the vendor's ids, and a row carrying no value is one the vendor has not been told about. Every entry `run` hands over must carry the link, or a row read from the vendor is handed back as a create once the state is lost and the vendor gets a twin. The example declares `example_id`. Say so in the connector's own README: a row of the type made by hand is carried to the vendor, and something meant to stay in Marfa is a row of the core type instead.
- **`onChange(change, context)`**: called once per row that changed in Marfa since the last run, with `change.kind` one of `created`, `updated`, `restored`, `archived`, `trashed` or `purged` and `change.item` the row as the log last showed it. A create and an update are told apart by the link, not by the event: a row without a value is handed as `created` whether the log showed it created or updated, and a row with one as `updated`; a transition and a purge keep their kind. What of a row travels is the connector's choice; the example sends the title, url and note. `context.setLink(item, id)` writes the vendor's id onto a row the vendor just made, retrying once if the row moved since, and throws `LinkTaken` for a value another row carries; the example takes that as a condition. Resolving means the change landed or was consciously abandoned with a condition naming the row; throwing fails the run and holds the cursor, so the change is offered again next run, and a throw while creates are carried also skips that run's read of the vendor. A vendor's refusal of one row is a condition; a refused token is a throw. A create the vendor cannot tell from a repeat leaves a twin there if a run fails between its answer and the link; the example sends the row's id as an idempotency key.

Every entry `run` hands to `upsert` should carry `changed_at`, when the vendor last changed it: it is what the conflict rule reads, and a vendor naming no time loses every conflict.

How a run goes: the log is read; `created` changes are carried first; `run` pulls and writes what the vendor had; the rest of the changes are carried in log order; the run is reported. A create is carried before the vendor is read because nothing the vendor sends can concern such a row, and a run that failed between the vendor's answer and the link would otherwise read the vendor's copy first and create the row's twin. The report's `pushed` counts every change `onChange` resolved, landed or abandoned; `own` counts events dropped as the connector's own or older than where the two sides last agreed; `conflicts` counts each row decided by the conflict rule once.

What the kit keeps, beside the connector's state in the same file: the log cursor and a memory of where the two sides last agreed for each row, its version and state after the connector's own write or a change it carried. An event at that record, or at a version below it, is nothing new to the vendor and is dropped as `own`, a purge excepted; the record is forgotten once the row moves past it, by a version above, a state moved at the same version, or a purge. A row the connector wrote from the vendor before its link existed, under its own source with a natural key and no link value, is not carried either, since the vendor has it: the run says how many with a condition, and the vendor's entries link them as they come, by the natural key. The cursor moves only when every write and push landed; the memory keeps what did land either way. Losing the file costs one replay of the log, a round of reads and no-op writes at the vendor, and never a duplicate; a cursor the log no longer serves carries every row of the type once, with a condition saying so.

The conflict rule, where a row changed in Marfa since the two sides last agreed and the vendor sends it too. An entry carrying the `changed_at` it carried when the two sides last agreed is one the vendor has not changed since, as a vendor that lists everything sends every run: the change in Marfa stands and is carried, and nothing is a conflict. Otherwise the later of the vendor's `changed_at` and the change in Marfa wins, before an inbound write and again after one the server merged or refused; the loser is a condition of the run naming the row, and `conflicts` counts it; a tie goes to Marfa. Where Marfa wins after a merge, the row is put back whole as the person left it and that state is carried to the vendor. A trash in Marfa always wins over the vendor and is carried back. An archive touches no property and travels beside the vendor's write. A restore is decided by the times: what the vendor sends after a trash was carried back can be the echo of what the trash did there, so an entry from before the restore is left unwritten and is not a conflict, an entry from after it is written, and the restore is carried either way; the vendor's deletion of that row is not applied while the restore is pending. A purge in Marfa is carried to the vendor and the vendor's copy is not written back while it is pending.

A connector without `onChange` makes no events request and its state file gains nothing.

## The key

One key per connector per account, minted with the `marfa` binary by a credential that holds `keys.mint`:

```bash
marfa keys create --label <name> --source <name> --type-permission <type>=write --metadata-permission types=write --default-tier feed
```

- `--source <name>`: the connector's source, which every row it writes carries.
- `--type-permission <type>=write`: reach on the connector's own type and on nothing else.
- `--metadata-permission types=write`: lets it register its type on its first start.
- `--default-tier feed`: puts what it writes in the feed.

"One key per connector per account" means a second account's key carries its own source and claims the connector's. A key's own source is unique among live keys, so the second key takes `<name>-<account>` as its own and claims `<name>`, which the kit names on every write:

```bash
marfa keys create --label <name>-<account> --source <name>-<account> --claim <name> --type-permission <type>=write --metadata-permission types=write --default-tier feed
```

`types=write` is used only when this account's process is the first to start and so registers the type; once the type is on the instance, the key never uses it. Mint the key with the operator key. A working key can pass on only the sources it writes under itself, its own and its claims, so even one holding every permission is refused `<name>`; the operator key is exempt, which is how a claim starts. The two keys then write under one source, each account's rows kept apart by the account inside the `source_id`, and each keeps its own state file.

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

Pass the environment with `-e`, and keep the state on a named volume, `-v <name>-state:/state`: the image sets `MARFA_STATE_DIR` to `/state`, and a container started without the volume begins with a full read of the vendor.
