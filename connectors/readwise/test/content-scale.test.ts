import { afterEach, expect, it, vi } from "vitest";
import type { Entry, Item, PendingInbound } from "@withmarfa/connector";
import {
  contentQueue,
  drainContent,
  ReadwiseAuthorizationError,
  RateLimited,
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
import {
  sync as readerSync,
  type ReaderContext,
} from "../../readwise-reader/src/sync.js";
afterEach(() => vi.unstubAllGlobals());

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
    trashed_at: null,
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
      READWISE_CONTENT_MAX_BYTES: undefined,
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

it("uses the Highlights download limit and retries pending content after the bound rises", async () => {
  const f = fixture(1);
  f.context.env = { ...f.context.env, READWISE_CONTENT_MAX_BYTES: "8" };
  const page = f.reader.page.bind(f.reader);
  f.reader.page = async (query) => {
    const answer = await page(query);
    if (query?.id)
      answer.results = answer.results.map((row) => ({
        ...row,
        raw_source_url: "https://readwise-assets.s3.amazonaws.com/fixture.pdf",
      }));
    return answer;
  };
  const bytes = "%PDF-1.7 content";
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await f.run();
  const pending = contentQueue(f.scope("reader-content").state)[0];
  expect(pending?.due).toBeDefined();
  expect(
    [...f.conditions.values()].some((message) =>
      message.includes("READWISE_CONTENT_MAX_BYTES (8 bytes)"),
    ),
  ).toBe(true);
  f.context.env = { ...f.context.env, READWISE_CONTENT_MAX_BYTES: "32" };
  const due = pending?.due;
  if (due === undefined) throw new Error("content retry deadline is missing");
  f.setNow(due - 1);
  await f.run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(contentQueue(f.scope("reader-content").state)[0]?.due).toBe(due);
  f.setNow(due);
  await f.run();
  expect(contentQueue(f.scope("reader-content").state)).toEqual([]);
  expect(
    new TextDecoder().decode(
      f.files.get("sample:reader-document:0000:content:original"),
    ),
  ).toBe(bytes);
});

it("keeps text references advanced by a capacity drain before a later row refreshes", async () => {
  const f = fixture(140);
  const document = f.documents[20];
  if (!document) throw new Error("fixture document is missing");
  document.notes = "x".repeat(100001);
  const key = "sample:reader-document:0020";
  const held = f.rows.get(key);
  if (!held) throw new Error("fixture row is missing");
  held.properties = {
    ...held.properties,
    notes: "old note",
    reader_text_files: ["old text reference"],
  };
  await enqueueContent(
    f.scope("reader-content").state,
    f.documents.slice(12).map((row) => ({
      id: row.id,
      canonical: `sample:reader-document:${row.id}`,
      type: "readwise.source",
      revision: readerContentRevision(
        row,
        [],
        mapReaderSource("sample", row).textFiles,
      ),
    })),
  );
  await f.run();
  const textFiles = mapReaderSource("sample", document).textFiles;
  expect(
    f.rows.get(`${key}:content:manifest`)?.properties["preservation"],
  ).toBe("accounted");
  expect(f.rows.get(key)?.properties["reader_text_files"]).toEqual(
    textFiles.map((file) => file.key),
  );
  expect(f.rows.get(key)?.properties["notes"]).not.toBe("old note");
  for (const file of textFiles)
    expect(new TextDecoder().decode(f.files.get(file.key))).toBe(file.text);
  await f.run();
  expect(f.rows.get(key)?.properties["reader_text_files"]).toEqual(
    textFiles.map((file) => file.key),
  );
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

async function readerPendingFixture(size: number) {
  const f = fixture(size);
  let hints: ReaderContext["hints"] = new Map();
  const context: ReaderContext = {
    ...f.context,
    env: {
      ...f.context.env,
      READWISE_READER_INCLUDE_FEED: undefined,
      READWISE_READER_PICTURES: undefined,
      READWISE_READER_INBOUND_ONLY: undefined,
      READWISE_READER_PROPAGATE_PURGE: undefined,
      READWISE_CONTENT_MAX_BYTES: undefined,
    },
    get hints() {
      return hints;
    },
    pendingOutbound: () => [],
    inspect: async (type, query) => {
      const found = await f.context.inspect(type, query);
      return { items: [...found.items], tombstones: [...found.tombstones] };
    },
    known: (type, keys) => {
      if (f.context.known === undefined)
        throw new Error("missing fixture identity lookup");
      return f.context.known(type, keys);
    },
  };
  const run = () =>
    readerSync(context, {
      reader: f.reader,
      exportClient: {
        page: () =>
          Promise.resolve({ count: 0, nextPageCursor: null, results: [] }),
        sourceForHighlight: () => Promise.resolve(undefined),
      },
      now: () => Date.parse("2026-10-15T00:00:00Z"),
    });
  await run();
  const state = f.scope("reader-list").state;
  await state.checkpoint("listing", {
    ...(state.get("listing") as Record<string, unknown>),
    pending: f.documents.map((row) => row.id),
  });
  const pending = () => (state.get("listing") as { pending: string[] }).pending;
  const accounted = () =>
    [...f.rows.values()].filter(
      (row) =>
        row.type === "readwise.file" &&
        row.properties["preservation"] === "accounted",
    );
  return {
    ...f,
    context,
    run,
    pending,
    accounted,
    listing: state,
    setHints: (value: ReaderContext["hints"]) => {
      hints = value;
    },
  };
}

it("drains a persistent Reader pending list beyond the bounded content queue", async () => {
  const f = await readerPendingFixture(140);
  for (let at = 0; at < 24; at++) await f.run();
  expect(f.pending()).toEqual([]);
  expect(f.accounted()).toHaveLength(140);
  expect(
    f.rows.get("sample:reader-document:0139:content:manifest")?.properties[
      "preservation"
    ],
  ).toBe("accounted");
  expect(contentQueue(f.scope("reader-content-queue").state)).toEqual([]);
});

it.each([false, true])(
  "keeps Reader pending progress and earlier failures through checkpoint loss=%s",
  async (lost) => {
    const f = await readerPendingFixture(140);
    const read = f.reader.document.bind(f.reader);
    let unavailable = true;
    f.reader.document = (id) =>
      id === "0000" && unavailable
        ? Promise.reject(new Error("Reader document unavailable"))
        : read(id);
    let armed = true;
    const scoped = f.context.forScope.bind(f.context);
    f.context.forScope = (name, options) => {
      const scope = scoped(name, options);
      return {
        ...scope,
        state: {
          ...scope.state,
          async checkpoint(key, value) {
            const pending = (value as { pending?: unknown }).pending;
            if (
              name === "reader-list" &&
              key === "listing" &&
              armed &&
              Array.isArray(pending) &&
              pending.length < 140
            ) {
              armed = false;
              if (lost) {
                await scope.state.checkpoint(key, value);
                throw new Error("listing acknowledgment lost");
              }
              return { committed: false, reason: "state-oversized" };
            }
            return scope.state.checkpoint(key, value);
          },
        },
      };
    };
    await expect(f.run()).rejects.toThrow(
      /listing acknowledgment lost|listing progress was not saved/,
    );
    expect(f.pending()).toContain("0000");
    expect(f.pending().includes("0001")).toBe(!lost);
    for (let at = 0; at < 24; at++) await f.run();
    expect(f.pending()).toEqual(["0000"]);
    expect(f.accounted()).toHaveLength(139);
    expect(
      f.rows.get("sample:reader-document:0139:content:manifest")?.properties[
        "preservation"
      ],
    ).toBe("accounted");
    expect(f.listing.get("listing")).not.toHaveProperty("completed");
    unavailable = false;
    await f.run();
    expect(f.pending()).toEqual([]);
    expect(f.accounted()).toHaveLength(140);
  },
);

it("retains unattempted Reader hints after the content queue fills", async () => {
  const f = await readerPendingFixture(140);
  await f.listing.checkpoint("listing", {
    ...(f.listing.get("listing") as Record<string, unknown>),
    pending: [],
  });
  f.setHints(
    new Map([
      [
        "readwise.source",
        new Set(f.documents.map((row) => `sample:reader-document:${row.id}`)),
      ],
    ]),
  );
  await f.run();
  expect(f.pending()).toHaveLength(12);
  expect(f.pending()).toContain("0139");
  f.setHints(new Map());
  for (let at = 0; at < 24; at++) await f.run();
  expect(f.pending()).toEqual([]);
  expect(f.accounted()).toHaveLength(140);
});

it("checkpoints an accepted Reader refusal before a later refusal fills the queue", async () => {
  const f = await readerPendingFixture(3);
  await f.listing.checkpoint("listing", {
    ...(f.listing.get("listing") as Record<string, unknown>),
    pending: ["0000"],
  });
  await enqueueContent(
    f.scope("reader-content-queue").state,
    Array.from({ length: 127 }, (_, index) => ({
      id: `deferred-${String(index)}`,
      canonical: `sample:reader-document:deferred-${String(index)}`,
      type: "readwise.source",
      revision: "deferred",
      due: Date.parse("2026-10-16T00:00:00Z"),
    })),
  );
  const read = f.reader.document.bind(f.reader);
  let first = true;
  f.reader.document = (id) => {
    if (id === "0000" && first) {
      first = false;
      return Promise.reject(new Error("temporary Reader failure"));
    }
    return read(id);
  };
  const records = ["0000", "0002"].map(
    (id): { record: PendingInbound; due: boolean } => ({
      record: {
        scope: "reader-list",
        operation: "upsert",
        mode: "refetch",
        identity: {
          type: "readwise.source",
          sourceId: `sample:reader-document:${id}`,
          link: `sample:reader-document:${id}`,
        },
        code: "invalid_properties",
        reason: "Retry source metadata",
        attemptedAt: "2026-10-15T00:00:00Z",
        dueAt: "2026-10-15T00:00:00Z",
        fingerprint: "f".repeat(64),
        context: "c".repeat(64),
      },
      due: true,
    }),
  );
  const scope = f.context.forScope.bind(f.context);
  f.context.forScope = (name, options) => {
    const held = scope(name, options);
    return name === "reader-list"
      ? { ...held, refusals: { pending: () => records } }
      : held;
  };
  await f.run();
  expect(f.pending()).toEqual([]);
  expect(contentQueue(f.scope("reader-content-queue").state)).toHaveLength(128);
});

async function queuedFixture(size: number) {
  const f = fixture(size);
  await enqueueContent(
    f.scope("reader-content").state,
    f.documents.map((document) => ({
      id: document.id,
      canonical: `sample:reader-document:${document.id}`,
      type: "readwise.source",
      revision: readerContentRevision(document),
    })),
  );
  return f;
}

it("reports the final empty content queue after two productive drains", async () => {
  const f = await queuedFixture(11);
  const unreached = vi.spyOn(f.context.log, "unreached");
  await f.run();
  expect(unreached.mock.calls).toHaveLength(1);
  expect(unreached).toHaveBeenCalledWith({
    prefixes: ["readwise:content:"],
    exceptKeys: f.documents.map(
      (document) =>
        `readwise:content:${digest(`sample:reader-document:${document.id}`)}`,
    ),
  });
  expect(contentQueue(f.scope("reader-content").state)).toEqual([]);
  expect(f.conditions.has("readwise:content-pending")).toBe(false);
  expect(
    [...f.rows.values()].filter(
      (row) => row.properties["preservation"] === "accounted",
    ),
  ).toHaveLength(11);
});

it("reports only the final remaining content count after two drains", async () => {
  const f = await queuedFixture(17);
  const condition = vi.spyOn(f.context.log, "condition");
  await f.run();
  expect(
    condition.mock.calls.filter(([key]) => key === "readwise:content-pending"),
  ).toHaveLength(1);
  expect(contentQueue(f.scope("reader-content").state)).toHaveLength(1);
  expect(f.conditions.get("readwise:content-pending")).toContain("1 documents");
});

it("keeps genuine job failures beside the final pending count", async () => {
  const f = await queuedFixture(11);
  const page = f.reader.page.bind(f.reader);
  f.reader.page = (query) =>
    query?.id === "0000"
      ? Promise.reject(new Error("download lookup failed"))
      : page(query);
  await f.run();
  expect(contentQueue(f.scope("reader-content").state)).toHaveLength(1);
  expect(f.conditions.get("readwise:content-pending")).toContain("1 documents");
  expect(
    f.conditions.get(
      `readwise:content:${digest("sample:reader-document:0000")}`,
    ),
  ).toContain("incomplete");
});

it("reports remaining content when authorization aborts the first drain", async () => {
  const f = await queuedFixture(11);
  const page = f.reader.page.bind(f.reader);
  f.reader.page = (query) =>
    query?.id === "0000"
      ? Promise.reject(new ReadwiseAuthorizationError(401))
      : page(query);
  await expect(f.run()).rejects.toThrow("HTTP 401");
  expect(contentQueue(f.scope("reader-content").state)).toHaveLength(11);
  expect(f.conditions.get("readwise:content-pending")).toContain(
    "11 documents",
  );
});

it("reports without requests, resources, or writes when the job limit is zero", async () => {
  const f = await queuedFixture(1);
  const state = f.scope("reader-content").state;
  const checkpoint = vi.spyOn(state, "checkpoint");
  const scope = vi.spyOn(f.context, "forScope");
  const inspect = vi.spyOn(f.context, "inspect");
  const known = vi.spyOn(f.context, "known");
  const page = vi.spyOn(f.reader, "page");
  const document = vi.spyOn(f.reader, "document");
  const fetch = vi.fn<typeof globalThis.fetch>();
  if (f.context.known === undefined) throw new Error("missing fixture lookup");
  const context = { ...f.context, known: f.context.known };
  await drainContent(context, f.reader, state, { maxJobs: 0, fetch });
  for (const call of [checkpoint, scope, inspect, known, page, document, fetch])
    expect(call).not.toHaveBeenCalled();
  expect(f.conditions.get("readwise:content-pending")).toContain("1 documents");
  expect(contentQueue(state)).toHaveLength(1);
  await drainContent(context, f.reader, state, { maxJobs: 1 });
  expect(page).toHaveBeenCalled();
  expect(scope).toHaveBeenCalled();
  expect(inspect).toHaveBeenCalled();
  expect(checkpoint).toHaveBeenCalled();
  expect(contentQueue(state)).toEqual([]);
});

it.each([1, 11])(
  "clears a prior document warning after successful preservation of %i documents",
  async (size) => {
    const { Harness, vendor } = await import("../../../kit/test/harness.js");
    const harness = await Harness.create();
    try {
      const f = await queuedFixture(size);
      const key = `readwise:content:${digest("sample:reader-document:0000")}`;
      const message = "Previous document preservation was incomplete";
      const held = vendor([]);
      held.conditions = [
        [key, message],
        ["readwise:content:unattempted", "Unattempted content remains pending"],
      ];
      expect(await harness.once(held)).toBe(0);
      expect(harness.lastRun().summary).toContain(message);
      held.conditions = [];
      held.read = async (context) => {
        f.context.log = context.log;
        await f.run();
      };
      expect(await harness.once(held)).toBe(0);
      expect(contentQueue(f.scope("reader-content").state)).toEqual([]);
      expect(
        [...f.rows.values()].filter(
          (row) => row.properties["preservation"] === "accounted",
        ),
      ).toHaveLength(size);
      expect(harness.lastRun().summary).toContain(
        "Unattempted content remains pending",
      );
      expect(harness.lastRun().summary).not.toContain(message);
    } finally {
      await harness.close();
    }
  },
);

it.each(["job failure", "hints", "rate limit"])(
  "retains document warnings through %s",
  async (mode) => {
    const { Harness, vendor } = await import("../../../kit/test/harness.js");
    const harness = await Harness.create();
    try {
      const f = await queuedFixture(2);
      const key = `readwise:content:${digest("sample:reader-document:0000")}`;
      const prior = "Previous document preservation was incomplete";
      const unattempted = "Unattempted content remains pending";
      const held = vendor([]);
      held.conditions = [
        [key, prior],
        ["readwise:content:unattempted", unattempted],
      ];
      expect(await harness.once(held)).toBe(0);
      held.conditions = [];
      if (mode === "hints") f.context.hints = new Map();
      else {
        const page = f.reader.page.bind(f.reader);
        f.reader.page = (query) => {
          if (mode === "job failure" && query?.id === "0000")
            return Promise.reject(new Error("Content unavailable"));
          if (mode === "rate limit" && query?.id === "0001")
            return Promise.reject(new RateLimited("2026-10-16T00:00:00Z"));
          return page(query);
        };
      }
      held.read = async (context) => {
        f.context.log = context.log;
        await f.run();
      };
      expect(await harness.once(held)).toBe(0);
      expect(harness.lastRun().summary).toContain(unattempted);
      if (mode === "job failure") {
        expect(harness.lastRun().summary).toContain(
          "Reader preservation is incomplete",
        );
        expect(contentQueue(f.scope("reader-content").state)).toHaveLength(1);
      } else expect(harness.lastRun().summary).toContain(prior);
      if (mode === "rate limit") {
        expect(harness.lastRun().summary).toContain("Readwise rate limit");
        expect(contentQueue(f.scope("reader-content").state)).toHaveLength(1);
      }
    } finally {
      await harness.close();
    }
  },
);
