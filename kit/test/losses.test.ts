import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionDefinition, Entry } from "../src/define.js";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One", vendor_id: "v1" } };

function kinds(held: { changes: { kind: string }[] }): string[] {
  return held.changes.map((change) => change.kind);
}

describe("a change in Marfa", () => {
  it("is not lost to a run that fails after reading the log and before recording it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    harness.server.refuseNext(
      "GET /connectors/connector-1/agreements",
      500,
      "internal",
    );
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(1);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["updated"]);
  });

  it("is not lost to a stop that comes before it is recorded", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    harness.server.beforeAnswer = (request) => {
      if (request.path.endsWith("/agreements") && request.method === "GET") {
        harness.stop();
        harness.server.beforeAnswer = undefined;
      }
    };
    held.entries = [];
    await harness.twoWay(held);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["updated"]);
  });

  it("is a purge carried on the run after one that failed before reaching it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.purge("a:1");
    held.changes.length = 0;
    held.fail = new Error("the vendor is down");
    expect(await harness.twoWay(held)).toBe(1);
    held.fail = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["purged"]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["purged"]);
  });

  it("is a restore carried where the vendor closed rather than deleted, though the vendor changed the item after it", async () => {
    const closed: Entry = {
      ...one,
      properties: { ...one.properties, note: "closed" },
      changed_at: "2026-10-01T00:00:00.000Z",
    };
    const held = vendor([one]);
    held.revive = true;
    held.answer = (change) => {
      if (change.kind !== "trashed") return undefined;
      held.entries = [closed];
      return closed;
    };
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.entries = [
      {
        ...closed,
        properties: { ...closed.properties, title: "One, commented" },
        changed_at: "2026-10-05T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["restored"]);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, commented",
    );
  });
});

describe("a link put back", () => {
  const blocks: ConnectionDefinition = {
    id: "test.blocks",
    cardinality: "many-to-many",
    source_type_constraints: ["test.entry"],
    target_type_constraints: ["test.entry"],
  };

  it("keeps what else was agreed, so the row's connections carry only what changed", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    const entry = (n: number, blocked: number[] = []): Entry => ({
      source_id: `a:${String(n)}`,
      properties: { title: `Entry ${String(n)}`, vendor_id: `v${String(n)}` },
      changed_at: "2026-09-01T00:00:00.000Z",
      connections: {
        "test.blocks": blocked.map((b) => ({
          type: "test.entry",
          id: `v${String(b)}`,
        })),
      },
    });
    const held = vendor([entry(1, [2]), entry(2), entry(3)]);
    held.connections = [blocks];
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const agreed = harness.agreement(row.id);
    harness.server.edit(row.id, { vendor_id: "changed-by-person" });
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1");
    expect(harness.agreement(row.id)).toMatchObject({
      connections: agreed?.["connections"],
      changedAt: agreed?.["changedAt"],
    });
    const three = harness.server.row("a:3");
    harness.server.drawEdge(row.id, three.id, "test.blocks");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const carried = held.changes[0]?.connections?.["test.blocks"];
    expect(carried?.added.map((item) => item.id)).toEqual([three.id]);
  });
});

