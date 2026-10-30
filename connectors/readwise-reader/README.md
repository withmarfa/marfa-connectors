# Readwise Reader

Keep Reader documents, highlights, annotations, and available content in Marfa. Reader can carry supported edits back to Readwise. The separate [Highlights connector](../readwise/README.md) remains usable on its own.

## Configure and run

Build from the repository root with Node 22.13 or later:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Create a connector key with source `readwise-reader`, claimed item source `readwise`, write access to `readwise.source`, `readwise.highlight`, and `readwise.file`, write access to the built-in `references` and `attached-to` edge types, and `types=write` metadata access. Use the feed default tier. Do not grant edge-type registration or unrelated permissions.

Reader and Highlights must use different key sources. Two keys under the same key source would share a registration and its saved state. Highlights uses key source `readwise`; both definitions write item source `readwise` and use the same stable account label.

| Variable                          | Meaning                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARFA_API_URL`                   | Marfa instance address.                                                                                                                                                                                                                                                    |
| `MARFA_API_KEY`                   | The Reader connector key.                                                                                                                                                                                                                                                  |
| `READWISE_ACCESS_TOKEN`           | Readwise access token, supplied through the process environment or secret manager.                                                                                                                                                                                         |
| `READWISE_ACCOUNT`                | Required stable nonsecret label, such as `primary`; use the same value in Highlights.                                                                                                                                                                                      |
| `READWISE_READER_INCLUDE_FEED`    | `true` includes feed documents. Default: `false`, saved library only.                                                                                                                                                                                                      |
| `READWISE_READER_INBOUND_ONLY`    | `true` disables outbound edits. Default: `false`.                                                                                                                                                                                                                          |
| `READWISE_READER_PROPAGATE_PURGE` | `true` allows permanent Marfa purges to delete Reader records. Default: `false`.                                                                                                                                                                                           |
| `READWISE_READER_PICTURES`        | Pictures hosted on other websites: `addresses` lists them in the manifest only, `save` saves them, and `save-in-library` saves them only for documents in the Marfa library tier. Default: `addresses`. See [Pictures from other websites](#pictures-from-other-websites). |
| `READWISE_READER_API_URL`         | Optional controlled-test API base. Default: `https://readwise.io/api/v3/`.                                                                                                                                                                                                 |
| `READWISE_CONTENT_MAX_BYTES`      | Remote resource limit in bytes, from 1 through 1073741824 (1 GiB). Default: 268435456 (256 MiB).                                                                                                                                                                           |
| `READWISE_API_URL`                | Optional export API base. Default: `https://readwise.io/api/v2/`.                                                                                                                                                                                                          |

Boolean values must be `true` or `false`. API overrides require HTTPS, except HTTP on loopback; credentials, query strings, and fragments are rejected. API credentials go only to the configured API base. Account labels are never derived from a token. Do not change an account label or endpoint against saved state.

```bash
node connectors/readwise-reader/dist/main.js --once
node connectors/readwise-reader/dist/main.js --every 15m
```

