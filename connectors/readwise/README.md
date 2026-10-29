# Readwise

Import sources, complete highlights, annotations, and tags from one Readwise account into Marfa. The connector only sends GET requests to Readwise. It polls through the connector kit and keeps progress on the Marfa instance.

## Data model

`readwise.source` inherits `core.media`. It represents a book, article, tweet, podcast, or another source exported by Readwise. `readwise.highlight` inherits `core.highlight` and keeps the complete passage and annotation. Each highlight declares a `references` edge to its source, which expresses a reference rather than containment.

Source notes map to `notes`, summaries to `description`, and valid web source and cover URLs to `url` and `image_url`. Readwise's original addresses, such as `source_url` and `readwise_url`, are kept in their own fields, which accept any absolute URL. A blank title falls back to `readable_title`, then `Readwise source <ID>`.

A valid highlighting time supplies the item's `occurred_at`; a valid update time supplies the kit's conflict-resolution timestamp. The original timestamps remain available in properties. `time_offset` maps to the core `time` locator; page, offset, order, none, and cfi retain their meaning. Original location kinds, numeric locations, and colors are retained even when core enums cannot represent them. Text and annotations are never truncated. Tags from strings or named objects are trimmed and deduplicated without changing case or Unicode.

### Highlight titles

A highlight shows its `title` and `body`, which both connectors write the same way. `body` is the whole passage as Markdown, pictures included, exactly as Readwise gives it. `title` is the passage's first paragraph as plain text, without Markdown, cut at a word boundary to at most 80 characters with an ellipsis. A blank line ends a paragraph, and a Markdown heading is a paragraph of its own; a single line break, such as one Reader puts around a link or a soft wrap, reads as a space. The title leaves out list and quotation markers at its start, a heading's permalink mark such as `#`, and any space before a closing punctuation mark or bracket. The Readwise Reader connector takes the title from the export passage, which keeps the paragraph breaks that Reader's plain passage loses, and from Reader's passage when the export has no words. A heading in either passage ends the title, because the export can join a heading to the text after it. A passage with only a picture is titled `Picture from <document title>`, or `Picture` when the document's title is unknown. `text` keeps the passage as before, and `note` stays the separate annotation.

### Field kinds

Every timestamp field, such as `highlighted_at`, `readwise_created_at` and `reader_saved_at`, is a `datetime` field. `reader_published_date` is a `date` field. Every address field, such as `source_url`, `readwise_url` and `reader_image_url`, is a `url` field; an address is stored as Marfa stores any URL, trimmed and without tabs or line breaks. A value Readwise sends in another shape never stops a row from being written:

- A blank value is left out.
- Any other value the field refuses is left out of its field and kept, exactly as sent, in `original_values` under the field's name. It leaves `original_values` once Readwise sends a value the field accepts.

Both types retain available export IDs and external IDs. A Reader-only row has no fabricated export ID. Verified Reader identities share the same rows through `canonical_key`; managed Reader content uses the shared preservation implementation.

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
marfa keys create --label readwise --source readwise --type-permission readwise.source=write --type-permission readwise.highlight=write --type-permission readwise.file=write --edge-permission references=write --edge-permission attached-to=write --metadata-permission types=write --default-tier feed
```

The built-in `references` and `attached-to` definitions are not registered or changed. Do not grant `metadata edge_types=write` or unrelated permissions.

Supply these environment variables through your secret manager or process environment:

| Variable                     | Meaning                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARFA_API_URL`              | Marfa instance address.                                                                                                                                                       |
| `MARFA_API_KEY`              | The scoped key created above.                                                                                                                                                 |
| `READWISE_ACCESS_TOKEN`      | Your Readwise access token, treated as a secret.                                                                                                                              |
| `READWISE_ACCOUNT`           | Stable nonsecret account label, such as `primary`.                                                                                                                            |
| `READWISE_CONTENT_MAX_BYTES` | Remote resource limit in bytes, from 1 through 1073741824 (1 GiB). Default: 268435456 (256 MiB).                                                                              |
| `READWISE_API_URL`           | Optional API base for controlled testing; defaults to `https://readwise.io/api/v2/`. Requires HTTPS, except HTTP on loopback, and rejects credentials, queries and fragments. |

Run once or poll with the kit's existing scheduler:

```bash
node connectors/readwise/dist/main.js --once
node connectors/readwise/dist/main.js --every 15m
```

A saved account label or endpoint cannot be changed in place. Restore the original configuration if startup reports a mismatch. Rotating the access token leaves identities and progress unchanged. The [template deployment guide](../../template/README.md) covers launchd and Docker; this connector does not install a scheduled service itself.

## Progress and recovery

The first run exports all records. Later runs use the previous completed walk's start time with a five-minute overlap. Each page is checkpointed only after its rows and applicable references are acknowledged, or its refused rows are durably retained for refetch by the kit. An interrupted walk retains its original start time, lower bound and cursor. An uncertain acknowledgement is resolved by reading saved state on the next run; repeated data keeps the same identities and does not rewrite unchanged items.

Incremental exports do not guarantee source-only metadata changes. A full rescan is due every 24 hours, and a changed effective field set also starts a full rescan. A run processes at most 50 pages of the main export before leaving the remaining walk for the next scheduled run. Repeated cursors fail visibly; a walk that exceeds 4,096 distinct cursors also stops with progress retained. Only an explicit invalid-cursor response restarts the same saved window.

