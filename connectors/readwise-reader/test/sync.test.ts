import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { Entry, Item, OutboundIntent } from "@withmarfa/connector";
import {
  RateLimited,
  ReadwiseThrottleError,
  ReadwiseAuthorizationError,
  InvalidCursor,
  type ReaderDocument,
  type ReaderQuery,
  type Source,
} from "@withmarfa/readwise";
import { sync, type ReaderContext, type ContentWork } from "../src/sync.js";
const stamp = "2026-10-15T00:00:00Z";
function fixture(capacity = false, hints?: ReaderContext["hints"]) {
  const controller = new AbortController();
  const states = new Map<string, Map<string, unknown>>();
  const writes: { type: string; entry: Entry }[] = [];
  const archives: string[] = [];
  const jobs: unknown[] = [];
  const requests: ReaderQuery[] = [];
  const conditions = new Map<string, string>();
  const rows: Item[] = [];
  const outbound: OutboundIntent[] = [];
  const checkpointBytes: number[] = [];
  const inbound = [
    {
      scope: "reader-list",
      operation: "upsert",
      identity: {
        type: "readwise.source",
        sourceId: "one:reader-document:refused",
        link: "one:reader-document:refused",
      },
      code: "invalid_properties",
      reason: "A refused item remains pending",
      attemptedAt: stamp,
      dueAt: stamp,
      mode: "refetch",
      fingerprint: "f".repeat(64),
      context: "c".repeat(64),
    },
  ];
  const refusals: ReturnType<
    ReturnType<ReaderContext["forScope"]>["refusals"]["pending"]
  >[number][] = [];
  const exports: Source[] = [];
  let pages: ReaderDocument[][] = [
    [
      {
        id: "doc",
        category: "article",
        title: "Title",
        updated_at: stamp,
        location: "new",
      },
    ],
  ];
  let allowQueue = true;
  let writeFails = false;
  const context: ReaderContext = {
    env: {
      READWISE_ACCOUNT: "one",
      READWISE_ACCESS_TOKEN: "token",
      READWISE_API_URL: undefined,
      READWISE_READER_API_URL: undefined,
      READWISE_READER_INCLUDE_FEED: undefined,
      READWISE_READER_PICTURES: undefined,
      READWISE_READER_INBOUND_ONLY: undefined,
      READWISE_READER_PROPAGATE_PURGE: undefined,
      READWISE_CONTENT_MAX_BYTES: undefined,
    },
    signal: controller.signal,
    waitUntil: () => Promise.resolve(),
    known: () => Promise.resolve(new Set<string>()),
    hints,
    written: () => ["title", "text"],
    held: (type, options) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.type === type &&
            (options?.includeUnlinked === true ||
              row.source === "readwise" ||
              typeof row.properties["canonical_key"] === "string"),
        ),
      ),
    pendingOutbound: () => structuredClone(outbound),
    inspect: (_type, query) =>
      Promise.resolve({
        items: rows.filter((row) =>
          "links" in query
            ? query.links.includes(String(row.properties["canonical_key"]))
            : query.source_ids.includes(row.source_id ?? ""),
        ),
        tombstones: [],
      }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      condition: (key, value) => conditions.set(key, value),
      unreached: () => undefined,
    },
    forScope(name) {
      const state = states.get(name) ?? new Map<string, unknown>();
      states.set(name, state);
      return {
        state: {
          get: (key) => structuredClone(state.get(key)),
          checkpoint: (key, value) => {
            const vendorState = Object.fromEntries(
              [...states.values()].flatMap((scope) => [...scope]),
            );
            const bytes = Buffer.byteLength(
              JSON.stringify({
                state: { ...vendorState, [key]: value },
                cursor: 12345,
                inbound,
                ...(outbound.length > 0 && { outbound }),
                relinked: { rows: {} },
              }),
            );
            checkpointBytes.push(bytes);
            if (capacity && bytes > 512 * 1024)
              return Promise.resolve({
                committed: false,
                reason: "state-oversized",
              });
            state.set(key, structuredClone(value));
            return Promise.resolve({ committed: true });
          },
        },
        upsert: (type, entries) => {
          if (writeFails) return Promise.reject(new Error("write failed"));
          for (const entry of entries) writes.push({ type, entry });
          return Promise.resolve();
        },
        archive: (_type, keys) => {
          archives.push(...keys);
          return Promise.resolve();
        },
        refusals: { pending: () => refusals },
      };
    },
  };
  const reader = {
    page(query: ReaderQuery = {}) {
      requests.push(query);
      const at = Number(query.cursor ?? 0);
      return Promise.resolve({
        count: pages.slice(at).flat().length,
        nextPageCursor: at + 1 < pages.length ? String(at + 1) : null,
        results: pages[at] ?? [],
      });
    },
    document(id: string) {
      return Promise.resolve(pages.flat().find((row) => row.id === id));
    },
  };
  const content: ContentWork = {
    enqueue: (_state, added) => {
      if (!allowQueue) return Promise.resolve(false);
      jobs.push(...added);
      return Promise.resolve(true);
    },
    drain: () => Promise.resolve(),
  };
  const run = (maxPages = 50) =>
    sync(context, {
      reader,
      content,
      exportClient: {
        page: (query) => {
          const results = exports.filter(
            (source) =>
              query.sourceId === undefined ||
              source.user_book_id === query.sourceId,
          );
          return Promise.resolve({
            count: results.length,
            nextPageCursor: null,
            results,
          });
        },
        sourceForHighlight: () => Promise.resolve(undefined),
      },
      now: () => Date.parse(stamp),
      maxPages,
    });
  return {
    context,
    controller,
    refusals,
    reader,
    content,
    rows,
    outbound,
    checkpointBytes,
    exports,
    states,
    writes,
    archives,
    jobs,
    requests,
    conditions,
    run,
    setPages: (value: ReaderDocument[][]) => {
      pages = value;
    },
    queue: (value: boolean) => {
      allowQueue = value;
    },
    failWrite: () => {
      writeFails = true;
    },
  };
}
describe("Reader durable metadata", () => {
  it("enqueues content before completing metadata and retains Reader-only identity", async () => {
    const f = fixture();
    await f.run();
    expect(f.writes[0]?.entry.source_id).toBe("one:reader-document:doc");
    expect(f.writes[0]?.entry.properties["readwise_id"]).toBeUndefined();
    expect(f.jobs).toHaveLength(1);
    expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
      completed: new Date(stamp).toISOString(),
    });
  });
  it("does not advance a page while content queue is full", async () => {
    const f = fixture();
    f.queue(false);
    await f.run();
    expect(f.writes).toEqual([]);
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "completed",
    );
    f.queue(true);
    await f.run();
    expect(f.writes).toHaveLength(1);
  });
  it("resumes the same walk and uses five-minute overlap only after completion", async () => {
    const f = fixture();
    f.setPages([
      [{ id: "a", category: "article" }],
      [{ id: "b", category: "article" }],
    ]);
    await f.run(1);
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "completed",
    );
    await f.run();
    expect(f.requests[1]?.cursor).toBe("1");
    await f.run();
    expect(f.requests.at(-1)?.updatedAfter).toBe("2026-10-14T23:55:00.000Z");
  });
  it("keeps its place in the listing when the picture setting changes", async () => {
    const f = fixture();
    f.setPages([[{ id: "a", category: "article", updated_at: stamp }]]);
    await f.run();
    await f.run();
    const before = f.requests.length;
    (
      f.context.env as { READWISE_READER_PICTURES?: string }
    ).READWISE_READER_PICTURES = "save";
    await f.run();
    expect(f.requests.slice(before)).toEqual([
      { updatedAfter: expect.any(String) as string },
    ]);
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "walk",
    );
  });
  it("keeps failed writes from committing page progress", async () => {
    const f = fixture();
    f.failWrite();
    await expect(f.run()).rejects.toThrow("write failed");
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "completed",
    );
  });
  it("excludes feed descendants and preserves orphan highlights", async () => {
    const f = fixture();
    f.setPages([
      [
        { id: "feed", category: "rss", location: "feed" },
        { id: "hi", category: "highlight", parent_id: "feed", content: "skip" },
        {
          id: "orphan",
          category: "highlight",
          parent_id: null,
          content: "keep",
        },
      ],
    ]);
    await f.run();
    expect(f.writes.map((x) => x.entry.source_id)).toEqual([
      "one:reader-highlight:orphan",
    ]);
  });
  it("folds note children onto their highlight rather than creating note rows", async () => {
    const f = fixture();
    f.setPages([
      [
        { id: "doc", category: "article" },
        {
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "passage",
          notes: "note",
        },
        { id: "note", category: "note", parent_id: "hi", content: "note" },
      ],
    ]);
    await f.run();
    expect(
      f.writes.filter((x) => x.type === "readwise.highlight").at(-1)?.entry
        .properties["reader_notes"],
    ).toHaveProperty("note");
    expect(
      f.writes.some((x) => x.entry.source_id.includes("reader-note")),
    ).toBe(false);
  });
  it("persists throttle deadline across restart without an early API request", async () => {
    const f = fixture();
    let calls = 0;
    f.reader.page = () => {
      calls++;
      return Promise.reject(new RateLimited("2026-10-15T00:01:00Z"));
    };
    await f.run();
    await f.run();
    expect(calls).toBe(1);
  });
  it("rejects repeated cursors without claiming complete listing", async () => {
    const f = fixture();
    f.reader.page = (query?: ReaderQuery) =>
      Promise.resolve({
        count: query?.cursor ? 1 : 2,
        nextPageCursor: "same",
        results: [{ id: query?.cursor ? "b" : "a", category: "article" }],
      });
    await expect(f.run()).rejects.toThrow(/repeated/);
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "completed",
    );
  });
});

