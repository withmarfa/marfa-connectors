import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition, Item } from "../src/define.js";
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
  const served = harness.server.edgeTypes.get("in-collection");
  if (served !== undefined) served["target_type_constraints"] = ["*"];
});
afterEach(async () => {
  await harness.close();
});

describe("the rows a connector holds, read with their edges", () => {
  async function joined(): Promise<void> {
    const first = vendor([
      { source_id: "shelf", properties: { title: "shelf" } },
      {
        source_id: "book",
        properties: { title: "book" },
        connections: {
          "in-collection": [{ type: testType.id, id: "shelf" }],
        },
      },
    ]);
    first.connections = [inCollection];
    expect(await harness.once(first), harness.lines.join("\n")).toBe(0);
  }

  async function read(
    options: { edges?: boolean } | undefined,
  ): Promise<Item[]> {
    const second = vendor();
    second.connections = [inCollection];
    let rows: Item[] = [];
    second.read = async (context) => {
      rows = await context.held(testType.id, { state: "any", ...options });
    };
    expect(await harness.once(second), harness.lines.join("\n")).toBe(0);
    return rows;
  }

  it("carry the edges they hold, from the same pages as the rows", async () => {
    await joined();
    harness.server.requests = [];
    const rows = await read({ edges: true });
    const book = rows.find((row) => row.source_id === "book");
    const shelf = rows.find((row) => row.source_id === "shelf");
    expect(
      book?.edges?.["in-collection"]?.data.map((edge) => edge.target_id),
    ).toEqual([shelf?.id]);
    expect(shelf?.edges?.["in-collection"]).toBeUndefined();

    const listings = harness.server
      .requestsTo("GET", "/items")
      .filter((request) => request.query.get("type") === testType.id);
    expect(listings.map((request) => request.query.get("include"))).toEqual([
      "edges",
    ]);
  });

  it("carry none, and ask for none, unless asked", async () => {
    await joined();
    harness.server.requests = [];
    const rows = await read(undefined);
    expect(rows.map((row) => row.edges)).toEqual([undefined, undefined]);
    const listings = harness.server
      .requestsTo("GET", "/items")
      .filter((request) => request.query.get("type") === testType.id);
    expect(listings).toHaveLength(1);
    expect(listings[0]?.query.get("include")).toBeNull();
  });
});
