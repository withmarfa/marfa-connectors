import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change, ConnectionDefinition, Entry } from "../src/define.js";
import { defineConnector } from "../src/define.js";
import { checkDefinition } from "../src/environment.js";
import {
  Harness,
  linkedType,
  testFields,
  vendor,
  type Vendor,
} from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { "test.entry": "write" },
    edge_permissions: { "parent-of": "write" },
  };
});
afterEach(async () => {
  await harness.close();
});

/** The child's side of the instance's `parent-of`. */
const childOf: ConnectionDefinition = {
  id: "child-of",
  cardinality: "many-to-one",
  cascade_on_delete: "cascade",
  source_type_constraints: ["test.entry"],
  target_type_constraints: ["test.entry"],
};

const parentOf: ConnectionDefinition = {
  id: "parent-of",
  cardinality: "one-to-many",
  cascade_on_delete: "cascade",
  source_type_constraints: ["test.entry"],
  target_type_constraints: ["test.entry"],
};

/** An exception names its series, or an empty list for an ordinary event. */
function exception(n: number, series?: number): Entry {
  return {
    source_id: `a:${String(n)}`,
    properties: { title: `Entry ${String(n)}`, vendor_id: `v${String(n)}` },
    connections: {
      "child-of":
        series === undefined
          ? []
          : [{ type: "test.entry", id: `v${String(series)}` }],
    },
  };
}

/** The series carries no connection: Google names it from the exception. */
function series(n: number): Entry {
  return {
    source_id: `a:${String(n)}`,
    properties: { title: `Entry ${String(n)}`, vendor_id: `v${String(n)}` },
  };
}

function calendar(entries: Entry[], readOnly = false): Vendor {
  const held = vendor(entries);
  held.connections = [childOf];
  if (readOnly) held.readOnly = ["child-of"];
  return held;
}

function seriesOf(n: number): string[] {
  const row = harness.server.row(`a:${String(n)}`);
  return harness.server.edges
    .filter(
      (edge) => edge.edge_type === "parent-of" && edge.target_id === row.id,
    )
    .map((edge) => harness.server.byId(edge.source_id).source_id ?? "");
}

function kinds(changes: readonly Change[]): string[] {
  return changes.map(
    (change) => `${change.kind} ${change.item.source_id ?? ""}`,
  );
}

describe("the child's side of parent-of", () => {
  it("is written from the series to the exception, the instance's own type neither registered nor changed", async () => {
    const held = calendar([series(1), exception(2, 1), exception(3, 1)]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.requestsTo("POST", "/edge-types")).toEqual([]);
    expect(seriesOf(2)).toEqual(["a:1"]);
    expect(seriesOf(3)).toEqual(["a:1"]);
    expect(seriesOf(1)).toEqual([]);
    const written = harness.server.requestsTo("POST", "/edges/bulk").length;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.requestsTo("POST", "/edges/bulk")).toHaveLength(
      written,
    );
  });

  it("connects the series when it arrives in a later run than its exception", async () => {
    const held = calendar([exception(2, 1)]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual([]);
    held.entries = [series(1)];
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual(["a:1"]);
    expect(held.changes).toEqual([]);
  });

  it("moves an exception to another series, the old one removed first", async () => {
    const held = calendar([series(1), series(4), exception(2, 1)]);
    await harness.twoWay(held);
    held.entries = [exception(2, 4)];
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual(["a:4"]);
    expect(harness.lastRun().summary).not.toContain("refused");
    expect(held.changes).toEqual([]);
  });

  it("removes the series where the entry names the type with an empty list, and leaves it where the entry does not name it", async () => {
    const held = calendar([series(1), exception(2, 1)]);
    await harness.twoWay(held);
    held.entries = [{ ...exception(2, 1), connections: {} }];
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual(["a:1"]);
    held.entries = [exception(2)];
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual([]);
  });

  it("is carried when a person makes or removes it in Marfa, as the series at the other end", async () => {
    const held = calendar([series(1), series(4), exception(2, 1)]);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    const one = harness.server.row("a:1");
    const four = harness.server.row("a:4");
    harness.server.removeEdge(harness.server.edges[0]?.id ?? "");
    harness.server.drawEdge(four.id, two.id, "parent-of");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["updated a:2"]);
    const carried = held.changes[0]?.connections?.["child-of"];
    expect(carried?.added.map((row) => row.id)).toEqual([four.id]);
    expect(carried?.removed.map((row) => row.id)).toEqual([one.id]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("is put back, and named, where the kind only reads", async () => {
    const held = calendar([series(1), series(4), exception(2, 1)], true);
    await harness.twoWay(held);
    const two = harness.server.row("a:2");
    harness.server.removeEdge(harness.server.edges[0]?.id ?? "");
    harness.server.drawEdge(harness.server.row("a:4").id, two.id, "parent-of");
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual(["a:1"]);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toContain(
      `the child-of connections of ${two.id} were changed in Marfa and put back`,
    );
  });

  it("is what linked answers for the series: its exceptions, by link", async () => {
    const held = calendar([
      series(1),
      series(4),
      exception(2, 1),
      exception(3, 4),
    ]);
    await harness.twoWay(held);
    held.entries = [];
    held.ask = {
      connection: "child-of",
      target: { type: "test.entry", id: "v1" },
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.answers).toEqual([["v2"]]);
  });
});

describe("a trash of the series in Marfa", () => {
  it("is carried once, the exceptions it took into the bin are not, and a restore carries none of theirs", async () => {
    const held = calendar([
      series(1),
      exception(2, 1),
      exception(3, 1),
      exception(4),
    ]);
    await harness.twoWay(held);
    const one = harness.server.row("a:1");
    harness.server.trash(one.id);
    harness.server.trash(harness.server.row("a:4").id);
    expect(harness.server.row("a:2").state).toBe("trashed");
    expect(harness.server.row("a:3").state).toBe("trashed");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes).sort()).toEqual(["trashed a:1", "trashed a:4"]);
    for (const n of [2, 3]) {
      expect(
        harness.agreement(harness.server.row(`a:${String(n)}`).id),
      ).toMatchObject({ state: "trashed", stateBy: "cascade" });
    }
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);

    harness.server.restore(one.id);
    expect(harness.server.row("a:2").state).toBe("active");
    expect(harness.server.row("a:3").state).toBe("active");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["restored a:1"]);
    expect(seriesOf(2)).toEqual(["a:1"]);
    expect(seriesOf(3)).toEqual(["a:1"]);
  });

  it("carries no purge of the exceptions the trash took", async () => {
    const held = calendar([series(1), exception(2, 1)]);
    await harness.twoWay(held);
    harness.server.trash(harness.server.row("a:1").id);
    await harness.twoWay(held);
    harness.server.purge("a:1");
    harness.server.purge("a:2");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["purged a:1"]);
  });
});