function stored(id: string, extra: Record<string, unknown> = {}): Item {
  return {
    id: `item-${id}`,
    source: "readwise",
    source_id: `one:reader-document:${id}`,
    type: "readwise.source",
    state: "active",
    version: 1,
    schema_version: 1,
    occurred_at: stamp,
    created_at: stamp,
    updated_at: stamp,
    trashed_at: null,
    properties: {
      account: "one",
      canonical_key: `one:reader-document:${id}`,
      reader_id: id,
      reader_managed: true,
      title: id,
      reader_location: "new",
      ...extra,
    },
  };
}
describe("Reader upgrade to display fields and kinds", () => {
  it("rewrites every held row once in place on the first run after the types change", async () => {
    const f = fixture();
    const picture = "![](https://readwise-assets.s3.amazonaws.com/p.png)";
    f.setPages([
      [
        {
          id: "doc",
          category: "article",
          title: "A long read",
          image_url: "",
          saved_at: "2025-08-18T14:18:02.114000+00:00",
          updated_at: stamp,
        },
        {
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "",
          notes: "kept note",
          updated_at: stamp,
        },
      ],
    ]);
    await f.run();
    const listing = f.states.get("reader-list")?.get("listing") as Record<
      string,
      unknown
    >;
    expect(listing["completed"]).toBeDefined();
    // The checkpoint and rows an earlier release left: its types hashed differently.
    f.states.get("reader-list")?.set("listing", {
      ...listing,
      fingerprint: "an earlier release",
    });
    f.rows.push(
      stored("doc", {
        title: "A long read",
        category: "article",
        reader_image_url: "",
        reader_saved_at: "2025-08-18T14:18:02.114000+00:00",
      }),
      {
        ...stored("hi"),
        type: "readwise.highlight",
        source_id: "one:reader-highlight:hi",
        properties: {
          account: "one",
          canonical_key: "one:reader-highlight:hi",
          reader_id: "hi",
          reader_managed: true,
          reader_parent_id: "doc",
          category: "highlight",
          text: "",
          note: "kept note",
          readwise_id: "42",
          readwise_text: picture,
        },
      },
    );
    f.writes.length = 0;
    const before = f.requests.length;
    await f.run();
    expect(f.requests[before]?.updatedAfter).toBeUndefined();
    const written = new Map(
      f.writes.map(({ entry }) => [entry.source_id, entry.properties]),
    );
    expect([...written.keys()].sort()).toEqual([
      "one:reader-document:doc",
      "one:reader-highlight:hi",
    ]);
    expect(written.get("one:reader-highlight:hi")).toMatchObject({
      title: "Picture from A long read",
      body: picture,
      text: "",
      note: "kept note",
      readwise_id: "42",
      readwise_text: picture,
    });
    expect(written.get("one:reader-document:doc")).toMatchObject({
      reader_saved_at: "2025-08-18T14:18:02.114000+00:00",
    });
    expect(written.get("one:reader-document:doc")).not.toHaveProperty(
      "reader_image_url",
    );
    // Without a type change, the next run reads only what changed.
    await f.run();
    expect(f.requests.at(-1)?.updatedAfter).toBeDefined();
  });
});
describe("Reader upstream disappearance", () => {
  it("preflights the entire confirmed set before archiving any row", async () => {
    const f = fixture();
    f.setPages([[]]);
    for (let n = 0; n < 21; n++) f.rows.push(stored(String(n)));
    await f.run();
    expect(f.archives).toEqual([]);
    expect(f.conditions.has("readwise:reader-delete-limit")).toBe(true);
  });
  it("archives a small missing set only after complete listing and direct emptiness", async () => {
    const f = fixture();
    f.setPages([[]]);
    f.rows.push(stored("gone"));
    await f.run();
    expect(f.archives).toEqual(["one:reader-document:gone"]);
  });
  it("does not archive on failed direct lookup, partial listing or excluded feed records", async () => {
    const f = fixture();
    f.setPages([[{ id: "new", category: "article" }], []]);
    f.rows.push(stored("gone"));
    await f.run(1);
    expect(f.archives).toEqual([]);
    f.reader.document = () => Promise.reject(new Error("lookup failed"));
    await f.run();
    expect(f.archives).toEqual([]);
    const g = fixture();
    g.setPages([[]]);
    g.rows.push(stored("feed", { reader_location: "feed" }));
    await g.run();
    expect(g.archives).toEqual([]);
  });
  it("archives documents in Reader's archive, and no highlight, without treating them as deletions", async () => {
    const f = fixture();
    const documents: ReaderDocument[] = Array.from({ length: 25 }, (_, i) => ({
      id: `d${String(i)}`,
      category: "article",
      title: "Done",
      updated_at: stamp,
      location: "archive",
    }));
    f.setPages([
      [
        ...documents,
        {
          id: "open",
          category: "article",
          updated_at: stamp,
          location: "later",
        },
        {
          id: "mark",
          category: "highlight",
          parent_id: "d0",
          content: "Kept",
          updated_at: stamp,
          location: "archive",
        },
      ],
    ]);
    await f.run();
    expect(f.archives).toEqual(
      documents.map((document) => `one:reader-document:${document.id}`),
    );
    expect(f.conditions.has("readwise:reader-delete-limit")).toBe(false);
  });
  it("archives nothing for a document that has moved out of Reader's archive", async () => {
    const f = fixture();
    f.setPages([[{ id: "doc", category: "article", location: "later" }]]);
    f.rows.push(stored("doc", { reader_location: "archive" }));
    await f.run();
    expect(f.archives).toEqual([]);
    expect(f.writes[0]?.entry.properties["reader_location"]).toBe("later");
  });
  it("adopts archived legacy natural keys without inventing export IDs", async () => {
    const f = fixture();
    const old = stored("doc", {
      reader_managed: false,
      reader_id: undefined,
      canonical_key: undefined,
      readwise_source: "reader",
      external_id: "doc",
      readwise_id: "7",
    });
    old.source_id = "one:source:7";
    old.state = "archived";
    f.rows.push(old);
    await f.run();
    expect(f.writes[0]?.entry.source_id).toBe("one:source:7");
    expect(f.writes[0]?.entry.properties["readwise_id"]).toBe("7");
  });
  it("keeps an oversized replacement out of an existing inline field until content lands", async () => {
    const f = fixture();
    f.rows.push(stored("doc", { notes: "Last good note" }));
    f.setPages([
      [{ id: "doc", category: "article", notes: "x".repeat(100001) }],
    ]);
    await f.run();
    expect(f.writes[0]?.entry.properties["notes"]).toBe("Last good note");
    expect(f.jobs).toHaveLength(1);
  });
});

