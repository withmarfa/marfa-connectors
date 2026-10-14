import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition, Entry } from "../src/define.js";
import { Harness, testType, vendor } from "./harness.js";

let harness: Harness;
const references: ConnectionDefinition = {
  id: "references",
  cardinality: "many-to-many",
  source_type_constraints: [testType.id],
  target_type_constraints: [testType.id],
};

beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { [testType.id]: "write" },
    edge_permissions: { references: "write" },
  };
  harness.server.edgeTypes.set("references", {
    ...references,
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
    shipped: true,
  });
});
afterEach(async () => {
  await harness.close();
});

function entry(id: string, targets?: string[]): Entry {
  return {
    source_id: id,
    properties: { title: id },
    ...(targets !== undefined && {
      connections: {
        references: targets.map((id) => ({ type: testType.id, id })),
      },
    }),
  };
}

function referencing(entries: Entry[] = []) {
  const held = vendor(entries);
  held.connections = [references];
  return held;
}

function targets(): string[] {
  return harness.server
    .targetsOf(harness.server.row("highlight").id, "references")
    .map((id) => harness.server.byId(id).source_id ?? id)
    .sort();
}

describe("built-in references", () => {
  it("uses the served definition without registering it and leaves a repeated import unchanged", async () => {
    const definition = structuredClone(
      harness.server.edgeTypes.get("references"),
    );
    const held = referencing([entry("source"), entry("highlight", ["source"])]);
    expect(await harness.once(held), harness.lines.join("\n")).toBe(0);
    expect(targets()).toEqual(["source"]);
    const writes = harness.server.requestsTo("POST", "/edges/bulk").length;
    expect(writes).toBeGreaterThan(0);
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.requestsTo("POST", "/edges/bulk")).toHaveLength(
      writes,
    );
    expect(harness.server.requestsTo("POST", "/edge-types")).toEqual([]);
    expect(harness.server.edgeTypes.get("references")).toEqual(definition);
  });

  it("refuses unnecessary permission to register edge types", async () => {
    harness.server.grants.metadata_permissions = { edge_types: "write" };
    expect(await harness.once(referencing())).toBe(1);
    expect(harness.lastRun().error).toContain("metadata edge_types=write");
  });

  it("requires references permission and refuses unrelated edge permissions", async () => {
    harness.server.grants.edge_permissions = {};
    expect(await harness.once(referencing())).toBe(1);
    expect(harness.lastRun().error).toContain("may not write edge references");
    harness.server.grants.edge_permissions = {
      references: "write",
      "in-thread": "write",
    };
    expect(await harness.once(referencing())).toBe(1);
    expect(harness.lastRun().error).toContain("edge in-thread=write");
  });

  it.each(["source_type_constraints", "target_type_constraints"] as const)(
    "refuses declarations reaching other types through %s",
    async (end) => {
      const held = referencing();
      held.connections = [{ ...references, [end]: ["core.note"] }];
      expect(await harness.once(held)).toBe(2);
      expect(harness.lines.join("\n")).toContain(
        "both ends constrained to its own types",
      );
      expect(harness.server.requests).toEqual([]);
    },
  );

  it.each(["absent", "different"])(
    "refuses a built-in that is %s without registering a replacement",
    async (kind) => {
      if (kind === "absent") harness.server.edgeTypes.delete("references");
      else {
        const definition = harness.server.edgeTypes.get("references");
        expect(definition).toBeDefined();
        if (definition !== undefined) definition["cardinality"] = "many-to-one";
      }
      expect(await harness.once(referencing())).toBe(1);
      expect(harness.lastRun().error).toContain(
        "differs from the instance's own",
      );
      expect(harness.server.requestsTo("POST", "/edge-types")).toEqual([]);
    },
  );

  it("changes the agreed source while preserving unrelated references, including to another owned item", async () => {
    const held = referencing([
      entry("old"),
      entry("new"),
      entry("personal"),
      entry("outside"),
      entry("highlight", ["old"]),
    ]);
    expect(await harness.once(held)).toBe(0);
    const highlight = harness.server.row("highlight");
    const outside = harness.server.row("outside");
    outside.type = "core.note";
    harness.server.drawEdge(highlight.id, outside.id, "references");
    harness.server.drawEdge(
      highlight.id,
      harness.server.row("personal").id,
      "references",
    );
    held.entries = [entry("highlight", ["new"])];
    expect(await harness.once(held)).toBe(0);
    expect(targets()).toEqual(["new", "outside", "personal"]);
    harness.server.agreements.clear();
    expect(await harness.once(held)).toBe(0);
    expect(targets()).toEqual(["new", "outside", "personal"]);
  });

  it("holds the page checkpoint after a refused reference and advances after a successful retry", async () => {
    const held = referencing();
    let fail = true;
    held.read = async (context) => {
      const page = context.forScope("page");
      await page.upsert(testType.id, [
        entry("source"),
        entry("highlight", ["source"]),
      ]);
      if (fail)
        harness.server.refuseNext(
          "POST /edges/bulk",
          400,
          "edge_constraint_violation",
        );
      expect(await page.state.checkpoint("page", 1)).toEqual(
        fail
          ? { committed: false, reason: "connection-unresolved" }
          : { committed: true },
      );
      if (fail) throw new Error("page did not finish");
    };
    expect(await harness.once(held)).toBe(1);
    expect(harness.kept()["state"]).toEqual({});
    expect(targets()).toEqual([]);
    fail = false;
    expect(await harness.once(held), harness.lines.join("\n")).toBe(0);
    expect(harness.kept()["state"]).toEqual({ page: 1 });
    expect(targets()).toEqual(["source"]);
  });
});
