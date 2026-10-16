import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector, type ConnectionDefinition } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, testType } from "./harness.js";

let harness: Harness;
const extra = { ...testType, id: "test.extra" };
const connection: ConnectionDefinition = {
  id: "test.in-repository",
  label: "Kept label",
  description: "Kept description",
  cardinality: "many-to-one",
  source_type_constraints: [testType.id],
  target_type_constraints: [testType.id],
};

beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { [testType.id]: "write", [extra.id]: "write" },
    edge_permissions: { [connection.id]: "write" },
    metadata_permissions: { types: "write", edge_types: "write" },
  };
});
afterEach(async () => {
  await harness.close();
});

function reader(definition = connection, includeExtra = false) {
  return defineConnector({
    name: "test",
    source: "test",
    description: "A connection evolution reader.",
    types: [testType, extra].map((type) => ({ type, fields: ["title"] })),
    connections: [definition],
    async run(context) {
      await context.upsert(testType.id, [
        { source_id: "target", properties: { title: "Target" } },
        {
          source_id: "source",
          properties: { title: "Source" },
          connections: {
            [connection.id]: [{ type: testType.id, id: "target" }],
          },
        },
      ]);
      if (includeExtra)
        await context.upsert(extra.id, [
          {
            source_id: "extra",
            properties: { title: "New source" },
            connections: {
              [connection.id]: [{ type: testType.id, id: "target" }],
            },
          },
        ]);
    },
  });
}
const widened = () => ({
  ...connection,
  source_type_constraints: [testType.id, extra.id],
});
const run = (definition = connection, includeExtra = false) =>
  start(reader(definition, includeExtra), harness.runtime(["--once"]));

it("widens a registered connection in place and imports the newly admitted source", async () => {
  expect(await run(), harness.lines.join("\n")).toBe(0);
  const original = structuredClone(harness.server.edges[0]);
  const before = structuredClone(harness.server.row("source"));
  const calls = harness.server.requestsTo("POST", "/edge-types").length;
  expect(await run(widened(), true), harness.lines.join("\n")).toBe(0);
  expect(harness.server.edges.find((edge) => edge.id === original?.id)).toEqual(
    original,
  );
  expect(harness.server.row("source")).toEqual(before);
  expect(
    harness.server.targetsOf(harness.server.row("extra").id, connection.id),
  ).toEqual([harness.server.row("target").id]);
  expect(
    harness.server
      .requestsTo("POST", "/edge-types")
      .slice(calls)
      .map((one) => one.body),
  ).toEqual([
    {
      ...connection,
      source_type_constraints: [testType.id, extra.id],
      cascade_on_delete: "orphan",
      property_schema: {},
      written_at: "source",
      evolve_constraints: true,
    },
  ]);
  const edges = structuredClone(harness.server.edges);
  expect(await run(widened(), true)).toBe(0);
  expect(harness.server.edges).toEqual(edges);
  expect(harness.server.requestsTo("POST", "/edge-types")).toHaveLength(
    calls + 1,
  );
});

it("preserves stored presentation text when the connector's text changes", async () => {
  expect(await run()).toBe(0);
  expect(
    await run({
      ...widened(),
      label: "New label",
      description: "New description",
    }),
  ).toBe(0);
  expect(harness.server.edgeTypes.get(connection.id)).toMatchObject({
    label: connection.label,
    description: connection.description,
  });
});

it("widens the target end with the same explicit operation", async () => {
  expect(await run()).toBe(0);
  expect(
    await run({
      ...connection,
      target_type_constraints: [testType.id, extra.id],
    }),
  ).toBe(0);
  expect(harness.server.edgeTypes.get(connection.id)).toMatchObject({
    target_type_constraints: [testType.id, extra.id],
  });
});

it.each<Partial<ConnectionDefinition>>([
  { cardinality: "many-to-many" },
  { cascade_on_delete: "cascade" },
  { reverse_name: "test.contains" },
  { written_at: "target" },
  { property_schema: { note: { type: "string" } } },
])("refuses widening alongside structural changes: %j", async (change) => {
  expect(await run()).toBe(0);
  const held = structuredClone(harness.server.edgeTypes.get(connection.id));
  const count = harness.server.requestsTo("POST", "/edge-types").length;
  expect(await run({ ...widened(), ...change }, true)).toBe(
    change.cascade_on_delete === "cascade" ? 2 : 1,
  );
  expect(harness.server.edgeTypes.get(connection.id)).toEqual(held);
  expect(harness.server.requestsTo("POST", "/edge-types")).toHaveLength(count);
  expect(harness.server.rows.some((row) => row.type === extra.id)).toBe(false);
});

it.each(["source_type_constraints", "target_type_constraints"] as const)(
  "refuses narrowing %s without sending evolution",
  async (end) => {
    const old = { ...connection, [end]: [testType.id, extra.id] };
    expect(await run(old)).toBe(0);
    const held = structuredClone(harness.server.edgeTypes.get(connection.id));
    const count = harness.server.requestsTo("POST", "/edge-types").length;
    expect(await run()).toBe(1);
    expect(harness.server.edgeTypes.get(connection.id)).toEqual(held);
    expect(harness.server.requestsTo("POST", "/edge-types")).toHaveLength(
      count,
    );
  },
);

it("keeps an unrestricted stored end rather than narrowing it to today's types", async () => {
  expect(await run()).toBe(0);
  const stored = harness.server.edgeTypes.get(connection.id);
  if (stored === undefined) throw new Error("No held definition");
  stored["source_type_constraints"] = [];
  const count = harness.server.requestsTo("POST", "/edge-types").length;
  expect(await run(widened())).toBe(1);
  expect(harness.server.requestsTo("POST", "/edge-types")).toHaveLength(count);
});

it("keeps existing edges and refuses startup when metadata authority is missing", async () => {
  expect(await run()).toBe(0);
  harness.server.grants.metadata_permissions = { types: "write" };
  const before = structuredClone(harness.server.edges);
  expect(await run(widened(), true)).toBe(1);
  expect(harness.lines.join("\n")).toContain("403");
  expect(harness.server.edges).toEqual(before);
  expect(harness.server.rows.some((row) => row.type === extra.id)).toBe(false);
});

it("checks the served definition after evolution before starting the vendor", async () => {
  expect(await run()).toBe(0);
  let evolving = false;
  harness.server.beforeAnswer = (request) => {
    if (request.method === "POST" && request.path === "/edge-types")
      evolving = true;
    if (
      evolving &&
      request.method === "GET" &&
      request.path === "/edge-types"
    ) {
      const held = harness.server.edgeTypes.get(connection.id);
      if (held === undefined) throw new Error("No held definition");
      held["source_type_constraints"] = [testType.id];
    }
  };
  const before = structuredClone(harness.server.edges);
  expect(await run(widened(), true)).toBe(1);
  expect(harness.server.edges).toEqual(before);
  expect(harness.server.rows.some((row) => row.type === extra.id)).toBe(false);
});
