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

describe("a purge the vendor refuses", () => {
  it("is kept and asked again next run, until the vendor takes it", async () => {
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
    expect(conditions()[`change-refused:${row.id}`]).toContain(
      "the account may not delete",
    );
    expect(harness.kept()["purges"]).toHaveLength(1);

    held.refused = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    expect(harness.kept()["purges"]).toBeUndefined();
    expect(conditions()).toEqual({});
  });
});
