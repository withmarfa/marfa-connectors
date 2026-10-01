import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition, Entry } from "../src/define.js";
import { Harness, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { "test.entry": "write" },
    edge_permissions: { "test.blocks": "write" },
    metadata_permissions: { types: "write", edge_types: "write" },
  };
});
afterEach(async () => {
  await harness.close();
});

const blocks: ConnectionDefinition = {
  id: "test.blocks",
  cardinality: "many-to-many",
  source_type_constraints: ["test.entry"],
  target_type_constraints: ["test.entry"],
};

function entry(n: number, blocked: number[] = []): Entry {
  return {
    source_id: `a:${String(n)}`,
    properties: { title: `Entry ${String(n)}`, vendor_id: `v${String(n)}` },
    connections: {
      "test.blocks": blocked.map((b) => ({
        type: "test.entry",
        id: `v${String(b)}`,
      })),
    },
  };
}

function connected(entries: Entry[]): Vendor {
  const held = vendor(entries);
  held.connections = [blocks];
  return held;
}

function targets(n: number): string[] {
  return harness.server
    .targetsOf(harness.server.row(`a:${String(n)}`).id, "test.blocks")
    .map((id) => harness.server.byId(id).source_id ?? id);
}

function bulkEdges(): number {
  return harness.server.requestsTo("POST", "/edges/bulk").length;
}

