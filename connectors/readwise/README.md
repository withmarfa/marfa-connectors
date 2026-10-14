# Readwise

Import sources, complete highlights, annotations, and tags from one Readwise account into Marfa. The connector only sends GET requests to Readwise. It polls through the connector kit and keeps progress on the Marfa instance.

## Data model

`readwise.source` inherits `core.media`. It represents a book, article, tweet, podcast, or another source exported by Readwise. `readwise.highlight` inherits `core.highlight` and keeps the complete passage and annotation. Each highlight declares a `references` edge to its source, which expresses a reference rather than containment.

Source notes map to `notes`, summaries to `description`, and valid source and cover URLs to `url` and `image_url`. Readwise's original URLs are retained separately even when they cannot populate a core URL field. A blank title falls back to `readable_title`, then `Readwise source <ID>`.

A valid highlighting time supplies the item's `occurred_at`; a valid update time supplies the kit's conflict-resolution timestamp. Original timestamp strings remain available in properties. `time_offset` maps to the core `time` locator; page, offset, order, none, and cfi retain their meaning. Original location kinds, numeric locations, and colors are retained even when core enums cannot represent them. Text and annotations are never truncated. Tags from strings or named objects are trimmed and deduplicated without changing case or Unicode.

Both types retain Readwise IDs and external IDs. The source's `external_id`, when `readwise_source` is `reader`, provides a later Reader connector with the upstream identifier. This does not claim cross-API deduplication or import Reader document content.

## Account identity

The caller supplies one stable, nonsecret account label. Labels have 1–64 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit. Natural keys are `<account>:source:<ID>` and `<account>:highlight:<ID>`, separating the two independent ID sequences. Keep the label unchanged across token changes and reinstallations. The connector is designed for one account; the label is not inferred from a token or an undocumented account response.

## Export validation

The parser requires a valid export envelope with a nonnegative count, explicit next-page cursor (a nonempty string or positive safe integer) or null, and source and highlight arrays. Numeric cursors, as returned by the live service, are normalized to strings without losing precision. The count describes highlights, not the number of sources. Invalid IDs, text, flags, or tag structures fail visibly instead of being treated as an empty account. Optional metadata can be absent or null where Readwise allows it. An explicit tombstone may omit passage text; mapping functions reject tombstones so the sync layer must handle them as archival operations that preserve existing content.

The connector requests explicit deletion records and archives only those records, retaining existing content. A source tombstone does not imply that its highlights are deleted. Missing records, empty pages, and HTTP 404 responses never imply deletion. User archives, trash and purge follow the kit's existing rules; no operation deletes anything from Readwise.

## Run the connector

Build from the repository root with Node 22.13 or later:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Mint a connector-scoped key using your existing Marfa administrative environment:

```bash
marfa keys create --label readwise --source readwise --type-permission readwise.source=write --type-permission readwise.highlight=write --edge-permission references=write --metadata-permission types=write --default-tier feed
```

The built-in `references` definition is not registered or changed. Do not grant `metadata edge_types=write` or unrelated permissions.

Supply these environment variables through your secret manager or process environment:

| Variable                | Meaning                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARFA_API_URL`         | Marfa instance address.                                                                                                                                                       |
| `MARFA_API_KEY`         | The scoped key created above.                                                                                                                                                 |
| `READWISE_ACCESS_TOKEN` | Your Readwise access token, treated as a secret.                                                                                                                              |
| `READWISE_ACCOUNT`      | Stable nonsecret account label, such as `primary`.                                                                                                                            |
| `READWISE_API_URL`      | Optional API base for controlled testing; defaults to `https://readwise.io/api/v2/`. Requires HTTPS, except HTTP on loopback, and rejects credentials, queries and fragments. |

Run once or poll with the kit's existing scheduler:

```bash
node connectors/readwise/dist/main.js --once
node connectors/readwise/dist/main.js --every 15m
```

A saved account label or endpoint cannot be changed in place. Restore the original configuration if startup reports a mismatch. Rotating the access token leaves identities and progress unchanged. The [template deployment guide](../../template/README.md) covers launchd and Docker; this connector does not install a scheduled service itself.

## Progress and recovery

The first run exports all records. Later runs use the previous completed walk's start time with a five-minute overlap. Each page is checkpointed only after its rows and applicable references are acknowledged, or isolated refused rows are durably retained for refetch by the kit. An interrupted walk retains its original start time, lower bound and cursor. An uncertain acknowledgement is resolved by reading saved state on the next run; repeated data keeps the same identities and does not rewrite unchanged items.

Incremental exports do not guarantee source-only metadata changes. A full rescan is due every 24 hours, and a changed effective field set also starts a full rescan. A run processes at most 50 pages of the main export before leaving the remaining walk for the next scheduled run. Repeated cursors fail visibly; a walk that exceeds 4,096 distinct cursors also stops with progress retained. Only an explicit invalid-cursor response restarts the same saved window.

Isolated rejected rows use the kit's bounded refetch journal. A pending highlight is resolved through its detail endpoint to a source ID, then the complete source is exported by ID without an incremental filter. Missing answers leave the refusal pending; explicit tombstones settle deletion. A journal or checkpoint that cannot safely retain progress blocks advancement.

HTTP 429 responses save `Retry-After` deadlines across restarts. Missing or malformed guidance fails visibly without guessing a retry delay. Requests have a 30-second timeout, honor cancellation, reject redirects and limit decoded responses to 32 MiB. Authentication failures, malformed data and unavailable services do not become successful empty imports. Watch-only kit runs restore mirrored fields from existing agreements and do not poll Readwise or advance export progress.

## Verify the connector

From the repository root:

```bash
pnpm exec vitest run connectors/readwise/test
pnpm proof
```

The mapping follows the [Readwise export API](https://readwise.io/api_deets#highlight-export).
