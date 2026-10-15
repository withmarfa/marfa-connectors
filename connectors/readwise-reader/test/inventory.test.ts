import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ReaderClient,
  type ReaderDocument,
  type ReaderPage,
} from "@withmarfa/readwise";
import { completeInventory } from "../src/outbound.js";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(count: number) {
  const starts: number[] = [];
  const cursors: (string | null)[] = [];
  const attempts: (string | null)[] = [];
  let retryAfter = "60";
  const token = `inventory-${String(count)}-${String(Math.random())}`;
  const rows: ReaderDocument[] = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    category: "article",
  }));
  vi.stubGlobal("fetch", (input: URL) => {
    const now = Date.now();
    if (!input.searchParams.has("id"))
      attempts.push(input.searchParams.get("pageCursor"));
    if (starts.filter((start) => start > now - 60_000).length >= 20)
      return Promise.resolve(
        new Response("", {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      );
    starts.push(now);
    const id = input.searchParams.get("id");
    const cursor = input.searchParams.get("pageCursor");
    if (id === null) cursors.push(cursor);
    const offset = Number(cursor ?? 0);
    const results =
      id === null
        ? rows.slice(offset, offset + 100)
        : rows.filter((row) => row.id === id);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          count: id === null ? count - offset : results.length,
          nextPageCursor:
            id === null && offset + 100 < count ? String(offset + 100) : null,
          results,
        }),
      ),
    );
  });
  return {
    starts,
    cursors,
    attempts,
    consumeElsewhere: (requests: number, guidance = "60") => {
      starts.push(...Array<number>(requests).fill(Date.now()));
      retryAfter = guidance;
    },
    reader: (signal = new AbortController().signal) =>
      new ReaderClient("https://example.com/api/v3/", token, signal),
  };
}

it.each([2100, 8246])(
  "completes a fresh %i-row inventory after inbound requests used the token budget",
  async (count) => {
    const f = fixture(count);
    const inbound = f.reader();
    for (let index = 0; index < 20; index++) await inbound.document("0");
    const outbound = f.reader();
    const work = completeInventory(outbound);
    const [result] = await Promise.all([work, vi.runAllTimersAsync()]);
    expect(result).toHaveLength(count);
    const direct = outbound.document("0");
    await vi.runAllTimersAsync();
    await expect(direct).resolves.toMatchObject({ id: "0" });
    expect(f.cursors).toHaveLength(Math.ceil(count / 100));
    expect(f.cursors[0]).toBe(null);
    const first = f.starts[0];
    const last = f.starts.at(-1);
    if (first === undefined || last === undefined)
      throw new Error("no requests");
    expect(last - first).toBeGreaterThanOrEqual(120_000);
    for (const start of f.starts)
      expect(
        f.starts.filter((other) => other >= start && other < start + 60_000)
          .length,
      ).toBeLessThanOrEqual(20);
  },
);

it("cancels a budget wait without fetching or retaining a partial proof, then restarts fresh", async () => {
  const f = fixture(2100);
  const stop = new AbortController();
  const interrupted = completeInventory(f.reader(stop.signal));
  const failed = expect(interrupted).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.cursors).toHaveLength(20);
  stop.abort();
  await failed;
  expect(f.cursors).toHaveLength(20);
  const restarted = completeInventory(f.reader());
  const [result] = await Promise.all([restarted, vi.runAllTimersAsync()]);
  expect(result).toHaveLength(2100);
  expect(f.cursors[20]).toBe(null);
  expect(f.cursors).toHaveLength(41);
});

it("waits through an external token consumer's 429 and retries the same inventory cursor", async () => {
  const f = fixture(2100);
  f.consumeElsewhere(10);
  const context = {
    waitUntil: vi.fn(async (until: string) => {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Date.parse(until) - Date.now()),
      );
    }),
  };
  const work = completeInventory(f.reader(), context);
  const [result] = await Promise.all([work, vi.runAllTimersAsync()]);
  expect(result).toHaveLength(2100);
  expect(new Set(result.map((row) => row.id)).size).toBe(2100);
  expect(context.waitUntil).toHaveBeenCalledExactlyOnceWith(
    "2026-10-15T00:01:00.000Z",
  );
  expect(f.attempts.slice(9, 12)).toEqual(["900", "1000", "1000"]);
  expect(f.attempts.filter((cursor) => cursor === null)).toHaveLength(1);
});

it("fails without resuming when throttling has invalid Retry-After guidance", async () => {
  const f = fixture(2100);
  f.consumeElsewhere(20, "invalid");
  const context = { waitUntil: vi.fn(() => Promise.resolve()) };
  await expect(completeInventory(f.reader(), context)).rejects.toThrow(
    "Retry-After",
  );
  expect(context.waitUntil).not.toHaveBeenCalled();
  expect(f.cursors).toHaveLength(0);
});

it.each([
  {
    name: "remaining count changes",
    pages: [
      {
        count: 2,
        results: [{ id: "a", category: "article" }],
        nextPageCursor: "next",
      },
      {
        count: 2,
        results: [{ id: "b", category: "article" }],
        nextPageCursor: null,
      },
    ],
  },
  {
    name: "an identity repeats",
    pages: [
      {
        count: 2,
        results: [{ id: "a", category: "article" }],
        nextPageCursor: "next",
      },
      {
        count: 1,
        results: [{ id: "a", category: "article" }],
        nextPageCursor: null,
      },
    ],
  },
  {
    name: "the final page omits a row",
    pages: [
      {
        count: 2,
        results: [{ id: "a", category: "article" }],
        nextPageCursor: "next",
      },
      { count: 1, results: [], nextPageCursor: null },
    ],
  },
])("rejects the complete proof when $name", async ({ pages }) => {
  let offset = 0;
  const reader = {
    page: () => Promise.resolve(pages[offset++] as ReaderPage),
    document: () => Promise.resolve(undefined),
  };
  await expect(completeInventory(reader)).rejects.toThrow();
});