describe("the state a row is in", () => {
  it("keeps a connection drawn before a trash waiting, and carries it with the restore", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
    };
    const none = { "test.blocks": [] };
    const held = vendor([
      { ...one, connections: none },
      {
        source_id: "a:3",
        properties: { title: "Three", vendor_id: "v3" },
        connections: none,
      },
    ]);
    held.connections = [
      {
        id: "test.blocks",
        cardinality: "many-to-many",
        source_type_constraints: ["test.entry"],
        target_type_constraints: ["test.entry"],
      },
    ];
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const three = harness.server.row("a:3");
    harness.server.drawEdge(row.id, three.id, "test.blocks");
    harness.server.trash(row.id);
    held.entries = [];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(kinds(held)).toEqual(["trashed"]);
    harness.server.restore(row.id);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["restored"]);
    expect(
      held.changes[0]?.connections?.["test.blocks"]?.added.map((i) => i.id),
    ).toEqual([three.id]);
  });

  it("is not carried where another row's trash took it and its restore lands after the log is read", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.cascadeTrash(row.id, "root-1");
    await harness.twoWay(held);
    harness.server.beforeAnswer = (request) => {
      if (request.path !== "/items/lookup") return;
      harness.server.restore(row.id);
      harness.server.beforeAnswer = undefined;
    };
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    const agreed = harness.agreement(row.id);
    expect(agreed?.["state"]).toBe("active");
    expect(agreed?.["stateBy"]).toBeUndefined();
    expect(agreed?.["waiting"]).toBeUndefined();
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("is taken as it stands where nothing is agreed, so an archived row's archive is not carried", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    held.entries = [];
    held.archived = ["v1"];
    await harness.twoWay(held);
    expect(harness.server.row("a:1").state).toBe("archived");
    harness.server.states.clear();
    harness.server.agreements.clear();
    held.entries = [one];
    held.archived = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("is a person's once they moved it, though they put it back in the state the connector gave it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    held.entries = [];
    held.archived = ["v1"];
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.transition(row.id, "active");
    harness.server.transition(row.id, "archived");
    held.archived = [];
    await harness.twoWay(held);
    held.entries = [one];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("archived");
  });
});

describe("what another row's trash, a lost store and a create leave", () => {
  it("does not carry a cascade that lands after the log is read, nor the restore out of it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { note: "edited" });
    harness.server.beforeAnswer = (request) => {
      if (request.path !== "/items/lookup") return;
      harness.server.cascadeTrash(row.id, "parent-1");
      harness.server.beforeAnswer = undefined;
    };
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual([]);
    harness.server.restore(row.id);
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["updated"]);
  });

  it("does not carry again a purge the log still holds once the store is lost", async () => {
    const two = {
      source_id: "a:2",
      properties: { title: "Two", vendor_id: "v2" },
    };
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [two];
    await harness.twoWay(held);
    harness.server.purge("a:1");
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(kinds(held)).toEqual(["purged"]);
    harness.server.states.clear();
    harness.server.agreements.clear();
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual([]);
  });

  it("carries an archive a person made before the row's create landed, after the create", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.pushFail = { id: row.id, error: new Error("vendor down") };
    expect(await harness.twoWay(held)).toBe(1);
    harness.server.transition(row.id, "archived");
    held.vendorIdFor = () => "v-made";
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes.map((change) => `${change.kind}:${change.item.state}`),
    ).toEqual(["created:archived", "archived:archived"]);
  });
});

describe("a row the connector archived", () => {
  it("comes back on the vendor's word though a person's edit to it was carried meanwhile", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    held.entries = [];
    held.archived = ["v1"];
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { note: "a note made in Marfa" });
    held.archived = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["updated"]);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "a note made in Marfa" },
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("active");
  });

  it("comes back on the vendor's word though the log is read again from before the archive", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { starred: true });
    held.entries = [];
    held.archived = ["v1"];
    harness.server.refuseNext(
      "PUT /connectors/connector-1/state",
      503,
      "unavailable",
    );
    await harness.twoWay(held);
    expect(harness.agreement(row.id)?.["stateBy"]).toBe("vendor");
    held.archived = [];
    await harness.twoWay(held);
    held.entries = [one];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("active");
  });
});

describe("a kind that revives", () => {
  it("leaves in the bin a row another row's trash took, since that trash never reached the vendor", async () => {
    const held = vendor([one]);
    held.revive = true;
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.cascadeTrash(row.id, "parent-1");
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "a comment at the vendor" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");
  });
});