describe("Reader overflow provenance", () => {
  it("keeps adopted export text inline until its replacement file is acknowledged", async () => {
    const f = fixture();
    f.exports.push({
      user_book_id: 7,
      source: "reader",
      external_id: "doc",
      highlights: [{ id: 42, external_id: "hi", text: "x".repeat(100001) }],
    });
    f.setPages([
      [
        { id: "doc", category: "article" },
        {
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "Reader canonical",
        },
      ],
    ]);
    const old = stored("hi", {
      reader_managed: false,
      reader_id: undefined,
      canonical_key: undefined,
      external_id: "hi",
      readwise_id: "42",
      readwise_source_id: "7",
      text: "Previous export passage",
    });
    old.type = "readwise.highlight";
    old.source_id = "one:highlight:42";
    f.rows.push(old);
    await f.run();
    const highlight = f.writes.find(
      (value) => value.type === "readwise.highlight",
    )?.entry;
    expect(highlight?.source_id).toBe("one:highlight:42");
    expect(highlight?.properties["text"]).toBe("Reader canonical");
    expect(highlight?.properties["readwise_text"]).toBe(
      "Previous export passage",
    );
    expect(f.jobs).toContainEqual(
      expect.objectContaining({
        id: "hi",
        exportSourceId: 7,
        exportHighlightId: 42,
      }),
    );
  });
  it("refetches an oversized export passage from the persisted alias after restart", async () => {
    const f = fixture();
    f.exports.push({
      user_book_id: 7,
      source: "reader",
      external_id: "doc",
      highlights: [{ id: 42, external_id: "hi", text: "x".repeat(100001) }],
    });
    f.setPages([
      [
        { id: "doc", category: "article" },
        {
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "Reader canonical",
        },
      ],
    ]);
    await f.run();
    f.jobs.length = 0;
    await f.run();
    expect(f.jobs).toContainEqual(
      expect.objectContaining({
        id: "hi",
        exportSourceId: 7,
        exportHighlightId: 42,
      }),
    );
    f.jobs.length = 0;
    const source = f.exports[0];
    if (source === undefined) throw new Error("missing fixture source");
    source.highlights = [{ id: 99, external_id: "hi", text: "wrong identity" }];
    await f.run();
    expect(f.jobs).not.toContainEqual(expect.objectContaining({ id: "hi" }));
    expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
      pending: ["hi"],
    });
  });
  it("queues oversized folded notes with the exact Reader note identities", async () => {
    const f = fixture();
    f.setPages([
      [
        { id: "doc", category: "article" },
        {
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "Passage",
        },
        {
          id: "note",
          category: "note",
          parent_id: "hi",
          content: "x".repeat(100001),
        },
      ],
    ]);
    await f.run();
    expect(f.jobs).toContainEqual(
      expect.objectContaining({ id: "hi", noteIds: ["note"] }),
    );
  });
});

