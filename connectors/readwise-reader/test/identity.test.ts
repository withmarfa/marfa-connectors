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
    page: (query) =>
      Promise.resolve({
        count: sources.length,
        results:
          query.sourceId === undefined
            ? sources
            : sources.filter(
                (source) => source.user_book_id === query.sourceId,
              ),
        nextPageCursor: null,
      }),
    sourceForHighlight: () => Promise.resolve(undefined),
  };
  const load = () =>
    ReaderIdentities.load("one", "https://example.com", context, state);
  return { saved, rows, sources, client, load, context, state };
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
  const original = f.sources[0];
  if (!original) throw new Error("missing source");
  original.is_deleted = false;
  const firstHighlight = original.highlights[0];
  if (!firstHighlight) throw new Error("missing highlight");
  firstHighlight.is_deleted = false;
  f.sources.push({
    user_book_id: 8,
    source: "reader",
    external_id: "other-doc",
    is_deleted: false,
    highlights: [
      {
        id: 42,
        external_id: "hi",
        text: "Different parent",
        is_deleted: false,
      },
    ],
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
  const first = await f.load();
  await first.prepare(f.client, 5);
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

it.each([false, true])(
  "selects the sole active export highlight while retaining its deleted alias; restart=%s",
  async (restart) => {
    const f = fixture();
    const source = f.sources[0];
    if (!source) throw new Error("missing source");
    source.is_deleted = false;
    source.highlights = [
      {
        id: 41,
        external_id: "hi",
        text: "Historical passage",
        is_deleted: true,
      },
      {
        id: 42,
        external_id: "hi",
        text: "Active export passage",
        is_deleted: false,
      },
    ];
    const first = await f.load();
    await first.prepare(f.client, 5);
    const identities = restart ? await f.load() : first;
    if (restart) await identities.prepare(f.client, 5);
    const resolved = await identities.resolve({
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "Reader passage",
    });
    expect(resolved.enrichment.properties).toMatchObject({
      readwise_id: "42",
      readwise_source_id: "7",
      readwise_text: "Active export passage",
    });
    const saved = structuredClone(f.saved.get("identities"));
    expect(JSON.stringify(saved)).not.toContain("Active export passage");
    await expect(
      identities.resolve({
        id: "hi",
        category: "highlight",
        parent_id: "other",
        content: "Reader passage",
      }),
    ).rejects.toThrow(/parent/);
  },
);

function lifecycleFixture() {
  const f = fixture();
  const source = f.sources[0];
  if (!source) throw new Error("missing source");
  source.is_deleted = false;
  source.highlights = [
    { id: 41, external_id: "hi", text: "Historical passage", is_deleted: true },
    {
      id: 42,
      external_id: "hi",
      text: "Active export passage",
      is_deleted: false,
    },
  ];
  const row = (id: string, readwiseId: string) => ({
    id,
    source: "readwise",
    source_id: `one:highlight:${readwiseId}`,
    type: "readwise.highlight",
    state: "active" as const,
    version: 3,
    schema_version: 1,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    occurred_at: "2026-10-15T00:00:00Z",
    properties: {
      account: "one",
      reader_id: "hi",
      readwise_id: readwiseId,
      readwise_source_id: "7",
      canonical_key: `one:highlight:${readwiseId}`,
      text:
        id === "historical" ? "Keep historical bytes" : "Kept active passage",
    },
  });
  f.rows.push(row("active", "42"), {
    ...row("historical", "41"),
    state: "archived",
  });
  return {
    ...f,
    source,
    document: {
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "Reader passage",
    },
  };
}

it("adopts only the verified active natural row and leaves a retained historical row intact", async () => {
  const f = lifecycleFixture();
  const before = structuredClone(f.rows);
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  expect(await identities.resolve(f.document)).toMatchObject({
    enrichment: {
      sourceId: "one:highlight:42",
      properties: {
        readwise_id: "42",
        text: "Kept active passage",
        readwise_text: "Active export passage",
      },
    },
  });
  expect(f.rows).toEqual(before);
});

it("retains a historical canonical holder rather than replacing it with the active alias", async () => {
  const f = lifecycleFixture();
  const historical = f.rows[1];
  if (!historical) throw new Error("missing historical row");
  historical.properties = {
    ...historical.properties,
    canonical_key: "one:reader-highlight:hi",
  };
  const before = structuredClone(f.rows);
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  await expect(identities.resolve(f.document)).rejects.toThrow(
    /existing states|tombstones/,
  );
  expect(f.rows).toEqual(before);
});

it.each([
  "two-active",
  "none-active",
  "source-status-missing",
  "highlight-status-missing",
  "parent-mismatch",
  "parent-missing",
  "missing-historical",
  "incomplete",
  "read-failed",
])("retains ambiguous or incomplete lifecycle evidence: %s", async (kind) => {
  const f = lifecycleFixture();
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  if (kind === "two-active" && f.source.highlights[0])
    f.source.highlights[0].is_deleted = false;
  if (kind === "none-active" && f.source.highlights[1])
    f.source.highlights[1].is_deleted = true;
  if (kind === "source-status-missing") delete f.source.is_deleted;
  if (kind === "highlight-status-missing" && f.source.highlights[0])
    delete f.source.highlights[0].is_deleted;
  const document = { ...f.document };
  if (kind === "parent-mismatch") document.parent_id = "other";
  if (kind === "parent-missing") Object.assign(document, { parent_id: null });
  if (kind === "missing-historical")
    f.source.highlights = f.source.highlights.slice(1);
  const resumed = await f.load();
  await resumed.prepare(f.client, 5);
  if (kind === "incomplete")
    vi.spyOn(f.client, "page").mockResolvedValue({
      count: 1,
      results: f.sources,
      nextPageCursor: "again",
    });
  if (kind === "read-failed")
    vi.spyOn(f.client, "page").mockRejectedValue(
      new Error("export unavailable"),
    );
  const before = structuredClone(f.rows);
  await expect(resumed.resolve(document)).rejects.toThrow(
    /identity|parent|export|cursor|unavailable|incomplete/,
  );
  expect(f.rows).toEqual(before);
});

it("requires complete paginated export evidence after an identity-cache restart", async () => {
  const f = lifecycleFixture();
  const page = vi.spyOn(f.client, "page").mockImplementation((query) =>
    Promise.resolve({
      count: 2,
      results: [
        {
          ...f.source,
          highlights: query.cursor
            ? f.source.highlights.slice(1)
            : f.source.highlights.slice(0, 1),
        },
      ],
      nextPageCursor: query.cursor ? null : "second",
    }),
  );
  const first = await f.load();
  expect(await first.prepare(f.client, 1)).toBe(false);
  const resumed = await f.load();
  expect(await resumed.prepare(f.client, 1)).toBe(true);
  expect(await resumed.resolve(f.document)).toMatchObject({
    enrichment: {
      sourceId: "one:highlight:42",
      properties: { readwise_id: "42" },
    },
  });
  expect(
    page.mock.calls.filter(([q]) => q.cursor === "second").length,
  ).toBeGreaterThanOrEqual(2);
});

it("does not admit the active row through a retained canonical tombstone", async () => {
  const f = lifecycleFixture();
  const inspect = f.context.inspect;
  vi.spyOn(f.context, "inspect").mockImplementation(async (type, query) => {
    const result = await inspect(type, query);
    return "links" in query
      ? {
          ...result,
          tombstones: [
            {
              key: "one:reader-highlight:hi",
              purged_at: "2026-10-15T00:00:00Z",
              settled_at: "2026-10-15T00:00:00Z",
            },
          ],
        }
      : result;
  });
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  await expect(identities.resolve(f.document)).rejects.toThrow(/tombstones/);
});

it.each(["active", "archived", "trashed"] as const)(
  "refuses a lone historical canonical holder without rewriting its %s state",
  async (state) => {
    const f = lifecycleFixture();
    f.rows.splice(0, 1);
    const historical = f.rows[0];
    if (!historical) throw new Error("missing historical row");
    historical.state = state;
    historical.properties = {
      ...historical.properties,
      reader_managed: true,
      canonical_key: "one:reader-highlight:hi",
    };
    const before = structuredClone(f.rows);
    for (let run = 0; run < 2; run++) {
      const identities = await f.load();
      await identities.prepare(f.client, 5);
      await expect(identities.resolve(f.document)).rejects.toThrow(
        /canonical holder|active alias/,
      );
      expect(f.rows).toEqual(before);
    }
  },
);

it("enriches a Reader-only natural row without reassigning an existing export identity", async () => {
  const f = lifecycleFixture();
  f.rows.splice(0);
  f.rows.push({
    id: "reader-only",
    source: "readwise",
    source_id: "one:reader-highlight:hi",
    type: "readwise.highlight",
    state: "active",
    version: 1,
    schema_version: 1,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    occurred_at: "2026-10-15T00:00:00Z",
    properties: {
      account: "one",
      reader_managed: true,
      reader_id: "hi",
      canonical_key: "one:reader-highlight:hi",
      text: "Reader passage",
    },
  });
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  expect(await identities.resolve(f.document)).toMatchObject({
    enrichment: {
      sourceId: "one:reader-highlight:hi",
      properties: { readwise_id: "42" },
    },
  });
});

it("keeps a lone document holder unresolved when two export sources claim it", async () => {
  const f = lifecycleFixture();
  f.rows.splice(0);
  f.rows.push({
    id: "historical-doc",
    source: "readwise",
    source_id: "one:source:7",
    type: "readwise.source",
    state: "archived",
    version: 2,
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
      title: "Keep historical document",
    },
  });
  f.sources.push({
    user_book_id: 8,
    source: "reader",
    external_id: "doc",
    is_deleted: false,
    highlights: [],
  });
  const before = structuredClone(f.rows);
  const identities = await f.load();
  await identities.prepare(f.client, 5);
  await expect(
    identities.resolve({ id: "doc", category: "article" }),
  ).rejects.toThrow(/multiple export IDs/);
  expect(f.rows).toEqual(before);
});

it("retains a complete 51-page lifecycle index across restart", async () => {
  const f = lifecycleFixture();
  f.rows.splice(0);
  const sources = Array.from({ length: 51 }, (_, at) =>
    at === 0
      ? f.source
      : {
          user_book_id: 7 + at,
          source: "reader",
          external_id: `doc-${String(at)}`,
          is_deleted: false,
          highlights: [],
        },
  );
  const page = vi.spyOn(f.client, "page").mockImplementation((query) => {
    if (query.updatedAfter !== undefined && query.sourceId === undefined)
      return Promise.resolve({ count: 0, results: [], nextPageCursor: null });
    const at = Number(query.cursor ?? 0);
    const source = query.sourceId === 7 ? f.source : sources[at];
    if (!source) throw new Error("missing export page");
    return Promise.resolve({
      count: 51,
      results: [source],
      nextPageCursor: query.sourceId === 7 || at === 50 ? null : String(at + 1),
    });
  });
  const first = await f.load();
  expect(await first.prepare(f.client, 51)).toBe(true);
  expect(
    (await first.resolve(f.document)).enrichment.properties?.["readwise_id"],
  ).toBe("42");
  const resumed = await f.load();
  expect(await resumed.prepare(f.client, 1)).toBe(true);
  page.mockClear();
  expect(
    (await resumed.resolve(f.document)).enrichment.properties?.["readwise_id"],
  ).toBe("42");
  expect(page.mock.calls.every(([query]) => query.sourceId === 7)).toBe(true);
});

it("resumes a bounded 51-page evidence upgrade instead of repeating its first pages", async () => {
  const f = lifecycleFixture();
  f.rows.splice(0);
  f.saved.set(
    "identities",
    cache({
      "one:reader-highlight:hi": [
        {
          natural: "one:highlight:41",
          readwiseId: "41",
          sourceId: 7,
          parent: "doc",
        },
        {
          natural: "one:highlight:42",
          readwiseId: "42",
          sourceId: 7,
          parent: "doc",
        },
      ],
    }),
  );
  const sources = Array.from({ length: 51 }, (_, at) =>
    at === 0
      ? f.source
      : {
          user_book_id: 7 + at,
          source: "reader",
          external_id: `doc-${String(at)}`,
          is_deleted: false,
          highlights: [],
        },
  );
  const cursors: number[] = [];
  vi.spyOn(f.client, "page").mockImplementation((query) => {
    const at = Number(query.cursor ?? 0);
    if (query.sourceId === undefined) cursors.push(at);
    const source = query.sourceId === 7 ? f.source : sources[at];
    if (!source) throw new Error("missing export page");
    return Promise.resolve({
      count: 51,
      results: [source],
      nextPageCursor: query.sourceId === 7 || at === 50 ? null : String(at + 1),
    });
  });
  for (let pass = 0; pass < 8; pass++) {
    const identities = await f.load();
    const complete = await identities.prepare(f.client, 7);
    expect(complete).toBe(pass === 7);
    if (complete)
      expect(
        (await identities.resolve(f.document)).enrichment.properties?.[
          "readwise_id"
        ],
      ).toBe("42");
    else
      await expect(identities.resolve(f.document)).rejects.toThrow(
        /complete export/,
      );
  }
  expect(cursors).toEqual(Array.from({ length: 51 }, (_, at) => at));
});

it("requires the lifecycle readiness checkpoint before admission and retries safely", async () => {
  const f = lifecycleFixture();
  const before = structuredClone(f.rows);
  const checkpoint = f.state.checkpoint.bind(f.state);
  const fail = vi
    .spyOn(f.state, "checkpoint")
    .mockImplementation((key, value) =>
      key === "lifecycle-ready" && value !== false
        ? Promise.resolve({ committed: false, reason: "row-refused" })
        : checkpoint(key, value),
    );
  const first = await f.load();
  await expect(first.prepare(f.client, 5)).rejects.toThrow(
    /evidence was not saved/,
  );
  await expect(first.resolve(f.document)).rejects.toThrow(/complete export/);
  expect(f.rows).toEqual(before);
  fail.mockRestore();
  const resumed = await f.load();
  expect(await resumed.prepare(f.client, 5)).toBe(true);
  expect(
    (await resumed.resolve(f.document)).enrichment.properties?.["readwise_id"],
  ).toBe("42");
  expect(f.rows).toEqual(before);
});

it("clears old lifecycle status when a refreshed export omits a historical alias", async () => {
  const f = lifecycleFixture();
  const first = await f.load();
  await first.prepare(f.client, 5);
  f.source.highlights = f.source.highlights.slice(1);
  const resumed = await f.load();
  expect(await resumed.prepare(f.client, 5, true)).toBe(true);
  await expect(resumed.resolve(f.document)).rejects.toThrow(
    /incomplete lifecycle evidence|reconciliation/,
  );
});

function crossSourceFixture() {
  const f = lifecycleFixture();
  f.rows.splice(1);
  f.source.highlights = f.source.highlights.filter((h) => h.id === 42);
  const historical: Source = {
    user_book_id: 8,
    source: "reader",
    external_id: "historical-doc",
    is_deleted: false,
    highlights: [
      {
        id: 41,
        external_id: "hi",
        text: "Historical passage",
        is_deleted: true,
      },
    ],
  };
  f.sources.push(historical);
  let updates: Source[] = [];
  const requests: {
    sourceId?: number;
    updatedAfter?: string;
    cursor?: string;
  }[] = [];
  vi.spyOn(f.client, "page").mockImplementation((query) => {
    requests.push({ ...query });
    return Promise.resolve({
      count: 2,
      results: structuredClone(
        query.sourceId === undefined
          ? query.updatedAfter === undefined
            ? f.sources
            : updates
          : f.sources.filter(
              (source) => source.user_book_id === query.sourceId,
            ),
      ),
      nextPageCursor: null,
    });
  });
  return {
    ...f,
    historical,
    requests,
    setUpdates: (value: Source[]) => {
      updates = value;
    },
  };
}

it.each([
  "reactivated",
  "new-claim",
  "parent-lost",
  "source-kind-lost",
  "reader-id-lost",
  "read-failed",
])("checks every current alias source after restart: %s", async (kind) => {
  const f = crossSourceFixture();
  const before = structuredClone(f.rows);
  const first = await f.load();
  await first.prepare(f.client, 5);
  await first.resolve(f.document);
  if (kind === "reactivated" && f.historical.highlights[0])
    f.historical.highlights[0].is_deleted = false;
  if (kind === "new-claim")
    f.historical.highlights.push({
      id: 43,
      external_id: "hi",
      text: "New competing claim",
      is_deleted: false,
    });
  if (kind === "parent-lost") f.historical.external_id = null;
  if (kind === "source-kind-lost") f.historical.source = null;
  if (kind === "reader-id-lost" && f.historical.highlights[0])
    f.historical.highlights[0].external_id = null;
  if (kind === "read-failed") {
    const page = vi.spyOn(f.client, "page").getMockImplementation();
    if (!page) throw new Error("missing provider fixture");
    vi.spyOn(f.client, "page").mockImplementation((query) =>
      query.sourceId === 8
        ? Promise.reject(new Error("historical source unavailable"))
        : page(query),
    );
  }
  const resumed = await f.load();
  await resumed.prepare(f.client, 5);
  await expect(resumed.resolve(f.document)).rejects.toThrow(
    /identity|alias|parent|unavailable|reconciliation/,
  );
  expect(f.rows).toEqual(before);
});

it.each([null, "", undefined])(
  "retains an unknown-parent competing claim in a complete export: %s",
  async (parent) => {
    const f = lifecycleFixture();
    f.sources.push({
      user_book_id: 8,
      source: "reader",
      ...(parent === undefined ? {} : { external_id: parent }),
      is_deleted: false,
      highlights: [
        {
          id: 43,
          external_id: "hi",
          text: "Unknown-parent competing claim",
          is_deleted: false,
        },
      ],
    });
    const before = structuredClone(f.rows);
    for (let run = 0; run < 2; run++) {
      const identities = await f.load();
      await identities.prepare(f.client, 5);
      await expect(identities.resolve(f.document)).rejects.toThrow(
        /identity|parent/,
      );
      expect(f.rows).toEqual(before);
    }
  },
);

it("does not block a verified identity because an unrelated source has no parent", async () => {
  const f = lifecycleFixture();
  f.sources.push({
    user_book_id: 8,
    source: "reader",
    external_id: null,
    is_deleted: false,
    highlights: [
      {
        id: 43,
        external_id: "unrelated",
        text: "Unrelated claim",
        is_deleted: false,
      },
    ],
  });
  vi.spyOn(f.client, "page").mockImplementation((query) =>
    Promise.resolve({
      count: 2,
      results: structuredClone(
        query.sourceId === undefined
          ? query.updatedAfter === undefined
            ? f.sources
            : []
          : f.sources.filter((s) => s.user_book_id === query.sourceId),
      ),
      nextPageCursor: null,
    }),
  );
  for (let run = 0; run < 2; run++) {
    const identities = await f.load();
    await identities.prepare(f.client, 5);
    expect(await identities.resolve(f.document)).toMatchObject({
      enrichment: {
        sourceId: "one:highlight:42",
        properties: { readwise_id: "42" },
      },
    });
  }
});

it("discovers a new competing source through a complete account-wide delta", async () => {
  const f = crossSourceFixture();
  const first = await f.load();
  await first.prepare(f.client, 5);
  await first.resolve(f.document);
  const newlyCompeting: Source = {
    user_book_id: 9,
    source: "reader",
    external_id: "new-doc",
    is_deleted: false,
    highlights: [
      {
        id: 44,
        external_id: "hi",
        text: "New source claim",
        is_deleted: false,
      },
    ],
  };
  f.sources.push(newlyCompeting);
  f.setUpdates([newlyCompeting]);
  const before = structuredClone(f.rows);
  const resumed = await f.load();
  await resumed.prepare(f.client, 5);
  await expect(resumed.resolve(f.document)).rejects.toThrow(/identity/);
  expect(f.rows).toEqual(before);
  expect(
    f.requests.some(
      (q) => q.updatedAfter !== undefined && q.sourceId === undefined,
    ),
  ).toBe(true);
});

it("checkpoints a paginated account-wide delta before admitting any lifecycle choice", async () => {
  const f = crossSourceFixture();
  const first = await f.load();
  await first.prepare(f.client, 5);
  await first.resolve(f.document);
  const before = structuredClone(f.rows);
  const original = vi.spyOn(f.client, "page").getMockImplementation();
  if (!original) throw new Error("missing fixture");
  const deltaCursors: (string | undefined)[] = [];
  const lowers: (string | undefined)[] = [];
  const competing: Source = {
    user_book_id: 9,
    source: "reader",
    external_id: "new-doc",
    is_deleted: false,
    highlights: [
      { id: 44, external_id: "hi", is_deleted: false, text: "New claim" },
    ],
  };
  f.sources.push(competing);
  vi.spyOn(f.client, "page").mockImplementation((query) => {
    if (query.updatedAfter === undefined || query.sourceId !== undefined)
      return original(query);
    deltaCursors.push(query.cursor);
    lowers.push(query.updatedAfter);
    return Promise.resolve({
      count: 2,
      results: query.cursor ? [competing] : [],
      nextPageCursor: query.cursor ? null : "next-delta",
    });
  });
  const partial = await f.load();
  expect(await partial.prepare(f.client, 1)).toBe(false);
  await expect(partial.resolve(f.document)).rejects.toThrow(/complete export/);
  expect(f.rows).toEqual(before);
  const resumed = await f.load();
  expect(await resumed.prepare(f.client, 1)).toBe(true);
  await expect(resumed.resolve(f.document)).rejects.toThrow(/identity/);
  expect(f.rows).toEqual(before);
  expect(deltaCursors).toEqual([undefined, "next-delta"]);
  expect(lowers[0]).toBeTruthy();
  expect(lowers[1]).toBe(lowers[0]);
});

it.each(["missing", "expired", "old-coverage"])(
  "requires a full catalogue when its overlap marker is %s",
  async (kind) => {
    const f = crossSourceFixture();
    const first = await f.load();
    await first.prepare(f.client, 5);
    const stored = f.saved.get("identities") as {
      start?: string;
      lower?: string;
    };
    if (kind === "missing") {
      delete stored.start;
      delete stored.lower;
    } else if (kind === "expired") stored.start = "2000-01-01T00:00:00.000Z";
    else f.saved.set("lifecycle-ready", true);
    f.saved.set("identities", stored);
    f.requests.length = 0;
    const resumed = await f.load();
    expect(await resumed.prepare(f.client, 5)).toBe(true);
    expect(f.requests[0]).toEqual({});
  },
);

it.each(["deleted", "reactivated"])(
  "applies an explicit %s highlight claim from a completed delta",
  async (kind) => {
    const f = crossSourceFixture();
    const first = await f.load();
    await first.prepare(f.client, 5);
    await first.resolve(f.document);
    const changed = kind === "deleted" ? f.source : f.historical;
    const highlight = changed.highlights[0];
    if (!highlight) throw new Error("missing changed claim");
    highlight.is_deleted = kind === "deleted";
    f.setUpdates([changed]);
    const before = structuredClone(f.rows);
    const resumed = await f.load();
    await resumed.prepare(f.client, 5);
    await expect(resumed.resolve(f.document)).rejects.toThrow(/identity/);
    expect(f.rows).toEqual(before);
  },
);

it("retains a failed delta cursor and cannot use partial evidence for admission", async () => {
  const f = crossSourceFixture();
  const first = await f.load();
  await first.prepare(f.client, 5);
  await first.resolve(f.document);
  const original = vi.spyOn(f.client, "page").getMockImplementation();
  if (!original) throw new Error("missing fixture");
  const cursors: (string | undefined)[] = [];
  let failed = true;
  vi.spyOn(f.client, "page").mockImplementation((query) => {
    if (query.updatedAfter === undefined || query.sourceId !== undefined)
      return original(query);
    cursors.push(query.cursor);
    if (query.cursor && failed)
      return Promise.reject(new Error("delta unavailable"));
    return Promise.resolve({
      count: 0,
      results: [],
      nextPageCursor: query.cursor ? null : "retry-delta",
    });
  });
  const partial = await f.load();
  expect(await partial.prepare(f.client, 1)).toBe(false);
  const interrupted = await f.load();
  await expect(interrupted.prepare(f.client, 1)).rejects.toThrow(/unavailable/);
  await expect(interrupted.resolve(f.document)).rejects.toThrow(
    /complete export/,
  );
  failed = false;
  const resumed = await f.load();
  expect(await resumed.prepare(f.client, 1)).toBe(true);
  expect(await resumed.resolve(f.document)).toMatchObject({
    enrichment: { properties: { readwise_id: "42" } },
  });
  expect(cursors).toEqual([undefined, "retry-delta", "retry-delta"]);
});
