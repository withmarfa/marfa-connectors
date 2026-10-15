import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType } from "./harness.js";
let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});
it.each(["none", "empty", "add", "owned-add", "adopted-add"] as const)(
  "checks connection ownership only for declared intent: %s",
  async (intent) => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    let checkpoint: unknown;
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [
        {
          type: linkedType,
          fields: ["title", "note", "vendor_id"],
          policy: (item, entry) => ({
            owned:
              item?.properties["note"] !== "other" &&
              (entry !== undefined || intent === "owned-add"),
            fields: { title: "observe" },
          }),
        },
      ],
      connections: [
        {
          id: "test.blocks",
          cardinality: "many-to-many",
          source_type_constraints: [linkedType.id],
          target_type_constraints: [linkedType.id],
        },
      ],
      async run(context) {
        const scope = context.forScope("observer");
        await scope.upsert(linkedType.id, [
          {
            source_id: "one",
            properties: { title: "Source", vendor_id: "one" },
            connections:
              intent === "none"
                ? {}
                : {
                    "test.blocks":
                      intent === "empty"
                        ? []
                        : [{ type: linkedType.id, id: "two" }],
                  },
          },
          {
            source_id: "two",
            properties: { title: "Target", vendor_id: "two" },
          },
        ]);
        if (intent === "adopted-add")
          harness.server.touch("one", { note: "other" });
        checkpoint = await scope.state.checkpoint("page", 1);
      },
    });
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.row("one").properties["title"]).toBe("Source");
    const guarded = intent === "adopted-add";
    expect(checkpoint).toEqual(
      guarded
        ? { committed: false, reason: "row-refused" }
        : { committed: true },
    );
    expect(harness.kept()["state"]).toEqual(guarded ? {} : { page: 1 });
    expect(
      harness.server.targetsOf(harness.server.row("one").id, "test.blocks"),
    ).toEqual(
      intent === "owned-add" || intent === "add"
        ? [harness.server.row("two").id]
        : [],
    );
  },
);
it.each([false, true])(
  "archive respects ownership at commit; race=%s",
  async (race) => {
    let seed = true;
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [
        {
          type: linkedType,
          fields: ["title", "note", "vendor_id"],
          policy: (item) => ({ owned: item?.properties["note"] !== "other" }),
        },
      ],
      async run(context) {
        if (seed) {
          await context.upsert(linkedType.id, [
            {
              source_id: "one",
              properties: { title: "Title", note: "", vendor_id: "vendor-one" },
            },
          ]);
          seed = false;
        } else await context.archive(linkedType.id, ["vendor-one"]);
      },
    });
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    const id = harness.server.row("one").id;
    let raced = false;
    harness.server.beforeAnswer = (request) => {
      if (
        race &&
        !raced &&
        request.method === "POST" &&
        request.path === `/items/${id}/transition`
      ) {
        raced = true;
        harness.server.touch("one", { note: "other" });
      }
    };
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(raced).toBe(race);
    expect(harness.server.row("one").state).toBe(race ? "active" : "archived");
  },
);

it.each([false, true])(
  "accepts a declared policy field omitted by permission narrowing; narrowed=%s",
  async (narrowed) => {
    const { specsOf } = await import("../src/run.js");
    const { forRow } = await import("../src/rows.js");
    const c = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [
        {
          type: linkedType,
          fields: ["title", "note", "vendor_id"],
          policy: () => ({ fields: { note: "observe" } }),
        },
      ],
      run() {
        return Promise.resolve();
      },
    });
    const spec = specsOf(
      c,
      {},
      narrowed
        ? {
            fields: new Map([[linkedType.id, ["note"]]]),
            conditions: new Map(),
          }
        : undefined,
    ).get(linkedType.id);
    if (spec === undefined) throw new Error("expected declared kind");
    expect(() => forRow(spec, undefined)).not.toThrow();
  },
);