describe("Reader pending create admission", () => {
  function pending(type: string, properties: Record<string, unknown>): Item {
    const row = stored("local", {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      ...properties,
    });
    row.type = type;
    row.source = "another-app";
    delete row.source_id;
    return row;
  }

  it.each(["active", "archived", "trashed"] as const)(
    "keeps matching source admission pending across restart with a %s local create",
    async (state) => {
      const f = fixture();
      const row = pending("readwise.source", {
        url: "https://example.com/saved",
        title: "Local title",
      });
      row.state = state;
      f.rows.push(row);
      f.setPages([
        [
          {
            id: "saved",
            category: "article",
            source_url: "https://example.com/saved",
            title: "Reader title",
          },
        ],
      ]);
      await f.run();
      await f.run();
      expect(f.writes).toEqual([]);
      expect(f.jobs).toEqual([]);
      expect(f.conditions.get("readwise:reader-import:saved")).toMatch(
        /pending.*create/i,
      );
      expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
        pending: ["saved"],
      });
      expect(row.properties["title"]).toBe("Local title");

      f.rows.length = 0;
      await f.run();
      expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
        "one:reader-document:saved",
      );
      expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
        pending: [],
      });
    },
  );

  it("blocks a highlight matching an unlinked create's parent and passage", async () => {
    const f = fixture();
    f.rows.push(
      pending("readwise.highlight", {
        reader_parent_id: "doc",
        text: "Saved passage",
        notes: "Local note",
      }),
    );
    f.setPages([
      [
        { id: "doc", category: "article" },
        {
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "Saved passage",
          notes: "Reader note",
        },
      ],
    ]);
    await f.run();
    expect(f.writes.map(({ entry }) => entry.source_id)).toEqual([
      "one:reader-document:doc",
    ]);
    expect(f.conditions.get("readwise:reader-import:hi")).toMatch(
      /pending.*create/i,
    );
    expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
      pending: ["hi"],
    });

    const local = f.rows[0];
    if (local === undefined) throw new Error("missing local create");
    local.properties = { ...local.properties, text: "Other passage" };
    await f.run();
    expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
      "one:reader-highlight:hi",
    );
  });

  it("admits a URL when the local row belongs to another account or has a confirmed identity", async () => {
    const f = fixture();
    f.rows.push(
      pending("readwise.source", {
        account: "another",
        url: "https://example.com/saved",
      }),
      pending("readwise.source", {
        url: "https://example.com/saved",
        reader_id: "confirmed",
        canonical_key: "one:reader-document:confirmed",
      }),
    );
    f.setPages([
      [
        {
          id: "saved",
          category: "article",
          source_url: "https://example.com/saved",
        },
      ],
    ]);
    await f.run();
    expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
      "one:reader-document:saved",
    );
  });
});

