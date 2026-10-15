import { describe, expect, it } from "vitest";
import type { Item, Entry } from "@withmarfa/connector";
import {
  mapSource,
  readerIdentity,
  type ReaderReader,
  type ContentJob,
} from "@withmarfa/readwise";
import { SharedRows, highlightsPolicy } from "../src/coexistence.js";
const row = (sourceId = "one:source:7"): Item => ({
  id: "held",
  source_id: sourceId,
  source: "readwise",
  type: "readwise.source",
  state: "active",
  version: 1,
  schema_version: 1,
  occurred_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  properties: {
    account: "one",
    canonical_key: readerIdentity("one", "document", "doc"),
    reader_id: "doc",
    reader_managed: true,
    title: "Local pending",
    notes: "Local note",
  },
});
function setup(
  items: Item[] = [],
  preserve?: (job: ContentJob) => Promise<void>,
) {
  const writes: { type: string; entries: readonly Entry[] }[] = [];
  const reader: ReaderReader = {
    page: () =>
      Promise.resolve({ count: 0, nextPageCursor: null, results: [] }),
    document: () =>
      Promise.resolve({
        id: "doc",
        category: "article",
        title: "Reader title",
        notes: "Reader note",
      }),
  };
  const context = {
    inspect: (
      _type: string,
      query: { links?: readonly string[]; source_ids?: readonly string[] },
    ) =>
      Promise.resolve({
        items: items.filter(
          (item) =>
            (query.links?.includes(String(item.properties["canonical_key"])) ??
              false) ||
            query.source_ids?.includes(item.source_id ?? ""),
        ),
        tombstones: [],
      }),
    held: (type: string) =>
      Promise.resolve(items.filter((item) => item.type === type)),
    log: { condition: () => undefined },
  };
  return {
    shared: new SharedRows("one", context, reader, preserve),
    reader,
    writes,
    scope: {
      upsert: (type: string, entries: readonly Entry[]) => {
        writes.push({ type, entries });
        return Promise.resolve();
      },
    },
  };
}
describe("Highlights coexistence", () => {
  it.each([false, true])(
    "refreshes a cleared annotation when its old record is absent: %s",
    async (present) => {
      const held = row("one:reader-highlight:hi");
      held.type = "readwise.highlight";
      held.properties = {
        account: "one",
        canonical_key: readerIdentity("one", "highlight", "hi"),
        reader_id: "hi",
        reader_managed: true,
        text: "Passage",
        note: "Old note",
        reader_notes: { note: { content: "Old note" } },
      };
      const f = setup([held]);
      f.reader.document = (id) =>
        Promise.resolve(
          id === "hi"
            ? {
                id: "hi",
                category: "highlight",
                parent_id: "doc",
                content: "Passage",
                notes: "",
              }
            : present
              ? {
                  id: "note",
                  category: "note",
                  parent_id: "hi",
                  content: "Old note",
                }
              : undefined,
        );
      await f.shared.refresh(f.scope);
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]?.entries[0]?.properties["note"]).toBe("");
      if (!present)
        expect(f.writes[0]?.entries[0]?.properties["reader_notes"]).toEqual(
          held.properties["reader_notes"],
        );
    },
  );
  it("keeps standalone export mapping without asking Reader", async () => {
    const f = setup();
    f.reader.document = () =>
      Promise.reject(new Error("Unexpected Reader call"));
    const source = {
      user_book_id: 7,
      title: "Export title",
      external_id: "doc",
      source: "reader",
      highlights: [],
    };
    const result = await f.shared.source(source);
    expect(result).toEqual(mapSource("one", source));
  });
  it("enriches Reader-first rows without changing their natural key or reading stale export text", async () => {
    const f = setup([row("one:reader-document:doc")]);
    const result = await f.shared.source({
      user_book_id: 7,
      title: "Stale export",
      external_id: "doc",
      source: "reader",
      highlights: [],
    });
    expect(result?.source_id).toBe("one:reader-document:doc");
    expect(result?.properties).toMatchObject({
      readwise_id: "7",
      title: "Reader title",
      notes: "Reader note",
      reader_managed: true,
    });
  });
  it("refreshes managed Reader-only rows even without any export changes", async () => {
    const f = setup([row("one:reader-document:doc")]);
    await f.shared.refresh(f.scope);
    expect(f.writes[0]?.entries[0]?.properties["title"]).toBe("Reader title");
  });
  it("never falls back to stale export values after Reader failure", async () => {
    const f = setup([row()]);
    f.reader.document = () => Promise.reject(new Error("Reader unavailable"));
    await expect(
      f.shared.source({
        user_book_id: 7,
        title: "Stale",
        source: "reader",
        external_id: "doc",
        highlights: [],
      }),
    ).rejects.toThrow("Reader unavailable");
  });
  it("durably queues oversized Reader text before returning refreshed metadata", async () => {
    const jobs: ContentJob[] = [];
    const f = setup([row()], (job) => {
      jobs.push(job);
      return Promise.resolve();
    });
    f.reader.document = () =>
      Promise.resolve({
        id: "doc",
        category: "article",
        title: "Reader title",
        notes: "n".repeat(100001),
      });
    const result = await f.shared.source({
      user_book_id: 7,
      title: "Export",
      source: "reader",
      external_id: "doc",
      highlights: [],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "doc",
      canonical: "one:reader-document:doc",
      type: "readwise.source",
    });
    expect(result?.properties["notes"]).toBe("Local note");
  });
  it("blocks stale export admission after adoption and observes pending shared edits", () => {
    const held = row();
    expect(
      highlightsPolicy("readwise.source", held, {
        source_id: "one:source:7",
        properties: { title: "Stale" },
      }).owned,
    ).toBe(false);
    expect(
      highlightsPolicy("readwise.source", held, {
        source_id: held.source_id ?? "",
        properties: held.properties,
      }).fields?.["notes"],
    ).toBe("observe");
  });
});
