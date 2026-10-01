import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition, Entry } from "../src/define.js";
import { defineConnector } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, testFields, testType, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One", vendor_id: "v1" } };

describe("an entry older than what was agreed", () => {
  it("is skipped as a read that lagged, and the agreed time moves with each newer one", async () => {
    const held = vendor([{ ...one, changed_at: "2026-10-01T00:00:00.000Z" }]);
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "Newer" },
        changed_at: "2026-10-03T00:00:00.000Z",
      },
    ];
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "Lagging" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe("Newer");
    expect(harness.lastRun().summary).toContain("skipped 1");
  });
});

describe("a create", () => {
  it("is recorded as sent before the vendor is asked", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    let recorded: unknown;
    held.vendorIdFor = () => {
      recorded = harness.server.agreements.get(theirs.id)?.record["attempted"];
      return "v-theirs";
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(typeof recorded).toBe("string");
  });
});

describe("a vendor's answer", () => {
  it("replaces what the vendor last held whole, so a field it dropped is agreed gone", async () => {
    const held = vendor([
      { ...one, properties: { ...one.properties, note: "vendor's" } },
    ]);
    held.answer = (change) =>
      change.kind === "updated"
        ? { ...one, properties: { ...one.properties, title: "Edited" } }
        : undefined;
    await harness.twoWay(held);
    harness.server.edit(harness.server.row("a:1").id, { title: "Edited" });
    held.entries = [];
    await harness.twoWay(held);
    // The vendor, as it answered: no note. Nothing is a change.
    held.entries = [
      { ...one, properties: { ...one.properties, title: "Edited" } },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["note"]).toBe("vendor's");
    expect(held.changes).toEqual([]);
  });
});

describe("a vendor's answer for a read-only field", () => {
  it("is written onto the row, as for a row the vendor just made, and nothing is carried after", async () => {
    const held = vendor([]);
    held.readOnly = ["note"];
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = () => "v9";
    held.answer = (change) => ({
      source_id: "a:9",
      properties: {
        ...change.item.properties,
        vendor_id: "v9",
        note: "number 9 at the vendor",
      },
    });
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(made.id).properties["note"]).toBe(
      "number 9 at the vendor",
    );
    held.changes.length = 0;
    held.answer = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });
});

describe("a vendor's answer for a field the change did not carry", () => {
  it("is written onto the row, as its reopening on a restore", async () => {
    const held = vendor([
      { ...one, properties: { ...one.properties, note: "closed" } },
    ]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.answer = (change) => ({
      source_id: "a:1",
      properties: { ...change.item.properties, note: "reopened" },
    });
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["note"]).toBe("reopened");
    held.changes.length = 0;
    held.answer = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("leaves a change a person made meanwhile, still to carry", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "Edited" });
    held.entries = [];
    held.answer = (change) => {
      // A person writes the note while the change is carried.
      harness.server.edit(row.id, { note: "the person's" });
      return {
        source_id: "a:1",
        properties: { ...change.item.properties, note: "the vendor's" },
      };
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["note"]).toBe("the person's");
  });
});

describe("a run for deliveries", () => {
  it("reads the vendor whole where more than two hundred rows wait", async () => {
    const many: Entry[] = Array.from({ length: 201 }, (_, n) => ({
      source_id: `a:${String(n)}`,
      properties: { title: `Entry ${String(n)}`, vendor_id: `v${String(n)}` },
    }));
    const held = vendor(many);
    const exit = harness.inboundTwoWay(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    held.pushFail = undefined;
    for (const row of harness.server.rows) {
      harness.server.edit(row.id, { note: "edited in Marfa" });
    }
    // Carried but refused at the vendor, so each still waits.
    held.answer = () => {
      throw new Error("the vendor is down");
    };
    harness.clock.advance(15 * 60_000);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    held.answer = undefined;
    const { signed } = await import("./harness.js");
    const said = signed({ ids: ["v0"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 3);
    expect(held.hints?.at(-1)).toBeUndefined();
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("fetches only what its deliveries name after a scheduled run connected more than two hundred rows", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    const many: Entry[] = Array.from({ length: 202 }, (_, n) => ({
      source_id: `a:${String(n)}`,
      properties: { title: `Entry ${String(n)}`, vendor_id: `v${String(n)}` },
      connections: {
        "test.blocks": n === 0 ? [] : [{ type: "test.entry", id: "v0" }],
      },
    }));
    const held = vendor(many);
    held.connections = [
      {
        id: "test.blocks",
        cardinality: "many-to-many",
        source_type_constraints: ["test.entry"],
        target_type_constraints: ["test.entry"],
      },
    ];
    const exit = harness.inboundTwoWay(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    expect(harness.server.edges).toHaveLength(201);
    const { signed } = await import("./harness.js");
    const said = signed({ ids: ["v1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.hints?.length === 2);
    expect(held.hints?.at(-1)).toEqual(new Set(["v1"]));
    harness.stop();
    expect(await exit).toBe(0);
  });
});

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("connections", () => {
  const blocks: ConnectionDefinition = {
    id: "test.blocks",
    cardinality: "many-to-many",
    source_type_constraints: ["test.entry"],
    target_type_constraints: ["test.entry"],
  };
  beforeEach(() => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
  });

  it("of a type the vendor never names carry nothing made in Marfa", async () => {
    const two = {
      source_id: "a:2",
      properties: { title: "Two", vendor_id: "v2" },
    };
    const held = vendor([one, two]);
    held.connections = [blocks];
    await harness.twoWay(held);
    harness.server.drawEdge(
      harness.server.row("a:1").id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("to a row the vendor has not been told about are carried once it has", async () => {
    const none = { "test.blocks": [] };
    const held = vendor([{ ...one, connections: none }]);
    held.connections = [blocks];
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(
      harness.server.row("a:1").id,
      theirs.id,
      "test.blocks",
    );
    // The create fails this run, so the target is not yet at the vendor.
    held.pushFail = { id: theirs.id, error: new Error("vendor down") };
    held.entries = [];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(
      held.changes.some((change) => change.connections !== undefined),
    ).toBe(false);
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-theirs" : undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    const carried = held.changes.flatMap(
      (change) =>
        change.connections?.["test.blocks"]?.added.map((item) => item.id) ?? [],
    );
    expect(carried).toEqual([theirs.id]);
  });
});

describe("a secret made at run time", () => {
  it("is refused where too short to find without redacting ordinary words", async () => {
    const connector = defineConnector({
      name: "test",
      source: "test",
      types: [{ type: testType, fields: testFields }],
      env: {},
      run(context) {
        context.secret("short");
        return Promise.resolve();
      },
    });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(1);
    expect(harness.lastRun().error).toContain(
      "a secret shorter than 8 characters cannot be kept out of the logs",
    );
  });
});