it("retains admission protection for the captured create after the local URL changes", async () => {
  const f = fixture();
  const captured = stored("local", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_create: true,
    url: "https://example.com/original",
  });
  f.outbound.push({
    token: "intent",
    acknowledged: false,
    request: {},
    baseline: {},
    change: { kind: "created", item: captured, changed: new Set(["url"]) },
  });
  const current = structuredClone(captured);
  current.properties["url"] = "https://example.com/edited";
  f.rows.push(current);
  f.setPages([
    [
      {
        id: "saved",
        category: "article",
        source_url: "https://example.com/original",
      },
    ],
  ]);
  await f.run();
  expect(f.writes).toEqual([]);
  expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
    pending: ["saved"],
  });
  f.outbound.length = 0;
  await f.run();
  expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
    "one:reader-document:saved",
  );
});

it("persists and resumes a realistic 5,422-identity Reader bridge within checkpoint capacity", async () => {
  const f = fixture();
  const readerId = (value: number) =>
    createHash("sha256").update(String(value)).digest("hex").slice(0, 36);
  for (let at = 0; at < 780; at++) {
    const sourceId = 100000000 + at;
    f.exports.push({
      user_book_id: sourceId,
      source: "reader",
      external_id: readerId(sourceId),
      highlights: Array.from({ length: at < 742 ? 6 : 5 }, (_, offset) => ({
        id: 1000000000 + at * 6 + offset,
        external_id: readerId(1000000000 + at * 6 + offset),
        text: "Export passage remains outside persisted identity state",
      })),
    });
  }
  const last = f.exports.at(-1);
  const highlight = last?.highlights.at(-1);
  if (!last?.external_id || !highlight?.external_id)
    throw new Error("missing large bridge fixture");
  const imported = stored(highlight.external_id, {
    readwise_id: String(highlight.id),
    readwise_source_id: String(last.user_book_id),
  });
  imported.type = "readwise.highlight";
  imported.source_id = `one:highlight:${String(highlight.id)}`;
  imported.state = "archived";
  f.rows.push(imported);
  f.setPages([
    [
      {
        id: highlight.external_id,
        category: "highlight",
        parent_id: last.external_id,
        content: "Canonical passage",
      },
    ],
  ]);
  await f.run();
  const persisted = JSON.stringify(
    f.states.get("reader-identities")?.get("identities"),
  );
  expect(Buffer.byteLength(persisted)).toBeLessThan(280 * 1024);
  expect(persisted).not.toContain("Export passage");
  f.writes.length = 0;
  await f.run();
  expect(f.writes[0]?.entry.source_id).toBe(
    `one:highlight:${String(highlight.id)}`,
  );
  expect(f.writes[0]?.entry.properties["readwise_source_id"]).toBe(
    String(last.user_book_id),
  );
  expect(f.writes[0]?.entry.properties["readwise_text"]).toBe(highlight.text);
});

