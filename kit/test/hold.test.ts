import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start, untilLapsed } from "../src/main.js";
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

/** Another process under the same key, holding the registration for an hour. */
function heldElsewhere(): void {
  harness.server.holder = {
    process: "another-process",
    until: Date.parse("2026-09-26T00:00:00.000Z"),
  };
}

describe("the hold", () => {
  it("is taken before a run and let go once the process ends", async () => {
    expect(await harness.once(vendor([one]))).toBe(0);
    const [taken, released] = harness.server.holds;
    expect(taken?.released).toBe(false);
    expect(released).toEqual({ process: taken?.process, released: true });
    expect(harness.server.holder).toBeUndefined();
    // The process names itself the same way to every door that asks.
    expect(
      harness.server.requestsTo("POST", "/connectors/connector-1/agreements")[0]
        ?.body,
    ).toMatchObject({ process: taken?.process });
  });

  it("keeps a second process under the key from running, and it writes nothing", async () => {
    heldElsewhere();
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.runs).toEqual([]);
    expect(harness.lines.join("\n")).toContain(
      "another process holds this connector until 2026-09-26T00:00:00.000Z, so this one does not run",
    );
    // The witness: with the hold let go, the same process runs.
    harness.server.holder = undefined;
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("waits under --every while another process holds it, and runs once it is let go", async () => {
    heldElsewhere();
    const held = vendor([one]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(0);
    harness.server.holder = undefined;
    await harness.clock.wake(15 * minute);
    // The run's report, not its start: a stop before the write aborts it.
    await until(() => harness.server.runs.length === 1);
    harness.stop();
    expect(await exit).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("tries again under --every once another process's hold lapses, not a whole interval later", async () => {
    harness.server.holder = {
      process: "another-process",
      until: harness.clock.now().getTime() + 3 * minute,
    };
    const held = vendor([one]);
    const exit = start(testConnector(held), harness.runtime(["--every", "1h"]));
    // A second past the lapse, rather than the hour.
    await harness.clock.sleeping(3 * minute + 1000);
    expect(held.runs).toBe(0);
    harness.server.holder = undefined;
    await harness.clock.wake(3 * minute + 1000);
    await until(() => harness.server.runs.length === 1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("stops a run once another process takes the hold, before it writes", async () => {
    const held = vendor([one]);
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 1);
    heldElsewhere();
    // The heartbeat renews the hold and finds it taken.
    await harness.clock.wake(minute);
    await until(() =>
      harness.lines.some((line) =>
        line.includes("another process holds this connector until"),
      ),
    );
    release();
    expect(await exit).toBe(1);
    expect(harness.server.rows).toEqual([]);
    expect(harness.lastRun().error).toContain("stopped");
  });

  it("keeps nothing where the instance refuses its writes to another process's hold", async () => {
    const held = vendor([one]);
    await harness.once(held);
    const cursor = harness.kept()["cursor"];
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 2);
    // Taken between renewals: only the instance's own fence stops it.
    heldElsewhere();
    release();
    expect(await exit).toBe(1);
    expect(harness.lastRun().error).toContain("connector_held");
    expect(harness.kept()["cursor"]).toBe(cursor);
  });

  it("keeps nothing where another process took the hold and let it go between renewals", async () => {
    const held = vendor([one]);
    await harness.once(held);
    const cursor = harness.kept()["cursor"];
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 2);
    harness.server.holder = undefined;
    release();
    expect(await exit).toBe(1);
    expect(harness.lastRun().error).toContain("connector_held");
    expect(harness.kept()["cursor"]).toBe(cursor);
  });

  it("goes on after one renewal fails", async () => {
    const held = vendor([one]);
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 1);
    harness.server.refuseNext("POST /connectors/connector-1/hold", 503, "down");
    await harness.clock.wake(minute);
    await until(() =>
      harness.lines.some((line) => line.includes("could not be renewed")),
    );
    release();
    expect(await exit).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("stops a run once its hold has gone unrenewed past two minutes, and keeps nothing it read", async () => {
    const held = vendor([one]);
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 1);
    const saves = harness.server.requestsTo(
      "PUT",
      "/connectors/connector-1/state",
    ).length;
    for (let beat = 1; beat <= 3; beat += 1) {
      harness.server.refuseNext(
        "POST /connectors/connector-1/hold",
        503,
        "down",
      );
      await harness.clock.wake(minute);
      await until(
        () =>
          harness.lines.filter((line) => line.includes("could not be renewed"))
            .length === beat,
      );
      // Two minutes after the last renewal, and not before.
      expect(
        harness.lines.some((line) => line.includes("went unrenewed too long")),
      ).toBe(beat === 3);
    }
    release();
    expect(await exit).toBe(1);
    expect(harness.server.rows).toEqual([]);
    expect(
      harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
    ).toHaveLength(saves);
  });

  it("stops a run whose hold lapsed and was taken again, since another process may have written", async () => {
    const held = vendor([one]);
    const release = gate(held);
    const exit = harness.once(held);
    await until(() => held.runs === 1);
    const saves = harness.server.requestsTo(
      "PUT",
      "/connectors/connector-1/state",
    ).length;
    // The hold lapsed with nobody else taking it: the renewal takes it anew.
    harness.server.holder = undefined;
    await harness.clock.wake(minute);
    await until(() =>
      harness.lines.some((line) =>
        line.includes("the hold lapsed before it was renewed"),
      ),
    );
    release();
    expect(await exit).toBe(1);
    expect(harness.server.rows).toEqual([]);
    expect(
      harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
    ).toHaveLength(saves);
  });
});

describe("the hold's window", () => {
  const linked = {
    source_id: "a:1",
    properties: { title: "One", vendor_id: "v1" },
  };

  it("is the instance's own, so a process past a shorter one carries nothing", async () => {
    harness.server.holdMs = 30_000;
    const held = vendor([linked]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { note: "made in Marfa" });
    const release = gate(held);
    held.changes.length = 0;
    const exit = harness.twoWay(held);
    await until(() => held.runs === 3);
    // Past the instance's thirty seconds, inside the two minutes it
    // would be trusted for by default; another process takes it.
    harness.clock.advance(90_000);
    harness.server.advance(90_000);
    heldElsewhere();
    release();
    await exit;
    expect(held.changes).toEqual([]);
    expect(harness.lines.join("\n")).toContain("went unrenewed too long");
  });

  it("fences every write, so a run whose hold went unrenewed writes no row", async () => {
    const held = vendor([linked]);
    await harness.twoWay(held);
    const version = harness.server.row("a:1").version;
    const release = gate(held);
    held.entries = [
      {
        ...linked,
        properties: { ...linked.properties, note: "from the vendor" },
      },
    ];
    const exit = harness.twoWay(held);
    await until(() => held.runs === 2);
    // Five minutes with no renewal, as a laptop asleep.
    harness.clock.advance(300_000);
    harness.server.advance(300_000);
    heldElsewhere();
    release();
    expect(await exit).toBe(1);
    expect(harness.server.row("a:1").version).toBe(version);
  });

  it("is renewed within it", async () => {
    harness.server.holdMs = 45_000;
    const held = vendor([linked]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    // A third of forty-five seconds.
    await harness.clock.sleeping(15_000);
    const renewals = harness.server.holds.length;
    await harness.clock.wake(15_000);
    await until(() => harness.server.holds.length > renewals);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("is taken anew by the next run under --every, after a run was fenced", async () => {
    const held = vendor([linked]);
    const release = gate(held);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await until(() => held.runs === 1);
    harness.server.holder = undefined;
    await harness.clock.wake(minute);
    await until(() =>
      harness.lines.some((line) =>
        line.includes("lapsed before it was renewed"),
      ),
    );
    release();
    await until(() => harness.server.runs.length === 1);
    expect(harness.lastRun().outcome).toBe("failed");
    // A failed run's next waits two intervals, looking between.
    harness.clock.advance(30 * minute);
    await harness.clock.wake(10_000);
    await until(() => harness.server.runs.length === 2);
    expect(harness.lastRun().outcome).toBe("succeeded");
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("the wait for another process's hold", () => {
  const hour = 60 * minute;
  const now = Date.parse("2026-09-26T00:00:00.000Z");
  it("ends a second after the hold would lapse, within the interval", () => {
    expect(untilLapsed("2026-09-26T00:03:00.000Z", now, hour)).toBe(
      3 * minute + 1000,
    );
    expect(untilLapsed("2026-09-26T03:00:00.000Z", now, hour)).toBe(hour);
  });

  it("is half a minute at least, where the hold has lapsed or this clock runs ahead", () => {
    expect(untilLapsed("2026-09-25T23:00:00.000Z", now, hour)).toBe(30_000);
  });

  it("is the interval where the hold's end cannot be read", () => {
    expect(untilLapsed("1790676000", now, hour)).toBe(hour);
    expect(untilLapsed(undefined, now, hour)).toBe(hour);
  });
});