describe("connections from the vendor", () => {
  it("are registered as edge types and written from each row, and the kit's own write is carried nowhere", async () => {
    const held = connected([entry(1, [2, 3]), entry(2), entry(3)]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.edgeTypes.get("test.blocks")).toMatchObject({
      cascade_on_delete: "orphan",
    });
    expect(targets(1)).toEqual(["a:2", "a:3"]);
    const written = bulkEdges();
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(bulkEdges()).toBe(written);
  });

  it("are read past the lookup's cap, so none is taken for one Marfa removed", async () => {
    harness.server.edgePageCap = 1;
    const held = connected([entry(1, [2, 3]), entry(2), entry(3)]);
    await harness.twoWay(held);
    held.entries = [entry(1, [2, 3])];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2", "a:3"]);
    expect(held.changes).toEqual([]);
  });

  it("retry an edge the server refused, and never carry it as a removal", async () => {
    const held = connected([entry(1, [2]), entry(2)]);
    harness.server.beforeAnswer = (request) => {
      if (request.path !== "/edges/bulk") return;
      const kind = harness.server.edgeTypes.get("test.blocks");
      if (kind !== undefined) kind["target_type_constraints"] = ["test.other"];
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual([]);
    expect(harness.lastRun().summary).toContain("edge_constraint_violation");
    harness.server.beforeAnswer = undefined;
    const kind = harness.server.edgeTypes.get("test.blocks");
    if (kind !== undefined) kind["target_type_constraints"] = ["test.entry"];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
    expect(held.changes).toEqual([]);
  });

  it("keep a target Marfa lacks waiting through a carry of the row", async () => {
    const held = connected([entry(1, [3])]);
    await harness.twoWay(held);
    harness.server.edit(harness.server.row("a:1").id, { note: "by a person" });
    held.entries = [];
    await harness.twoWay(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    held.entries = [entry(3)];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:3"]);
  });

  it("keep a target Marfa lacks waiting through a run that finds nothing to carry", async () => {
    const held = connected([entry(1, [2, 3]), entry(2)]);
    await harness.twoWay(held);
    held.entries = [];
    await harness.twoWay(held);
    expect(held.changes).toEqual([]);
    held.entries = [entry(3)];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2", "a:3"]);
  });

  it("wait for a target in the bin, and connect it once it is back", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    two.state = "trashed";
    held.entries = [entry(1, [2])];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual([]);
    expect(harness.lastRun().summary).not.toContain("refused");
    harness.server.restore(two.id);
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
  });

  it("take the vendor's set where nothing was agreed, and carry none of Marfa's", async () => {
    const held = connected([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:3").id,
      "test.blocks",
    );
    // The agreements are lost, and the vendor dropped a:2 meanwhile.
    harness.server.agreements.clear();
    held.entries = [entry(1, []), entry(2), entry(3)];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual([]);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toContain(
      `the test.blocks connections of ${one.id} had nothing agreed, so they took the vendor's`,
    );
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("connect a target Marfa does not hold yet once it arrives, though the vendor does not name it again", async () => {
    const held = connected([entry(1, [3])]);
    await harness.twoWay(held);
    expect(targets(1)).toEqual([]);
    held.entries = [entry(3)];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:3"]);
    expect(held.changes).toEqual([]);
  });

  it("remove in Marfa what the vendor removed", async () => {
    const held = connected([entry(1, [2]), entry(2)]);
    await harness.twoWay(held);
    held.entries = [entry(1, [])];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual([]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("leave a connection type the entry does not name as it is", async () => {
    const held = connected([entry(1, [2]), entry(2)]);
    await harness.twoWay(held);
    held.entries = [{ ...entry(1), connections: {} }];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
  });
});

describe("connections, whatever order the rows come in", () => {
  const parentOf: ConnectionDefinition = {
    id: "test.parent-of",
    cardinality: "one-to-many",
    source_type_constraints: ["test.entry"],
    target_type_constraints: ["test.entry"],
  };

  function parenting(entries: Entry[]): Vendor {
    const held = vendor(entries);
    held.connections = [parentOf];
    return held;
  }

  function child(parent: number, children: number[]): Entry {
    return {
      ...entry(parent),
      connections: {
        "test.parent-of": children.map((c) => ({
          type: "test.entry",
          id: `v${String(c)}`,
        })),
      },
    };
  }

  it("move a child to its new parent, the old one's connection removed first", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.parent-of": "write" },
    };
    const held = parenting([child(1, [3]), child(2, []), child(3, [])]);
    await harness.twoWay(held);
    // The new parent comes first, as a vendor may send it.
    held.entries = [child(2, [3]), child(1, [])];
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      harness.server
        .targetsOf(harness.server.row("a:2").id, "test.parent-of")
        .map((id) => harness.server.byId(id).source_id),
    ).toEqual(["a:3"]);
    expect(
      harness.server.targetsOf(harness.server.row("a:1").id, "test.parent-of"),
    ).toEqual([]);
    expect(harness.lastRun().summary).not.toContain("refused");
  });
});

describe("connections made in Marfa", () => {
  it("stay, removed or added, while the vendor's entry is unchanged, and are carried", async () => {
    const held = connected([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const two = harness.server.row("a:2");
    const three = harness.server.row("a:3");
    const edge = harness.server.edges.find(
      (candidate) => candidate.target_id === two.id,
    );
    harness.server.removeEdge(edge?.id ?? "");
    harness.server.drawEdge(one.id, three.id, "test.blocks");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:3"]);
    const carried = held.changes[0]?.connections?.["test.blocks"];
    expect(carried?.added.map((row) => row.id)).toEqual([three.id]);
    expect(carried?.removed.map((row) => row.id)).toEqual([two.id]);
  });

  it("are carried, added and removed, as the rows at the other end", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const two = harness.server.row("a:2");
    const edge = harness.server.drawEdge(two.id, one.id, "test.blocks");
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    expect(held.changes[0]?.item.id).toBe(two.id);
    expect(
      held.changes[0]?.connections?.["test.blocks"]?.added.map((row) => row.id),
    ).toEqual([one.id]);
    // Carried once: the next run finds nothing.
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);

    harness.server.removeEdge(edge.id);
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes[0]?.connections?.["test.blocks"]?.removed.map(
        (row) => row.id,
      ),
    ).toEqual([one.id]);
  });

  it("carry nothing a purge took, where a person's removal is carried", async () => {
    const held = connected([entry(1, [2]), entry(2), entry(3, [2])]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    harness.server.trash(two.id);
    await harness.twoWay(held);
    harness.server.purge("a:2");
    held.changes.length = 0;
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    // A person's change beside it carries only itself.
    const one = harness.server.row("a:1");
    const three = harness.server.row("a:3");
    harness.server.drawEdge(one.id, three.id, "test.blocks");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const carried = held.changes[0]?.connections?.["test.blocks"];
    expect(carried?.added.map((row) => row.id)).toEqual([three.id]);
    expect(carried?.removed).toEqual([]);
    expect(harness.agreement(one.id)?.["connections"]).toEqual({
      "test.blocks": [three.id],
    });
  });

  it("carry only what changed after a field went either way", async () => {
    const held = connected([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    // The vendor changes a field and names no connections.
    held.entries = [
      {
        ...entry(1),
        properties: { title: "From the vendor", vendor_id: "v1" },
        connections: undefined,
      },
    ];
    await harness.twoWay(held);
    // A person changes a field, which is carried.
    harness.server.edit(one.id, { note: "by a person" });
    held.entries = [];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    const three = harness.server.row("a:3");
    harness.server.drawEdge(one.id, three.id, "test.blocks");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const carried = held.changes[0]?.connections?.["test.blocks"];
    expect(carried?.added.map((row) => row.id)).toEqual([three.id]);
    expect(carried?.removed).toEqual([]);
  });

  it("are put back where the kind only reads, and the run names them", async () => {
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One" },
        connections: { "test.blocks": [{ type: "test.entry", id: "a:2" }] },
      },
      { source_id: "a:2", properties: { title: "Two" } },
    ]);
    held.connections = [blocks];
    await harness.once(held);
    const one = harness.server.row("a:1");
    const two = harness.server.row("a:2");
    expect(targets(1)).toEqual(["a:2"]);
    harness.server.drawEdge(two.id, one.id, "test.blocks");
    harness.server.removeEdge(harness.server.edges[0]?.id ?? "");
    held.entries = [];
    expect(await harness.once(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
    expect(targets(2)).toEqual([]);
    expect(harness.lastRun().summary).toContain(
      `the test.blocks connections of ${two.id} were changed in Marfa and put back`,
    );
  });
});

describe("what a run finds linked", () => {
  it("is the active rows holding the connection to the target, by link", async () => {
    const held = connected([entry(1, [2]), entry(2), entry(3, [2]), entry(4)]);
    await harness.twoWay(held);
    harness.server.transition(harness.server.row("a:3").id, "archived");
    held.entries = [];
    held.ask = {
      connection: "test.blocks",
      target: { type: "test.entry", id: "v2" },
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.answers).toEqual([["v1"]]);
  });

  it("leaves out a row this run's entries moved elsewhere, and one never told to the vendor", async () => {
    const held = connected([entry(1, [2]), entry(2), entry(3), entry(4, [2])]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const untold = harness.server.insert(
      undefined,
      { title: "Untold" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(untold.id, two.id, "test.blocks");
    held.entries = [entry(1, [3])];
    held.ask = {
      connection: "test.blocks",
      target: { type: "test.entry", id: "v2" },
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.answers).toEqual([["v4"]]);
  });

  it("leaves out a row an answer before the run moved elsewhere", async () => {
    const held = connected([entry(1), entry(2), entry(3)]);
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(
      made.id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    held.vendorIdFor = () => "v9";
    held.answer = (change) => ({
      source_id: "a:9",
      properties: { ...change.item.properties, vendor_id: "v9" },
      connections: { "test.blocks": [{ type: "test.entry", id: "v3" }] },
    });
    held.entries = [];
    held.ask = {
      connection: "test.blocks",
      target: { type: "test.entry", id: "v2" },
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.answers).toEqual([[]]);
  });

  it("reads every page", async () => {
    const many = Array.from({ length: 450 }, (_, at) => entry(at + 2, [1]));
    const held = connected([entry(1), ...many]);
    await harness.twoWay(held);
    held.entries = [];
    held.ask = {
      connection: "test.blocks",
      target: { type: "test.entry", id: "v1" },
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.answers?.[0]).toHaveLength(450);
  });

  it("is nothing where Marfa lacks the target", async () => {
    const held = connected([entry(1)]);
    held.ask = {
      connection: "test.blocks",
      target: { type: "test.entry", id: "v9" },
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.answers).toEqual([[]]);
  });

  it("refuses a connection the type does not hold", async () => {
    const held = connected([entry(1)]);
    held.ask = {
      connection: "test.other",
      target: { type: "test.entry", id: "v1" },
    };
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      "test.entry declares no connection test.other",
    );
  });
});

describe("connections the vendor answers after a carry", () => {
  it("are what it holds: one it would not take is taken back in Marfa, and nothing more is carried", async () => {
    const held = connected([entry(1), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const two = harness.server.row("a:2");
    const three = harness.server.row("a:3");
    harness.server.drawEdge(one.id, two.id, "test.blocks");
    harness.server.drawEdge(one.id, three.id, "test.blocks");
    // The vendor takes the first and refuses the second.
    held.answer = (change) => ({
      ...entry(1, [2]),
      properties: change.item.properties,
    });
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes[0]?.connections?.["test.blocks"]?.added.map((row) => row.id),
    ).toEqual([two.id, three.id]);
    expect(targets(1)).toEqual(["a:2"]);
    expect(harness.agreement(one.id)?.["connections"]).toEqual({
      "test.blocks": [two.id],
    });
    held.changes.length = 0;
    held.answer = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("give way to the vendor's own entry for the row later in the same run", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(made.id, one.id, "test.blocks");
    held.vendorIdFor = () => "v9";
    held.answer = (change) => ({
      source_id: "a:9",
      properties: { ...change.item.properties, vendor_id: "v9" },
      connections: { "test.blocks": [{ type: "test.entry", id: "v1" }] },
    });
    // The vendor has since linked the new row to a second one too.
    held.entries = [
      {
        source_id: "a:9",
        properties: { title: "Made in Marfa", vendor_id: "v9" },
        connections: {
          "test.blocks": [
            { type: "test.entry", id: "v1" },
            { type: "test.entry", id: "v2" },
          ],
        },
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      harness.server
        .targetsOf(made.id, "test.blocks")
        .map((id) => harness.server.byId(id).source_id),
    ).toEqual(["a:1", "a:2"]);
  });

  it("keep a type the vendor's later entry does not name", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(
      made.id,
      harness.server.row("a:1").id,
      "test.blocks",
    );
    harness.server.drawEdge(
      made.id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    held.vendorIdFor = () => "v9";
    held.answer = (change) => ({
      source_id: "a:9",
      properties: { ...change.item.properties, vendor_id: "v9" },
      connections: { "test.blocks": [{ type: "test.entry", id: "v1" }] },
    });
    held.entries = [
      {
        source_id: "a:9",
        properties: { title: "Made", vendor_id: "v9" },
        connections: {},
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      harness.server
        .targetsOf(made.id, "test.blocks")
        .map((id) => harness.server.byId(id).source_id),
    ).toEqual(["a:1"]);
  });

  it("from before the run are applied where the vendor sends nothing after", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(
      made.id,
      harness.server.row("a:1").id,
      "test.blocks",
    );
    harness.server.drawEdge(
      made.id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    held.vendorIdFor = () => "v9";
    held.answer = (change) => ({
      source_id: "a:9",
      properties: { ...change.item.properties, vendor_id: "v9" },
      connections: { "test.blocks": [{ type: "test.entry", id: "v1" }] },
    });
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      harness.server
        .targetsOf(made.id, "test.blocks")
        .map((id) => harness.server.byId(id).source_id),
    ).toEqual(["a:1"]);
  });

  it("are taken back though a later carry fails the run", async () => {
    const held = connected([entry(1), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const three = harness.server.row("a:3");
    // Carried in the order the log shows them: the first, then the third.
    harness.server.edit(one.id, { note: "first" });
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    harness.server.edit(three.id, { note: "by a person" });
    held.answer = (change) =>
      change.item.id === one.id
        ? { ...entry(1, []), properties: change.item.properties }
        : undefined;
    held.pushFail = { id: three.id, error: new Error("the vendor is down") };
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(1);
    expect(targets(1)).toEqual([]);
  });

  it("of a type the row's kind does not hold are left alone", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.edit(one.id, { note: "by a person" });
    held.answer = (change) => ({
      source_id: "a:1",
      properties: change.item.properties,
      connections: { "test.other": [{ type: "test.entry", id: "v2" }] },
    });
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().summary).not.toContain("connection-refused");
    expect(harness.lastRun().summary).not.toContain("test.other");
  });

  it("leave a type the answer does not name as carried", async () => {
    const held = connected([entry(1), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    held.answer = (change) => ({
      source_id: "a:1",
      properties: change.item.properties,
    });
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
  });
});

describe("a read-only connection type on a two-way kind", () => {
  function mirrored(entries: Entry[]): Vendor {
    const held = connected(entries);
    held.readOnly = ["test.blocks"];
    return held;
  }

  const relates: ConnectionDefinition = { ...blocks, id: "test.relates" };
  const make = (title: string) =>
    harness.server.insert(undefined, { title }, "test.entry", "person");
  const addedTo = (held: Vendor, at: number) =>
    held.changes[at]?.connections?.["test.blocks"]?.added.map((row) => row.id);

  it("is put back when changed in Marfa, carried nowhere, and the run names it", async () => {
    const held = mirrored([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const three = harness.server.row("a:3");
    harness.server.removeEdge(harness.server.edges[0]?.id ?? "");
    harness.server.drawEdge(one.id, three.id, "test.blocks");
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toContain(
      `the test.blocks connections of ${one.id} were changed in Marfa and put back`,
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("is put back and named where the vendor sends the row in the same run", async () => {
    const held = mirrored([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:3").id,
      "test.blocks",
    );
    held.entries = [entry(1, [2])];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
    expect(harness.lastRun().summary).toContain(
      `the test.blocks connections of ${one.id} were changed in Marfa and put back`,
    );
  });

  it("follows the vendor, whatever Marfa agreed", async () => {
    const held = mirrored([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    held.entries = [entry(1, [3])];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:3"]);
    expect(held.changes).toEqual([]);
  });

  it("places a create, handed to it with the row", async () => {
    const held = mirrored([entry(2)]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(made.id, two.id, "test.blocks");
    held.vendorIdFor = () => "v9";
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["created"]);
    expect(
      held.changes[0]?.connections?.["test.blocks"]?.added.map((row) => row.id),
    ).toEqual([two.id]);
    expect(harness.server.targetsOf(made.id, "test.blocks")).toEqual([two.id]);
  });

  it("holds a create back until the vendor has the row it names, made later in the same run", async () => {
    const held = mirrored([]);
    await harness.twoWay(held);
    const first = harness.server.insert(
      undefined,
      { title: "First" },
      "test.entry",
      "person",
    );
    const second = harness.server.insert(
      undefined,
      { title: "Second" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(first.id, second.id, "test.blocks");
    held.vendorIdFor = (change) =>
      change.item.id === first.id ? "v-first" : "v-second";
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      held.changes[1]?.connections?.["test.blocks"]?.added.map((row) => row.id),
    ).toEqual([second.id]);
  });

  it("holds a create back across runs while the row it names stays untold", async () => {
    const held = mirrored([]);
    await harness.twoWay(held);
    const first = harness.server.insert(
      undefined,
      { title: "First" },
      "test.entry",
      "person",
    );
    const second = harness.server.insert(
      undefined,
      { title: "Second" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(first.id, second.id, "test.blocks");
    held.pushFail = { id: second.id, error: new Error("the vendor is down") };
    expect(await harness.twoWay(held)).toBe(1);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
    held.changes.length = 0;
    held.vendorIdFor = (change) =>
      change.item.id === first.id ? "v-first" : "v-second";
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("places a create sent again after the vendor took nothing", async () => {
    const held = mirrored([entry(2)]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(made.id, two.id, "test.blocks");
    expect(await harness.twoWay(held)).toBe(0);
    harness.server.edit(made.id, { title: "Made in Marfa, fixed" });
    held.vendorIdFor = () => "v9";
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual([
      "created",
      "created",
    ]);
    expect(
      held.changes[1]?.connections?.["test.blocks"]?.added.map((row) => row.id),
    ).toEqual([two.id]);
  });

  it("holds each create of a chain until the row it names is made, all in one run", async () => {
    const held = mirrored([]);
    await harness.twoWay(held);
    const make = (title: string) =>
      harness.server.insert(undefined, { title }, "test.entry", "person");
    const c = make("C");
    const b = make("B");
    const a = make("A");
    harness.server.drawEdge(c.id, b.id, "test.blocks");
    harness.server.drawEdge(b.id, a.id, "test.blocks");
    held.vendorIdFor = (change) => `v-${change.item.id}`;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });

  it("names a create it holds for a row the vendor never takes", async () => {
    const held = mirrored([]);
    await harness.twoWay(held);
    const first = harness.server.insert(
      undefined,
      { title: "First" },
      "test.entry",
      "person",
    );
    const second = harness.server.insert(
      undefined,
      { title: "Second" },
      "test.entry",
      "person",
    );
    harness.server.drawEdge(first.id, second.id, "test.blocks");
    held.vendorIdFor = (change) =>
      change.item.id === first.id ? "v-first" : undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
    expect(harness.lastRun().summary).toContain(
      `${first.id} is not sent to the vendor until the vendor has each row its read-only connections name`,
    );
  });

  it("hands a row made again the rows that place it, and keeps them", async () => {
    const held = mirrored([entry(1, [2]), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    const two = harness.server.row("a:2");
    harness.server.trash(one.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(one.id);
    held.gone = new Map([[one.id, "v1-again"]]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.remakes?.[0]?.change.connections?.["test.blocks"]?.added.map(
        (row) => row.id,
      ),
    ).toEqual([two.id]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
    expect(harness.lastRun().summary).not.toContain("put back");
  });

  it("leaves a type nothing was agreed for until the vendor names it", async () => {
    const held = mirrored([{ ...entry(1), connections: undefined }, entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:2").id,
      "test.blocks",
    );
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).not.toContain("put back");
  });

  it("puts back on restore a change made while in the bin", async () => {
    const held = mirrored([entry(1, [2]), entry(2), entry(3)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.trash(one.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.drawEdge(
      one.id,
      harness.server.row("a:3").id,
      "test.blocks",
    );
    await harness.twoWay(held);
    harness.server.restore(one.id);
    expect(await harness.twoWay(held)).toBe(0);
    expect(targets(1)).toEqual(["a:2"]);
  });

  it("places a create sent again with the placement the person redrew, putting nothing back", async () => {
    const held = mirrored([entry(2), entry(3)]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const three = harness.server.row("a:3");
    const a = make("A");
    const edge = harness.server.drawEdge(a.id, two.id, "test.blocks");
    expect(await harness.twoWay(held)).toBe(0);
    harness.server.removeEdge(edge.id);
    harness.server.drawEdge(a.id, three.id, "test.blocks");
    held.vendorIdFor = () => "vA";
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["created"]);
    expect(addedTo(held, 0)).toEqual([three.id]);
    expect(harness.server.targetsOf(a.id, "test.blocks")).toEqual([three.id]);
    expect(harness.lastRun().summary).not.toContain("put back");
  });

  it("names a create sent again that its placement now holds back", async () => {
    const held = mirrored([entry(2)]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const a = make("A");
    const edge = harness.server.drawEdge(a.id, two.id, "test.blocks");
    expect(await harness.twoWay(held)).toBe(0);
    const c = make("C");
    harness.server.removeEdge(edge.id);
    harness.server.drawEdge(a.id, c.id, "test.blocks");
    held.vendorIdFor = (change) => (change.item.id === a.id ? "vA" : undefined);
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([c.id]);
    expect(harness.lastRun().summary).toContain(
      `${a.id} is not sent to the vendor until`,
    );
  });

  it("sends a create whose only untold target is two-way, which follows once told", async () => {
    const held = mirrored([entry(2)]);
    held.connections = [blocks, relates];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write", "test.relates": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const a = make("A");
    const c = make("C");
    harness.server.drawEdge(a.id, two.id, "test.blocks");
    harness.server.drawEdge(a.id, c.id, "test.relates");
    held.vendorIdFor = (change) => (change.item.id === a.id ? "vA" : undefined);
    expect(await harness.twoWay(held)).toBe(0);
    const made = held.changes.find((change) => change.item.id === a.id);
    expect(made?.kind).toBe("created");
    expect(
      made?.connections?.["test.blocks"]?.added.map((row) => row.id),
    ).toEqual([two.id]);
    expect(made?.connections?.["test.relates"]).toBeUndefined();
    harness.server.edit(c.id, { title: "C again" });
    held.vendorIdFor = (change) => (change.item.id === c.id ? "vC" : undefined);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    const later = held.changes.find((change) => change.item.id === a.id);
    expect(
      later?.connections?.["test.relates"]?.added.map((row) => row.id),
    ).toEqual([c.id]);
    expect(later?.connections?.["test.blocks"]).toBeUndefined();
  });

  it("holds a remake its placement names an untold row for, rather than restoring it, and makes it once told", async () => {
    const held = mirrored([entry(1, [2]), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.trash(one.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(one.id);
    const c = make("C");
    let seen = 0;
    // A person places it on C between the log's read and the remake.
    harness.server.beforeAnswer = (request) => {
      const body = request.body as
        { ids?: string[]; include?: string[] } | undefined;
      if (
        request.path === "/items/lookup" &&
        body?.include?.includes("edges") === true &&
        body.ids?.includes(one.id) === true &&
        ++seen === 1
      ) {
        harness.server.drawEdge(one.id, c.id, "test.blocks");
      }
    };
    held.gone = new Map([[one.id, "v1-again"]]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    harness.server.beforeAnswer = undefined;
    expect(held.changes.filter((change) => change.item.id === one.id)).toEqual(
      [],
    );
    expect(held.remakes ?? []).toEqual([]);
    expect(harness.lastRun().summary).toContain(
      `${one.id} is not sent to the vendor until`,
    );
    held.vendorIdFor = (change) => (change.item.id === c.id ? "vC" : undefined);
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.remakes).toHaveLength(1);
    expect(
      held.changes.filter(
        (change) => change.item.id === one.id && change.kind === "restored",
      ),
    ).toEqual([]);
  });

  it("hands a remake only the rows that place it, where a two-way type is carried after", async () => {
    const held = mirrored([
      {
        ...entry(1, [2]),
        connections: {
          "test.blocks": [{ type: "test.entry", id: "v2" }],
          "test.relates": [{ type: "test.entry", id: "v3" }],
        },
      },
      entry(2),
      entry(3),
    ]);
    held.connections = [blocks, relates];
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write", "test.relates": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.trash(one.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(one.id);
    held.gone = new Map([[one.id, "v1-again"]]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const handed = held.remakes?.[0]?.change.connections;
    expect(Object.keys(handed ?? {})).toEqual(["test.blocks"]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes
        .find((change) => change.item.id === one.id)
        ?.connections?.["test.relates"]?.added.map((row) => row.id),
    ).toEqual([harness.server.row("a:3").id]);
  });

  it("names no put-back where a placement's target was purged meanwhile", async () => {
    const held = mirrored([entry(1, [2]), entry(2)]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.trash(one.id);
    harness.server.trash(harness.server.row("a:2").id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.purge("a:2");
    await harness.twoWay(held);
    harness.server.restore(one.id);
    held.gone = new Map([[one.id, "v1-again"]]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().summary).not.toContain("put back");
  });

  it("sharing a field's name is refused at start", async () => {
    const held = connected([]);
    held.connections = [{ ...blocks, id: "title" }];
    expect(await harness.twoWay(held)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "connection types named apart from every field, where title is both",
    );
  });

  it("naming no connection type of the kind is refused at start", async () => {
    const held = connected([]);
    held.readOnly = ["test.other"];
    expect(await harness.twoWay(held)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "test.entry's link and read-only fields among its fields or the connection types from it, where test.other is not",
    );
  });
});

describe("in-thread", () => {
  const thread: ConnectionDefinition = {
    id: "in-thread",
    cardinality: "many-to-one",
    source_type_constraints: ["test.entry"],
    target_type_constraints: ["test.entry"],
  };

  function threaded(entries: Entry[]): Vendor {
    const held = vendor(entries);
    held.connections = [thread];
    return held;
  }

  function reply(n: number, to?: number): Entry {
    return {
      ...entry(n),
      connections: {
        "in-thread":
          to === undefined
            ? []
            : [{ type: "test.entry", id: `v${String(to)}` }],
      },
    };
  }

  it("is the instance's own, never registered, written between the connector's rows", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "in-thread": "write" },
    };
    const held = threaded([reply(1), reply(2, 1)]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.requestsTo("POST", "/edge-types")).toEqual([]);
    expect(
      harness.server
        .targetsOf(harness.server.row("a:2").id, "in-thread")
        .map((id) => harness.server.byId(id).source_id),
    ).toEqual(["a:1"]);
  });

  it("needs no key to register connection types, and a key that may is refused", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "in-thread": "write" },
      metadata_permissions: { edge_types: "write" },
    };
    expect(await harness.twoWay(threaded([]))).toBe(1);
    expect(harness.lastRun().error).toContain("metadata edge_types=write");
  });

  it("is refused where the key may not write it, or it differs from the instance's", async () => {
    harness.server.grants = { type_permissions: { "test.entry": "write" } };
    expect(await harness.twoWay(threaded([]))).toBe(1);
    expect(harness.lastRun().error).toContain("may not write edge in-thread");
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "in-thread": "write" },
    };
    const held = threaded([]);
    held.connections = [{ ...thread, cardinality: "many-to-many" }];
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      "the connection type in-thread differs from the instance's own",
    );
  });
});

describe("a connection type", () => {
  it("that cascades, or reaches past the connector's types, is refused at start", async () => {
    const cascading = connected([]);
    cascading.connections = [{ ...blocks, cascade_on_delete: "cascade" }];
    expect(await harness.twoWay(cascading)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "test.blocks to orphan on delete",
    );
    const outward = connected([]);
    outward.connections = [
      { ...blocks, target_type_constraints: ["core.note"] },
    ];
    expect(await harness.twoWay(outward)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "test.blocks's both ends constrained to its own types",
    );
    expect(harness.server.requests).toEqual([]);
  });

  it("is refused where the key may not write it, or the server holds it otherwise", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    expect(await harness.twoWay(connected([]))).toBe(1);
    expect(harness.lastRun().error).toContain("may not write edge test.blocks");
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    harness.server.edgeTypes.set("test.blocks", {
      ...blocks,
      cardinality: "one-to-many",
      cascade_on_delete: "orphan",
      written_at: "source",
      property_schema: {},
    });
    expect(await harness.twoWay(connected([]))).toBe(1);
    expect(harness.lastRun().error).toContain(
      'cardinality is "many-to-many" here and "one-to-many" on the server',
    );
  });
});

describe("a row made again at the vendor", () => {
  it("carries every connection it holds, the vendor's new copy holding none", async () => {
    const held = connected([entry(1, [2]), entry(2)]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const two = harness.server.row("a:2");
    harness.server.trash(row.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.gone = new Map([[row.id, "v1-again"]]);
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.remakes).toHaveLength(1);
    await harness.twoWay(held);
    expect(
      held.changes.map((change) => [
        change.kind,
        change.connections?.["test.blocks"]?.added.map((item) => item.id),
      ]),
    ).toEqual([["updated", [two.id]]]);
  });
});
