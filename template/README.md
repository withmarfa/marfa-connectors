# A new connector

A connector is a small folder: `src/main.ts`, what the connector is and what one run reads from its vendor, beside the type it writes and any helpers its vendor needs. The kit, `@withmarfa/connector`, does the rest:

- registers the connector on every start;
- refuses a key that holds more than its type needs;
- checks its type against the instance's;
- compares what the run found with the rows already written, and writes only what changed;
- heartbeats, keeps the connector's state, and reports each run;
- takes the webhooks a vendor posts, where the connector reads them.

## Start one

1. `cp -R template/connector connectors/<name>`, and set `name` in its `package.json` to `<name>`. The folder sits at a connector's depth, so its paths hold once copied.
2. Add `{ "path": "connectors/<name>" }` to the references in the root `tsconfig.json`. Until it is there, the tree test fails `pnpm test`, since the build would skip the connector.
3. Replace `src/example.item.json` with the type the connector writes, and in `src/main.ts` name the connector, its source and its `types`, each a type with the `fields` the vendor holds, declare the environment it needs, and write `run`. A connector may write up to ten types, such as issues, comments and files, each with its own fields, read-only fields and link. Where the vendor's rows read as a core type, such as a task or a bookmark, the type names that core type as its `parent` and adds only the vendor's own fields, and `run` writes the core type's fields under the core type's names; `compatible_with` is not used.
4. `test/connector.test.ts` runs the example as a process against a scripted server and a stub vendor. Rewrite it for yours.
5. `pnpm install && pnpm build && pnpm test`.

What a run has to hand:

- **`upsert(type, entries)`**: each entry is a `source_id`, its properties and its `occurred_at`. Put the vendor account inside the `source_id`, as `<account>:<id>`, so two accounts under one source never share a row. A property that is absent or `null` is cleared from the row. Every property an entry carries is among its type's `fields`, the properties the vendor holds; an entry carrying another is refused with a condition. A row's other properties are Marfa's own and never touched.
- **What the vendor changed, field by field.** For each row the kit keeps, on the instance, what each side last held, field by field. An entry is written only where the vendor changed something since, and only the fields it changed: an edit made in Marfa to another field stays. A field both sides changed goes to the later change, by the entry's `changed_at` and when the edit was first seen in Marfa, and a tie to Marfa; the run names the row and the field that lost. An entry older than what the two sides last agreed on is left unwritten. A row that nothing was agreed for, as after the connector's state was cleared, takes the vendor's value wherever the two differ, and the run says how many.
- **`archive(type, keys)`**: for what the vendor deleted, by natural key, or by the vendor's id where the type declares a link. A row is archived, never trashed, and a row a person trashed is never touched.
- **`state.get` and `state.set`**: a small value kept between runs, such as a sync token. It is kept on the instance, under the key's own source, and only when every write in the run landed, so a connector needs no disk of its own and can start anywhere, empty.
- **`log.condition(key, message)`**: something that lasts across runs but lets the run go on, such as a feed that stopped answering among several. It is reported on the first run it appears. What stops the run, such as a vendor refusing the token, is thrown instead, and fails the run.
- **`signal`**: hand it to `fetch`, so a stop is prompt.
- **`env`**: the values the connector declared. A `secret` or `required` value that is missing stops the start, and a secret never reaches a log line or a report. A secret that holds a list, such as several addresses, is also kept out part by part, where each part is set apart by whitespace or commas and is at least eight characters long. A value the connector can tell is wrong on sight, such as a malformed address, is refused by throwing from `checkEnv`, which stops the start the same way.

A connector writes only its own type at the feed tier. Promoting a row into the library is a person's or an app's act. A connector reads from its vendor; one that is asked to also carries changes made in Marfa back to it, as the next section describes, and never anything else.

## Carrying changes back

A two-way connector declares two more things, and the kit's watch phase does the rest:

