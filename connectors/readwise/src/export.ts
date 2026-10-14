export interface Highlight {
  id: number;
  is_deleted?: boolean;
  text?: string;
  note?: string | null;
  color?: string | null;
  location?: number | null;
  end_location?: number | null;
  location_type?: string | null;
  highlighted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  external_id?: string | null;
  url?: string | null;
  readwise_url?: string | null;
  book_id?: number;
  tags?: Tag[];
  is_favorite?: boolean;
  is_discard?: boolean;
}
export type Tag = string | { name: string; id?: number };
export interface Source {
  user_book_id: number;
  is_deleted?: boolean;
  title?: string | null;
  readable_title?: string | null;
  author?: string | null;
  source?: string | null;
  cover_image_url?: string | null;
  unique_url?: string | null;
  category?: string | null;
  document_note?: string | null;
  summary?: string | null;
  readwise_url?: string | null;
  source_url?: string | null;
  external_id?: string | null;
  asin?: string | null;
  book_tags?: Tag[];
  highlights: Highlight[];
}
export interface ExportPage {
  count: number;
  nextPageCursor: string | null;
  results: Source[];
}
function invalid(field: string): never {
  throw new Error(`Readwise export has an invalid ${field}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function id(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid(field);
}
function strings(row: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && typeof value !== "string")
      invalid(name);
  }
}
function flags(row: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names)
    if (row[name] !== undefined && typeof row[name] !== "boolean")
      invalid(name);
}
function tags(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid("tags");
  for (const tag of value) {
    if (typeof tag === "string") continue;
    if (typeof object(tag, "tag")["name"] !== "string") invalid("tag name");
  }
}
export function parsePage(value: unknown): ExportPage {
  const page = object(value, "page");
  if (
    typeof page["count"] !== "number" ||
    !Number.isSafeInteger(page["count"]) ||
    page["count"] < 0
  )
    invalid("count");
  if (
    page["nextPageCursor"] !== null &&
    (typeof page["nextPageCursor"] !== "string" ||
      page["nextPageCursor"].length === 0)
  )
    invalid("nextPageCursor");
  if (!Array.isArray(page["results"])) invalid("results");
  for (const value of page["results"]) {
    const source = object(value, "source");
    id(source["user_book_id"], "user_book_id");
    flags(source, ["is_deleted"]);
    strings(source, [
      "title",
      "readable_title",
      "author",
      "source",
      "cover_image_url",
      "unique_url",
      "category",
      "document_note",
      "summary",
      "readwise_url",
      "source_url",
      "external_id",
      "asin",
    ]);
    tags(source["book_tags"]);
    if (!Array.isArray(source["highlights"])) invalid("highlights");
    for (const value of source["highlights"]) {
      const highlight = object(value, "highlight");
      id(highlight["id"], "highlight id");
      flags(highlight, ["is_deleted", "is_favorite", "is_discard"]);
      if (
        highlight["is_deleted"] !== true &&
        typeof highlight["text"] !== "string"
      )
        invalid("highlight text");
      strings(highlight, [
        "text",
        "note",
        "color",
        "location_type",
        "highlighted_at",
        "created_at",
        "updated_at",
        "external_id",
        "url",
        "readwise_url",
      ]);
      for (const name of ["location", "end_location"]) {
        const location = highlight[name];
        if (
          location !== undefined &&
          location !== null &&
          (typeof location !== "number" || !Number.isSafeInteger(location))
        )
          invalid(name);
      }
      if (
        highlight["book_id"] !== undefined &&
        highlight["book_id"] !== source["user_book_id"]
      )
        invalid("highlight book_id");
      tags(highlight["tags"]);
    }
  }
  return value as ExportPage;
}