// Reconciliation compresses progress after each inventory item, which needs
// more headroom on shared CI runners than the ordinary fixture cases.
it("resumes a 5,422-row full inventory with aliases, queued work and the whole checkpoint envelope", async () => {
  const f = fixture(true);
  const id = (n: number) =>
    createHash("sha256").update(String(n)).digest("hex").slice(0, 36);
  for (let at = 0; at < 780; at++) {
    const sourceId = 100000000 + at;
    const parent = id(sourceId);
    f.exports.push({
      user_book_id: sourceId,
      source: "reader",
      external_id: parent,
      highlights: Array.from({ length: at < 742 ? 6 : 5 }, (_, offset) => {
        const highlightId = 1000000000 + at * 6 + offset;
        return {
          id: highlightId,
          external_id: id(highlightId),
          text: "Saved passage",
        };
      }),
    });
    f.rows.push(stored(parent, { readwise_id: String(sourceId) }));
    const source = f.exports.at(-1);
    if (source === undefined) throw new Error("missing export fixture");
    for (const highlight of source.highlights) {
      const row = stored(highlight.external_id ?? "", {
        readwise_id: String(highlight.id),
        readwise_source_id: String(sourceId),
        reader_parent_id: parent,
      });
      row.type = "readwise.highlight";
      row.source_id = `one:reader-highlight:${highlight.external_id ?? ""}`;
      row.properties["canonical_key"] = row.source_id;
      f.rows.push(row);
    }
  }
  const queue = Array.from({ length: 100 }, (_, n) => ({
    id: id(n),
    canonical: `one:reader-document:${id(n)}`,
    type: "readwise.source",
    revision: id(n + 100),
    attempts: 0,
    due: stamp,
  }));
  f.states.set("reader-content-queue", new Map([["reader-content", queue]]));
  const first = f.rows[0];
  if (first === undefined) throw new Error("missing inventory fixture");
  f.setPages([
    [{ id: String(first.properties["reader_id"]), category: "article" }],
    [],
  ]);
  await f.run(1);
  expect(f.rows).toHaveLength(5422);
  expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
    "completed",
  );
  const previous = Math.max(...f.checkpointBytes);
  expect(previous).toBeLessThan(512 * 1024);
  f.rows.forEach((row) => {
    row.state = "archived";
  });
  await f.run(0);
  expect(f.requests.at(-1)?.cursor).toBeUndefined();
  await f.run(1);
  expect(f.requests.at(-1)?.cursor).toBe("1");
  expect(f.states.get("reader-list")?.get("listing")).toHaveProperty(
    "completed",
  );
  expect(Math.max(...f.checkpointBytes)).toBeLessThan(512 * 1024);
}, 60_000);

it("rejects malformed compressed listing identities before resuming vendor reads", async () => {
  const f = fixture();
  f.setPages([
    [{ id: "a", category: "article" }],
    [{ id: "b", category: "article" }],
  ]);
  await f.run(1);
  const saved = f.states.get("reader-list")?.get("listing") as {
    walk: { missing: unknown };
  };
  saved.walk.missing = { encoding: "deflate-base64", data: "not valid" };
  const calls = f.requests.length;
  await expect(f.run()).rejects.toThrow(
    /compressed listing identities are invalid/,
  );
  expect(f.requests).toHaveLength(calls);
});

describe("Reader listing completeness evidence", () => {
  it.each([
    { count: 1, nextPageCursor: null, results: [] },
    {
      count: 2,
      nextPageCursor: null,
      results: [{ id: "only", category: "article" }],
    },
    { count: 1, nextPageCursor: "next", results: [] },
  ])(
    "does not complete or reconcile an inconsistent listing: %j",
    async (page) => {
      const f = fixture();
      f.rows.push(stored("gone"));
      f.reader.page = () =>
        Promise.resolve(page as Awaited<ReturnType<typeof f.reader.page>>);
      await expect(f.run()).rejects.toThrow(/count|empty/);
      expect(f.archives).toEqual([]);
      expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
        "fullAt",
      );
      expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
        "completed",
      );
    },
  );
  it.each([2, 3])(
    "rejects an inconsistent remaining count of %s across a durable restart",
    async (count) => {
      const f = fixture();
      f.reader.page = (query?: ReaderQuery) =>
        Promise.resolve(
          query?.cursor
            ? {
                count,
                nextPageCursor: null,
                results: [{ id: "b", category: "article" }],
              }
            : {
                count: 2,
                nextPageCursor: "next",
                results: [{ id: "a", category: "article" }],
              },
        );
      await f.run(1);
      await expect(f.run()).rejects.toThrow(/count/);
      expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
        "fullAt",
      );
    },
  );
  it("counts unique IDs across restart rather than repeated rows", async () => {
    const f = fixture();
    f.reader.page = (query?: ReaderQuery) =>
      Promise.resolve({
        count: query?.cursor ? 1 : 2,
        nextPageCursor: query?.cursor ? null : "next",
        results: [{ id: "same", category: "article" }],
      });
    await f.run(1);
    await expect(f.run()).rejects.toThrow(/count/);
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "fullAt",
    );
  });
  it("rejects overlapping pages even when the remaining row counts agree", async () => {
    const f = fixture();
    f.setPages([
      [{ id: "a", category: "article" }],
      [
        { id: "a", category: "article" },
        { id: "b", category: "article" },
      ],
    ]);
    await f.run(1);
    await expect(f.run()).rejects.toThrow(/count/);
    expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
      "fullAt",
    );
  });
});

