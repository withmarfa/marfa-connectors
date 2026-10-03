import { afterEach, beforeEach, expect, it } from "vitest";
import { Harness, testType, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

it("keeps an acknowledged scope after a later scope fails and a process restarts", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A");
    await a.upsert(testType.id, [
      { source_id: "a", properties: { title: "A" } },
    ]);
    expect(await a.state.checkpoint("vendors", { A: { cursor: 1 } })).toEqual({
      committed: true,
    });
    expect(harness.kept()["state"]).toEqual({ vendors: { A: { cursor: 1 } } });
    throw new Error("B failed");
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ vendors: { A: { cursor: 1 } } });
  held.read = async (context) => {
    const b = context.forScope("B");
    const latest = b.state.get("vendors") as Record<string, unknown>;
    expect(latest).toEqual({ A: { cursor: 1 } });
    expect(
      await b.state.checkpoint("vendors", { ...latest, B: { cursor: 2 } }),
    ).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({
    vendors: { A: { cursor: 1 }, B: { cursor: 2 } },
  });
});

it("detaches candidates, acknowledged reads and the root draft after checkpoint", async () => {
  const held = vendor();
  held.read = async (context) => {
    const scope = context.forScope("A");
    const candidate = { position: { page: 1 } };
    expect(await scope.state.checkpoint("A", candidate)).toEqual({
      committed: true,
    });
    candidate.position.page = 2;
    (scope.state.get("A") as typeof candidate).position.page = 3;
    (context.state.get("A") as typeof candidate).position.page = 4;
    expect(scope.state.get("A")).toEqual({ position: { page: 1 } });
    throw new Error("later failure");
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ A: { position: { page: 1 } } });
});

it("keeps prototype-named keys as own JSON state properties", async () => {
  const held = vendor();
  held.read = async (context) => {
    const scope = context.forScope("A");
    expect(scope.state.get("__proto__")).toBeUndefined();
    expect(await scope.state.checkpoint("__proto__", { page: 1 })).toEqual({
      committed: true,
    });
    expect(scope.state.get("__proto__")).toEqual({ page: 1 });
  };
  expect(await harness.once(held)).toBe(0);
  expect(Object.entries(harness.kept()["state"] as object)).toEqual([
    ["__proto__", { page: 1 }],
  ]);
});

it.each([
  undefined,
  NaN,
  Infinity,
  new Date(),
  new Map(),
  { value: undefined },
  [undefined],
  BigInt(1),
])(
  "rejects non-JSON checkpoint input %# without writing state",
  async (value) => {
    const held = vendor();
    held.read = async (context) => {
      await expect(
        context.forScope("A").state.checkpoint("A", value),
      ).rejects.toThrow("JSON-compatible");
      throw new Error("end");
    };
    expect(await harness.once(held)).toBe(1);
    expect(harness.kept()["state"]).toEqual({});
  },
);

it("blocks a complete oversized envelope without poisoning an unrelated scope", async () => {
  const held = vendor();
  held.read = async (context) => {
    expect(
      await context.forScope("A").state.checkpoint("A", "x".repeat(512 * 1024)),
    ).toEqual({ committed: false, reason: "state-oversized" });
    expect(await context.forScope("B").state.checkpoint("B", 1)).toEqual({
      committed: true,
    });
    throw new Error("end");
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ B: 1 });
});

it("blocks two unfinished scopes sharing an item, then allows unrelated progress", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A"),
      b = context.forScope("B");
    await a.upsert(testType.id, [
      { source_id: "same", properties: { title: "A" } },
    ]);
    await b.upsert(testType.id, [
      { source_id: "same", properties: { title: "B" } },
    ]);
    expect(await a.state.checkpoint("A", 1)).toEqual({
      committed: false,
      reason: "scope-overlap",
    });
    expect(await b.state.checkpoint("B", 1)).toEqual({
      committed: false,
      reason: "scope-overlap",
    });
    expect(await context.forScope("C").state.checkpoint("C", 1)).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ C: 1 });
});

it("allows a later scope to update a previously acknowledged item", async () => {
  const held = vendor();
  held.read = async (context) => {
    for (const name of ["A", "B"]) {
      const scope = context.forScope(name);
      await scope.upsert(testType.id, [
        { source_id: "same", properties: { title: name } },
      ]);
      expect(await scope.state.checkpoint(name, 1)).toEqual({
        committed: true,
      });
    }
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ A: 1, B: 1 });
});

