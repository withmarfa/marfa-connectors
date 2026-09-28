import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { Harness, testConnector, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = {
  source_id: "a:1",
  properties: { title: "One", vendor_id: "v1" },
};

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("the look between runs, for a connector that carries changes back", () => {
  it("carries an edit made in Marfa within a look, not at the next schedule", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.edit(harness.server.row("a:1").id, { title: "Edited" });
    await harness.clock.wake(10_000);
    await until(() => held.changes.length === 1);
    expect(held.runs).toBe(2);
    expect(held.changes[0]?.item.properties["title"]).toBe("Edited");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for the connector's own writes", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    for (let look = 0; look < 3; look += 1) {
      await harness.clock.wake(10_000);
      await harness.clock.sleeping(10_000);
    }
    expect(held.runs).toBe(1);
    // The witness: an edit of a person's does start one.
    harness.server.edit(harness.server.row("a:1").id, { title: "Edited" });
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for the purge of a row the vendor was never told about", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    // Made, trashed and purged between two looks.
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    harness.server.trash(theirs.id);
    harness.server.purgeById(theirs.id);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for a trash another row's trash made, nor for its purge", async () => {
    const held = vendor([one]);
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const row = harness.server.row("a:1");
    harness.server.cascadeTrash(row.id, "root-1");
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    harness.server.purgeById(row.id);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    // The witness: a purge of the row's own does start one.
    held.entries = [];
    harness.server.insert(
      "a:2",
      { title: "Two", vendor_id: "v2" },
      "test.entry",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    harness.server.trash(harness.server.row("a:2").id);
    harness.server.purge("a:2");
    await harness.clock.wake(10_000);
    await until(() => held.runs === 3);
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("the look, for connections", () => {
  const blocks = {
    id: "test.blocks",
    cardinality: "many-to-many" as const,
    source_type_constraints: ["test.entry"],
    target_type_constraints: ["test.entry"],
  };

  function blocking(): ReturnType<typeof vendor> {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One", vendor_id: "v1" },
        connections: { "test.blocks": [{ type: "test.entry", id: "v2" }] },
      },
      { source_id: "a:2", properties: { title: "Two", vendor_id: "v2" } },
    ]);
    held.connections = [blocks];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    return held;
  }

  it("starts no run for its own edge frame whose target was purged since", async () => {
    const held = blocking();
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    // A cascade's trash and purge start no run of their own.
    const two = harness.server.row("a:2");
    harness.server.cascadeTrash(two.id, "root-1");
    harness.server.purgeById(two.id);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    // The witness: a person's connection starts one.
    harness.server.insert(
      "a:3",
      { title: "Three", vendor_id: "v3" },
      "test.entry",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    harness.server.drawEdge(
      harness.server.row("a:1").id,
      harness.server.row("a:3").id,
      "test.blocks",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 3);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for its own writes to a row waiting on a target Marfa lacks", async () => {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One", vendor_id: "v1" },
        connections: { "test.blocks": [{ type: "test.entry", id: "v3" }] },
      },
    ]);
    held.connections = [blocks];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    for (let look = 0; look < 3; look += 1) {
      await harness.clock.wake(10_000);
      await harness.clock.sleeping(10_000);
    }
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("starts no run for a person's connection to a row of their own, and one for a connection to the connector's", async () => {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One", vendor_id: "v1" },
        connections: { "attached-to": [] },
      },
      {
        source_id: "a:2",
        properties: { title: "Two", vendor_id: "v2" },
        connections: { "attached-to": [] },
      },
    ]);
    held.connections = [
      {
        id: "attached-to",
        cardinality: "many-to-many",
        source_type_constraints: ["test.entry"],
        target_type_constraints: ["test.entry"],
      },
    ];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "attached-to": "write" },
    };
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const one = harness.server.row("a:1");
    const note = harness.server.insert(
      undefined,
      { body: "mine" },
      "core.note",
      "person",
    );
    harness.server.drawEdge(one.id, note.id, "attached-to");
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:2").id,
      "attached-to",
    );
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("reads nothing for connections a purge took", async () => {
    const held = blocking();
    const exit = harness.twoWayRunning(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    // Past the run's own edge frame first.
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const two = harness.server.row("a:2");
    harness.server.cascadeTrash(two.id, "root-1");
    harness.server.purgeById(two.id);
    const reads = harness.server.requestsTo("POST", "/items/lookup").length;
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(1);
    expect(harness.server.requestsTo("POST", "/items/lookup").length).toBe(
      reads,
    );
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("--look-every", () => {
  it("is refused for a connector that neither receives webhooks nor carries changes back", async () => {
    expect(
      await start(
        testConnector(vendor([])),
        harness.runtime(["--every", "15m", "--look-every", "30s"]),
      ),
    ).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "--look-every is for a connector that receives webhooks or carries changes back",
    );
    expect(harness.server.requests).toEqual([]);
    // The witness: the two-way connector takes it.
    const held = vendor([]);
    const exit = harness.twoWayRunning(held, [
      "--every",
      "15m",
      "--look-every",
      "30s",
    ]);
    await harness.clock.sleeping(30_000);
    harness.stop();
    expect(await exit).toBe(0);
  });
});
