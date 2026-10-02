import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change, Entry } from "../src/define.js";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One", vendor_id: "v1" } };
const two = { source_id: "a:2", properties: { title: "Two", vendor_id: "v2" } };
const plain = { source_id: "a:1", properties: { title: "One" } };
const other = { source_id: "a:2", properties: { title: "Two" } };

function lookups(): Record<string, unknown>[] {
  return harness.server
    .requestsTo("POST", "/items/lookup")
    .map((request) => request.body as Record<string, unknown>);
}

function kinds(changes: readonly Change[]): string[] {
  return changes.map(
    (change) => `${change.kind} ${change.item.source_id ?? ""}`,
  );
}

describe("the rows a run reads", () => {
  it("are those its entries and the log name, by one lookup each, never the type's listing", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    held.entries = [
      { ...two, properties: { ...two.properties, title: "Two, later" } },
    ];
    held.changes.length = 0;
    const before = lookups().length;
    const listed = harness.server.requestsTo("GET", "/items").length;
    expect(await harness.twoWay(held)).toBe(0);
    expect(lookups().slice(before)).toEqual([
      { type: "test.entry", ids: [row.id] },
      { type: "test.entry", links: ["v2"] },
    ]);
    expect(harness.server.requestsTo("GET", "/items")).toHaveLength(listed);
    expect(kinds(held.changes)).toEqual(["updated a:1"]);
    expect(harness.server.row("a:2").properties["title"]).toBe("Two, later");
  });
});

describe("a purge", () => {
  it("holds against the vendor's unchanged entry once the connector's store is lost", async () => {
    await harness.once(vendor([plain, other]));
    harness.server.row("a:1").state = "trashed";
    harness.server.purge("a:1");
    harness.server.states.clear();
    harness.server.agreements.clear();
    expect(await harness.once(vendor([plain, other]))).toBe(0);
    expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:2"]);
    expect(harness.lastRun().summary).toContain("unchanged 1, skipped 1");
  });

  it("carried to the vendor is remembered past the vendor's own change carrying it made", async () => {
    const closedAt = "2026-10-01T00:00:00.000Z";
    const held = vendor([one]);
    held.answer = (change) =>
      change.kind === "purged"
        ? {
            ...one,
            properties: { ...one.properties, note: "closed" },
            changed_at: closedAt,
          }
        : undefined;
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.purge("a:1");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["purged a:1"]);
    expect(
      harness.server.requestsTo("POST", "/items/tombstones").map((r) => r.body),
    ).toEqual([
      { type: "test.entry", settled_at: closedAt, links: ["v1"] },
      {
        type: "test.entry",
        settled_at: closedAt,
        source: "test",
        source_ids: ["a:1"],
      },
    ]);

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "closed" },
        changed_at: closedAt,
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toEqual([]);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "reopened" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").id).not.toBe(row.id);
    expect(harness.server.row("a:1").properties["note"]).toBe("reopened");
  });
});

describe("a cascade", () => {
  it("carries neither the trash another row's trash made nor the restore out of it, and keeps what changed before it", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const taken = harness.server.row("a:1");
    const own = harness.server.row("a:2");
    harness.server.edit(taken.id, { title: "One, by a person" });
    harness.server.cascadeTrash(taken.id, "root-1");
    harness.server.trash(own.id);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["trashed a:2"]);
    expect(harness.agreement(taken.id)).toMatchObject({
      state: "trashed",
      stateBy: "cascade",
    });

    harness.server.restore(taken.id);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["updated a:1"]);
    expect([...(held.changes[0]?.changed ?? [])]).toEqual(["title"]);
  });

  it("carries no purge of a row another row's trash took", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const taken = harness.server.row("a:1");
    const own = harness.server.row("a:2");
    harness.server.cascadeTrash(taken.id, "root-1");
    harness.server.trash(own.id);
    await harness.twoWay(held);
    harness.server.purge("a:1");
    harness.server.purge("a:2");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(kinds(held.changes)).toEqual(["purged a:2"]);
  });
});