- **`link`**, on each type: the property that holds the vendor's own id for a row. With a link, every row of the type is the connector's to read and write, whoever created it and under whatever source: an entry finds its row by the link first and by its natural key second, `archive` takes the vendor's ids, and a row carrying no value is one the vendor has not been told about. Every entry `run` hands over carries the link; one without it is refused with a condition. The link is the connector's: a person's change to it is put back, with a condition, before anything is carried by it. The example declares `example_id`. Say so in the connector's own README: a row of the type made by hand is carried to the vendor, and something meant to stay in Marfa is a row of the core type instead.
- **`onChange(change, context)`**: called once per row with something in Marfa the vendor has not had, with `change.kind` one of `created`, `updated`, `restored`, `archived`, `trashed` or `purged`, `change.item` the row as it stands, and `change.changed` the fields changed in Marfa and not yet carried, the read-only ones and the link left out. A transition carries the fields changed beside it; a trash and a purge carry none. What of a row travels is the connector's choice; the example sends the title, url and note. It may answer the vendor's entry as its write left it, which the kit takes as what the vendor now holds, so a value the vendor normalizes, or its own close echoed back, is no change; without an answer the carried values are taken as the vendor's. `context.setLink(item, id)` writes the vendor's id onto a row the vendor just made, retrying once if the row moved since, and throws `LinkTaken` for a value another row carries; the example takes that as a condition. Resolving means the change landed or was consciously abandoned with a condition naming the row; throwing fails the run, and the change waits for the next. A vendor's refusal of one row is a condition; a refused token is a throw.
- **`readOnly`**, optional, on each type: fields the vendor holds that are never carried back. Marfa mirrors them: a change made to one in Marfa is put back on the next run, from what the connector last wrote, and the run names the field. Every field is read-only for a connector without `onChange`, or for a type its `carries(env)` leaves out, so any kind can run read only; and the link is read-only for every type.

Every entry `run` hands to `upsert` should carry `changed_at`, when the vendor last changed it: it is what the conflict rule reads, and a vendor naming no time loses every conflict.

- **`remake(change, context)`**, optional: makes a restored row again at a vendor that no longer has it, links the row to what it made, and answers whether it did. It is asked for every `restored` change before the vendor is read; a row the vendor still has answers `false` and is carried by `onChange` after the read. The example asks the vendor for the item and makes it again on a 404.

How a run goes: the log is read, and each row it names is compared with what the two sides last agreed on; what differs is recorded as waiting, from when it was first seen, before the log's cursor moves past it, so a run that fails, or a process that stops, loses nothing still to carry. Creates are carried, and restored rows offered to `remake`; `run` pulls and writes what the vendor had; the rest of what waits is carried; the run is reported. A create goes before the vendor is read, because a run that failed between the vendor's answer and the link would otherwise read the vendor's copy first and create the row's twin. The kit records a create before sending it; where one was sent and no link came back, `change.attempted` says when, so a connector whose vendor takes no idempotency key can look for what it made before making another. The report's `pushed` counts every change carried, landed or abandoned; `own` counts the log's frames showing a row as the connector last left it, which are its own writes; `conflicts` counts each row where a field was decided by the later change.

A trash in Marfa wins over the vendor: a trashed row is never written, and the trash is carried. An archive in Marfa touches no field and travels beside whatever the vendor sends. A restore is carried as a restore, made again at a vendor that no longer has the row. A row the vendor deleted is archived, and a person's restore of it since is not undone by the vendor's next word. A purge is carried once; the example sends the trash's delete again, which a vendor that took it answers as already done, and which still deletes where a trash and a purge made between two runs reach the connector as the purge alone. The vendor's copy of a row purged this run is not written back.

A connector without `onChange` reads the log too: a change made in Marfa to a field it mirrors is put back from what it last wrote, on the next run, and the run names the field.

## Receiving webhooks

A vendor that posts webhooks, such as GitHub, can tell the connector what changed rather than wait for its schedule. The instance stores each delivery as it arrived and never reads it; the connector declares how to read one:

