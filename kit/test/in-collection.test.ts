import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition } from "../src/define.js";
import { Harness, testType, vendor } from "./harness.js";

let harness: Harness;
const inCollection: ConnectionDefinition = {
  id: "in-collection",
  cardinality: "many-to-many",
  source_type_constraints: [testType.id],
  target_type_constraints: [testType.id],
};

beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { [testType.id]: "write" },
    edge_permissions: { "in-collection": "write" },
  };
  // The test's type holds no container role, which the instance's own
  // constraint asks of the target.
  const served = harness.server.edgeTypes.get("in-collection");
  if (served !== undefined) served["target_type_constraints"] = ["*"];
});
afterEach(async () => {
  await harness.close();
});

describe("built-in in-collection", () => {
  it("joins a member to its container through the served definition, registering nothing", async () => {
    const definition = structuredClone(
      harness.server.edgeTypes.get("in-collection"),
    );
    const held = vendor([
      { source_id: "shelf", properties: { title: "shelf" } },
      {
        source_id: "book",
        properties: { title: "book" },
        connections: {
          "in-collection": [{ type: testType.id, id: "shelf" }],
        },
      },
    ]);
    held.connections = [inCollection];
    expect(await harness.once(held), harness.lines.join("\n")).toBe(0);
    expect(
      harness.server.targetsOf(harness.server.row("book").id, "in-collection"),
    ).toEqual([harness.server.row("shelf").id]);
    expect(harness.server.requestsTo("POST", "/edge-types")).toEqual([]);
    expect(harness.server.edgeTypes.get("in-collection")).toEqual(definition);
  });
});