it.each(["owned", "adopted", "racing"])(
  "guards delayed connections for a %s source",
  async (ownership) => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    let first = true;
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [
        {
          type: linkedType,
          fields: ["title", "note", "vendor_id"],
          policy: (item) => ({ owned: item?.properties["note"] !== "other" }),
        },
      ],
      connections: [
        {
          id: "test.blocks",
          cardinality: "many-to-many",
          source_type_constraints: [linkedType.id],
          target_type_constraints: [linkedType.id],
        },
      ],
      async run(context) {
        await context.upsert(
          linkedType.id,
          first
            ? [
                {
                  source_id: "one",
                  properties: { title: "Source", note: "", vendor_id: "one" },
                  connections: {
                    "test.blocks": [{ type: linkedType.id, id: "two" }],
                  },
                },
              ]
            : [
                {
                  source_id: "two",
                  properties: { title: "Target", note: "", vendor_id: "two" },
                },
              ],
        );
        first = false;
      },
    });
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    const source = harness.server.row("one").id;
    expect(harness.server.targetsOf(source, "test.blocks")).toEqual([]);
    if (ownership === "adopted") harness.server.touch("one", { note: "other" });
    let raced = false;
    harness.server.beforeAnswer = (request) => {
      if (
        ownership === "racing" &&
        !raced &&
        request.method === "POST" &&
        ["/edges", "/edges/bulk"].includes(request.path)
      ) {
        raced = true;
        harness.server.touch("one", { note: "other" });
      }
    };
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(raced).toBe(ownership === "racing");
    expect(harness.server.targetsOf(source, "test.blocks")).toEqual(
      ownership === "owned" ? [harness.server.row("two").id] : [],
    );
  },
);

it.each([false, true])(
  "revival respects ownership at commit; race=%s",
  async (race) => {
    let step = 0;
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [
        {
          type: linkedType,
          fields: ["title", "note", "vendor_id"],
          policy: (item) => ({ owned: item?.properties["note"] !== "other" }),
        },
      ],
      async run(context) {
        if (step === 1) await context.archive(linkedType.id, ["one"]);
        else
          await context.upsert(linkedType.id, [
            {
              source_id: "one",
              properties: { title: "Title", note: "", vendor_id: "one" },
            },
          ]);
        step += 1;
      },
    });
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    const id = harness.server.row("one").id;
    expect(harness.server.row("one").state).toBe("archived");
    let raced = false;
    harness.server.beforeAnswer = (request) => {
      if (
        race &&
        !raced &&
        request.method === "POST" &&
        request.path === `/items/${id}/transition`
      ) {
        raced = true;
        harness.server.touch("one", { note: "other" });
      }
    };
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(raced).toBe(race);
    expect(harness.server.row("one").state).toBe(race ? "archived" : "active");
  },
);

it.each([false, true])(
  "guards connection removals against ownership adoption; race=%s",
  async (race) => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    let connected = true;
    const definition = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [
        {
          type: linkedType,
          fields: ["title", "note", "vendor_id"],
          policy: (item) => ({ owned: item?.properties["note"] !== "other" }),
        },
      ],
      connections: [
        {
          id: "test.blocks",
          cardinality: "many-to-many",
          source_type_constraints: [linkedType.id],
          target_type_constraints: [linkedType.id],
        },
      ],
      async run(context) {
        await context.upsert(linkedType.id, [
          {
            source_id: "one",
            properties: { title: "Source", note: "", vendor_id: "one" },
            connections: {
              "test.blocks": connected
                ? [{ type: linkedType.id, id: "two" }]
                : [],
            },
          },
          {
            source_id: "two",
            properties: { title: "Target", note: "", vendor_id: "two" },
          },
        ]);
      },
    });
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    const source = harness.server.row("one").id,
      target = harness.server.row("two").id;
    expect(harness.server.targetsOf(source, "test.blocks")).toEqual([target]);
    connected = false;
    let raced = false;
    harness.server.beforeAnswer = (request) => {
      if (
        race &&
        !raced &&
        request.method === "DELETE" &&
        request.path.startsWith("/edges/")
      ) {
        raced = true;
        harness.server.touch("one", { note: "other" });
      }
    };
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    expect(raced).toBe(race);
    expect(harness.server.targetsOf(source, "test.blocks")).toEqual(
      race ? [target] : [],
    );
  },
);
