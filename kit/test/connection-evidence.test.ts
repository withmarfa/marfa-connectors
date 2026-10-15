import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector, type Entry, type Item } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType } from "./harness.js";

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

const type = {
  type: linkedType,
  fields: ["title", "note", "vendor_id"],
  policy: (item: Item | undefined, entry?: Entry) => ({
    owned:
      item?.properties["note"] !== "adopted" &&
      entry?.properties["note"] === "verified",
  }),
};
const connections = [
  {
    id: "test.blocks",
    cardinality: "many-to-many" as const,
    source_type_constraints: [linkedType.id],
    target_type_constraints: [linkedType.id],
  },
];
function entry(id: string): Entry {
  return {
    source_id: id,
    properties: { title: id, note: "verified", vendor_id: id },
  };
}

it.each([false, true])(
  "detaches acknowledged connection evidence; checkpoint=%s",
  async (checkpoint) => {
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [type],
      connections,
      async run(context) {
        const reader = checkpoint ? context.forScope("reader") : context;
        const properties = { title: "one", note: "verified", vendor_id: "one" };
        const targets = {
          "test.blocks": [{ type: linkedType.id, id: "two" }],
        };
        const source = { source_id: "one", properties, connections: targets };
        await reader.upsert(linkedType.id, [source, entry("two")]);
        properties.note = "unverified";
        targets["test.blocks"] = [];
        if (checkpoint)
          expect(
            await context.forScope("reader").state.checkpoint("page", 1),
          ).toEqual({ committed: true });
      },
    });
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(
      harness.server.targetsOf(harness.server.row("one").id, "test.blocks"),
    ).toEqual([harness.server.row("two").id]);
  },
);

it.each([false, true])(
  "does not use incoming evidence for an unnamed pending connection; incoming=%s",
  async (incoming) => {
    let phase = 0;
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [type],
      connections,
      async run(context) {
        const source = entry("one");
        source.connections =
          phase === 1
            ? {}
            : { "test.blocks": [{ type: linkedType.id, id: "two" }] };
        if (phase === 0) await context.upsert(linkedType.id, [source]);
        else
          await context.upsert(linkedType.id, [
            ...(phase === 2 || incoming ? [source] : []),
            entry("two"),
          ]);
        if (phase === 1) await context.archive(linkedType.id, ["one"]);
      },
    });
    const once = () => start(definition, harness.runtime(["--once"]));
    expect(await once()).toBe(0);
    const id = harness.server.row("one").id;
    expect(harness.agreement(id)?.["pending"]).toBeDefined();
    phase = 1;
    expect(await once()).toBe(0);
    expect(harness.server.targetsOf(id, "test.blocks")).toEqual([]);
    expect(harness.server.row("one").state).toBe("active");
    expect(harness.agreement(id)?.["pending"]).toBeDefined();
    phase = 2;
    expect(await once()).toBe(0);
    expect(harness.server.targetsOf(id, "test.blocks")).toEqual([
      harness.server.row("two").id,
    ]);
  },
);