describe("the parent's side of parent-of", () => {
  it("is written from the row to the children the entry names", async () => {
    const held = vendor([
      {
        ...series(1),
        connections: {
          "parent-of": [
            { type: "test.entry", id: "v2" },
            { type: "test.entry", id: "v3" },
          ],
        },
      },
      series(2),
      series(3),
    ]);
    held.connections = [parentOf];
    expect(await harness.twoWay(held)).toBe(0);
    expect(seriesOf(2)).toEqual(["a:1"]);
    expect(seriesOf(3)).toEqual(["a:1"]);
    expect(held.changes).toEqual([]);
  });
});

describe("a declaration of parent-of", () => {
  it("with an end outside the connector's types is refused at start", async () => {
    const held = calendar([]);
    held.connections = [{ ...childOf, target_type_constraints: ["core.note"] }];
    expect(await harness.twoWay(held)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "child-of's both ends constrained to its own types",
    );
    expect(harness.server.requests).toEqual([]);
  });

  it("with its reverse name beside it is refused, since they are one edge type", async () => {
    const held = calendar([]);
    held.connections = [childOf, parentOf];
    expect(await harness.twoWay(held)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "child-of and parent-of declared once between them, since they are one edge type",
    );
  });

  it("is refused where the key may not write parent-of, naming it", async () => {
    harness.server.grants = { type_permissions: { "test.entry": "write" } };
    expect(await harness.twoWay(calendar([]))).toBe(1);
    expect(harness.lastRun().error).toContain("may not write edge parent-of");
  });

  it("is refused where the key may register edge types, which a shipped one never needs", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "parent-of": "write" },
      metadata_permissions: { edge_types: "write" },
    };
    expect(await harness.twoWay(calendar([]))).toBe(1);
    expect(harness.lastRun().error).toContain("metadata edge_types=write");
  });

  it("is refused where it differs from the instance's own, read from the child's side", async () => {
    const held = calendar([]);
    held.connections = [{ ...childOf, cardinality: "one-to-many" }];
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      'cardinality is "one-to-many" here and "many-to-one" on the server, read from child-of\'s side',
    );
    held.connections = [{ ...childOf, cascade_on_delete: "orphan" }];
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      'cascade_on_delete is "orphan" here and "cascade" on the server',
    );
    harness.server.edgeTypes.set("parent-of", {
      ...harness.server.edgeTypes.get("parent-of"),
      reverse_name: "kid-of",
    });
    held.connections = [childOf];
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().error).toContain("kid-of");
  });

  it("is refused for a type with a row policy, since the instance conditions an edge only on its source", () => {
    const connector = defineConnector({
      name: "test",
      source: "test",
      types: [{ type: linkedType, fields: testFields, policy: () => ({}) }],
      connections: [childOf],
      async run() {
        await Promise.resolve();
      },
    });
    expect(() => {
      checkDefinition(connector);
    }).toThrow("child-of's ends without a row policy");
  });

  it("still leaves a custom connection type that cascades refused", async () => {
    const held = calendar([]);
    held.connections = [
      { ...childOf, id: "test.child-of", cascade_on_delete: "cascade" },
    ];
    expect(await harness.twoWay(held)).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "test.child-of to orphan on delete",
    );
  });
});
