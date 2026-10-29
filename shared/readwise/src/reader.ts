import { createHash } from "node:crypto";
import type { Entry } from "@withmarfa/connector";
import { highlightDisplay } from "./display.js";
import { fitKinds } from "./kinds.js";
import {
  date,
  highlightKinds,
  identity,
  properties,
  sourceKinds,
  webUrl,
} from "./mapping.js";

export interface ReaderDocument {
  id: string;
  category: string;
  title?: string | null;
  author?: string | null;
  content?: string | null;
  notes?: string | null;
  parent_id?: string | null;
  tags?: Record<string, unknown> | null;
  url?: string | null;
  source_url?: string | null;
  image_url?: string | null;
  summary?: string | null;
  language?: string | null;
  location?: string | null;
  source?: string | null;
  site_name?: string | null;
  word_count?: number | null;
  reading_time?: string | null;
  listening_time?: string | null;
  published_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  first_opened_at?: string | null;
  last_opened_at?: string | null;
  saved_at?: string | null;
  last_moved_at?: string | null;
  highlight_offset?: number | null;
  highlight_location?: string | null;
  reading_progress?: number | null;
  html_content?: string | null;
  raw_source_url?: string | null;
}
export interface ReaderPage {
  count: number;
  nextPageCursor: string | null;
  results: ReaderDocument[];
}
const stringFields = [
  "title",
  "author",
  "content",
  "notes",
  "parent_id",
  "url",
  "source_url",
  "image_url",
  "summary",
  "language",
  "location",
  "source",
  "site_name",
  "reading_time",
  "listening_time",
  "published_date",
  "created_at",
  "updated_at",
  "first_opened_at",
  "last_opened_at",
  "saved_at",
  "last_moved_at",
  "highlight_location",
  "html_content",
  "raw_source_url",
] as const;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return false;
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      return false;
  return true;
}
export function parseReaderPage(value: unknown): ReaderPage {
  if (
    !record(value) ||
    !Number.isSafeInteger(value["count"]) ||
    (value["count"] as number) < 0 ||
    !(value["nextPageCursor"] === null || validId(value["nextPageCursor"])) ||
    !Array.isArray(value["results"])
  )
    throw new Error("Reader returned an invalid page");
  const seen = new Set<string>();
  for (const row of value["results"]) {
    if (
      !record(row) ||
      !validId(row["id"]) ||
      typeof row["category"] !== "string" ||
      row["category"] === "" ||
      seen.has(row["id"])
    )
      throw new Error("Reader returned an invalid or duplicate document");
    seen.add(row["id"]);
    for (const field of stringFields)
      if (row[field] != null && typeof row[field] !== "string")
        throw new Error(`Reader returned invalid ${field}`);
    for (const field of ["word_count", "highlight_offset"])
      if (row[field] != null && !Number.isSafeInteger(row[field]))
        throw new Error(`Reader returned invalid ${field}`);
    if (
      row["reading_progress"] != null &&
      (typeof row["reading_progress"] !== "number" ||
        !Number.isFinite(row["reading_progress"]))
    )
      throw new Error("Reader returned invalid reading_progress");
    if (row["tags"] != null && !record(row["tags"]))
      throw new Error("Reader returned invalid tags");
    if (
      ["highlight", "note"].includes(row["category"]) &&
      typeof row["content"] !== "string"
    )
      throw new Error("Reader returned a child without content");
  }
  return value as unknown as ReaderPage;
}
export function readerIdentity(
  account: string,
  kind: "document" | "highlight",
  id: string,
): string {
  identity(account, "source", 1);
  if (!validId(id))
    throw new Error(
      "Reader ID must be a nonempty bounded string without control characters",
    );
  return `${account}:reader-${kind}:${id}`;
}
export interface ExistingIdentity {
  id: string;
  source_id: string | null;
  state: string;
}
export interface ResolvedIdentity {
  sourceId: string;
  state?: string;
}
export function reconcileIdentity(
  canonical: string,
  candidates: readonly ExistingIdentity[],
): ResolvedIdentity {
  const unique = new Map(candidates.map((row) => [row.id, row]));
  if (unique.size > 1)
    throw new Error(
      "Readwise identity conflict; multiple existing rows or tombstones match",
    );
  const row = unique.values().next().value;
  if (row === undefined) return { sourceId: canonical };
  if (!row.source_id)
    throw new Error(
      "Readwise identity conflict; existing row has no natural key",
    );
  return { sourceId: row.source_id, state: row.state };
}
export interface ReaderEnrichment {
  sourceId?: string;
  properties?: Readonly<Record<string, unknown>>;
  notes?: readonly ReaderDocument[];
  /** The title of the document a highlight belongs to, for a passage with no words. */
  documentTitle?: string | null | undefined;
}
export interface TextFilePlan {
  key: string;
  field: string;
  text: string;
}
export interface ReaderMapping {
  entry: Entry;
  textFiles: TextFilePlan[];
  conditions: string[];
}
const metadataFields = [
  "location",
  "source",
  "site_name",
  "word_count",
  "reading_time",
  "listening_time",
  "published_date",
  "created_at",
  "updated_at",
  "first_opened_at",
  "last_opened_at",
  "saved_at",
  "last_moved_at",
  "highlight_offset",
  "highlight_location",
  "reading_progress",
  "url",
  "source_url",
  "image_url",
  "language",
] as const;
export const readerMutableSourceFields = [
  "title",
  "author",
  "description",
  "notes",
  "tags",
  "reader_location",
  "category",
  "language",
  "published_at",
  "image_url",
] as const;
export const readerMutableHighlightFields = ["note", "tags"] as const;
export function isReaderManaged(
  type: string,
  value: Readonly<Record<string, unknown>>,
  account?: string,
): boolean {
  const kind =
    type === "readwise.source"
      ? "document"
      : type === "readwise.highlight"
        ? "highlight"
        : undefined;
  return (
    kind !== undefined &&
    value["reader_managed"] === true &&
    typeof value["account"] === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value["account"]) &&
    (account === undefined || value["account"] === account) &&
    validId(value["reader_id"]) &&
    value["canonical_key"] ===
      readerIdentity(value["account"], kind, value["reader_id"])
  );
}
export function foldReaderNotes(
  highlight: ReaderDocument,
  notes: readonly ReaderDocument[],
): {
  note: string | null | undefined;
  records: Record<string, ReaderDocument>;
  differs: boolean;
} {
  const records: Record<string, ReaderDocument> = Object.create(null) as Record<
    string,
    ReaderDocument
  >;
  for (const note of notes) {
    if (note.category !== "note" || note.parent_id !== highlight.id)
      throw new Error("Reader note does not belong to its highlight");
    records[note.id] = Object.fromEntries(
      Object.entries(note).filter(
        ([key]) => !["raw_source_url", "html_content"].includes(key),
      ),
    ) as unknown as ReaderDocument;
  }
  const latest = [...notes].sort((a, b) =>
    (a.updated_at ?? "").localeCompare(b.updated_at ?? ""),
  );
  const fallback = latest.at(-1)?.content;
  return {
    note: highlight.notes !== undefined ? highlight.notes : fallback,
    records,
    differs:
      highlight.notes !== undefined &&
      fallback !== undefined &&
      highlight.notes !== fallback,
  };
}
function mapped(
  account: string,
  row: ReaderDocument,
  kind: "document" | "highlight",
  enrichment: ReaderEnrichment,
): ReaderMapping {
  const canonical = readerIdentity(account, kind, row.id);
  // Export-only fields survive Reader refreshes; old Reader fields are replaced below.
  const old = enrichment.properties ?? {};
  const kept = Object.fromEntries(
    Object.entries(old).filter(
      ([key]) =>
        !key.startsWith("reader_") &&
        !(kind === "highlight" && key === "body") &&
        ![
          "canonical_key",
          "text",
          "note",
          "title",
          "author",
          "description",
          "notes",
          "tags",
          "url",
          "image_url",
          "category",
          "language",
          "published_at",
          "locator_type",
          "start_location",
          "end_location",
        ].includes(key),
    ),
  );
  const values: Record<string, unknown> = {
    ...kept,
    account,
    canonical_key: canonical,
    reader_id: row.id,
    reader_managed: true,
    reader_parent_id: row.parent_id,
    category: row.category,
    tags: Object.keys(row.tags ?? {}),
    reader_metadata: Object.fromEntries(
      Object.entries({
        title: row.title,
        author: row.author,
        summary: row.summary,
        notes: row.notes,
        tags: row.tags ?? null,
      }).filter(([, value]) => value !== undefined),
    ),
  };
  for (const field of metadataFields) values[`reader_${field}`] = row[field];
  const result: ReaderMapping = {
    entry: {
      source_id: enrichment.sourceId ?? canonical,
      properties: values,
      changed_at: date(row.updated_at),
      ...(enrichment.sourceId !== undefined &&
        old["canonical_key"] === enrichment.sourceId &&
        old["reader_managed"] !== true &&
        enrichment.sourceId !== canonical && {
          movedFrom: enrichment.sourceId,
        }),
    },
    textFiles: [],
    conditions: [],
  };
  if (kind === "document")
    Object.assign(values, {
      title: row.title?.trim() ? row.title : `Reader document ${row.id}`,
      author: row.author,
      description: row.summary,
      notes: row.notes,
      url: webUrl(row.source_url) ?? webUrl(row.url),
      image_url: webUrl(row.image_url),
      language:
        row.language &&
        /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(row.language)
          ? row.language
          : undefined,
      published_at: date(row.published_date),
    });
  else {
    if (typeof row.content !== "string")
      throw new Error("Reader highlight has no passage");
    const folded = foldReaderNotes(row, enrichment.notes ?? []);
    Object.assign(values, {
      text: row.content,
      note: folded.note,
      reader_notes: Object.keys(folded.records).length
        ? folded.records
        : old["reader_notes"],
      readwise_text:
        typeof old["readwise_text"] === "string"
          ? old["readwise_text"]
          : old["reader_managed"] !== true && typeof old["text"] === "string"
            ? old["text"]
            : undefined,
    });
    if (values["readwise_text"] === row.content) delete values["readwise_text"];
    Object.assign(
      values,
      highlightDisplay(
        row.content,
        values["readwise_text"],
        enrichment.documentTitle,
        old,
      ),
    );
    if (folded.differs) result.conditions.push("note-snapshot-differs");
    if (row.highlight_offset != null)
      Object.assign(values, {
        locator_type: "offset",
        start_location: String(row.highlight_offset),
      });
    result.entry.occurred_at = date(row.created_at);
    result.entry.connections = {
      references: row.parent_id
        ? [
            {
              type: "readwise.source",
              id: readerIdentity(account, "document", row.parent_id),
            },
          ]
        : [],
    };
    if (!row.parent_id) result.conditions.push("unresolved-parent");
  }
  const originals = old["original_values"];
  if (typeof originals === "object" && originals !== null)
    values["original_values"] = Object.fromEntries(
      Object.entries(originals).filter(([key]) => !key.startsWith("reader_")),
    );
  fitKinds(values, kind === "document" ? sourceKinds : highlightKinds);
  for (const [field, value] of Object.entries(values)) {
    if (kind === "highlight" && field === "body") continue;
    const text =
      typeof value === "string"
        ? value
        : typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : undefined;
    if (text === undefined || text.length <= 100_000) continue;
    const digest = createHash("sha256").update(text).digest("hex");
    const key = `${canonical}:text:${field}:${digest}`;
    result.textFiles.push({ key, field, text });
    values[field] =
      field === "text" || field === "title"
        ? `Complete ${field} is preserved in the attached text file.`
        : undefined;
  }
  if (
    kind === "highlight" &&
    typeof values["body"] === "string" &&
    values["body"].length > 100_000
  )
    values["body"] = "Complete passage is preserved in the attached text file.";
  if (result.textFiles.length)
    values["reader_text_files"] = result.textFiles.map(({ key }) => key);
  result.entry.properties = properties(values);
  return result;
}
export function mapReaderSource(
  account: string,
  row: ReaderDocument,
  enrichment: ReaderEnrichment = {},
): ReaderMapping {
  if (["highlight", "note"].includes(row.category))
    throw new Error("Reader child cannot be mapped as a source");
  return mapped(account, row, "document", enrichment);
}
export function mapReaderHighlight(
  account: string,
  row: ReaderDocument,
  enrichment: ReaderEnrichment = {},
): ReaderMapping {
  if (row.category !== "highlight")
    throw new Error("Reader document is not a highlight");
  return mapped(account, row, "highlight", enrichment);
}

/** Both connectors fingerprint the same content work, independent of fetch options. */
export function readerContentRevision(
  document: ReaderDocument,
  notes: readonly ReaderDocument[] = [],
  textFiles: readonly TextFilePlan[] = [],
): string {
  const metadata = (row: ReaderDocument) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !["raw_source_url", "html_content"].includes(key),
      ),
    );
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable([
          metadata(document),
          [...notes].sort((a, b) => a.id.localeCompare(b.id)).map(metadata),
          [...textFiles].sort((a, b) => a.key.localeCompare(b.key)),
        ]),
      ),
    )
    .digest("hex");
}
