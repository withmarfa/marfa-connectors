# Readwise

Readwise export types and mappings for a read-only highlights connector. This package currently contains the data model and validation; it does not yet have a runnable sync process.

## Data model

`readwise.source` inherits `core.media`. It represents a book, article, tweet, podcast, or another source exported by Readwise. `readwise.highlight` inherits `core.highlight` and keeps the complete passage and annotation. Each highlight declares a `references` edge to its source, which expresses a reference rather than containment.

Source notes map to `notes`, summaries to `description`, and valid source and cover URLs to `url` and `image_url`. Readwise's original URLs are retained separately even when they cannot populate a core URL field. A blank title falls back to `readable_title`, then `Readwise source <ID>`.

Highlight times map to the item's `occurred_at` and `changed_at` when valid. Original timestamp strings remain available in properties. `time_offset` maps to the core `time` locator; page, offset, order, none, and cfi retain their meaning. Original location kinds, numeric locations, and colors are retained even when core enums cannot represent them. Text and annotations are never truncated. Tags from strings or named objects are trimmed and deduplicated without changing case or Unicode.

Both types retain Readwise IDs and external IDs. The source's `external_id`, when `readwise_source` is `reader`, provides a later Reader connector with the upstream identifier. This does not claim cross-API deduplication or import Reader document content.

## Account identity

The caller supplies one stable, nonsecret account label. Labels have 1–64 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit. Natural keys are `<account>:source:<ID>` and `<account>:highlight:<ID>`, separating the two independent ID sequences. Keep the label unchanged across token changes and reinstallations. The connector is designed for one account; the label is not inferred from a token or an undocumented account response.

## Export validation

The parser requires a valid export envelope with a nonnegative count, explicit next-page cursor or null, and source and highlight arrays. The count describes highlights, not the number of sources. Invalid IDs, text, flags, or tag structures fail visibly instead of being treated as an empty account. Optional metadata can be absent or null where Readwise allows it. An explicit tombstone may omit passage text; mapping functions reject tombstones so the sync layer must handle them as archival operations that preserve existing content.

The sync implementation will request explicit deletions and archive only those records. Missing records and empty responses will not imply deletion. Outbound editing and daily deployment are outside this package's current scope.

## Check the mapping

From the repository root:

```bash
pnpm exec vitest run connectors/readwise/test/mapping.test.ts
```

The mapping follows the [Readwise export API](https://readwise.io/api_deets#highlight-export).
