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
  const conditions: string[] = [];
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
      condition(key) {
        conditions.push(key);
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
  return { context, checkpoint, files, canonical, rows, conditions };
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