it("rejects overlapping asynchronous scope operations explicitly", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A"),
      b = context.forScope("B");
    const writing = a.upsert(testType.id, [
      { source_id: "a", properties: { title: "A" } },
    ]);
    await expect(
      b.upsert(testType.id, [{ source_id: "b", properties: { title: "B" } }]),
    ).rejects.toThrow("awaited serially");
    await writing;
    expect(await a.state.checkpoint("A", 1)).toEqual({ committed: true });
    expect(await b.state.checkpoint("B", 1)).toEqual({
      committed: false,
      reason: "row-refused",
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ A: 1 });
});

it("blocks a refusal not counted as held while another scope checkpoints", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A");
    harness.server.entryRefusals.set("bad", {
      status: 400,
      code: "type_mismatch",
      message: "type moved",
    });
    await a.upsert(testType.id, [
      { source_id: "bad", properties: { title: "bad" } },
    ]);
    expect(
      await a.state.checkpoint("vendors", { A: { validator: "speculative" } }),
    ).toEqual({
      committed: false,
      reason: "row-refused",
    });
    const b = context.forScope("B");
    const latest = b.state.get("vendors") as
      Record<string, unknown> | undefined;
    expect(latest).toBeUndefined();
    expect(
      await b.state.checkpoint("vendors", {
        ...latest,
        B: { validator: "acknowledged" },
      }),
    ).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held), harness.lines.join("\n")).toBe(0);
  expect(harness.kept()["state"]).toEqual({
    vendors: { B: { validator: "acknowledged" } },
  });
});

it("blocks an agreement skipped after purge while unrelated progress checkpoints", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A");
    await a.upsert(testType.id, [
      { source_id: "purged", properties: { title: "purged" } },
    ]);
    harness.server.purge("purged");
    expect(await a.state.checkpoint("A", 1)).toEqual({
      committed: false,
      reason: "agreement-skipped",
    });
    expect(await context.forScope("B").state.checkpoint("B", 1)).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ B: 1 });
});

it("drains applicable edges and durably retains missing target identity before progress", async () => {
  harness.server.grants = {
    type_permissions: { "test.entry": "write" },
    edge_permissions: { "test.blocks": "write" },
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  const held = vendor();
  held.connections = [
    {
      id: "test.blocks",
      cardinality: "many-to-many",
      source_type_constraints: [testType.id],
      target_type_constraints: [testType.id],
    },
  ];
  held.read = async (context) => {
    const a = context.forScope("A");
    await a.upsert(testType.id, [
      { source_id: "target", properties: { title: "target" } },
      {
        source_id: "source",
        properties: { title: "source" },
        connections: {
          "test.blocks": [
            { type: testType.id, id: "target" },
            { type: testType.id, id: "later" },
          ],
        },
      },
    ]);
    expect(await a.state.checkpoint("A", 1)).toEqual({ committed: true });
    const source = harness.server.row("source").id;
    expect(harness.server.targetsOf(source, "test.blocks")).toEqual([
      harness.server.row("target").id,
    ]);
    expect(harness.agreement(source)).toMatchObject({
      pending: { "test.blocks": ["test.entry later"] },
    });
    expect(
      typeof (
        harness.agreement(source)?.["waiting"] as Record<string, unknown>
      )["@connect"],
    ).toBe("string");
    expect(await a.state.checkpoint("A", 2)).toEqual({ committed: true });
    throw new Error("later scope failed");
  };
  expect(await harness.once(held)).toBe(1);
  held.read = async (context) => {
    expect(context.forScope("A").state.get("A")).toBe(2);
    await context.upsert(testType.id, [
      { source_id: "later", properties: { title: "later" } },
    ]);
  };
  expect(await harness.once(held)).toBe(0);
  expect(
    harness.server.targetsOf(harness.server.row("source").id, "test.blocks"),
  ).toHaveLength(2);
  expect(
    harness.agreement(harness.server.row("source").id)?.["pending"],
  ).toBeUndefined();
});

it("treats intentional trash and unchanged purge entries as terminal no-ops", async () => {
  const held = vendor([
    { source_id: "trashed", properties: { title: "trash" } },
    {
      source_id: "purged",
      properties: { title: "purge" },
      changed_at: "2026-09-24T00:00:00Z",
    },
  ]);
  expect(await harness.once(held)).toBe(0);
  harness.server.trash(harness.server.row("trashed").id);
  harness.server.purge("purged");
  held.read = async (context) => {
    const a = context.forScope("A");
    await a.upsert(testType.id, held.entries);
    expect(await a.state.checkpoint("A", 1)).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.server.row("trashed").state).toBe("trashed");
});

it("stops every later write after the state applied but its response was lost", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A");
    expect(await a.state.checkpoint("A", 1)).toEqual({ committed: true });
    harness.server.loseStateAnswer = true;
    await expect(a.state.checkpoint("A", 2)).rejects.toThrow();
    await expect(
      context.upsert(testType.id, [
        { source_id: "late", properties: { title: "late" } },
      ]),
    ).rejects.toThrow("restart before writing");
    await expect(
      context.forScope("B").state.checkpoint("B", 1),
    ).rejects.toThrow("restart before writing");
  };
  expect(await harness.once(held), harness.lines.join("\n")).toBe(1);
  expect(harness.kept()["state"]).toEqual({ A: 2 });
  expect(
    harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
  ).toHaveLength(2);
  held.read = (context) => {
    expect(context.forScope("A").state.get("A")).toBe(2);
    return Promise.resolve();
  };
  expect(await harness.once(held)).toBe(0);
});