Rejected rows use the kit's bounded refetch journal, even when every row on a page is rejected. A pending highlight is resolved through its detail endpoint to a source ID, then the complete source is exported by ID without an incremental filter. Missing answers leave the refusal pending; explicit tombstones settle deletion. A journal or checkpoint that cannot safely retain progress blocks advancement.

HTTP 429 responses save `Retry-After` deadlines across restarts. Missing or malformed guidance fails visibly without guessing a retry delay. Requests have a 30-second timeout, honor cancellation, reject redirects and limit decoded responses to 32 MiB. Authentication failures, malformed data and unavailable services do not become successful empty imports. Watch-only kit runs restore mirrored fields from existing agreements and do not poll Readwise or advance export progress.

## Verify the connector

From the repository root:

```bash
pnpm exec vitest run connectors/readwise/test
pnpm proof
```

The mapping follows the [Readwise export API](https://readwise.io/api_deets#highlight-export).

## Use Highlights with Reader

Both installations use the same `READWISE_ACCOUNT` label and write item source `readwise`. They have separate registration keys: `readwise` for Highlights and `readwise-reader` for Reader. Their checkpoints and agreements are independent.

The private `@withmarfa/readwise` workspace package defines both item types, identities, and vendor mappings. Existing export natural keys and item IDs remain unchanged. Reader-only rows use `<account>:reader-document:<ID>` or `<account>:reader-highlight:<ID>`. The `canonical_key` link joins verified Reader identities to existing rows, including archived and trashed rows. Purged identities are not recreated, and conflicting holders produce a condition requiring investigation. An export ID arriving later enriches the existing Reader row.

For verified Reader-managed rows, Highlights refreshes Reader metadata, including when no export change is available and the Reader process is stopped. Up to 20 managed document and known annotation lookups use direct requests. Larger sets use a complete validated Reader listing when its first page indicates no more requests than individual lookups; a large unrelated feed keeps the direct lookup path. The listing retains only those managed identities and known annotations and does not authorize deletion. Reader supplies the canonical passage; a differing export passage is retained in `readwise_text`. Highlights observes shared fields without replacing pending local edits or carrying them upstream. Export tombstones do not archive Reader-managed rows. Ordinary export-only rows retain their existing behavior.

Set `READWISE_READER_API_URL` only for controlled testing. Its default is `https://readwise.io/api/v3/`, with the same endpoint restrictions as `READWISE_API_URL`. The token is sent only to the configured API endpoint. A failed Reader lookup never substitutes older export values. Managed Reader content and over-limit text use the shared bounded preservation queue, including when Reader is stopped. An acknowledged manifest for the same canonical identity and revision avoids requeuing unchanged content. Queue pressure drains ready work before admission; if capacity remains full, refresh retains its cursor before the unaccepted row and does not report completion. The last good row and bytes remain until their replacements are acknowledged. Grant `readwise.file=write` and `attached-to=write` before enabling this content recovery.

Downloads stream through a private temporary file, removed after success, failure, or cancellation; upload retries reopen that file without buffering the whole resource in memory. Set `READWISE_CONTENT_MAX_BYTES` to a positive decimal byte count, default 268435456 (256 MiB), at most 1073741824 (1 GiB). Oversized resources remain pending with an explicit byte-limit condition and keep their last acknowledged copy. A limit increase applies to existing pending jobs at their recorded retry deadlines without triggering a metadata backfill.

## Replace existing schemas

Adding the canonical link and making export IDs optional are structural changes. Normal scoped connector startup deliberately refuses to replace an existing incompatible schema.

1. Stop both connector installations. Keep their registrations, checkpoints, agreements, and stored rows.
2. Back up the instance and inventory `readwise.source` and `readwise.highlight`, including archived and trashed rows, tombstones, properties, and relationships.
3. Review the definitions in `shared/readwise/src/readwise.source.json` and `shared/readwise/src/readwise.highlight.json`. Using the existing administrative client, replace those two type definitions through `PUT /types/{id}`. Do not delete or recreate the types or items.
4. Read the definitions and inventory back. Confirm that item IDs, natural keys, state, properties, tombstones, and relationships are unchanged.
5. Install builds using the same shared definitions in both connectors before restarting either. Existing canonical links are resolved before further imports; identity conflicts must be investigated without merging or deleting rows automatically.

This operation changes schemas only. It does not migrate item identities, erase stored content, or authorize provider writes.

### Upgrade to highlight titles and field kinds

The release that adds highlight titles and field kinds changes the kind of existing fields, which only an operator can do. Until you replace the types, each connector stops at startup and names the `marfa types replace` command to run. Follow the steps above, replacing both types with a credential that holds `schema.write`:

```bash
marfa types replace readwise.source --file shared/readwise/src/readwise.source.json
marfa types replace readwise.highlight --file shared/readwise/src/readwise.highlight.json
```

The replacement adds `title`, `body` and `original_values`, sets the highlight's display fields, and changes no stored item. Restart the connectors straight afterward. Because their types changed, the first run of each connector reads the whole account again and rewrites each row in place, under the same natural key:

- Every highlight gains its `title` and `body`.
- A row holding a blank address or date loses that blank value, and a value its field's kind refuses moves to `original_values`. Until then, an edit to that row in Marfa is refused, because Marfa checks the whole row on each write.
- A source whose values already fit is left unchanged.

No item is created, duplicated or deleted. With outbound edits on, `title` and `body` are read only and are never sent to Readwise; `note` and the other editable fields carry edits as before.