describe("Reader direct retry isolation", () => {
  it("retains a failed metadata retry and still imports healthy new documents", async () => {
    const f = fixture();
    f.setPages([[{ id: "orphan", category: "note", content: "note" }]]);
    await f.run();
    f.setPages([[{ id: "healthy", category: "article" }]]);
    const lookup = f.reader.document.bind(f.reader);
    f.reader.document = (id) =>
      id === "orphan"
        ? Promise.reject(new Error("Readwise request failed (HTTP 500)"))
        : lookup(id);
    await f.run();
    expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
      "one:reader-document:healthy",
    );
    expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
      pending: ["orphan"],
    });
    expect(f.conditions.has("readwise:reader-retry:orphan")).toBe(true);
  });
  it("retains a failed refusal retry and still imports healthy new documents", async () => {
    const f = fixture();
    f.refusals.push({
      record: {
        ...{
          scope: "reader-list",
          operation: "upsert",
          identity: {
            type: "readwise.source",
            sourceId: "one:reader-document:bad",
            link: "one:reader-document:bad",
          },
          code: "invalid_properties",
          reason: "bad",
          attemptedAt: stamp,
          dueAt: stamp,
          mode: "refetch",
          fingerprint: "f".repeat(64),
          context: "c".repeat(64),
        },
      },
      due: true,
    });
    f.reader.document = () =>
      Promise.reject(new Error("malformed direct response"));
    await f.run();
    expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
      "one:reader-document:doc",
    );
    expect(
      f.conditions.has("readwise:reader-retry:one:reader-document:bad"),
    ).toBe(true);
  });
  it("contains a failed note-parent lookup to that note", async () => {
    const f = fixture();
    f.setPages([
      [
        { id: "note", category: "note", parent_id: "bad", content: "note" },
        { id: "healthy", category: "article" },
      ],
    ]);
    f.reader.document = () => Promise.reject(new Error("parent unavailable"));
    await f.run();
    expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
      "one:reader-document:healthy",
    );
    expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
      pending: ["note"],
    });
  });
});

it.each([401, 403] as const)(
  "stops all listing on HTTP %s during an item retry",
  async (status) => {
    const f = fixture();
    f.setPages([[{ id: "orphan", category: "note", content: "note" }]]);
    await f.run();
    f.setPages([[{ id: "healthy", category: "article" }]]);
    f.reader.document = () =>
      Promise.reject(new ReadwiseAuthorizationError(status));
    const calls = f.requests.length;
    await expect(f.run()).rejects.toThrow(`HTTP ${String(status)}`);
    expect(f.requests).toHaveLength(calls);
    expect(f.writes).toEqual([]);
  },
);

it("retains a global rate limit from an item retry before any listing", async () => {
  const f = fixture();
  f.setPages([[{ id: "orphan", category: "note", content: "note" }]]);
  await f.run();
  const calls = f.requests.length;
  f.reader.document = () =>
    Promise.reject(new RateLimited("2026-10-15T00:01:00Z"));
  await f.run();
  await f.run();
  expect(f.requests).toHaveLength(calls);
  expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
    retryUntil: "2026-10-15T00:01:00Z",
  });
});

it("does not swallow cancellation during an item retry", async () => {
  const f = fixture();
  f.setPages([[{ id: "orphan", category: "note", content: "note" }]]);
  await f.run();
  f.reader.document = () => {
    f.controller.abort(new Error("cancelled"));
    return Promise.reject(new Error("lookup interrupted"));
  };
  const calls = f.requests.length;
  await expect(f.run()).rejects.toThrow("cancelled");
  expect(f.requests).toHaveLength(calls);
});

it("retains a failed absence lookup while importing a later healthy listing", async () => {
  const f = fixture();
  f.rows.push(stored("missing"));
  f.setPages([[]]);
  const lookup = f.reader.document.bind(f.reader);
  f.reader.document = () =>
    Promise.reject(new Error("cannot establish absence"));
  await f.run();
  expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
    reconcile: { remaining: ["one:reader-document:missing"] },
  });
  f.setPages([[{ id: "healthy", category: "article" }]]);
  await f.run();
  expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
    "one:reader-document:healthy",
  );
  expect(f.archives).toEqual([]);
  f.reader.document = lookup;
  await f.run();
  expect(f.archives).toEqual(["one:reader-document:missing"]);
});

it("restarts count evidence when Reader expires the cursor", async () => {
  const f = fixture();
  let expired = true;
  f.reader.page = (query?: ReaderQuery) => {
    if (query?.cursor && expired) {
      expired = false;
      return Promise.reject(new InvalidCursor());
    }
    return Promise.resolve(
      expired
        ? {
            count: 2,
            nextPageCursor: "expired",
            results: [{ id: "old", category: "article" }],
          }
        : {
            count: 1,
            nextPageCursor: null,
            results: [{ id: "current", category: "article" }],
          },
    );
  };
  await f.run(1);
  await f.run();
  expect(f.states.get("reader-list")?.get("listing")).toHaveProperty("fullAt");
});

it("compresses thousands of observed IDs and resumes a complete inventory", async () => {
  const f = fixture(true);
  const rows: ReaderDocument[] = Array.from({ length: 5422 }, (_, n) => ({
    id: createHash("sha256").update(String(n)).digest("hex").slice(0, 36),
    category: "rss",
    location: "feed",
  }));
  f.setPages([rows.slice(0, 4000), rows.slice(4000)]);
  await f.run(1);
  expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
    walk: {
      total: 5422,
      identities: { encoding: "deflate-base64" },
    },
  });
  await f.run();
  expect(f.states.get("reader-list")?.get("listing")).toHaveProperty("fullAt");
  expect(Math.max(...f.checkpointBytes)).toBeLessThan(512 * 1024);
});