it("preserves the last acknowledgment after a definite state refusal", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A");
    expect(await a.state.checkpoint("A", 1)).toEqual({ committed: true });
    harness.server.refuseNext(
      "PUT /connectors/connector-1/state",
      400,
      "validation_error",
    );
    await a.state.checkpoint("A", 2);
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ A: 1 });
});

it("keeps unfinished ownership after agreements land but state is definitely refused", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A"),
      b = context.forScope("B");
    await a.upsert(testType.id, [
      { source_id: "same", properties: { title: "A" } },
    ]);
    harness.server.refuseNext(
      "PUT /connectors/connector-1/state",
      400,
      "validation_error",
    );
    await expect(a.state.checkpoint("A", 1)).rejects.toThrow();
    await b.upsert(testType.id, [
      { source_id: "same", properties: { title: "B" } },
    ]);
    expect(await b.state.checkpoint("B", 1)).toEqual({
      committed: false,
      reason: "scope-overlap",
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({});
});

it("accepts the complete 512 KiB checkpoint envelope and blocks one byte over", async () => {
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A");
    const overhead = Buffer.byteLength(
      JSON.stringify({ state: { A: "" }, conditions: {} }),
    );
    const candidate = "x".repeat(512 * 1024 - overhead);
    expect(await a.state.checkpoint("A", candidate)).toEqual({
      committed: true,
    });
    expect(Buffer.byteLength(JSON.stringify(harness.kept()))).toBe(512 * 1024);
    expect(await a.state.checkpoint("A", candidate + "x")).toEqual({
      committed: false,
      reason: "state-oversized",
    });
    throw new Error("end");
  };
  expect(await harness.once(held), harness.lines.join("\n")).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(harness.kept()))).toBe(512 * 1024);
});

it("blocks full missing-target identities that grow past the agreement cap during drain", async () => {
  harness.server.grants = {
    type_permissions: { "test.entry": "write" },
    edge_permissions: { "test.blocks": "write" },
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  const held = vendor();
  held.connections = [
    {
      id: "test.blocks",
      cardinality: "many-to-many",
      source_type_constraints: [testType.id],
      target_type_constraints: [testType.id],
    },
  ];
  held.read = async (context) => {
    const a = context.forScope("A");
    await a.upsert(testType.id, [
      {
        source_id: "source",
        properties: { title: "source" },
        connections: {
          "test.blocks": Array.from({ length: 300 }, (_, n) => ({
            type: testType.id,
            id: String(n) + "x".repeat(60),
          })),
        },
      },
    ]);
    expect(await a.state.checkpoint("A", 1)).toEqual({
      committed: false,
      reason: "agreement-oversized",
    });
    expect(await context.forScope("B").state.checkpoint("B", 1)).toEqual({
      committed: true,
    });
    expect(
      harness.server.requestsTo("POST", "/connectors/connector-1/agreements"),
    ).toHaveLength(0);
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ B: 1 });
});

it.each([{}, { state: { wrong: true }, updated_at: null }])(
  "treats malformed applied state acknowledgment %j as ambiguous",
  async (response) => {
    const held = vendor();
    held.read = async (context) => {
      const a = context.forScope("A");
      harness.server.stateAnswer = { value: response };
      await expect(a.state.checkpoint("A", 1)).rejects.toThrow(
        "invalid state acknowledgment",
      );
    };
    expect(await harness.once(held)).toBe(1);
    expect(harness.kept()["state"]).toEqual({ A: 1 });
    expect(
      harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
    ).toHaveLength(1);
  },
);

it("writes no state after a failed original state load", async () => {
  const held = vendor();
  harness.server.refuseNext(
    "GET /connectors/connector-1/state",
    500,
    "internal_error",
  );
  held.read = async (context) => {
    await context.forScope("A").state.checkpoint("A", 1);
  };
  expect(await harness.once(held)).toBe(1);
  expect(
    harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
  ).toHaveLength(0);
});
