import { expect, it } from "vitest";
import type { Entry, Item } from "@withmarfa/connector";
import {
  contentQueue,
  digest,
  enqueueContent,
  mapReaderHighlight,
  mapReaderSource,
  readerContentRevision,
  sourceFields,
  type ReaderDocument,
  type ReaderReader,
} from "@withmarfa/readwise";
import { sync, type ReadContext, type ReadScope } from "../src/sync.js";

function fixture(size: number) {
  const rows = new Map<string, Item>();
  const files = new Map<string, Uint8Array>();
  const states = new Map<string, Map<string, unknown>>();
  const documents = Array.from(
    { length: size },
    (_, index): ReaderDocument => ({
      id: String(index).padStart(4, "0"),
      category: "article",
      title: `Article ${String(index)}`,
    }),
  );
  let direct = 0;
  let lists = 0;
  const conditions = new Map<string, string>();
  const archived: string[] = [];
  let now = Date.parse("2026-10-15T00:00:00Z");
  const item = (type: string, entry: Entry): Item => ({
    id: entry.source_id,
    type,
    source: "readwise",
    source_id: entry.source_id,
    state: "active",
    version: 1,
    schema_version: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    occurred_at: "2026-01-01T00:00:00Z",
    properties: { ...entry.properties },
  });
  for (const document of documents) {
    const entry = mapReaderSource("sample", document).entry;
    rows.set(entry.source_id, item("readwise.source", entry));
  }
  const reader: ReaderReader = {
    document(id) {
      direct++;
      return Promise.resolve(documents.find((document) => document.id === id));
    },
    page(query) {
      if (query?.id) {
        const found = documents.find((document) => document.id === query.id);
        return Promise.resolve({
          count: found ? 1 : 0,
          nextPageCursor: null,
          results: found
            ? [{ ...found, html_content: `<html>${found.id}</html>` }]
            : [],
        });
      }
      lists++;
      const start = Number(query?.cursor ?? 0);
      const results = documents.slice(start, start + 50);
      return Promise.resolve({
        count: documents.length - start,
        nextPageCursor:
          start + results.length < documents.length
            ? String(start + results.length)
            : null,
        results,
      });
    },
  };
  const scope = (name: string): ReadScope => {
    let state = states.get(name);
    if (!state) {
      state = new Map();
      states.set(name, state);
    }
    const kept = state;
    return {
      state: {
        get: (key) => structuredClone(kept.get(key)),
        checkpoint: (key, value) => {
          kept.set(key, structuredClone(value));
          return Promise.resolve({ committed: true });
        },
      },
      async upsert(type, entries) {
        for (const entry of entries) {
          const row = item(type, entry);
          if (entry.file) {
            const file = await entry.file.load(context.signal);
            const bytes = new Uint8Array(
              await new Response(file.bytes).arrayBuffer(),
            );
            files.set(entry.source_id, bytes);
            row.properties = {
              ...row.properties,
              blob_ref: `sha256:${digest(bytes)}`,
            };
          }
          rows.set(entry.source_id, row);
        }
      },
      archive: (_type, keys) => {
        archived.push(...keys);
        return Promise.resolve();
      },
      refusals: { pending: () => [] },
    };
  };
  const context: ReadContext = {
    env: {
      READWISE_ACCOUNT: "sample",
      READWISE_ACCESS_TOKEN: "fixture",
      READWISE_API_URL: undefined,
      READWISE_READER_API_URL: undefined,
    },
    signal: new AbortController().signal,
    waitUntil: () => Promise.resolve(),
    hints: undefined,
    held: (type) =>
      Promise.resolve([...rows.values()].filter((row) => row.type === type)),
    inspect: (type, query) =>
      Promise.resolve({
        items: [...rows.values()].filter(
          (row) =>
            row.type === type &&
            ((query.links ?? []).includes(
              String(row.properties["canonical_key"]),
            ) ||
              (query.source_ids ?? []).includes(row.source_id ?? "")),
        ),
        tombstones: [],
      }),
    known: (type, keys) =>
      Promise.resolve(
        new Set(keys.filter((key) => rows.get(key)?.type === type)),
      ),
    forScope: scope,
    written: () => sourceFields,
    log: {
      info: () => undefined,
      warn: () => undefined,
      condition: (key, value) => {
        conditions.set(key, value);
      },
      unreached: () => undefined,
    },
  };
  const run = () =>
    sync(context, {
      reader,
      client: {
        page: () =>
          Promise.resolve({ count: 0, nextPageCursor: null, results: [] }),
        sourceForHighlight: () => Promise.resolve(undefined),
      },
      now: () => now,
    });
  return {
    rows,
    files,
    states,
    reader,
    run,
    conditions,
    context,
    scope,
    documents,
    item,
    archived,
    setNow: (value: number) => {
      now = value;
    },
    direct: () => direct,
    lists: () => lists,
  };
}

it("preserves every managed source beyond the queue capacity while Reader is stopped", async () => {
  const f = fixture(140);
  for (let run = 0; run < 20; run++) await f.run();
  const accounted = [...f.rows.values()].filter(
    (row) =>
      row.type === "readwise.file" &&
      row.properties["preservation"] === "accounted",
  );
  expect(accounted).toHaveLength(140);
  expect(contentQueue(f.scope("reader-content").state)).toEqual([]);
  expect(f.direct()).toBe(0);
  expect(f.lists()).toBe(60);
});

