import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const noted = {
  source_id: "a:1",
  properties: { title: "One", note: "Kept note", vendor_id: "v1" },
};

const conditions = (): Record<string, string> =>
  (harness.kept()["conditions"] ?? {}) as Record<string, string>;

describe("a change the vendor refuses", () => {
  it("is not agreed, keeps the edit over the vendor's next read, and says why until a later change lands", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });
    held.refused = new Map([[first.id, "the title is not allowed"]]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(held.changes.map((change) => change.item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(Object.keys(conditions())).toEqual([`change-refused:${first.id}`]);
    expect(conditions()[`change-refused:${first.id}`]).toContain(
      "the title is not allowed",
    );

    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.byId(first.id).properties["title"]).toBe(
      "One, edited",
    );
    expect(Object.keys(conditions())).toEqual([`change-refused:${first.id}`]);

    held.refused = undefined;
    harness.server.edit(first.id, { title: "One, edited again" });
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes.map((change) => [change.item.id, [...change.changed]]),
    ).toEqual([[first.id, ["title"]]]);
    expect(conditions()).toEqual({});
    expect(harness.agreement(first.id)?.["refused"]).toBeUndefined();

    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("to create leaves the row unlinked and makes it once the row changes", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.refused = new Map([[made.id, "the list is full"]]);
    held.vendorIdFor = () => "v9";
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["created"]);
    expect(
      harness.server.byId(made.id).properties["vendor_id"],
    ).toBeUndefined();

    held.refused = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(Object.keys(conditions())).toEqual([`change-refused:${made.id}`]);

    harness.server.edit(made.id, { title: "Made in Marfa, shorter" });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["created"]);
    expect(harness.server.byId(made.id).properties["vendor_id"]).toBe("v9");
    expect(conditions()).toEqual({});
  });

  it("to make a restored row again is not carried as an edit, and is asked again once the row changes", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.entries = [];
    held.gone = new Map([[row.id, "v1-again"]]);
    held.refused = new Map([[row.id, "the project is archived"]]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(held.remakes).toHaveLength(1);
    expect(conditions()[`change-refused:${row.id}`]).toContain(
      "the project is archived",
    );

    held.refused = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.remakes).toHaveLength(1);
    expect(held.changes).toEqual([]);

    harness.server.edit(row.id, { title: "One, back" });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.remakes).toHaveLength(2);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
      "v1-again",
    );
    expect(conditions()).toEqual({});
  });
});

describe("what a refusal remembers", () => {
  it("tells a clear from the value it cleared, so a clear after a refused edit is sent", async () => {
    const held = vendor([noted]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, edited" });
    held.refused = new Map([[row.id, "nope"]]);
    await harness.twoWay(held);
    held.refused = undefined;
    harness.server.rewrite("a:1", { title: "One, edited", vendor_id: "v1" });
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes.map((change) => [...change.changed].sort())).toEqual([
      ["note", "title"],
    ]);
  });

  it("sends a field put back after a refused edit that cleared it", async () => {
    const held = vendor([noted]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.rewrite("a:1", { title: "One, edited", vendor_id: "v1" });
    held.refused = new Map([[row.id, "nope"]]);
    await harness.twoWay(held);
    held.refused = undefined;
    harness.server.edit(row.id, { note: "Kept note" });
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes.map((change) => [...change.changed])).toEqual([
      ["title"],
    ]);
  });

  it("is forgotten once the row is undone in Marfa, so the same edit made again is sent", async () => {
    const held = vendor([noted]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, edited" });
    held.refused = new Map([[row.id, "nope"]]);
    await harness.twoWay(held);
    held.refused = undefined;
    held.entries = [];
    harness.server.edit(row.id, { title: "One" });
    await harness.twoWay(held);
    expect(harness.agreement(row.id)?.["refused"]).toBeUndefined();
    expect(conditions()).toEqual({});
    harness.server.edit(row.id, { title: "One, edited" });
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes).toHaveLength(1);
  });

  it("is handed to the change sent after it, and to no other", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.refused = new Map([[made.id, "the list is full"]]);
    await harness.twoWay(held);
    held.refused = undefined;
    harness.server.edit(made.id, { title: "Made, again" });
    held.vendorIdFor = () => "v9";
    await harness.twoWay(held);
    const [first, second] = held.changes;
    expect(first?.refused).toBeUndefined();
    expect(typeof second?.refused).toBe("string");
    harness.server.edit(made.id, { title: "Made, once more" });
    await harness.twoWay(held);
    expect(held.changes[2]?.refused).toBeUndefined();
  });

  it("keeps its reason within 200 bytes", async () => {
    const held = vendor([noted]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, edited" });
    held.refused = new Map([[row.id, "é".repeat(400)]]);
    await harness.twoWay(held);
    const refused = harness.agreement(row.id)?.["refused"] as {
      reason: string;
    };
    expect(Buffer.byteLength(refused.reason)).toBeLessThanOrEqual(200);
    expect(refused.reason.startsWith("é".repeat(90))).toBe(true);
  });

  it("never makes an agreement too large to keep: the reason goes first", async () => {
    const held = vendor([noted]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const kept = harness.server.agreements.get(row.id);
    if (kept === undefined) throw new Error("nothing agreed");
    kept.record = {
      ...kept.record,
      file: { key: "k".repeat(16 * 1024 - 400), ref: "r", mime: "text/plain" },
    };
    harness.server.edit(row.id, { title: "One, edited" });
    held.refused = new Map([[row.id, "r".repeat(150)]]);
    await harness.twoWay(held);
    const record = harness.agreement(row.id);
    expect(record?.["waiting"]).toBeDefined();
    const refused = record?.["refused"] as Record<string, unknown>;
    expect(Object.keys(refused)).toEqual(["change"]);
    expect(conditions()[`change-refused:${row.id}`]).toBeDefined();
    held.refused = undefined;
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes).toEqual([]);
  });

  it("names a refused trash as waiting for the row's restore", async () => {
    const held = vendor([noted]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.refused = new Map([[row.id, "the account may not delete"]]);
    await harness.twoWay(held);
    expect(conditions()[`change-refused:${row.id}`]).toBe(
      `the trash of ${row.id} was refused, so it waits until the row is restored in Marfa: the account may not delete`,
    );
  });
});

describe("a purge the vendor refuses", () => {
  it("is kept, says so every run, and is asked again a day later, until the vendor takes it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.purge("a:1");
    held.refused = new Map([[row.id, "the account may not delete"]]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    const said = conditions()[`change-refused:${row.id}`];
    expect(said).toContain("the account may not delete");
    expect(harness.kept()["purges"]).toHaveLength(1);

    held.refused = undefined;
    held.changes.length = 0;
    harness.clock.advance(23 * 3_600_000);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(conditions()[`change-refused:${row.id}`]).toBe(said);

    harness.clock.advance(3_600_000);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    expect(held.changes[0]?.item).not.toHaveProperty("refused");
    expect(harness.kept()["purges"]).toBeUndefined();
    expect(conditions()).toEqual({});
  });
});