describe("a purge kept for a type no longer declared", () => {
  it("is dropped with a condition, rather than fail every run", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const kept = harness.server.states.get("test") ?? {};
    harness.server.states.set("test", {
      ...kept,
      purges: [
        {
          id: "0190a000-0000-7000-8000-00000000c0de",
          type: "test.comment",
          state: "trashed",
          properties: { comment_id: "c1" },
          source: "test",
          source_id: "a:c1",
          version: 1,
          created_at: "2026-09-25T00:00:00.000Z",
          updated_at: "2026-09-25T00:00:00.000Z",
          occurred_at: "2026-09-25T00:00:00.000Z",
        },
      ],
    });
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().summary).toContain(
      "no longer declares test.comment",
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual([]);
  });
});

describe("a create that may have reached the vendor", () => {
  it("still says so after the row is trashed and restored before it was linked", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.pushFail = { id: row.id, error: new Error("socket hang up") };
    expect(await harness.twoWay(held)).toBe(1);
    harness.server.trash(row.id);
    expect(await harness.twoWay(held)).toBe(0);
    harness.server.restore(row.id);
    held.changes.length = 0;
    held.vendorIdFor = () => "v-made";
    expect(await harness.twoWay(held)).toBe(0);
    const created = held.changes.find((change) => change.kind === "created");
    expect(created?.attempted).toBeDefined();
  });
});

describe("a person's change around a link the run wrote", () => {
  it("is carried on the next run, where the run failed after writing the link", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(row.id);
    const remade: Entry = {
      ...one,
      properties: { ...one.properties, vendor_id: "v1-again" },
    };
    held.gone = new Map([[row.id, "v1-again"]]);
    held.duringRemake = () => {
      harness.server.edit(row.id, { note: "done" });
      held.duringRemake = undefined;
    };
    held.entries = [remade];
    held.failAfter = new Error("the vendor went away");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(1);
    expect(held.remakes?.map(({ change }) => [...change.changed])).toEqual([
      [],
    ]);
    expect(harness.server.row("a:1").properties).toMatchObject({
      note: "done",
      vendor_id: "v1-again",
    });
    expect(held.changes).toEqual([]);

    held.failAfter = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["updated", ["note"]]]);
    expect(harness.server.row("a:1").properties["note"]).toBe("done");
  });

  it("is carried on the next run, where the run failed after linking a create", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = (change) => {
      if (change.item.id !== theirs.id) return undefined;
      harness.server.edit(theirs.id, { note: "done" });
      return "v-theirs";
    };
    held.entries = [
      {
        source_id: "a:theirs",
        properties: { title: "Theirs", vendor_id: "v-theirs" },
      },
    ];
    held.failAfter = new Error("the vendor went away");
    expect(await harness.twoWay(held)).toBe(1);
    expect(
      held.changes.map((change) => [
        change.kind,
        change.item.properties["note"],
      ]),
    ).toEqual([["created", undefined]]);
    expect(harness.server.byId(theirs.id).properties).toMatchObject({
      note: "done",
      vendor_id: "v-theirs",
    });

    held.failAfter = undefined;
    held.vendorIdFor = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["updated", ["note"]]]);
    expect(harness.server.byId(theirs.id).properties["note"]).toBe("done");
  });
});

describe("a restore of a row whose trash was carried", () => {
  it("is not archived by the vendor's close of it, where it lands after the log is read", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(kinds(held)).toEqual(["trashed"]);
    held.archived = ["v1"];
    const streams = harness.server.requestsTo("GET", "/events").length;
    let afterLog = false;
    harness.server.beforeAnswer = (request) => {
      if (request.path !== "/items/lookup") return;
      afterLog = harness.server.requestsTo("GET", "/events").length > streams;
      harness.server.restore(row.id);
      harness.server.beforeAnswer = undefined;
    };
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(afterLog).toBe(true);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/archived 0, .*skipped 1/);
    expect(harness.server.row("a:1").state).toBe("active");

    held.archived = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held)).toEqual(["restored"]);
    expect(harness.server.row("a:1").state).toBe("active");
  });
});
