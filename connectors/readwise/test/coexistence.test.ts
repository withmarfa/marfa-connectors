import { describe, expect, it } from "vitest";
import type { Item, Entry } from "@withmarfa/connector";
import {
  mapReaderHighlight,
  mapSource,
  readerIdentity,
  type ReaderReader,
  type ContentJob,
} from "@withmarfa/readwise";
import {
  PreservationQueueFull,
  SharedRows,
  highlightsPolicy,
} from "../src/coexistence.js";
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
    context,
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
  it("replays an earlier missing row after a later capacity stop and restart", async () => {
    const items = Array.from({ length: 21 }, (_, index) => {
      const id = String(index).padStart(4, "0");
      const canonical = readerIdentity("one", "document", id);
      return {
        ...row(canonical),
        id: canonical,
        properties: {
          ...row().properties,
          canonical_key: canonical,
          reader_id: id,
        },
      };
    });
    let full = true;
    const preserve = (job: ContentJob) => {
      if (full && job.id === "0002")
        throw new PreservationQueueFull("queue is full");
      return Promise.resolve();
    };
    const f = setup(items, preserve);
    const documents = items.map((item) => ({
      id: item.properties.reader_id,
      category: "article",
      title: "Current Reader title",
    }));
    f.reader.page = () =>
      Promise.resolve({
        count: 20,
        nextPageCursor: null,
        results: documents.slice(1),
      });
    const kept = new Map<string, unknown>();
    const scope = {
      ...f.scope,
      state: {
        get: (key: string) => kept.get(key),
        checkpoint: (key: string, value: unknown) => {
          kept.set(key, value);
          return Promise.resolve({ committed: true });
        },
      },
    };
    expect(await f.shared.refresh(scope)).toBe(false);
    const interruptedCursor = kept.get("cursor");
    full = false;
    const restarted = new SharedRows("one", f.context, f.reader, preserve);
    expect(await restarted.refresh(scope)).toBe(false);
    expect(interruptedCursor).toBeUndefined();
    expect(
      f.writes
        .flatMap(({ entries }) => entries)
        .some((entry) => entry.source_id === "one:reader-document:0020"),
    ).toBe(true);
    expect(
      f.writes
        .flatMap(({ entries }) => entries)
        .some((entry) => entry.source_id === "one:reader-document:0000"),
    ).toBe(false);
    f.reader.page = () =>
      Promise.resolve({ count: 21, nextPageCursor: null, results: documents });
    expect(
      await new SharedRows("one", f.context, f.reader, preserve).refresh(scope),
    ).toBe(true);
    expect(
      f.writes
        .flatMap(({ entries }) => entries)
        .some((entry) => entry.source_id === "one:reader-document:0000"),
    ).toBe(true);
  });
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
  describe("a Reader-managed picture highlight", () => {
    const picture =
      "![](https://readwise-assets.s3.amazonaws.com/media/picture.png)";
    const document = {
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "",
      notes: "",
    };
    function managedRow(properties: Record<string, unknown> = {}): Item {
      return {
        ...row("one:reader-highlight:hi"),
        type: "readwise.highlight",
        properties: {
          account: "one",
          canonical_key: readerIdentity("one", "highlight", "hi"),
          reader_id: "hi",
          reader_managed: true,
          reader_parent_id: "doc",
          category: "highlight",
          text: "",
          note: "",
          readwise_id: "42",
          readwise_source_id: "7",
          readwise_text: picture,
          external_id: "hi",
          ...properties,
        },
      };
    }
    // Each run reads the row the last run wrote, as each connector does.
    function runs(exportTitle: string | undefined) {
      const held = managedRow();
      const f = setup([held]);
      f.reader.document = (id) =>
        Promise.resolve(id === "hi" ? document : undefined);
      return {
        reader() {
          held.properties = mapReaderHighlight("one", document, {
            properties: held.properties,
            sourceId: held.source_id ?? "",
            documentTitle: "Reader Title",
          }).entry.properties;
          return held.properties;
        },
        async highlights() {
          const entry = await f.shared.highlight(
            {
              user_book_id: 7,
              ...(exportTitle !== undefined && { title: exportTitle }),
              external_id: "doc",
              source: "reader",
              highlights: [],
            },
            { id: 42, text: picture, external_id: "hi" },
          );
          if (entry === undefined) throw new Error("No entry");
          held.properties = entry.properties;
          return held.properties;
        },
      };
    }
    it.each(["Export Title", undefined])(
      "keeps Reader's title when the Reader connector runs first, export title %s",
      async (exportTitle) => {
        const run = runs(exportTitle);
        const written = { ...run.reader() };
        expect(written).toMatchObject({
          title: "Picture from Reader Title",
          body: picture,
        });
        expect(await run.highlights()).toEqual(written);
        expect(run.reader()).toEqual(written);
        expect(await run.highlights()).toEqual(written);
      },
    );
    it.each(["Export Title", undefined])(
      "settles on Reader's title when the Highlights connector runs first, export title %s",
      async (exportTitle) => {
        const run = runs(exportTitle);
        expect((await run.highlights())["title"]).toBe(
          exportTitle === undefined ? "Picture" : `Picture from ${exportTitle}`,
        );
        const written = { ...run.reader() };
        expect(written).toMatchObject({
          title: "Picture from Reader Title",
          body: picture,
        });
        expect(await run.highlights()).toEqual(written);
        expect(run.reader()).toEqual(written);
      },
    );
    it("takes a date the export refuses out of the field it held", async () => {
      const held = managedRow({ highlighted_at: "2025-01-01T00:00:00Z" });
      const f = setup([held]);
      f.reader.document = (id) =>
        Promise.resolve(id === "hi" ? document : undefined);
      const entry = await f.shared.highlight(
        {
          user_book_id: 7,
          external_id: "doc",
          source: "reader",
          highlights: [],
        },
        { id: 42, text: picture, external_id: "hi", highlighted_at: "soon" },
      );
      expect(entry?.properties["highlighted_at"]).toBeUndefined();
      expect(entry?.properties["original_values"]).toEqual({
        highlighted_at: "soon",
      });
    });
  });
});
