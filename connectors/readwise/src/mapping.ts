import type { Entry } from "@withmarfa/connector";
import type { Highlight, Source, Tag } from "./export.js";

export function identity(
  account: string,
  kind: "source" | "highlight",
  id: number,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account))
    throw new Error(
      "READWISE_ACCOUNT must be a stable label of 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit",
    );
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("Readwise ID must be a positive safe integer");
  return `${account}:${kind}:${String(id)}`;
}
function normalizedTags(tags: Tag[] | undefined): string[] {
  return [
    ...new Set(
      (tags ?? [])
        .map((tag) => (typeof tag === "string" ? tag : tag.name).trim())
        .filter(Boolean),
    ),
  ];
}
function properties(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}
function webUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}
function date(value: string | null | undefined): string | undefined {
  return value &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}
export function mapSource(account: string, source: Source): Entry {
  if (source.is_deleted === true)
    throw new Error("Readwise source tombstones must be archived, not mapped");
  return {
    source_id: identity(account, "source", source.user_book_id),
    properties: properties({
      readwise_id: String(source.user_book_id),
      account,
      title: source.title?.trim()
        ? source.title
        : source.readable_title?.trim()
          ? source.readable_title
          : `Readwise source ${String(source.user_book_id)}`,
      readable_title: source.readable_title,
      author: source.author,
      description: source.summary,
      notes: source.document_note,
      url: webUrl(source.source_url) ?? webUrl(source.readwise_url),
      image_url: webUrl(source.cover_image_url),
      category: source.category,
      readwise_source: source.source,
      source_url: source.source_url,
      cover_image_url: source.cover_image_url,
      unique_url: source.unique_url,
      readwise_url: source.readwise_url,
      external_id: source.external_id,
      asin: source.asin,
      tags: normalizedTags(source.book_tags),
    }),
  };
}
const colors = new Set(["yellow", "blue", "green", "pink", "orange", "purple"]);
const locators: Record<string, string> = {
  offset: "offset",
  page: "page",
  time_offset: "time",
  order: "order",
  none: "none",
  cfi: "cfi",
};
export function mapHighlight(
  account: string,
  sourceId: number,
  highlight: Highlight,
): Entry {
  if (highlight.is_deleted === true || typeof highlight.text !== "string")
    throw new Error(
      "Readwise highlight tombstones must be archived, not mapped",
    );
  return {
    source_id: identity(account, "highlight", highlight.id),
    occurred_at: date(highlight.highlighted_at),
    changed_at: date(highlight.updated_at),
    properties: properties({
      readwise_id: String(highlight.id),
      account,
      readwise_source_id: String(sourceId),
      text: highlight.text,
      note: highlight.note,
      color:
        highlight.color && colors.has(highlight.color)
          ? highlight.color
          : undefined,
      readwise_color: highlight.color,
      locator_type: highlight.location_type
        ? locators[highlight.location_type]
        : undefined,
      start_location:
        highlight.location == null ? undefined : String(highlight.location),
      end_location:
        highlight.end_location == null
          ? undefined
          : String(highlight.end_location),
      location: highlight.location,
      location_type: highlight.location_type,
      highlighted_at: highlight.highlighted_at,
      readwise_created_at: highlight.created_at,
      readwise_updated_at: highlight.updated_at,
      external_id: highlight.external_id,
      url: highlight.url,
      readwise_url: highlight.readwise_url,
      tags: normalizedTags(highlight.tags),
      is_favorite: highlight.is_favorite,
      is_discard: highlight.is_discard,
    }),
    connections: {
      references: [
        { type: "readwise.source", id: identity(account, "source", sourceId) },
      ],
    },
  };
}