describe("a kind that revives", () => {
  const closedAt = "2026-10-01T00:00:00.000Z";
  const closed: Entry = {
    ...one,
    properties: { ...one.properties, note: "closed" },
    changed_at: closedAt,
  };

  it("brings a row back when the vendor changes it after its trash reached the vendor, and never on its own close", async () => {
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
    expect(kinds(held.changes)).toEqual(["trashed a:1"]);

    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "reopened" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("active");
    expect(harness.server.row("a:1").properties["note"]).toBe("reopened");
    expect(harness.lastRun().summary).toContain(
      `the vendor changed ${row.id} while it was in the bin, so it was brought back`,
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("never takes a derived field for the vendor's activity, and gives it to the row once the row comes back", async () => {
    const held = vendor([one]);
    held.revive = true;
    held.readOnly = ["note"];
    held.derived = ["note"];
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    held.changes.length = 0;

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "where it sits" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(held.changes).toEqual([]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");

    held.entries = [
      {
        ...one,
        properties: {
          ...one.properties,
          title: "Reopened",
          note: "where it sits",
        },
        changed_at: "2026-10-03T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("active");
    expect(harness.server.row("a:1").properties["note"]).toBe("where it sits");
  });

  it("sets a derived field on the rows held, and not on one in the bin", async () => {
    const held = vendor([one, two]);
    held.revive = true;
    held.readOnly = ["note"];
    held.derived = ["note"];
    await harness.twoWay(held);
    harness.server.trash(harness.server.row("a:2").id);
    await harness.twoWay(held);
    held.derive = { keys: ["v1", "v2"], values: { note: "unreadable" } };
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["note"]).toBe("unreadable");
    expect(harness.server.row("a:2").properties["note"]).toBeUndefined();
    const version = harness.server.row("a:1").version;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").version).toBe(version);
    held.derive = { keys: ["v1"], values: { title: "No" } };
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      "declares no derived field title",
    );
  });

  it("brings a row back as the vendor has it, its close among the fields, and carries nothing", async () => {
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
    held.entries = [
      {
        ...closed,
        properties: { ...closed.properties, title: "Commented on" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("active");
    expect(harness.server.row("a:1").properties).toMatchObject({
      title: "Commented on",
      note: "closed",
    });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("leaves a row in the bin whose trash still waits to be carried", async () => {
    const held = vendor([one]);
    held.revive = true;
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "edited at the vendor" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(kinds(held.changes)).toEqual(["trashed a:1"]);
  });

  it("leaves a row in the bin that a person trashed again after restoring it, before the restore was carried", async () => {
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
    harness.server.beforeAnswer = (request) => {
      if (request.path !== "/items/lookup") return;
      harness.server.trash(row.id);
      harness.server.beforeAnswer = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "reopened" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(held.changes).toEqual([]);
  });

  it("is a choice: a kind that does not revive keeps the row in the bin", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "reopened" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("trashed");
  });
});

describe("a row the connector archived", () => {
  it("comes back when the vendor sends it again, where one a person archived stays", async () => {
    const held = vendor([plain, other]);
    await harness.once(held);
    held.entries = [plain];
    held.archived = ["a:2"];
    await harness.once(held);
    expect(harness.server.row("a:2").state).toBe("archived");
    harness.server.transition(harness.server.row("a:1").id, "archived");

    held.entries = [plain, other];
    held.archived = [];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.row("a:2").state).toBe("active");
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(harness.lastRun().summary).toContain("updated 1");
  });
});

function relinkedRows(kept: Record<string, unknown>): string[] {
  const held = kept["relinked"] as { rows?: object } | undefined;
  return Object.keys(held?.rows ?? {});
}

describe("a purge of a row whose link a person changed before its trash", () => {
  it("is carried by the link agreed with the vendor, which a restore lets go", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const first = harness.server.row("a:1").id;
    harness.server.edit(first, { vendor_id: "v-other" });
    harness.server.trash(first);
    held.entries = [two];
    await harness.twoWay(held);
    harness.server.purge("a:1");
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const purge = held.changes.find((change) => change.kind === "purged");
    expect(purge?.item.properties["vendor_id"]).toBe("v1");

    const second = harness.server.row("a:2").id;
    harness.server.edit(second, { vendor_id: "v-other" });
    harness.server.trash(second);
    await harness.twoWay(held);
    const relinked = () => relinkedRows(harness.kept());
    expect(relinked()).toEqual([second]);
    harness.server.restore(second);
    await harness.twoWay(held);
    expect(relinked()).toEqual([]);
  });

  it("is not carried where the link was changed, the row trashed and purged between two runs, and the run names it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1").id;
    harness.server.edit(row, { vendor_id: "v-other" });
    harness.server.trash(row);
    harness.server.purge("a:1");
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toContain(
      `the purge of ${row} is not carried`,
    );
  });

  it("is carried where the row was trashed and purged between two runs with its link untouched", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1").id;
    harness.server.trash(row);
    harness.server.purge("a:1");
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes.map((change) => [
        change.kind,
        change.item.properties["vendor_id"],
      ]),
    ).toEqual([["purged", "v1"]]);
  });

  it("past what the kit keeps, is not carried by the row's own link, and the run names it", async () => {
    const many = Array.from({ length: 1001 }, (_, at) => ({
      source_id: `m:${String(at)}`,
      properties: { title: `Many ${String(at)}`, vendor_id: `m${String(at)}` },
    }));
    const held = vendor(many);
    await harness.twoWay(held);
    for (const entry of many) {
      const id = harness.server.row(entry.source_id).id;
      harness.server.edit(id, { vendor_id: `other-${entry.source_id}` });
      harness.server.trash(id);
    }
    held.entries = [];
    await harness.twoWay(held);
    expect(relinkedRows(harness.kept())).toHaveLength(1000);
    for (const entry of many) harness.server.purge(entry.source_id);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const purged = held.changes.filter((change) => change.kind === "purged");
    expect(purged).toHaveLength(1000);
    expect(
      purged.every((change) =>
        /^m\d+$/.test(String(change.item.properties["vendor_id"])),
      ),
    ).toBe(true);
    expect(harness.lastRun().summary).toMatch(
      /the purge of \S+ is not carried/,
    );
  }, 120_000);

  it("lets go of what it kept for a row purged while the log was out of reach", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1").id;
    harness.server.edit(row, { vendor_id: "v-other" });
    harness.server.trash(row);
    held.entries = [];
    await harness.twoWay(held);
    expect(relinkedRows(harness.kept())).toEqual([row]);
    harness.server.purge("a:1");
    harness.server.tooOld = true;
    await harness.twoWay(held);
    harness.server.tooOld = false;
    expect(harness.kept()["relinked"]).toBeUndefined();
  });

  it("goes by the agreed link where a put-back failed partway through the run that read the link's change", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const first = harness.server.row("a:1").id;
    const second = harness.server.row("a:2").id;
    harness.server.edit(first, { vendor_id: "v-first-other" });
    harness.server.edit(second, { vendor_id: "v-second-other" });
    harness.server.refuseNext(`PATCH /items/${first}`, 500, "internal");
    held.entries = [];
    await harness.twoWay(held);
    harness.server.trash(second);
    harness.server.purge("a:2");
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(
      held.changes
        .filter((change) => change.item.id === second)
        .map((change) => [change.kind, change.item.properties["vendor_id"]]),
    ).toEqual([["purged", "v2"]]);
  });
});
