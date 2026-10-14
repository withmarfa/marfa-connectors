import type { Entry, PendingInbound } from "@withmarfa/connector";
import { describe, expect, it } from "vitest";
import {
  InvalidCursor,
  RateLimited,
  type ExportClient,
  type Query,
} from "../src/client.js";
import type { ExportPage } from "../src/export.js";
import { sync, type ReadContext, type ReadScope } from "../src/sync.js";

const start = Date.parse("2026-10-14T00:00:00Z");
const page = (id = 1, cursor: string | null = null): ExportPage => ({
  count: 1,
  nextPageCursor: cursor,
  results: [
    {
      user_book_id: id,
      title: "Source",
      highlights: [{ id, text: "Passage", updated_at: "2026-10-13T00:00:00Z" }],
    },
  ],
});
function fixture() {
  let kept: unknown;
  let now = start;
  let refused = false;
  let failSave = false;
  let uncertainSave = false;
  const written: { type: string; entries: readonly Entry[] }[] = [];
  const archived: { type: string; keys: readonly string[] }[] = [];
  const checkpoints: unknown[] = [];
  const conditions = new Map<string, string>();
  const requests: Query[] = [];
  let pending: { record: PendingInbound; due: boolean }[] = [];
  let answer: (query: Query) => Promise<ExportPage> = () =>
    Promise.resolve(page());
  const scope: ReadScope = {
    state: {
      get: () => structuredClone(kept),
      checkpoint: (_, value) => {
        if (refused)
          return Promise.resolve({
            committed: false,
            reason: "connection-unresolved",
          });
        if (failSave) return Promise.reject(new Error("checkpoint failed"));
        kept = structuredClone(value);
        checkpoints.push(kept);
        if (uncertainSave) {
          uncertainSave = false;
          return Promise.reject(new Error("ACK lost"));
        }
        return Promise.resolve({ committed: true });
      },
    },
    upsert: (type, entries) => {
      written.push({ type, entries });
      return Promise.resolve();
    },
    archive: (type, keys) => {
      archived.push({ type, keys });
      return Promise.resolve();
    },
    refusals: { pending: () => pending },
  };
  const client: ExportClient = {
    page: (query) => {
      requests.push(query);
      return answer(query);
    },
    sourceForHighlight: () => Promise.resolve(1),
  };
  const context: ReadContext = {
    env: {
      READWISE_ACCOUNT: "primary",
      READWISE_ACCESS_TOKEN: "token",
      READWISE_API_URL: undefined,
    },
    signal: new AbortController().signal,
    hints: undefined,
    forScope: () => scope,
    written: () => ["text", "title"],
    log: {
      info: () => undefined,
      warn: () => undefined,
      condition: (key, value) => conditions.set(key, value),
      unreached: () => undefined,
    },
  };
  return {
    context,
    client,
    scope,
    written,
    archived,
    requests,
    checkpoints,
    conditions,
    run: (maxPages = 50) => sync(context, { client, now: () => now, maxPages }),
    setNow: (value: number) => {
      now = value;
    },
    setAnswer: (value: typeof answer) => {
      answer = value;
    },
    setRefused: (value: boolean) => {
      refused = value;
    },
    setFailSave: (value: boolean) => {
      failSave = value;
    },
    setUncertain: () => {
      uncertainSave = true;
    },
    setPending: (value: typeof pending) => {
      pending = value;
    },
    kept: () =>
      kept as {
        completed?: string;
        fullAt?: string;
        retryUntil?: string;
        walk?: {
          lower: string | null;
          start: string;
          cursor: string | null;
          full: boolean;
        };
      },
  };
}

