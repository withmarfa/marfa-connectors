import { describe, expect, it } from "vitest";
import type { Agreement } from "../src/agreement.js";
import type { Marfa } from "../src/marfa.js";
import { Store } from "../src/store.js";

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
