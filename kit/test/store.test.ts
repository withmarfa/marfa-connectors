import { describe, expect, it } from "vitest";
import type { Agreement } from "../src/agreement.js";
import type { Marfa } from "../src/marfa.js";
import { Store, withRefusal } from "../src/store.js";

describe("the store", () => {
  it("retains an oversized prerequisite without clearing it or sending a batch", async () => {
    const written: { set: { item_id: string }[]; clear: string[] }[] = [];
    const marfa = {
      writeAgreements: (
        _id: string,
        _process: string,
        set: { item_id: string }[],
        clear: string[],
      ) => {
        written.push({ set, clear });
        return Promise.resolve();
      },
    } as unknown as Marfa;
    const store = new Store(marfa, "connector-1", "process-1");
    const small: Agreement = { vendor: {}, marfa: {}, state: "active" };
    const large: Agreement = {
      ...small,
      connections: {
        "test.blocks": Array.from(
          { length: 600 },
          (_, n) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`,
        ),
      },
    };
    store.set("small", small);
    store.set("large", large);
    await expect(store.flush()).rejects.toThrow("oversized");
    expect(written).toEqual([]);
    expect(store.get("large")).toEqual(large);
    expect([...store.oversized]).toEqual(["large"]);
  });
});

describe("a refusal kept with a row", () => {
  const sized = (bytes: number): Agreement => {
    const bare: Agreement = { vendor: {}, marfa: {}, state: "active" };
    const pad = bytes - Buffer.byteLength(JSON.stringify(bare)) - 20;
    return { ...bare, link: "x".repeat(pad) };
  };
  const size = (agreement: Agreement | undefined): number =>
    Buffer.byteLength(JSON.stringify(agreement));

  it("keeps its reason, cut to 200 bytes, where it fits", () => {
    const kept = withRefusal(sized(1000), "mark", "é".repeat(400));
    expect(kept?.refused?.change).toBe("mark");
    expect(Buffer.byteLength(kept?.refused?.reason ?? "")).toBe(200);
  });

  it("drops the reason first, then answers nothing where not even the mark fits", () => {
    const near = sized(16 * 1024 - 60);
    const bare = withRefusal(near, "mark", "r".repeat(150));
    expect(bare?.refused).toEqual({ change: "mark" });
    expect(size(bare)).toBeLessThanOrEqual(16 * 1024);
    expect(withRefusal(sized(16 * 1024 - 10), "mark", "why")).toBeUndefined();
  });
});

describe("agreement acknowledgments", () => {
  const agreement: Agreement = { vendor: {}, marfa: {}, state: "active" };
  function fixture(results: unknown[]) {
    const calls: { set: { item_id: string }[]; clear: string[] }[] = [];
    const store = new Store(
      {
        writeAgreements: (
          _id: string,
          _process: string,
          set: { item_id: string }[],
          clear: string[],
        ) => {
          calls.push({ set, clear });
          const result = results.shift();
          return result instanceof Error
            ? Promise.reject(result)
            : Promise.resolve(result);
        },
      } as unknown as Marfa,
      "connector",
      "process",
    );
    return { store, calls };
  }
  it("acknowledges a readable idempotent clear with no agreement", async () => {
    const { store, calls } = fixture([{ written: 0, cleared: 0, skipped: [] }]);
    store.clear("absent");
    await store.flush();
    await store.flush();
    expect(calls).toHaveLength(1);
  });
  it("removes only acknowledged entries from a mixed skipped response", async () => {
    const { store, calls } = fixture([
      { written: 1, cleared: 0, skipped: ["skip"] },
      { written: 1, cleared: 0, skipped: [] },
    ]);
    store.set("ok", agreement);
    store.set("skip", agreement);
    store.clear("absent");
    await expect(store.flush()).rejects.toThrow("agreement-skipped");
    await store.flush();
    expect(calls[1]).toEqual({
      set: [expect.objectContaining({ item_id: "skip" })],
      clear: [],
    });
  });
  it.each([
    undefined,
    {},
    { written: 1, cleared: 0, skipped: ["outside"] },
    { written: 1, cleared: 0, skipped: ["one", "one"] },
    { written: 1, cleared: 0, skipped: ["one"] },
    { written: 1, cleared: 1, skipped: [] },
    { written: 1, cleared: -1, skipped: [] },
    { written: 1.5, cleared: 0, skipped: [] },
  ])("retains pending intent after a malformed response %j", async (result) => {
    const { store, calls } = fixture([
      result,
      { written: 1, cleared: 0, skipped: [] },
    ]);
    store.set("one", agreement);
    await expect(store.flush()).rejects.toThrow(
      "invalid agreement acknowledgment",
    );
    await store.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.set.map((x) => x.item_id)).toEqual(["one"]);
  });
  it("retains only the unacknowledged batch after a later batch fails", async () => {
    const { store, calls } = fixture([
      { written: 500, cleared: 0, skipped: [] },
      new Error("cut"),
      { written: 1, cleared: 0, skipped: [] },
    ]);
    for (let i = 0; i < 501; i++) store.set(String(i), agreement);
    await expect(store.flush()).rejects.toThrow("cut");
    await store.flush();
    expect(calls.map((x) => x.set.length)).toEqual([500, 1, 1]);
  });
  it("does not acknowledge a replacement made while the request was pending", async () => {
    let answer!: (result: unknown) => void;
    let calls = 0;
    const store = new Store(
      {
        writeAgreements: () => {
          calls++;
          return calls === 1
            ? new Promise((resolve) => {
                answer = resolve;
              })
            : Promise.resolve({ written: 1, cleared: 0, skipped: [] });
        },
      } as unknown as Marfa,
      "connector",
      "process",
    );
    store.set("one", agreement);
    const flushing = store.flush();
    store.set("one", { ...agreement, vendor: { title: "replacement" } });
    answer({ written: 1, cleared: 0, skipped: [] });
    await flushing;
    await store.flush();
    expect(calls).toBe(2);
  });
});

it("accepts exactly 16 KiB, retaining one byte over without a clear", async () => {
  const agreement: Agreement = {
    vendor: {},
    marfa: {},
    state: "active",
    link: "",
  };
  const padding = 16 * 1024 - Buffer.byteLength(JSON.stringify(agreement));
  const calls: string[][] = [];
  const store = new Store(
    {
      writeAgreements: (
        _id: string,
        _process: string,
        set: { item_id: string }[],
      ) => {
        calls.push(set.map((entry) => entry.item_id));
        return Promise.resolve({
          written: set.length,
          cleared: 0,
          skipped: [],
        });
      },
    } as unknown as Marfa,
    "connector",
    "process",
  );
  store.set("boundary", { ...agreement, link: "x".repeat(padding) });
  await store.flush();
  store.set("over", { ...agreement, link: "x".repeat(padding + 1) });
  await expect(store.flush()).rejects.toThrow("agreement-oversized");
  expect(calls).toEqual([["boundary"]]);
});
