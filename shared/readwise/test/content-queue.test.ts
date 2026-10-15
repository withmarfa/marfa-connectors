import { describe, expect, it, vi } from "vitest";
import type { Entry, Item } from "@withmarfa/connector";
import { drainContent } from "../src/content-queue.js";
import { contentQueue, digest, enqueueContent } from "../src/content.js";
import { RateLimited } from "../src/http.js";
import type { ReaderDocument } from "../src/reader.js";

function fixture() {
  const rows = new Map<string, Item>();
  const files = new Map<string, { key: string; bytes: Uint8Array }>();
  const state = new Map<string, unknown>();
  const conditions = new Map<string, string>();
  const streamed = new Set<string>();
  const canonical = "sample:reader-document:one";
  rows.set(canonical, {
    id: "one",
    type: "readwise.source",
    source_id: canonical,
    properties: { account: "sample" },
    state: "active",
  } as unknown as Item);
  const context: Parameters<typeof drainContent>[0] = {
    signal: new AbortController().signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      condition(key, message) {
        conditions.set(key, message);
      },
      unreached: vi.fn(),
    },
    known: (_type, keys) =>
      Promise.resolve(new Set(keys.filter((key) => rows.has(key)))),
    inspect: (_type, by) =>
      Promise.resolve({
        items: by.links.flatMap((key) => {
          const row = rows.get(key);
          return row ? [row] : [];
        }),
        tombstones: [],
      }),
    forScope: () => ({
      state: checkpoint,
      async upsert(type, entries: readonly Entry[]) {
        for (const value of entries) {
          const prior = files.get(value.source_id);
          if (value.file && value.file.key !== prior?.key) {
            const result = await value.file.load(context.signal);
            if (result.bytes instanceof ReadableStream)
              streamed.add(value.source_id);
            const bytes = new Uint8Array(
              await new Response(result.bytes).arrayBuffer(),
            );
            files.set(value.source_id, { key: value.file.key, bytes });
          }
          const bytes = files.get(value.source_id)?.bytes;
          rows.set(value.source_id, {
            id: value.source_id,
            source_id: value.source_id,
            type,
            state: "active",
            properties: {
              ...value.properties,
              ...(bytes && { blob_ref: `sha256:${digest(bytes)}` }),
            },
          } as unknown as Item);
        }
      },
    }),
  };
  const checkpoint = {
    get: (key: string) => structuredClone(state.get(key)),
    checkpoint: (key: string, value: unknown) => {
      state.set(key, structuredClone(value));
      return Promise.resolve({ committed: true as const });
    },
  };
  return { context, checkpoint, files, canonical, rows, conditions, streamed };
}
const document: ReaderDocument = {
  id: "one",
  category: "article",
  title: "Article",
  updated_at: "2026-01-01T00:00:00Z",
  html_content: "<html>exact bytes</html>",
  raw_source_url:
    "https://readwise-assets.s3.amazonaws.com/a.pdf?secret=temporary",
};
function client(row: ReaderDocument) {
  return {
    page: () =>
      Promise.resolve({ results: [row], count: 1, nextPageCursor: null }),
    document: () => Promise.resolve(row),
  };
}