it("stops listing when an item lookup is throttled without valid retry guidance", async () => {
  const f = fixture();
  f.setPages([[{ id: "orphan", category: "note", content: "note" }]]);
  await f.run();
  const calls = f.requests.length;
  f.reader.document = () =>
    Promise.reject(new ReadwiseThrottleError("invalid Retry-After"));
  await expect(f.run()).rejects.toThrow("invalid Retry-After");
  expect(f.requests).toHaveLength(calls);
});

it("retains a failed hint lookup while processing healthy hints", async () => {
  const f = fixture(
    false,
    new Map([
      [
        "readwise.source",
        new Set(["one:reader-document:bad", "one:reader-document:doc"]),
      ],
    ]),
  );
  const lookup = f.reader.document.bind(f.reader);
  f.reader.document = (id) =>
    id === "bad" ? Promise.reject(new Error("failed hint")) : lookup(id);
  await f.run();
  expect(f.writes.map(({ entry }) => entry.source_id)).toContain(
    "one:reader-document:doc",
  );
  expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
    pending: ["bad"],
  });
  expect(f.requests).toEqual([]);
});

it("resumes the observed Reader remaining counts of 8248, 8148 and 8048", async () => {
  const f = fixture();
  f.reader.page = (query?: ReaderQuery) => {
    const at = Number(query?.cursor ?? 0);
    return Promise.resolve({
      count: 8248 - at * 100,
      nextPageCursor: String(at + 1),
      results: Array.from({ length: 100 }, (_, offset) => ({
        id: `reader-${String(at * 100 + offset)}`,
        category: "rss",
        location: "feed",
      })),
    });
  };
  await f.run(1);
  await f.run(1);
  await f.run(1);
  expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
    walk: {
      total: 8248,
      cursor: "3",
    },
  });
  const saved = f.states.get("reader-list")?.get("listing") as {
    walk: { identities: string[] };
  };
  expect(saved.walk.identities).toHaveLength(300);
  expect(saved.walk.identities).toContain("reader-0");
  expect(saved.walk.identities).toContain("reader-299");
  expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
    "completed",
  );
});

it.each(["resume", "checkpoint failure", "cancellation"] as const)(
  "keeps an HTTP-throttled parent lookup inside its loaded page: %s",
  async (outcome) => {
    const f = fixture();
    const paths: string[] = [];
    const children = Array.from({ length: 25 }, (_, at) => ({
      id: `child-${String(at)}`,
      category: "highlight",
      parent_id: `parent-${String(at)}`,
      content: `Passage ${String(at)}`,
    }));
    let throttled = false;
    const http = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const url = new URL(request.url ?? "", "http://example.com");
      paths.push(url.pathname + url.search);
      const id = url.searchParams.get("id");
      if (id === "parent-20" && !throttled) {
        throttled = true;
        response.writeHead(429, { "Retry-After": "60" }).end();
        return;
      }
      const results =
        url.pathname === "/api/v2/export/"
          ? []
          : id !== null
            ? [{ id, category: "article", title: id }]
            : url.searchParams.has("pageCursor")
              ? []
              : children;
      response.end(
        JSON.stringify({
          count: results.length,
          nextPageCursor:
            id === null && results.length > 0 ? "after-children" : null,
          results,
        }),
      );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`;
    Object.assign(f.context.env, {
      READWISE_API_URL: `${base}/api/v2/`,
      READWISE_READER_API_URL: `${base}/api/v3/`,
      READWISE_ACCESS_TOKEN: `inbound-${outcome}`,
    });
    const waitUntil = vi.fn((until: string) => {
      expect(until).toBe("2026-10-15T00:01:00.000Z");
      expect(f.states.get("reader-list")?.get("listing")).toMatchObject({
        walk: { cursor: null, seen: [], identities: [] },
      });
      expect(f.writes).toEqual([]);
      if (outcome === "cancellation")
        f.controller.abort(new Error("cancelled"));
      return outcome === "resume"
        ? Promise.resolve()
        : Promise.reject(new Error(outcome));
    });
    Object.assign(f.context, { waitUntil });
    // Advance the local permit clock without delaying real HTTP exchanges.
    let monotonic = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => (monotonic += 60_001));
    try {
      const run = sync(f.context, {
        content: f.content,
        now: () => Date.parse(stamp),
      });
      if (outcome === "resume") {
        await run;
        expect(f.writes).toHaveLength(50);
        expect(paths.filter((path) => path === "/api/v3/list/")).toHaveLength(
          1,
        );
        expect(
          paths.filter((path) => path === "/api/v3/list/?id=parent-20"),
        ).toHaveLength(2);
        expect(paths).toContain("/api/v3/list/?id=parent-24");
        expect(f.states.get("reader-list")?.get("listing")).toHaveProperty(
          "completed",
        );
      } else {
        await expect(run).rejects.toThrow(
          outcome === "cancellation" ? "cancelled" : /wait failed/,
        );
        expect(paths.at(-1)).toBe("/api/v3/list/?id=parent-20");
        expect(f.states.get("reader-list")?.get("listing")).not.toHaveProperty(
          "completed",
        );
      }
      expect(waitUntil).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      http.closeAllConnections();
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
    }
  },
);