For an existing Highlights installation, follow [Replace existing schemas](../readwise/README.md#replace-existing-schemas) first. An installation from before highlight titles and field kinds follows [Upgrade to highlight titles and field kinds](../readwise/README.md#upgrade-to-highlight-titles-and-field-kinds). Install both updated binaries and their required key permissions before restarting either connector. Scoped startup deliberately refuses the structural schema replacement.

## Identity and shared rows

Documents retain type `readwise.source`; highlights retain `readwise.highlight`. Existing item IDs and export natural keys remain unchanged. Verified Reader identities use the link `<account>:reader-document:<ID>` or `<account>:reader-highlight:<ID>`. Reader-only rows begin with that natural key. A later export ID enriches the same row; an absent export ID stays absent.

When a complete export explicitly identifies one active highlight and deleted historical aliases for the same Reader highlight, the connector adopts only the active alias after verifying its Reader parent. Historical aliases and retained historical rows stay intact. Missing lifecycle evidence or two active claims remain unresolved.

The identity catalog first completes the account-wide export, including deleted highlights. Later runs complete an overlapping, paginated `updatedAfter` walk before admitting lifecycle identities. Each overlap starts at the previous walk's start, and cursors survive restarts. The connector also reads every known alias source to verify current parents and lifecycle status. Alias identity consists of its natural key, export ID, and export source. Parent and lifecycle status are mutable provider observations: a later completed walk can correct earlier evidence, while conflicting observations within one walk remain unresolved. Retained local rows do not overwrite provider evidence. Unknown-parent claims remain attached to their highlight identity; an unrelated unknown parent does not block the account. This follows the [Readwise export API's full-then-incremental synchronization method](https://readwise.io/api_deets).

The identity index inspects retained states and known purge tombstones before admission. Conflicting holders or contradictory export evidence produce a condition and retain the pending identity for investigation. The connector never merges or deletes conflicting rows automatically. A local explicit create that may be recovering a request blocks matching inbound admission until its journal settles.

Reader supplies the canonical highlight passage in `text`. A differing export passage, which is Markdown and keeps pictures, remains in `readwise_text`. A highlight shows its `title` and `body`, as [Highlight titles](../readwise/README.md#highlight-titles) describes: `body` is the export passage when there is one, and Reader's passage when Readwise cut the export at its 8,191-character limit. A picture-only passage is titled after its Reader document. Timestamps, dates and addresses follow [Field kinds](../readwise/README.md#field-kinds). Note records retain their identities and metadata while their text is folded into the annotation. Unknown categories remain available.

Reader owns verified Reader rows and explicit Reader creates, not every row of the shared types. Highlights refreshes managed rows directly from Reader and observes shared fields without sending local edits or putting them back. On first adoption, differing existing mutable values are held as a separate Marfa baseline and reported. Adoption alone never invents an outbound edit; a subsequent local edit does. Reader metadata and unsupported fields remain inbound-only.

## Preserve content

Listing and preservation have independent scopes. A page acknowledges its bounded content queue before advancing. Listing completion does not mean preservation is complete: pending resources and retry conditions remain visible separately.

Each retained HTML document, available original, Readwise-hosted image, overflow text, and resource manifest has its own `readwise.file` item with a `blob_ref`. Every file has an `attached-to` edge to its source or highlight. Highlights reference their source through `references`. Original HTML bytes are retained without rewriting links.

The manifest distinguishes kept, pending, unavailable, and deliberately unkept resources. A completed empty HTTP 200 download is recorded as unavailable without replacing any retained bytes; failed or incomplete downloads remain pending. Downloads accept only the verified HTTPS `readwise-assets.s3.amazonaws.com` host and validate each redirect. They never send API credentials to storage or fetch linked websites. Pictures hosted on other websites are fetched only when `READWISE_READER_PICTURES` asks for them. Transient signed URLs are excluded from checkpoint and manifest metadata; original HTML remains exact. A changed or expired source link is refreshed through Reader. Failed downloads retain the last acknowledged bytes.

Downloaded resources have a default 256 MiB limit and a bounded timeout. Set `READWISE_CONTENT_MAX_BYTES` to a positive decimal byte count up to 1073741824 (1 GiB).

Downloads stream through a private temporary file so upload retries can reopen a fresh stream without buffering the entire resource in memory. The temporary file is removed after success, failure, or cancellation. A resource above the configured limit remains pending with its byte limit reported, and its last acknowledged copy remains available. Raising the limit lets existing pending jobs retry at their recorded deadlines without starting a metadata backfill.

Each content pass handles a bounded number of documents and resources; later runs resume pending work. A productive pass that stops at its resource budget remains ready for the next pass. Failed or stalled work keeps its retry delay. Stable resource keys and acknowledged manifests avoid repeat uploads and unchanged downloads. Text that exceeds the item field limit is retained in a referenced text blob before its final metadata is acknowledged. A purged content item is not silently recreated.

Both binaries use the same preservation implementation for already managed Reader rows. Stopping Reader does not make Highlights substitute stale export text or discard retained content.

## Pictures from other websites

A document's HTML often shows pictures hosted on other websites. Pictures on Readwise storage keep their own download path, whatever the setting. For a document that saves pictures, a picture is the absolute address in an `img` element's `src`, or in its `data-src` when it has no `src`, or the document's cover `image_url`. Each whole address is one picture, so two addresses that differ only in the query are two pictures. Other image references, such as `srcset` candidates and relative or `data:` addresses, stay listed as deliberately unkept, reason `third-party`, and are never fetched.

`READWISE_READER_PICTURES` decides what happens to them:

- `addresses` (the default): nothing from another website is fetched. The manifest lists each image on another website as deliberately unkept, reason `third-party`, one resource for each origin and path.
- `save`: each HTTPS picture is fetched and saved. An `http:` address is never fetched and is listed as deliberately unkept, reason `not_https`.
- `save-in-library`: pictures are saved only for documents whose `readwise.source` row is in the Marfa library tier. Feed documents keep the `addresses` behavior.

Any other value stops the connector at start.

A saved picture is a `readwise.file` item with `resource_kind` `picture`, its bytes, `mime_type`, and `source_url` set to the picture's address. It has an `attached-to` edge to its source and takes the source's tier when it is created. The HTML is never rewritten: it keeps the original addresses. The manifest lists each picture with its saved file, and that file's `source_url` holds the address.

Picture work runs after the listing and content work of each scheduled run, in its own queue, apart from content preservation. Content preservation never fetches a picture and never waits for one: it lists a picture that is not yet saved as deliberately unkept, reason `third-party`, and a document's content is accounted for whatever its pictures. Picture work then takes each document whose content is accounted for, reads it from Reader once, saves its pictures, and writes the manifest again at the same revision, only while the manifest is still the accounted manifest of that revision. A run that a webhook hint started, or that Reader rate-limits, leaves picture work to the next run.

Pictures are fetched through the kit's picture fetcher. It refuses a redirect that is not HTTPS (reason `not_https`), private network addresses, known trackers, SVG, one-pixel images, and responses that are not pictures or are too large. A refused picture is recorded as unavailable with the refusal reason, and the HTTP status when there is one, and is not fetched again. The connector keeps the 1,024 most recent refusals in its saved state across runs and manifest rewrites. A timeout, a failed connection, a failed upload, or an HTTP 408, 425, 429, or 5xx response is retried on later runs, up to 3 attempts in all. One failed picture never fails its document or the run.

Each document saves at most 50 pictures; the rest are listed as deliberately unkept, reason `over-document-limit`. Each run fetches at most 100 pictures and 200 MiB, and stops starting fetches 10 minutes after its first picture fetch, so a slow listing leaves pictures their time. Once a run reaches a limit, it reads no more documents for pictures, reports the condition `readwise:reader-pictures-limit`, and the next run continues. Each run reads at most 25 documents for pictures, and at most 256 documents wait for picture work; when that queue is full, the connector reports `readwise:reader-pictures-backlog` and later goes over the kept documents again. A document whose picture work fails, whose content isn't accounted for yet, or whose picture needed its edge repaired is tried again on a later run, after a wait that doubles from 2 minutes up to 24 hours, as content preservation waits. It stays in the queue until its picture work finishes. If the saved picture-work state can't be read, the connector reports `readwise:reader-pictures-invalid`, starts again from an empty queue, goes over the kept documents again, and lets the listing continue; with the setting at `addresses`, it clears that state.

A picture is listed as kept only when Marfa holds it: an active `readwise.file` item with `resource_kind` `picture`, the picture's `source_url`, its bytes, and an `attached-to` edge to the document. This holds whichever connector writes the manifest and whatever the setting, so a manifest that Readwise Highlights writes lists the pictures Reader saved. A saved picture that lacks its edge, as a run that stopped early can leave one, is written again with its edge and is listed as kept from the next run. If the edge still hasn't landed after 5 such repairs in a row, the connector stops writing the picture again, lists it as deliberately unkept, reason `third-party`, and reports a condition whose key is `readwise:pictures-repair:` followed by a hash of the document's canonical key. A picture that was trashed, archived, or purged in Marfa is listed as deliberately unkept, reason `removed`, and is not fetched again.

Turning the setting on doesn't walk the Reader listing again. Picture work goes over the documents already kept in Marfa instead, a bounded batch at a time, with one Reader request for each document. It uploads nothing that is already kept and changes no existing item except to add pictures and update the manifest. Turning the setting off stops picture work; turning it on again goes over the kept documents again.

## Archive and restore

Reader's archive and Marfa's `archived` state mean the same thing: finished with, but kept. The connector keeps the two in step for documents (`readwise.source`).

- After a run, a document whose `reader_location` is `archive` is `archived` in Marfa. One that has moved out of Reader's archive, to `new`, `later` or `feed`, is `active` again.
- Archiving a document's item in Marfa moves the document to Reader's archive. Restoring it to `active` moves the document to `later`. The connector stores no earlier location. If the document has already left Reader's archive, a restore changes nothing in Reader. `READWISE_READER_INBOUND_ONLY` turns this off, with the other edits to Reader.
- Highlights keep their own state. Archiving a document leaves its highlights active, as Readwise does: its documentation says to keep annotated documents in the Reader archive to preserve their highlights. Saved pictures stay active too, and are never listed as deliberately unkept because their document was archived.
- When both sides change in one run, the later change wins, as it does for other fields. A restore in Marfa is carried to Reader unless Reader changed the document after the restore, in which case Reader's change stands and the item is archived again.
- Archiving many documents in Reader at once is not a deletion. Only a document confirmed missing counts toward the limit of 20 described under [Deletion and reconciliation](#deletion-and-reconciliation).

A document that disappeared from Reader is archived too, but its `reader_location` is whatever Reader last reported, which is not `archive`. An archived item whose `reader_location` is `archive` is in Reader's archive, whichever side archived it; any other archived item is missing from Reader or, with `READWISE_READER_INBOUND_ONLY` on, was archived in Marfa only.

## Edit and create

Supported document edits are title, author, summary (`description`), notes, tags, reading location (`reader_location`), and supported category values. Highlights support annotation (`note`) and tags; `title` and `body` are read only. Empty notes and empty tag arrays are explicit clears. Only changed supported fields are sent. Body replacement, passage edits, progress writes, and original-file upload remain read-only.

To request a local create, use the shared type and matching `account`, and explicitly set `reader_create: true`. A source needs a stable HTTP URL. A highlight needs `reader_parent_id` and passage text. Do not invent a Reader ID or export ID. Ordinary local rows without this explicit intent are not created upstream.

Every vendor mutation is preceded by an acknowledged journal entry containing the exact request and recovery baseline. URL saves are read back before a separate acknowledged update phase applies intended fields. Readback is required before agreement. A missing update target is never recreated.

After an uncertain highlight create, recovery accepts exactly one new matching object absent from the pre-send inventory. Zero or multiple matches remain pending without another blind create. A definitive rate-limit refusal can be retried only after its durable deadline and after consuming the recorded no-apply evidence. Lost responses and ambiguous readbacks retain the immutable request for reconciliation. Definitive validation refusals remain visible so a corrected local edit can be tried.

## Deletion and reconciliation

Trash never changes Reader. Purge propagation is off unless explicitly enabled. Before any vendor mutation, the connector checks the complete pending purge set, including retries and provider cascades. More than 20 intended deletions fails the whole run before Reader is read: no change of any kind is carried to Reader and nothing is read from it. Each later run fails the same way until the count is 20 or fewer or purge propagation is turned off.

An upstream disappearance requires a completed inventory and a successful empty direct lookup. A failed request, incomplete inventory, or excluded feed record does not establish deletion. More than 20 confirmed disappearances blocks archival of the whole set. Confirmed missing documents and their dependent highlights are archived explicitly, while content remains retained. A document in Reader's archive is not missing; see [Archive and restore](#archive-and-restore). Returning records reuse their existing identities.

## Progress and verification

Incremental listing starts from the last completed walk's start with a five-minute overlap. A full reconciliation is due daily. Expanded scope or effective fields trigger a backfill. The checkpoint retains the walk start, lower bound, cursor, configuration fingerprint, and rate-limit deadline. Invalid pages and repeated or rejected cursors never become an empty successful inventory. Bounded state refuses advancement rather than dropping identities.

Run focused fixtures or the process proof from the repository root:

```bash
pnpm exec vitest run shared/readwise/test connectors/readwise/test connectors/readwise-reader/test
pnpm proof
```

Prepare the proof server with `scripts/monorepo.sh` as described in the repository README. The process proof uses disposable vendor fixtures and separate connector registrations. It covers existing schemas, both startup orders, retained states, uncertain creates, independent refresh, cleared fields, unchanged row/file/edge versions, oversized text, deletion limits, and readable archived blobs after housekeeping. Fixture results are not evidence of a live account import.

Provider behavior is checked against the [Reader API](https://readwise.io/reader_api) and [Readwise export API](https://readwise.io/api_deets).
