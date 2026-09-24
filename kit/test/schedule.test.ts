import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { Harness, testConnector, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One" } };
const minute = 60_000;

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function every(held: Vendor, interval: string): Promise<number> {
  return start(testConnector(held), harness.runtime(["--every", interval]));
}

function gate(held: Vendor): () => void {
  let open!: () => void;
  held.gate = new Promise((resolve) => {
    open = resolve;
  });
  return () => {
    held.gate = undefined;
    open();
  };
}

describe("--every", () => {
  it("runs one run at a time, the interval between them", async () => {
    const held = vendor([one]);
    let active = 0;
    let most = 0;
    const connector = testConnector(held);
    const run = connector.run.bind(connector);
    const exit = start(
      {
        ...connector,
        run: async (context) => {
          active += 1;
          most = Math.max(most, active);
          await run(context);
          active -= 1;
        },
      },
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(1);
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(2);
    harness.stop();
    expect(await exit).toBe(0);
    expect(most).toBe(1);
    expect(harness.server.runs.map((reported) => reported.outcome)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  it("heartbeats on its own minute, through a long run too", async () => {
    const held = vendor([one]);
    const release = gate(held);
    const exit = every(held, "15m");
    await until(() => held.runs === 1 && harness.server.heartbeats === 1);
    await harness.clock.wake(minute);
    await until(() => harness.server.heartbeats === 2);
    await harness.clock.wake(minute);
    await until(() => harness.server.heartbeats === 3);
    expect(harness.server.runs).toEqual([]);

    release();
    await harness.clock.sleeping(15 * minute);
    expect(harness.server.runs).toHaveLength(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("backs off after a failed run, doubling to eight intervals, and comes back on success", async () => {
    const held = vendor([one]);
    held.fail = new Error("the vendor answered 502");
    const exit = every(held, "10m");
    for (const factor of [2, 4, 8, 8]) {
      await harness.clock.wake(factor * 10 * minute);
    }
    held.fail = undefined;
    await harness.clock.sleeping(10 * minute);
    harness.stop();
    expect(await exit).toBe(0);
    expect(harness.server.runs.map((reported) => reported.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "succeeded",
    ]);
  });

  it("retries a server it cannot reach at start, the same way", async () => {
    harness.server.refuseNext("POST /connectors", 503, "unavailable");
    harness.server.refuseNext("POST /connectors", 503, "unavailable");
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.wake(20 * minute);
    await harness.clock.wake(40 * minute);
    await harness.clock.sleeping(10 * minute);
    expect(harness.server.requestsTo("POST", "/connectors")).toHaveLength(3);
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("stops on SIGTERM between runs, starting no other", async () => {
    const held = vendor([one]);
    const exit = every(held, "15m");
    await harness.clock.sleeping(15 * minute);
    harness.stop();
    expect(await exit).toBe(0);
    expect(held.runs).toBe(1);
  });

  it("stops a run in flight after its current write, reporting it stopped and keeping no state", async () => {
    const earlier = vendor([one]);
    earlier.token = "t-old";
    await harness.once(earlier);

    const held = vendor([{ source_id: "a:1", properties: { title: "One, changed" } }]);
    held.token = "t-new";
    const release = gate(held);
    const exit = every(held, "15m");
    await until(() => held.runs === 1);
    harness.stop();
    release();
    expect(await exit).toBe(0);

    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("stopped");
    expect(harness.server.row("a:1").properties).toEqual({ title: "One" });
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t-old" } });
  });
});

describe("--once", () => {
  it("heartbeats through a long run and stops beating when it ends", async () => {
    const held = vendor([one]);
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 1 && harness.server.heartbeats === 1);
    await harness.clock.wake(minute);
    await until(() => harness.server.heartbeats === 2);
    release();
    expect(await exit).toBe(0);
    const beats = harness.server.heartbeats;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.server.heartbeats).toBe(beats);
  });
});