it("uses direct managed lookups when an unrelated feed would cost more listing pages", async () => {
  const f = fixture(21);
  f.documents.push(
    ...Array.from({ length: 2000 }, (_, index): ReaderDocument => ({
      id: `unrelated-${String(index)}`,
      category: "article",
    })),
  );
  await f.run();
  expect(f.direct()).toBe(21);
  expect(f.lists()).toBe(1);
  expect(
    [...f.rows.values()].filter((row) => row.type === "readwise.source"),
  ).toHaveLength(21);
});

it("retains a missing managed row without claiming refresh completion or deletion", async () => {
  const f = fixture(140);
  const key = "sample:reader-document:0000";
  const held = structuredClone(f.rows.get(key));
  f.documents.shift();
  await f.run();
  expect(f.rows.get(key)).toEqual(held);
  expect(f.files.get(`${key}:content:manifest`)).toBeUndefined();
  expect(f.scope("reader-refresh").state.get("refresh")).toBeUndefined();
  expect(f.conditions.has(`readwise:reader-refresh:${key}`)).toBe(true);
  expect(f.archived).toEqual([]);
  expect(f.direct()).toBe(0);
});

it("holds refresh at a full deferred queue without resetting its due dates", async () => {
  const f = fixture(140);
  const due = Date.parse("2026-10-16T00:00:00Z");
  await enqueueContent(
    f.scope("reader-content").state,
    f.documents.slice(0, 128).map((document) => ({
      id: document.id,
      canonical: `sample:reader-document:${document.id}`,
      type: "readwise.source",
      revision: readerContentRevision(document),
      due,
      attempts: 4,
    })),
  );
  await f.run();
  const state = f.scope("reader-refresh").state;
  expect(state.get("cursor")).toBe("sample:reader-document:0127");
  expect(state.get("refresh")).toBeUndefined();
  expect(contentQueue(f.scope("reader-content").state)).toHaveLength(128);
  expect(
    contentQueue(f.scope("reader-content").state).every(
      (job) => job.due === due && job.attempts === 4,
    ),
  ).toBe(true);
  await f.run();
  expect(state.get("cursor")).toBe("sample:reader-document:0127");
  expect(state.get("refresh")).toBeUndefined();
  f.setNow(due);
  for (let run = 0; run < 12; run++) await f.run();
  expect(contentQueue(f.scope("reader-content").state)).toEqual([]);
  expect(
    [...f.rows.values()].filter(
      (row) => row.properties["preservation"] === "accounted",
    ),
  ).toHaveLength(140);
  expect(state.get("cursor")).toBeNull();
  expect(state.get("refresh")).toBe(new Date(due).toISOString());
});

it.each([
  "count",
  "repeated-cursor",
  "duplicate",
  "empty-page",
  "incomplete-final",
  "network",
])(
  "leaves refresh progress untouched after a %s listing failure",
  async (failure) => {
    const f = fixture(140);
    const state = f.scope("reader-refresh").state;
    await state.checkpoint("refresh", "previous refresh");
    await state.checkpoint("cursor", "sample:reader-document:0001");
    const original = structuredClone([...f.rows]);
    const page = f.reader.page.bind(f.reader);
    f.reader.page = async (query) => {
      const result = await page(query);
      if (query?.cursor === "50") {
        if (failure === "count") result.count++;
        if (failure === "repeated-cursor") result.nextPageCursor = "50";
        if (failure === "duplicate") {
          const duplicate = f.documents[0];
          if (!duplicate) throw new Error("fixture document is missing");
          result.results[0] = duplicate;
        }
        if (failure === "empty-page") result.results = [];
        if (failure === "network") throw new Error("listing failed");
      }
      if (query?.cursor === "100" && failure === "incomplete-final")
        result.results.pop();
      return result;
    };
    await expect(f.run()).rejects.toThrow(/Reader|listing failed/);
    expect(state.get("refresh")).toBe("previous refresh");
    expect(state.get("cursor")).toBe("sample:reader-document:0001");
    expect([...f.rows]).toEqual(original);
    expect(f.files.size).toBe(0);
    expect(f.direct()).toBe(0);
  },
);

it("refreshes only managed identities and their known notes from a validated listing", async () => {
  const f = fixture(21);
  const highlight = {
    id: "hi",
    category: "highlight",
    parent_id: "0000",
    content: "Passage",
    notes: "Fresh annotation",
  };
  const note = {
    id: "note",
    category: "note",
    parent_id: "hi",
    content: "Fresh annotation",
  };
  const entry = mapReaderHighlight("sample", {
    ...highlight,
    notes: "Old annotation",
  }).entry;
  entry.properties = {
    ...entry.properties,
    reader_notes: { note: { content: "Old annotation" } },
  };
  f.rows.set(entry.source_id, f.item("readwise.highlight", entry));
  f.documents.push(
    highlight,
    note,
    { id: "unmanaged", category: "article", title: "Unrelated" },
    {
      id: "unknown-note",
      category: "note",
      parent_id: "other-highlight",
      content: "Unrelated",
    },
  );
  await f.run();
  expect(f.rows.get(entry.source_id)?.properties["note"]).toBe(
    "Fresh annotation",
  );
  expect(f.rows.get(entry.source_id)?.properties["reader_notes"]).toEqual({
    note,
  });
  expect(f.rows.has("sample:reader-document:unmanaged")).toBe(false);
  expect(f.rows.has("sample:reader-highlight:other-highlight")).toBe(false);
  expect(f.direct()).toBe(0);
  expect(f.lists()).toBe(1);
});
