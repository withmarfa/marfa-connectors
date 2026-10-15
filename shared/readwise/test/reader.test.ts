import { describe, expect, it } from "vitest";
import {
  parseReaderPage,
  readerContentRevision,
  readerIdentity,
  mapReaderSource,
  mapReaderHighlight,
  reconcileIdentity,
  highlightType,
} from "../src/index.js";

const document = {
  id: "doc",
  category: "podcast",
  title: "Title",
  location: "unknown",
  tags: { 日本語: { name: "日本語" } },
  notes: "",
  reading_progress: 0.3,
};
describe("shared Reader mapping", () => {
  it("keeps unknown metadata, empty clears and Reader-only identities without fabricated export IDs", () => {
    const parsed = parseReaderPage({
      count: 1,
      nextPageCursor: null,
      results: [document],
    });
    const mapped = mapReaderSource("one", parsed.results[0] ?? document);
    expect(mapped.entry.source_id).toBe("one:reader-document:doc");
    expect(mapped.entry.properties).toMatchObject({
      canonical_key: "one:reader-document:doc",
      reader_managed: true,
      category: "podcast",
      reader_location: "unknown",
      reader_reading_progress: 0.3,
      tags: ["日本語"],
      notes: "",
    });
    expect(mapped.entry.properties["readwise_id"]).toBeUndefined();
    expect(highlightType.fields["readwise_id"]?.required).not.toBe(true);
  });
  it("uses Reader passage and keeps differing export passage with the old natural key", () => {
    const mapped = mapReaderHighlight(
      "one",
      {
        id: "hi",
        category: "highlight",
        parent_id: "doc",
        content: "Reader text",
        notes: "",
        tags: null,
      },
      {
        sourceId: "one:highlight:42",
        properties: {
          readwise_id: "42",
          text: "Export text",
          readwise_source_id: "7",
        },
      },
    );
    expect(mapped.entry.source_id).toBe("one:highlight:42");
    expect(mapped.entry.properties).toMatchObject({
      text: "Reader text",
      readwise_text: "Export text",
      readwise_id: "42",
      note: "",
    });
    expect(mapped.entry.connections).toEqual({
      references: [{ type: "readwise.source", id: "one:reader-document:doc" }],
    });
  });
  it("preserves over-limit text through explicit file plans and keeps orphans", () => {
    const text = "漢".repeat(100_001);
    const mapped = mapReaderHighlight("one", {
      id: "hi",
      category: "highlight",
      content: text,
      parent_id: null,
    });
    expect(mapped.textFiles[0]?.text).toBe(text);
    expect(mapped.entry.properties["reader_text_files"]).toContain(
      mapped.textFiles[0]?.key,
    );
    expect(mapped.conditions).toContain("unresolved-parent");
    expect(mapped.entry.connections).toEqual({ references: [] });
  });
  it("rejects malformed pages without converting failure to emptiness", () => {
    for (const value of [
      {},
      { count: 1, nextPageCursor: null, results: [null] },
      { count: 1, nextPageCursor: null, results: [{ ...document, tags: 3 }] },
      {
        count: 1,
        nextPageCursor: null,
        results: [{ id: "hi", category: "highlight" }],
      },
    ])
      expect(() => parseReaderPage(value)).toThrow();
  });
  it("retains an existing natural key in every state and refuses conflicting identities", () => {
    const key = readerIdentity("one", "document", "doc");
    for (const state of ["active", "archived", "trashed", "purged"] as const) {
      const found = reconcileIdentity(key, [
        { id: "existing", source_id: "one:source:7", state },
      ]);
      expect(found).toMatchObject({ sourceId: "one:source:7", state });
    }
    expect(() =>
      reconcileIdentity(key, [
        { id: "a", source_id: "one:source:7", state: "active" },
        { id: "b", source_id: key, state: "trashed" },
      ]),
    ).toThrow(/conflict/i);
  });
});

it("shares content revisions across omitted notes and refreshed fetch options", () => {
  const revision = readerContentRevision(document);
  expect(
    readerContentRevision(
      {
        ...document,
        html_content: "Fetched HTML",
        raw_source_url: "https://example.com/?signature=temporary",
      },
      [],
    ),
  ).toBe(revision);
  expect(
    readerContentRevision({ ...document, updated_at: "2026-10-15T12:00:00Z" }),
  ).not.toBe(revision);
});
it("keeps retained note identities when content work supplies no verified notes", () => {
  const notes = { n: { content: "Retained annotation", parent_id: "hi" } };
  const mapped = mapReaderHighlight(
    "one",
    { id: "hi", category: "highlight", content: "Long passage", notes: "" },
    { notes: [], properties: { reader_notes: notes } },
  );
  expect(mapped.entry.properties["reader_notes"]).toEqual(notes);
  expect(mapped.entry.properties["note"]).toBe("");
});