describe("independent Reader content recovery", () => {
  it.each(["header", "stream"])(
    "keeps the last good original pending with an explicit %s byte limit",
    async (boundary) => {
      const f = fixture();
      const job = {
        id: document.id,
        canonical: f.canonical,
        type: "readwise.source",
        revision: "old",
      };
      await enqueueContent(f.checkpoint, [job]);
      await drainContent(f.context, client(document), f.checkpoint, {
        fetch: () => Promise.resolve(new Response("%PDF-1.7 last good")),
        maxBytes: 512,
      });
      const original = structuredClone(
        f.files.get(`${f.canonical}:content:original`),
      );
      const changed = { ...document, updated_at: "2026-01-02T00:00:00Z" };
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(256));
                controller.enqueue(new Uint8Array(257));
                controller.close();
              },
            }),
            {
              headers: boundary === "header" ? { "content-length": "513" } : {},
            },
          ),
        ),
      );
      await enqueueContent(f.checkpoint, [{ ...job, revision: "new" }]);
      await drainContent(f.context, client(changed), f.checkpoint, {
        fetch: fetcher,
        maxBytes: 512,
        now: () => 0,
      });
      expect(f.files.get(`${f.canonical}:content:original`)).toEqual(original);
      expect(
        f.rows.get(`${f.canonical}:content:manifest`)?.properties[
          "preservation"
        ],
      ).toBe("pending");
      const manifest = JSON.parse(
        new TextDecoder().decode(
          f.files.get(`${f.canonical}:content:manifest`)?.bytes,
        ),
      ) as {
        resources: {
          id: string;
          status: string;
          reason?: string;
          maxBytes?: number;
        }[];
      };
      expect(
        manifest.resources.find((resource) => resource.id === "original"),
      ).toMatchObject({
        status: "pending",
        reason: "resource-exceeds-byte-limit",
        maxBytes: 512,
      });
      expect(
        f.conditions.get(`readwise:content:${digest(f.canonical)}`),
      ).toContain("READWISE_CONTENT_MAX_BYTES (512 bytes)");
      await drainContent(f.context, client(changed), f.checkpoint, {
        fetch: fetcher,
        maxBytes: 1024,
        now: () => 0,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await drainContent(f.context, client(changed), f.checkpoint, {
        fetch: fetcher,
        maxBytes: 1024,
        now: () => 120_000,
      });
      expect(contentQueue(f.checkpoint)).toEqual([]);
      expect(
        f.files.get(`${f.canonical}:content:original`)?.bytes.byteLength,
      ).toBe(513);
    },
  );
  it("replays staged remote content as a stream instead of a whole-body buffer", async () => {
    const f = fixture();
    await enqueueContent(f.checkpoint, [
      {
        id: document.id,
        canonical: f.canonical,
        type: "readwise.source",
        revision: "streamed",
      },
    ]);
    await drainContent(f.context, client(document), f.checkpoint, {
      fetch: () => Promise.resolve(new Response("%PDF-1.7 bytes")),
    });
    expect(f.streamed.has(`${f.canonical}:content:original`)).toBe(true);
  });
  it("resumes a productive resource budget at the same clock without a retry delay", async () => {
    const f = fixture();
    const row = {
      ...document,
      raw_source_url: null,
      html_content: Array.from(
        { length: 17 },
        (_, index) =>
          `<img src="https://readwise-assets.s3.amazonaws.com/${String(index)}.png">`,
      ).join(""),
    };
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("image bytes")),
    );
    await enqueueContent(f.checkpoint, [
      {
        id: row.id,
        canonical: f.canonical,
        type: "readwise.source",
        revision: "many-images",
      },
    ]);
    await drainContent(f.context, client(row), f.checkpoint, {
      fetch: fetcher,
      now: () => 0,
      maxJobs: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(15);
    expect(contentQueue(f.checkpoint)).toMatchObject([{ id: row.id }]);
    expect(contentQueue(f.checkpoint)[0]?.due).toBeUndefined();
    expect(contentQueue(f.checkpoint)[0]?.attempts).toBeUndefined();
    await drainContent(f.context, client(row), f.checkpoint, {
      fetch: fetcher,
      now: () => 0,
      maxJobs: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(17);
    expect(contentQueue(f.checkpoint)).toEqual([]);
    expect(
      f.rows.get(`${f.canonical}:content:manifest`)?.properties["preservation"],
    ).toBe("accounted");
  });

  it("backs off real resource failures even when other resources made progress", async () => {
    const f = fixture();
    const row = {
      ...document,
      raw_source_url: null,
      html_content: Array.from(
        { length: 17 },
        (_, index) =>
          `<img src="https://readwise-assets.s3.amazonaws.com/${String(index)}.png">`,
      ).join(""),
    };
    const fetcher = vi.fn<typeof fetch>((input) =>
      input instanceof URL && input.pathname === "/0.png"
        ? Promise.reject(new Error("network failed"))
        : Promise.resolve(new Response("image bytes")),
    );
    await enqueueContent(f.checkpoint, [
      {
        id: row.id,
        canonical: f.canonical,
        type: "readwise.source",
        revision: "many-images",
      },
    ]);
    await drainContent(f.context, client(row), f.checkpoint, {
      fetch: fetcher,
      now: () => 0,
      maxJobs: 1,
    });
    expect(contentQueue(f.checkpoint)).toMatchObject([
      { attempts: 1, due: 120_000 },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(15);
    await drainContent(f.context, client(row), f.checkpoint, {
      fetch: fetcher,
      now: () => 0,
      maxJobs: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(15);
  });
  it.each([false, true])(
    "accounts for an empty original without changing prior bytes: prior=%s",
    async (prior) => {
      const f = fixture();
      const job = {
        id: "one",
        canonical: f.canonical,
        type: "readwise.source",
        revision: "old",
      };
      if (prior) {
        await enqueueContent(f.checkpoint, [job]);
        await drainContent(f.context, client(document), f.checkpoint, {
          fetch: () => Promise.resolve(new Response("%PDF-1.7 last good")),
        });
      }
      const original = structuredClone(
        f.files.get(`${f.canonical}:content:original`),
      );
      const originalRow = structuredClone(
        f.rows.get(`${f.canonical}:content:original`),
      );
      const changed = {
        ...document,
        updated_at: "2026-01-02T00:00:00Z",
        html_content: "fresh HTML",
      };
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("")),
      );
      await enqueueContent(f.checkpoint, [{ ...job, revision: "new" }]);
      await drainContent(f.context, client(changed), f.checkpoint, {
        fetch: fetcher,
      });
      expect(contentQueue(f.checkpoint)).toEqual([]);
      expect(f.files.get(`${f.canonical}:content:original`)).toEqual(original);
      expect(f.rows.get(`${f.canonical}:content:original`)).toEqual(
        originalRow,
      );
      expect(
        new TextDecoder().decode(
          f.files.get(`${f.canonical}:content:html`)?.bytes,
        ),
      ).toBe("fresh HTML");
      expect(
        f.rows.get(`${f.canonical}:content:manifest`)?.properties[
          "preservation"
        ],
      ).toBe("accounted");
      const manifest = JSON.parse(
        new TextDecoder().decode(
          f.files.get(`${f.canonical}:content:manifest`)?.bytes,
        ),
      ) as { resources: { id: string; status: string; reason?: string }[] };
      expect(
        manifest.resources.find((resource) => resource.id === "original"),
      ).toMatchObject({
        status: "unavailable",
        reason: "provider-returned-empty-content",
      });
      await enqueueContent(f.checkpoint, [{ ...job, revision: "new" }]);
      await drainContent(
        f.context,
        {
          page: () => Promise.reject(new Error("must not refetch")),
          document: () => Promise.reject(new Error("must not refetch")),
        },
        f.checkpoint,
        { fetch: fetcher },
      );
      expect(contentQueue(f.checkpoint)).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "malformed",
    "truncated",
    "broken-stream",
    "network",
    "503",
    "404",
    "401",
    "206",
  ])(
    "keeps %s failures pending and lets healthy jobs finish",
    async (failure) => {
      const f = fixture();
      const job = {
        id: "one",
        canonical: f.canonical,
        type: "readwise.source",
        revision: "old",
      };
      await enqueueContent(f.checkpoint, [job]);
      await drainContent(f.context, client(document), f.checkpoint, {
        fetch: () => Promise.resolve(new Response("%PDF-1.7 last good")),
      });
      const original = structuredClone(
        f.files.get(`${f.canonical}:content:original`),
      );
      const canonical = "sample:reader-document:two";
      const parent = f.rows.get(f.canonical);
      if (!parent) throw new Error("fixture parent is missing");
      f.rows.set(canonical, {
        ...parent,
        id: "two",
        source_id: canonical,
      });
      await enqueueContent(f.checkpoint, [
        { ...job, revision: "new" },
        { ...job, id: "two", canonical, revision: "new" },
      ]);
      await drainContent(
        f.context,
        {
          page: (query) =>
            Promise.resolve({
              count: 1,
              nextPageCursor: null,
              results: [
                {
                  ...document,
                  id: query?.id ?? "one",
                  updated_at: "2026-01-02T00:00:00Z",
                  raw_source_url: `https://readwise-assets.s3.amazonaws.com/${query?.id ?? "one"}.pdf`,
                },
              ],
            }),
          document: () => Promise.resolve(document),
        },
        f.checkpoint,
        {
          fetch: (input) => {
            if (input instanceof URL && input.pathname === "/two.pdf")
              return Promise.resolve(new Response("%PDF-1.7 healthy"));
            if (failure === "network")
              return Promise.reject(new Error("network failed"));
            if (failure === "broken-stream")
              return Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.error(new Error("stream failed"));
                    },
                  }),
                ),
              );
            if (failure === "malformed")
              return Promise.resolve(
                new Response("", { headers: { "content-length": "invalid" } }),
              );
            if (failure === "truncated")
              return Promise.resolve(
                new Response("", { headers: { "content-length": "20" } }),
              );
            return Promise.resolve(
              new Response("", { status: Number(failure) }),
            );
          },
        },
      );
      expect(contentQueue(f.checkpoint).map((pending) => pending.id)).toEqual([
        "one",
      ]);
      expect(f.files.get(`${f.canonical}:content:original`)).toEqual(original);
      expect(
        f.rows.get(`${f.canonical}:content:manifest`)?.properties[
          "preservation"
        ],
      ).toBe("pending");
      expect(
        new TextDecoder().decode(
          f.files.get(`${canonical}:content:original`)?.bytes,
        ),
      ).toBe("%PDF-1.7 healthy");
    },
  );
  it("keeps last good bytes on failure and makes healthy HTML available", async () => {
    const f = fixture();
    const job = {
      id: "one",
      canonical: f.canonical,
      type: "readwise.source",
      revision: document.updated_at ?? "",
    };
    await enqueueContent(f.checkpoint, [job]);
    await drainContent(f.context, client(document), f.checkpoint, {
      fetch: () => Promise.resolve(new Response("%PDF-1.7 old bytes")),
    });
    const original = f.files.get(`${f.canonical}:content:original`);
    expect(original).toBeDefined();
    expect(contentQueue(f.checkpoint)).toHaveLength(0);
    await enqueueContent(f.checkpoint, [
      { ...job, revision: "2026-01-02T00:00:00Z" },
    ]);
    await drainContent(
      f.context,
      client({
        ...document,
        updated_at: "2026-01-02T00:00:00Z",
        html_content: "new exact HTML",
      }),
      f.checkpoint,
      { fetch: () => Promise.resolve(new Response(null, { status: 500 })) },
    );
    expect(f.files.get(`${f.canonical}:content:original`)).toEqual(original);
    expect(
      new TextDecoder().decode(
        f.files.get(`${f.canonical}:content:html`)?.bytes,
      ),
    ).toBe("new exact HTML");
    expect(contentQueue(f.checkpoint)).toHaveLength(1);
    expect(
      new TextDecoder().decode(
        f.files.get(`${f.canonical}:content:manifest`)?.bytes,
      ),
    ).toContain('"pending"');
  });
  it("does not refetch unchanged accounted content", async () => {
    const f = fixture();
    const job = {
      id: "one",
      canonical: f.canonical,
      type: "readwise.source",
      revision: document.updated_at ?? "",
    };
    await enqueueContent(f.checkpoint, [job]);
    await drainContent(f.context, client(document), f.checkpoint, {
      fetch: () => Promise.resolve(new Response("%PDF-1.7 bytes")),
    });
    await enqueueContent(f.checkpoint, [job]);
    await drainContent(
      f.context,
      {
        page: () => Promise.reject(new Error("must not refetch")),
        document: () => Promise.reject(new Error("must not refetch")),
      },
      f.checkpoint,
    );
    expect(contentQueue(f.checkpoint)).toHaveLength(0);
  });
  it("acknowledges a metadata fingerprint instead of only the vendor timestamp", async () => {
    const f = fixture();
    const job = {
      id: "one",
      canonical: f.canonical,
      type: "readwise.source",
      revision: "metadata-with-note-fingerprint",
    };
    await enqueueContent(f.checkpoint, [job]);
    await drainContent(
      f.context,
      client({ ...document, raw_source_url: null }),
      f.checkpoint,
    );
    await enqueueContent(f.checkpoint, [job]);
    await drainContent(
      f.context,
      {
        page: () =>
          Promise.reject(new Error("unchanged content must not be fetched")),
        document: () => Promise.resolve(undefined),
      },
      f.checkpoint,
    );
    expect(contentQueue(f.checkpoint)).toHaveLength(0);
    expect(
      f.rows.get(`${f.canonical}:content:manifest`)?.properties[
        "reader_revision"
      ],
    ).toBe(job.revision);
  });
  it("passes API throttling to the caller for a durable Retry-After", async () => {
    const f = fixture();
    await enqueueContent(f.checkpoint, [
      {
        id: "one",
        canonical: f.canonical,
        type: "readwise.source",
        revision: document.updated_at ?? "",
      },
    ]);
    const error = new RateLimited("2026-01-02T00:00:00Z");
    await expect(
      drainContent(
        f.context,
        {
          page: () => Promise.reject(error),
          document: () => Promise.resolve(undefined),
        },
        f.checkpoint,
      ),
    ).rejects.toBe(error);
    expect(contentQueue(f.checkpoint)).toHaveLength(1);
  });
});

