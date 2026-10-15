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

| Variable                          | Meaning                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `MARFA_API_URL`                   | Marfa instance address.                                                               |
| `MARFA_API_KEY`                   | The Reader connector key.                                                             |
| `READWISE_ACCESS_TOKEN`           | Readwise access token, supplied through the process environment or secret manager.    |
| `READWISE_ACCOUNT`                | Required stable nonsecret label, such as `primary`; use the same value in Highlights. |
| `READWISE_READER_INCLUDE_FEED`    | `true` includes feed documents. Default: `false`, saved library only.                 |
| `READWISE_READER_INBOUND_ONLY`    | `true` disables outbound edits. Default: `false`.                                     |
| `READWISE_READER_PROPAGATE_PURGE` | `true` allows permanent Marfa purges to delete Reader records. Default: `false`.      |
| `READWISE_READER_API_URL`         | Optional controlled-test API base. Default: `https://readwise.io/api/v3/`.            |
| `READWISE_API_URL`                | Optional export API base. Default: `https://readwise.io/api/v2/`.                     |

Boolean values must be `true` or `false`. API overrides require HTTPS, except HTTP on loopback; credentials, query strings, and fragments are rejected. API credentials go only to the configured API base. Account labels are never derived from a token. Do not change an account label or endpoint against saved state.

```bash
node connectors/readwise-reader/dist/main.js --once
node connectors/readwise-reader/dist/main.js --every 15m
```

For an existing Highlights installation, follow [Replace existing schemas](../readwise/README.md#replace-existing-schemas) first. Install both updated binaries and their required key permissions before restarting either connector. Scoped startup deliberately refuses the structural schema replacement.

## Identity and shared rows

Documents retain type `readwise.source`; highlights retain `readwise.highlight`. Existing item IDs and export natural keys remain unchanged. Verified Reader identities use the link `<account>:reader-document:<ID>` or `<account>:reader-highlight:<ID>`. Reader-only rows begin with that natural key. A later export ID enriches the same row; an absent export ID stays absent.

The identity index inspects retained states and known purge tombstones before admission. Conflicting holders or contradictory export evidence produce a condition and retain the pending identity for investigation. The connector never merges or deletes conflicting rows automatically. A local explicit create that may be recovering a request blocks matching inbound admission until its journal settles.

Reader supplies the canonical highlight passage. A differing export passage remains in `readwise_text`. Note records retain their identities and metadata while their text is folded into the annotation. Unknown categories remain available. Reader's archive location is a reading location, not Marfa's archive state.

Reader owns verified Reader rows and explicit Reader creates, not every row of the shared types. Highlights refreshes managed rows directly from Reader and observes shared fields without sending local edits or putting them back. On first adoption, differing existing mutable values are held as a separate Marfa baseline and reported. Adoption alone never invents an outbound edit; a subsequent local edit does. Reader metadata and unsupported fields remain inbound-only.

## Preserve content

Listing and preservation have independent scopes. A page acknowledges its bounded content queue before advancing. Listing completion does not mean preservation is complete: pending resources and retry conditions remain visible separately.

Each retained HTML document, available original, Readwise-hosted image, overflow text, and resource manifest has its own `readwise.file` item with a `blob_ref`. Every file has an `attached-to` edge to its source or highlight. Highlights reference their source through `references`. Original HTML bytes are retained without rewriting links.

The manifest distinguishes kept, pending, unavailable, and deliberately unkept resources. Downloads accept only the verified HTTPS `readwise-assets.s3.amazonaws.com` host and validate each redirect. They never send API credentials to storage or fetch third-party images, tracking pixels, or linked websites. Transient signed URLs are excluded from checkpoint and manifest metadata; original HTML remains exact. A changed or expired source link is refreshed through Reader. Failed downloads retain the last acknowledged bytes.

Downloads stream with a 128 MiB resource limit and bounded timeout. Each content pass handles a bounded number of documents and resources; later runs resume pending work. Stable resource keys and acknowledged manifests avoid repeat uploads and unchanged downloads. Text that exceeds the item field limit is retained in a referenced text blob before its final metadata is acknowledged. A purged content item is not silently recreated.

Both binaries use the same preservation implementation for already managed Reader rows. Stopping Reader does not make Highlights substitute stale export text or discard retained content.

## Edit and create

Supported document edits are title, author, summary (`description`), notes, tags, reading location (`reader_location`), and supported category values. Highlights support annotation (`note`) and tags. Empty notes and empty tag arrays are explicit clears. Only changed supported fields are sent. Body replacement, passage edits, progress writes, and original-file upload remain read-only.

To request a local create, use the shared type and matching `account`, and explicitly set `reader_create: true`. A source needs a stable HTTP URL. A highlight needs `reader_parent_id` and passage text. Do not invent a Reader ID or export ID. Ordinary local rows without this explicit intent are not created upstream.

Every vendor mutation is preceded by an acknowledged journal entry containing the exact request and recovery baseline. URL saves are read back before a separate acknowledged update phase applies intended fields. Readback is required before agreement. A missing update target is never recreated.

After an uncertain highlight create, recovery accepts exactly one new matching object absent from the pre-send inventory. Zero or multiple matches remain pending without another blind create. A definitive rate-limit refusal can be retried only after its durable deadline and after consuming the recorded no-apply evidence. Lost responses and ambiguous readbacks retain the immutable request for reconciliation. Definitive validation refusals remain visible so a corrected local edit can be tried.

## Deletion and reconciliation

Trash never changes Reader. Purge propagation is off unless explicitly enabled. Before any vendor mutation, the connector checks the complete pending purge set, including retries and provider cascades. More than 20 intended deletions blocks every deletion and reports a condition.

An upstream disappearance requires a completed inventory and a successful empty direct lookup. A failed request, incomplete inventory, or excluded feed record does not establish deletion. More than 20 confirmed disappearances blocks archival of the whole set. Confirmed missing documents and their dependent highlights are archived explicitly, while content remains retained. Returning records reuse their existing identities.

## Progress and verification

Incremental listing starts from the last completed walk's start with a five-minute overlap. A full reconciliation is due daily. Expanded scope or effective fields trigger a backfill. The checkpoint retains the walk start, lower bound, cursor, configuration fingerprint, and rate-limit deadline. Invalid pages and repeated or rejected cursors never become an empty successful inventory. Bounded state refuses advancement rather than dropping identities.

Run focused fixtures or the process proof from the repository root:

```bash
pnpm exec vitest run shared/readwise/test connectors/readwise/test connectors/readwise-reader/test
pnpm proof
```

Prepare the proof server with `scripts/monorepo.sh` as described in the repository README. The process proof uses disposable vendor fixtures and separate connector registrations. It covers existing schemas, both startup orders, retained states, uncertain creates, independent refresh, cleared fields, unchanged row/file/edge versions, oversized text, deletion limits, and readable archived blobs after housekeeping. Fixture results are not evidence of a live account import.

Provider behavior is checked against the [Reader API](https://readwise.io/reader_api) and [Readwise export API](https://readwise.io/api_deets).
