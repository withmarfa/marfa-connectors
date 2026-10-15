import { expect, it } from "vitest";
import { defineConnector } from "../src/define.js";
import { start } from "../src/main.js";
import { Unreachable } from "../src/rows.js";
import { Harness, linkedType } from "./harness.js";

it("keeps an inbound vendor retry deadline across processes", async () => {
  const harness = await Harness.create();
  try {
    let calls = 0;
    const retryAt = new Date(
      harness.clock.now().getTime() + 60_000,
    ).toISOString();
    const connector = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [{ type: linkedType, fields: ["title", "note", "vendor_id"] }],
      run() {
        calls++;
        if (calls === 1) throw new Unreachable("reader throttled", { retryAt });
        return Promise.resolve();
      },
    });

    expect(await start(connector, harness.runtime(["--once"]))).toBe(1);
    expect(harness.kept()["outboundRetryAt"]).toBe(retryAt);
    expect(await start(connector, harness.runtime(["--once"]))).toBe(1);
    expect(calls).toBe(1);

    harness.clock.advance(60_000);
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(calls).toBe(2);
    expect(harness.kept()["outboundRetryAt"]).toBeUndefined();
  } finally {
    await harness.close();
  }
});