describe("Readwise export checkpoints", () => {
  it("resumes a multi-page walk from its original start and commits only after rows", async () => {
    const f = fixture();
    f.setAnswer((query) =>
      Promise.resolve(page(query.cursor ? 2 : 1, query.cursor ? null : "next")),
    );
    await f.run(1);
    expect(f.kept().completed).toBeUndefined();
    expect(f.kept().walk).toMatchObject({
      lower: null,
      start: new Date(start).toISOString(),
      cursor: "next",
    });
    expect(f.written.flatMap(({ entries }) => entries)).toHaveLength(2);
    f.setNow(start + 60_000);
    await f.run();
    expect(f.requests[1]).toEqual({ cursor: "next" });
    expect(f.kept().completed).toBe(new Date(start).toISOString());
    expect(f.kept().walk).toBeUndefined();
    await f.run();
    expect(f.requests[2]?.updatedAfter).toBe(
      new Date(start - 300_000).toISOString(),
    );
  });
  it("retains the current page after refused relationships or lost writes", async () => {
    const f = fixture();
    f.setAnswer(() => {
      f.setRefused(true);
      return Promise.resolve(page(1, "next"));
    });
    await expect(f.run()).rejects.toThrow("connection-unresolved");
    expect(f.kept().walk?.cursor).toBeNull();
    f.setRefused(false);
    f.setAnswer(() => Promise.resolve(page()));
    await f.run();
    expect(f.kept().completed).toBeDefined();
  });
  it("handles an uncertain checkpoint by using the next acknowledged state", async () => {
    const f = fixture();
    f.setAnswer(() => {
      f.setUncertain();
      return Promise.resolve(page(1, "next"));
    });
    await expect(f.run()).rejects.toThrow("ACK lost");
    expect(f.kept().walk?.cursor).toBe("next");
    f.setAnswer(() => Promise.resolve(page(2)));
    await f.run();
    expect(f.requests[1]?.cursor).toBe("next");
  });
  it("keeps a page replayable when a checkpoint definitely fails", async () => {
    const f = fixture();
    f.setAnswer(() => {
      f.setFailSave(true);
      return Promise.resolve(page(1, "next"));
    });
    await expect(f.run()).rejects.toThrow("checkpoint failed");
    expect(f.kept().walk?.cursor).toBeNull();
  });
  it("honors persisted throttling across runs and keeps the walk intact", async () => {
    const f = fixture();
    const until = new Date(start + 120_000).toISOString();
    f.setAnswer(() => Promise.reject(new RateLimited(until)));
    await f.run();
    expect(f.kept().retryUntil).toBe(until);
    await f.run();
    expect(f.requests).toHaveLength(1);
    f.setNow(start + 120_000);
    f.setAnswer(() => Promise.resolve(page()));
    await f.run();
    expect(f.requests).toHaveLength(2);
    expect(f.kept().retryUntil).toBeUndefined();
  });
  it("does not advance on authentication or malformed-page errors", async () => {
    const f = fixture();
    f.setAnswer(() => Promise.reject(new Error("HTTP 401")));
    await expect(f.run()).rejects.toThrow("401");
    expect(f.kept().completed).toBeUndefined();
  });
  it("detects cursor cycles across interrupted runs", async () => {
    const f = fixture();
    f.setAnswer(() => Promise.resolve(page(1, "same")));
    await f.run(1);
    await expect(f.run()).rejects.toThrow("repeated");
    expect(f.kept().walk?.cursor).toBe("same");
  });
  it("restarts a rejected cursor from its saved window without moving the watermark", async () => {
    const f = fixture();
    await f.run();
    f.setNow(start + 60_000);
    f.setAnswer(() => Promise.resolve(page(1, "expired")));
    await f.run(1);
    const lower = f.kept().walk?.lower;
    f.setAnswer((query) =>
      query.cursor
        ? Promise.reject(new InvalidCursor())
        : Promise.resolve(page()),
    );
    await f.run();
    expect(f.requests.at(-1)).toEqual({ updatedAfter: lower });
    expect(f.kept().completed).toBe(new Date(start + 60_000).toISOString());
  });
  it("performs daily and effective-field rescans without fabricating source update times", async () => {
    const f = fixture();
    await f.run();
    f.setNow(start + 86_400_000);
    await f.run();
    expect(f.requests.at(-1)).toEqual({});
    f.context.written = () => ["text", "title", "new_field"];
    await f.run();
    expect(f.requests.at(-1)).toEqual({});
  });
  it("archives only explicit tombstones, not a source's unmarked highlights", async () => {
    const f = fixture();
    f.setAnswer(() =>
      Promise.resolve({
        count: 2,
        nextPageCursor: null,
        results: [
          {
            user_book_id: 1,
            is_deleted: true,
            highlights: [
              { id: 1, text: "Kept" },
              { id: 2, is_deleted: true },
            ],
          },
        ],
      }),
    );
    await f.run();
    expect(f.archived).toEqual([
      { type: "readwise.source", keys: ["primary:source:1"] },
      { type: "readwise.highlight", keys: ["primary:highlight:2"] },
    ]);
    expect(
      f.written
        .flatMap(({ entries }) => entries)
        .some((entry) => entry.source_id === "primary:highlight:1"),
    ).toBe(true);
  });
  it("refetches due rejected highlights through their full source and never a narrowed incremental export", async () => {
    const f = fixture();
    await f.run();
    f.setPending([
      {
        due: true,
        record: {
          identity: {
            type: "readwise.highlight",
            sourceId: "primary:highlight:1",
          },
          scope: "export",
          mode: "refetch",
          operation: "upsert",
          fingerprint: "a".repeat(64),
          context: "a".repeat(64),
          code: "invalid_properties",
          reason: "bad",
          attemptedAt: new Date(start).toISOString(),
          dueAt: new Date(start).toISOString(),
        },
      },
    ]);
    await f.run();
    expect(f.requests[1]).toEqual({ sourceId: 1 });
  });
  it("leaves missing retry records pending and does not treat 404 as deletion", async () => {
    const f = fixture();
    await f.run();
    f.setPending([
      {
        due: true,
        record: {
          identity: {
            type: "readwise.highlight",
            sourceId: "primary:highlight:1",
          },
          scope: "export",
          mode: "refetch",
          operation: "upsert",
          fingerprint: "a".repeat(64),
          context: "a".repeat(64),
          code: "invalid_properties",
          reason: "bad",
          attemptedAt: new Date(start).toISOString(),
          dueAt: new Date(start).toISOString(),
        },
      },
    ]);
    f.client.sourceForHighlight = () => Promise.resolve(undefined);
    await f.run();
    expect(f.archived).toEqual([]);
    expect(f.conditions.has("readwise:retry-missing:primary:highlight:1")).toBe(
      true,
    );
  });
  it("does not call the vendor or alter checkpoints during watch-only runs", async () => {
    const f = fixture();
    f.context.hints = new Map();
    await f.run();
    expect(f.requests).toEqual([]);
    expect(f.checkpoints).toEqual([]);
  });
  it("refuses an account or endpoint change against saved progress", async () => {
    const f = fixture();
    await f.run();
    f.context.env = { ...f.context.env, READWISE_ACCOUNT: "different" };
    await expect(f.run()).rejects.toThrow("account or endpoint");
  });
});
