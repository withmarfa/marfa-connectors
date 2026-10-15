import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import type { CheckpointState, Item } from "@withmarfa/connector";
import type { Source } from "@withmarfa/readwise";
import { ReaderIdentities, type IdentityContext } from "../src/identity.js";

function fixture() {
  const saved = new Map<string, unknown>();
  const rows: Item[] = [];
  const sources: Source[] = [
    {
      user_book_id: 7,
      source: "reader",
      external_id: "doc",
      highlights: [{ id: 42, external_id: "hi", text: "Export passage" }],
    },
  ];
  const context: IdentityContext = {
    held: (type) => Promise.resolve(rows.filter((row) => row.type === type)),
    inspect: () => Promise.resolve({ items: [], tombstones: [] }),
    pendingOutbound: () => [],
  };
  const state: CheckpointState = {
    get: (key) => structuredClone(saved.get(key)),
    checkpoint: (key, value) => {
      saved.set(key, structuredClone(value));
      return Promise.resolve({ committed: true });
    },
  };
  const client = {
    page: () =>
      Promise.resolve({
        count: sources.length,
        results: sources,
        nextPageCursor: null,
      }),
    sourceForHighlight: () => Promise.resolve(undefined),
  };
  const load = () =>
    ReaderIdentities.load("one", "https://example.com", context, state);
  return { saved, rows, sources, client, load };
}

it("refines an existing highlight alias with verified export parent evidence for restart", async () => {
  const f = fixture();
  f.rows.push({
    id: "local",
    source: "readwise",
    source_id: "one:highlight:42",
    type: "readwise.highlight",
    state: "archived",
    version: 1,
    schema_version: 1,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    occurred_at: "2026-10-15T00:00:00Z",
    properties: {
      account: "one",
      reader_managed: true,
      reader_id: "hi",
      readwise_id: "42",
    },
  });
  const first = await f.load();
  await first.prepare(f.client, 5);
  const resumed = await f.load();
  await resumed.prepare(f.client, 5);
  expect(
    (
      await resumed.resolve({
        id: "hi",
        category: "highlight",
        parent_id: "doc",
        content: "Reader passage",
      })
    ).enrichment.properties,
  ).toMatchObject({
    readwise_source_id: "7",
    readwise_text: "Export passage",
  });
});

it("retains conflicting export parent evidence for the same natural identity", async () => {
  const f = fixture();
  f.sources.push({
    user_book_id: 8,
    source: "reader",
    external_id: "other-doc",
    highlights: [{ id: 42, external_id: "hi", text: "Different parent" }],
  });
  const first = await f.load();
  await first.prepare(f.client, 5);
  const resumed = await f.load();
  await resumed.prepare(f.client, 5);
  await expect(
    resumed.resolve({
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "Reader passage",
    }),
  ).rejects.toThrow(/multiple export IDs/);
});

function cache(aliases: unknown) {
  return {
    account: "one",
    endpoint: "https://example.com",
    aliases: {
      encoding: "deflate-base64",
      data: deflateSync(JSON.stringify(aliases)).toString("base64"),
    },
    cursor: null,
    seen: [],
    complete: true,
  };
}

it.each([
  { natural: "one:highlight:42", readwiseId: "01" },
  { natural: "one:highlight:42", readwiseId: "42", sourceId: 0, parent: "doc" },
  { natural: "one:highlight:42", readwiseId: "42", sourceId: 7 },
  {
    natural: "one:highlight:42",
    readwiseId: "42",
    sourceId: 7,
    parent: "bad\nparent",
  },
  { natural: "one:highlight:42", readwiseId: "42", unexpected: "field" },
])("rejects malformed decoded alias fields %#", async (alias) => {
  const f = fixture();
  f.saved.set("identities", cache({ "one:reader-highlight:hi": [alias] }));
  await expect(f.load()).rejects.toThrow(/aliases are invalid/);
});

it("rejects aliases under another account and document aliases with highlight parents", async () => {
  const f = fixture();
  for (const aliases of [
    {
      "other:reader-highlight:hi": [
        { natural: "one:highlight:42", readwiseId: "42" },
      ],
    },
    {
      "one:reader-document:doc": [
        {
          natural: "one:source:7",
          readwiseId: "7",
          sourceId: 7,
          parent: "doc",
        },
      ],
    },
  ]) {
    f.saved.set("identities", cache(aliases));
    await expect(f.load()).rejects.toThrow(/aliases are invalid/);
  }
});

it("bounds packed bytes and inflated bytes before parsing an identity cache", async () => {
  const f = fixture();
  const oversized = cache({});
  oversized.aliases.data = "A".repeat(512 * 1024);
  f.saved.set("identities", oversized);
  await expect(f.load()).rejects.toThrow(/invalid/);
  const bomb = cache({});
  bomb.aliases.data = deflateSync(" ".repeat(8 * 1024 * 1024 + 1)).toString(
    "base64",
  );
  f.saved.set("identities", bomb);
  await expect(f.load()).rejects.toThrow(/invalid or oversized/);
  bomb.aliases.data = "invalid*base64";
  f.saved.set("identities", bomb);
  await expect(f.load()).rejects.toThrow(
    /compressed identity aliases are invalid/,
  );
});

it("accepts one export ID with a canonical natural key and retains its export lookup alias", async () => {
  const f = fixture();
  f.rows.push({
    id: "local-source",
    source: "readwise",
    source_id: "one:reader-document:doc",
    type: "readwise.source",
    state: "active",
    version: 1,
    schema_version: 1,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    occurred_at: "2026-10-15T00:00:00Z",
    properties: {
      account: "one",
      reader_managed: true,
      reader_id: "doc",
      readwise_id: "7",
    },
  });
  const first = await f.load();
  await first.prepare(f.client, 5);
  const resumed = await f.load();
  await resumed.prepare(f.client, 5);
  await expect(
    resumed.resolve({ id: "doc", category: "article" }),
  ).resolves.toMatchObject({
    enrichment: {
      sourceId: "one:reader-document:doc",
      properties: { readwise_id: "7" },
    },
  });
});