```ts
inbound: {
  // The vendor's signature over the body exactly as it arrived.
  verify: (delivery, env) =>
    verifyHmac({
      secret: env.EXAMPLE_WEBHOOK_SECRET,
      body: delivery.body,
      signature: delivery.header("X-Signature"),
    }),
  // What the delivery says changed, as ids `run` can fetch.
  hints: (delivery) => [
    {
      type: "example.item",
      id: String(JSON.parse(new TextDecoder().decode(delivery.body)).id),
    },
  ],
},
```

- **`verify`** answers whether a delivery came from the vendor. `verifyHmac` from the kit compares an HMAC in constant time: `prefix` for a header such as GitHub's `sha256=…`, `encoding: "base64"` for a vendor that signs in base64. The secret is declared in `env` as a `secret`, so it never reaches a log line. A delivery that fails, or whose `verify` throws, is marked rejected for good and changes nothing, and the run says how many with a condition, which usually means the secret differs from the one the vendor signs with. Keep `verify` to the delivery and the environment: a check that reaches the network can fail for a passing reason and reject a genuine delivery. It is handed a signal that aborts on a stop or after ten seconds; a check still running then leaves its delivery waiting for a later run, with a condition, and the deliveries behind it are taken.
- **`hints`** answers what the delivery says changed, as the type and id of each thing `run` fetches, or `"everything"`. A `hints` that throws, as the example does on a body that is not JSON, means everything, and the run says how many with a condition; neither error's text is kept, since it can quote the body. A delivery is a hint, never the vendor's state: the vendor may send them out of order, twice, or not at all, so `run` always fetches what the hint names and writes that.
- **`run`** reads `context.hints`. It is `undefined` on a scheduled run, which reads the vendor whole, and on a run whose deliveries asked for everything; otherwise it is, by type, the ids the deliveries named, which may be empty, and the run fetches only those and leaves any cursor into the vendor, such as a sync token, where it was, since the rest was not read. Both write through `upsert` and `archive`, so a delivery and the schedule reach a row the same way.
- A run the deliveries started clears no condition, having checked only part.
- A connector with `onChange` is handed no hints: a delivery starts a whole run, which reads the vendor whole and carries back what changed in Marfa as a scheduled run does. Carrying back after a partial read would overwrite vendor entries the run did not see, and writing without carrying would leave changes behind that the next run could no longer tell from the connector's own. Webhooks bring a two-way connector's run forward; they do not make it smaller.

How deliveries are taken:

- Every run first collects what waits at the connector's endpoints, up to five hundred, fetching each body to verify it. A body that cannot be fetched leaves its delivery waiting for a later run, with a condition, and the rest are taken. A verified delivery that repeats one already processed, or one verified earlier in the same collection, by the header the endpoint names, is marked a duplicate.
- A delivery is marked processed once the run that took it ends without error. A write the run held does not keep it waiting, since the next scheduled run reads the vendor whole and writes it again; a run that fails leaves it waiting for the next.
- A scheduled run that cannot read the deliveries or the endpoints says so with a condition and still reads the vendor whole.
- With `--every`, the kit looks for a waiting delivery every ten seconds between scheduled runs, or as often as `--deliveries-every` says, and starts a run for it at once. A run for deliveries that fails, or whose deliveries could not be marked, leaves them for the scheduled run rather than trying again at every look. The schedule stays the safety net, since a vendor does not promise to deliver: GitHub does not retry a failed delivery.
- Each run's report counts the deliveries it processed, rejected and marked duplicate.

The address comes from the instance, never from the kit. With the connector registered, make an endpoint with its own key or the operator key:

```bash
marfa connectors endpoints create <connector-id> --label <vendor> --duplicate-header <header>
```

The answer carries the address in full this once, as `path` and as `url`, the address the binary reached joined to it; later reads show only its last four characters. Give the vendor the instance's public address with that path, and the secret it signs with. `--duplicate-header` names the header a vendor repeats on a redelivery, such as `X-GitHub-Delivery`. A scheduled run whose registration holds no live endpoint says how to make one. `marfa connectors endpoints retire <connector-id> <endpoint-id>` stops an address answering. `marfa connectors deliveries list <connector-id>` shows what waits, with the connector's own key only: the operator key is refused, as on every read of the connector's data.

