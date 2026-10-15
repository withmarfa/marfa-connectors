import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import type { CheckpointState, Item } from "@withmarfa/connector";
import {
  mapReaderHighlight,
  type ExportClient,
  type Source,
} from "@withmarfa/readwise";
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
    inspect: (type, query) =>
      Promise.resolve({
        items: rows.filter(
          (row) =>
            row.type === type &&
            ("links" in query
              ? query.links.includes(String(row.properties["canonical_key"]))
              : query.source_ids.includes(row.source_id ?? "")),
        ),
        tombstones: [],
      }),
    pendingOutbound: () => [],
  };
  const state: CheckpointState = {
    get: (key) => structuredClone(saved.get(key)),
    checkpoint: (key, value) => {
      saved.set(key, structuredClone(value));
      return Promise.resolve({ committed: true });
    },
  };
  const client: ExportClient = {
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
  return { saved, rows, sources, client, load, context };
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

it.each([false, true])(
  "preserves a deleted export highlight's retained passage; restart=%s",
  async (restart) => {
    const f = fixture();
    const highlight = f.sources[0]?.highlights[0];
    if (highlight === undefined) throw new Error("missing export fixture");
    highlight.is_deleted = true;
    const first = await f.load();
    await first.prepare(f.client, 5);
    const identities = restart ? await f.load() : first;
    if (restart) await identities.prepare(f.client, 5);
    const document = {
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "Current Reader passage",
    };
    const resolved = await identities.resolve(document);
    expect(
      mapReaderHighlight("one", document, resolved.enrichment).entry,
    ).toMatchObject({
      source_id: "one:reader-highlight:hi",
      properties: {
        text: "Current Reader passage",
        readwise_text: "Export passage",
      },
    });
  },
);

it.each([false, true])(
  "retains acknowledged text when a matching export tombstone has no text; managed=%s",
  async (managed) => {
    const f = fixture();
    f.saved.set(
      "identities",
      cache({
        "one:reader-highlight:hi": [
          {
            natural: "one:highlight:42",
            readwiseId: "42",
            sourceId: 7,
            parent: "doc",
          },
        ],
        "one:reader-highlight:other": [
          {
            natural: "one:highlight:43",
            readwiseId: "43",
            sourceId: 7,
            parent: "doc",
          },
        ],
      }),
    );
    f.rows.push({
      id: "local",
      source: "readwise",
      source_id: "one:highlight:42",
      type: "readwise.highlight",
      state: "active",
      version: 1,
      schema_version: 1,
      created_at: "2026-10-15T00:00:00Z",
      updated_at: "2026-10-15T00:00:00Z",
      occurred_at: "2026-10-15T00:00:00Z",
      properties: {
        account: "one",
        reader_managed: managed,
        reader_id: "hi",
        readwise_id: "42",
        text: managed
          ? "Previous Reader passage"
          : "Acknowledged export passage",
        ...(managed && { readwise_text: "Acknowledged export passage" }),
      },
    });
    const source = f.sources[0];
    if (source === undefined) throw new Error("missing export fixture");
    source.highlights = [
      { id: 42, is_deleted: true },
      { id: 43, is_deleted: true },
    ];
    const page = vi.spyOn(f.client, "page");
    const identities = await f.load();
    await identities.prepare(f.client, 5);
    for (const id of ["hi", "other", "hi"]) {
      const document = {
        id,
        category: "highlight",
        parent_id: "doc",
        content: "Current Reader passage",
      };
      const resolved = await identities.resolve(document);
      const mapped = mapReaderHighlight(
        "one",
        document,
        resolved.enrichment,
      ).entry;
      expect(mapped.properties["text"]).toBe("Current Reader passage");
      expect(mapped.properties["readwise_text"]).toBe(
        id === "hi" ? "Acknowledged export passage" : undefined,
      );
    }
    expect(page).toHaveBeenCalledTimes(1);
  },
);

it.each(
  [
    "source",
    "parent",
    "highlight",
    "external",
    "absent",
    "malformed",
    "missing-external",
    "source-deleted",
    "source-kind",
    "ambiguous",
  ].flatMap((kind) => [false, true].map((complete) => ({ kind, complete }))),
)(
  "keeps Reader admission blocked for $kind; restarted=$complete",
  async ({ kind, complete }) => {
    const f = fixture();
    f.saved.set("identities", {
      ...cache({
        "one:reader-highlight:hi": [
          {
            natural: "one:highlight:42",
            readwiseId: "42",
            sourceId: 7,
            parent: "doc",
          },
        ],
      }),
      complete,
    });
    const source = f.sources[0];
    if (source === undefined) throw new Error("missing export fixture");
    source.highlights = [{ id: 42, external_id: "hi", is_deleted: true }];
    if (kind === "source") source.user_book_id = 8;
    if (kind === "parent") source.external_id = "other-doc";
    if (kind === "highlight")
      source.highlights = [{ id: 99, external_id: "hi", is_deleted: true }];
    if (kind === "external")
      source.highlights = [{ id: 42, external_id: "other", is_deleted: true }];
    if (kind === "absent") source.highlights = [];
    if (kind === "malformed")
      source.highlights = [{ id: 42, external_id: "hi" }];
    if (kind === "missing-external")
      source.highlights = [{ id: 42, text: "Unverified passage" }];
    if (kind === "source-deleted") source.is_deleted = true;
    if (kind === "source-kind") source.source = "other";
    if (kind === "ambiguous")
      source.highlights = [
        { id: 42, external_id: "hi", is_deleted: true, text: "First passage" },
        {
          id: 42,
          external_id: "hi",
          is_deleted: true,
          text: "Different passage",
        },
      ];
    await expect(
      (async () => {
        const identities = await f.load();
        await identities.prepare(f.client, 5);
        return identities.resolve({
          id: "hi",
          category: "highlight",
          parent_id: "doc",
          content: "Reader passage",
        });
      })(),
    ).rejects.toThrow(/identity|unavailable|invalid|ambiguous/);
  },
);

it("does not admit a matching tombstone from an incomplete export answer", async () => {
  const f = fixture();
  f.saved.set(
    "identities",
    cache({
      "one:reader-highlight:hi": [
        {
          natural: "one:highlight:42",
          readwiseId: "42",
          sourceId: 7,
          parent: "doc",
        },
      ],
    }),
  );
  const source = f.sources[0];
  if (source === undefined) throw new Error("missing export fixture");
  source.highlights = [{ id: 42, external_id: "hi", is_deleted: true }];
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  vi.spyOn(f.client, "page").mockResolvedValue({
    count: 1,
    results: f.sources,
    nextPageCursor: "again",
  });
  await expect(
    identities.resolve({
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "Reader passage",
    }),
  ).rejects.toThrow(/repeated a cursor/);
});

it.each(["links", "source_ids"] as const)(
  "keeps the fresh %s snapshot after content updates a previously held row",
  async (door) => {
    const f = fixture();
    const old: Item = {
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
        canonical_key: "one:reader-document:doc",
        reader_text_files: ["old retained file"],
      },
    };
    f.rows.push(old);
    const identities = await f.load();
    await identities.prepare(f.client, 5);
    const fresh = {
      ...old,
      version: 2,
      properties: {
        ...old.properties,
        reader_text_files: ["new acknowledged file"],
      },
    };
    const inspected = vi
      .spyOn(f.context, "inspect")
      .mockImplementation((_type, query) =>
        Promise.resolve({
          items: door in query ? [fresh] : [],
          tombstones: [],
        }),
      );
    const resolved = await identities.resolve({
      id: "doc",
      category: "article",
    });
    expect(resolved.previousProperties?.["reader_text_files"]).toEqual([
      "new acknowledged file",
    ]);
    expect(resolved.enrichment.properties?.["reader_text_files"]).toEqual([
      "new acknowledged file",
    ]);
    inspected.mockResolvedValue({
      items: [{ ...fresh, id: "different" }],
      tombstones: [],
    });
    await expect(
      identities.resolve({ id: "doc", category: "article" }),
    ).rejects.toThrow(/identity conflict/);
  },
);

it.each(["source-deleted", "ambiguous"])(
  "rejects %s passage evidence during a cold identity walk",
  async (kind) => {
    const f = fixture();
    const source = f.sources[0];
    if (source === undefined) throw new Error("missing export fixture");
    source.highlights = [
      { id: 42, external_id: "hi", is_deleted: true, text: "First passage" },
    ];
    if (kind === "source-deleted") source.is_deleted = true;
    else
      source.highlights.push({
        id: 42,
        external_id: "hi",
        is_deleted: true,
        text: "Different passage",
      });
    const cold = await f.load();
    await cold.prepare(f.client, 5);
    await expect(
      cold.resolve({
        id: "hi",
        category: "highlight",
        parent_id: "doc",
        content: "Reader passage",
      }),
    ).rejects.toThrow(/identity|ambiguous/);
    const resumed = await f.load();
    await resumed.prepare(f.client, 5);
    await expect(
      resumed.resolve({
        id: "hi",
        category: "highlight",
        parent_id: "doc",
        content: "Reader passage",
      }),
    ).rejects.toThrow(/identity|ambiguous/);
  },
);