it("retains content work when a direct answer has an inconsistent count", async () => {
  const f = fixture();
  await enqueueContent(f.checkpoint, [
    {
      id: "one",
      canonical: f.canonical,
      type: "readwise.source",
      revision: "new",
    },
  ]);
  await drainContent(
    f.context,
    {
      ...client(document),
      page: () =>
        Promise.resolve({
          count: 0,
          nextPageCursor: null,
          results: [document],
        }),
    },
    f.checkpoint,
  );
  expect(f.files.size).toBe(0);
  expect(contentQueue(f.checkpoint)).toHaveLength(1);
});

it.each([
  {
    label: "active",
    deleted: false,
    externalId: "hi",
    exportId: 42,
    accepted: true,
  },
  {
    label: "deleted",
    deleted: true,
    externalId: "hi",
    exportId: 42,
    accepted: true,
  },
  {
    label: "deleted without Reader ID",
    deleted: true,
    externalId: undefined,
    exportId: 42,
    accepted: true,
  },
  {
    label: "wrong Reader ID",
    deleted: true,
    externalId: "other",
    exportId: 42,
    accepted: false,
  },
  {
    label: "wrong export ID",
    deleted: true,
    externalId: "hi",
    exportId: 99,
    accepted: false,
  },
  {
    label: "active without Reader ID",
    deleted: false,
    externalId: undefined,
    exportId: 42,
    accepted: false,
  },
])(
  "preserves export overflow only with verified evidence: $label",
  async ({ deleted, externalId, exportId, accepted }) => {
    const f = fixture();
    const canonical = "sample:reader-highlight:hi";
    const original = f.rows.get(f.canonical);
    if (original === undefined) throw new Error("missing parent fixture");
    f.rows.set(canonical, {
      ...original,
      id: "hi",
      type: "readwise.highlight",
      source_id: canonical,
      properties: { account: "sample", reader_managed: true },
    });
    const row: ReaderDocument = {
      id: "hi",
      category: "highlight",
      parent_id: "doc",
      content: "Current Reader passage",
    };
    const text = "Retained export passage".repeat(5000);
    await enqueueContent(f.checkpoint, [
      {
        id: "hi",
        canonical,
        type: "readwise.highlight",
        revision: "export-overflow",
        exportSourceId: 7,
        exportHighlightId: 42,
      },
    ]);
    await drainContent(f.context, client(row), f.checkpoint, {
      now: () => 0,
      exportClient: {
        page: () =>
          Promise.resolve({
            count: 1,
            nextPageCursor: null,
            results: [
              {
                user_book_id: 7,
                source: "reader",
                external_id: "doc",
                highlights: [
                  {
                    id: exportId,
                    ...(externalId !== undefined && {
                      external_id: externalId,
                    }),
                    text,
                    is_deleted: deleted,
                  },
                ],
              },
            ],
          }),
        sourceForHighlight: () => Promise.resolve(undefined),
      },
    });
    if (!accepted) {
      expect(contentQueue(f.checkpoint)).toHaveLength(1);
      expect(f.files.size).toBe(0);
      return;
    }
    expect(contentQueue(f.checkpoint)).toEqual([]);
    const retained = [...f.files].find(([key]) =>
      key.includes(":text:readwise_text:"),
    );
    expect(retained).toBeDefined();
    expect(Buffer.from(retained?.[1].bytes ?? []).toString()).toBe(text);
    expect(f.rows.get(canonical)?.properties["text"]).toBe(
      "Current Reader passage",
    );
  },
);