## The key

One key per connector per account, minted with the `marfa` binary by a credential that holds `keys.mint`:

```bash
marfa keys create --label <name> --source <name> --type-permission <type>=write --metadata-permission types=write --default-tier feed
```

- `--source <name>`: the connector's source, which every row it writes carries.
- `--type-permission <type>=write`, once for each type the connector writes: reach on its own types and on nothing else.
- `--metadata-permission types=write`: lets it register its type on its first start.
- `--default-tier feed`: puts what it writes in the feed.

Naming a map, the key holds no permission: it cannot mint keys, purge, or change the instance, and it reads and writes no other type's rows. `types=write` still lets it register a type under any id, which is why it matters only on the first start. The kit reads the key back on every start (`GET /keys/current`) and refuses to run on one that holds anything more than read and write on its own types and `types` to register them, naming the key and what is too wide, before it registers a type or writes a row; the refusal is the registration's failed run. A key minted naming nothing, which takes the minter's whole set, is refused, and so is one minted before an instance gave a key named with maps no permission beside them. Revoke such a key with `marfa keys revoke <id>` and mint another as above; its source is free again once it is revoked. The revoked key's registration stays, with its failed run, until `marfa connectors delete <id>` removes it.

"One key per connector per account" means a second account's key carries its own source and claims the connector's. A key's own source is unique among live keys, so the second key takes `<name>-<account>` as its own and claims `<name>`, which the kit names on every write:

```bash
marfa keys create --label <name>-<account> --source <name>-<account> --claim <name> --type-permission <type>=write --metadata-permission types=write --default-tier feed
```

`types=write` is used only when this account's process is the first to start and so registers the type; once the type is on the instance, the key never uses it. Mint the key with the operator key. A working key can pass on only the sources it writes under itself, its own and its claims, so even one holding every permission is refused `<name>`; the operator key is exempt, which is how a claim starts. The two keys then write under one source, each account's rows kept apart by the account inside the `source_id`, and each keeps its own state on the instance, under its own source. For a connector that carries changes back, one account per instance: a row of the type without a link would be created in whichever account's connector ran first, and the other could not tell that account's item from one gone.

## Run it

The environment is `MARFA_URL`, `MARFA_KEY` and whatever `env` declares. The connector keeps no file: its state is on the instance.

- **`node dist/main.js --once`**: one run, then exit, for launchd, cron or a scheduled container. Exit codes: `0` for a run that succeeded or a clean stop, `1` for a failed run or a start that could not complete, `2` for a missing or malformed setting.
- **`node dist/main.js --every 15m`**: a long-lived process. Runs never overlap, and the heartbeat has its own one-minute timer. A failed run is reported, and the next waits twice as long, up to eight intervals. SIGTERM stops it cleanly. A connector that receives webhooks also looks for waiting deliveries between runs, every ten seconds unless `--every 15m --deliveries-every 30s` says otherwise.

### launchd

`launchd.plist.example` runs the connector `--once` every fifteen minutes. Copy it to `~/Library/LaunchAgents/`, give it a label and the real paths, and load it with `launchctl bootstrap gui/$(id -u) <plist>`. Its `ProgramArguments` start the connector under a secrets tool, so the key and the vendor's token never sit in the plist. Run `--once`, a connector takes its deliveries only when it runs, so a webhook is acted on within the fifteen minutes; run it `--every` to act on one within seconds.

### A container

`Dockerfile` builds an image that runs one connector `--every 15m`. Build it from the repository root, once `scripts/monorepo.sh` and `scripts/vendor-client.sh` have packed the client:

```bash
docker build -f template/Dockerfile --build-arg CONNECTOR=<name> -t <name> .
```

Pass the environment with `-e`. The container needs no volume: a new one picks up where the last left off, from the state kept on the instance.
