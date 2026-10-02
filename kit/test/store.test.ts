import { describe, expect, it } from "vitest";
import type { Agreement } from "../src/agreement.js";
import type { Marfa } from "../src/marfa.js";
import { Store, withRefusal } from "../src/store.js";

describe("the store", () => {
  it("drops an agreement past the instance's cap rather than have every flush refused", async () => {
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
    await store.flush();
    expect(written).toEqual([
      {
        set: [expect.objectContaining({ item_id: "small" })],
        clear: ["large"],
      },
    ]);
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
