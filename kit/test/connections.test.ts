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
