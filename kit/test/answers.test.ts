import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entry } from "../src/define.js";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One", vendor_id: "v1" } };

describe("a row back from the bin", () => {
  it("has a field the vendor cleared meanwhile cleared", async () => {
    const held = vendor([
      { ...one, properties: { ...one.properties, note: "x" } },
    ]);
    held.revive = true;
    await harness.twoWay(held);
    harness.server.trash(harness.server.row("a:1").id);
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "Reopened" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.state).toBe("active");
    expect(row.properties["title"]).toBe("Reopened");
    expect(row.properties["note"]).toBeUndefined();
  });

  it("keeps a person's edit not yet carried, as no conflict, where the vendor never changed it", async () => {
    const closed: Entry = {
      ...one,
      properties: { ...one.properties, note: "closed" },
      changed_at: "2026-09-24T00:00:00.000Z",
    };
    const held = vendor([one]);
    held.revive = true;
    held.answer = (change) => {
      if (change.kind !== "trashed") return undefined;
      held.entries = [closed];
      return closed;
    };
    await harness.twoWay(held);
    const id = harness.server.row("a:1").id;
    harness.server.edit(id, { title: "Mine" });
    harness.server.trash(id);
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "reopened" },
        changed_at: "2026-09-24T01:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const summary = harness.lastRun().summary;
    expect(harness.server.row("a:1").properties["title"]).toBe("Mine");
    expect(summary).toContain("conflicts 0");
  });

  it("keeps it where the vendor's time is later than the return", async () => {
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
    const id = harness.server.row("a:1").id;
    harness.server.edit(id, { title: "Mine" });
    harness.server.trash(id);
    await harness.twoWay(held);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, note: "reopened" },
        changed_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe("Mine");
  });
});

describe("an answer written onto the row", () => {
  const made = async (held: ReturnType<typeof vendor>) => {
    held.readOnly = ["note"];
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = () => "v9";
    return row;
  };
  const answer = (change: {
    item: { properties: Record<string, unknown> };
  }) => ({
    source_id: "a:9",
    properties: {
      ...change.item.properties,
      vendor_id: "v9",
      note: "number 9",
    },
  });

  it("leaves a person's edit to a carried field made during the carry, still to carry", async () => {
    const held = vendor([]);
    const row = await made(held);
    held.answer = (change) => {
      harness.server.edit(row.id, { title: "Edited meanwhile" });
      return answer(change);
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(row.id).properties).toMatchObject({
      title: "Edited meanwhile",
      note: "number 9",
    });
    held.changes.length = 0;
    held.answer = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((c) => [...c.changed])).toEqual([["title"]]);
  });

  it("has a person's edit to a read-only field during the carry put back, and named", async () => {
    const held = vendor([]);
    const row = await made(held);
    held.answer = (change) => {
      harness.server.edit(row.id, { note: "person's" });
      return answer(change);
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(row.id).properties["note"]).toBe("number 9");
    expect(harness.lastRun().summary).toContain("put back");
  });

  it("lands on a later listing where the write was refused", async () => {
    const held = vendor([]);
    const row = await made(held);
    held.answer = (change) => {
      harness.server.refuseNext(
        `PATCH /items/${row.id}`,
        409,
        "version_conflict",
      );
      harness.server.refuseNext(
        `PATCH /items/${row.id}`,
        409,
        "version_conflict",
      );
      return answer(change);
    };
    await harness.twoWay(held);
    expect(harness.server.byId(row.id).properties["note"]).toBeUndefined();
    held.answer = undefined;
    held.entries = [
      {
        source_id: "a:9",
        properties: {
          title: "Made in Marfa",
          vendor_id: "v9",
          note: "number 9",
        },
      },
    ];
    await harness.twoWay(held);
    await harness.twoWay(held);
    expect(harness.server.byId(row.id).properties["note"]).toBe("number 9");
  });

  it("stays across later runs with nothing from the vendor", async () => {
    const held = vendor([]);
    const row = await made(held);
    held.answer = answer;
    await harness.twoWay(held);
    held.answer = undefined;
    held.vendorIdFor = undefined;
    await harness.twoWay(held);
    await harness.twoWay(held);
    expect(harness.server.byId(row.id).properties["note"]).toBe("number 9");
    expect(harness.lastRun().summary).not.toContain("put back");
  });

  it("clears a field the answer states as null", async () => {
    const held = vendor([
      {
        ...one,
        properties: { ...one.properties, note: "closed", link: "closed-at" },
      },
    ]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.answer = (change) => ({
      source_id: "a:1",
      properties: { ...change.item.properties, note: "reopened", link: null },
    });
    expect(await harness.twoWay(held)).toBe(0);
    held.answer = undefined;
    held.entries = [
      { ...one, properties: { ...one.properties, note: "reopened" } },
    ];
    await harness.twoWay(held);
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["note"]).toBe("reopened");
    expect(harness.server.row("a:1").properties["link"]).toBeUndefined();
  });

  it("replaces a read-only field a person typed into a row they made", async () => {
    const held = vendor([]);
    held.readOnly = ["note"];
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Made in Marfa", note: "typed by a person" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = () => "v9";
    held.answer = answer;
    await harness.twoWay(held);
    const after = harness.server.byId(row.id).properties["note"];
    held.answer = undefined;
    held.vendorIdFor = undefined;
    held.entries = [
      {
        source_id: "a:9",
        properties: {
          title: "Made in Marfa",
          vendor_id: "v9",
          note: "number 9",
        },
      },
    ];
    await harness.twoWay(held);
    await harness.twoWay(held);
    expect([after, harness.server.byId(row.id).properties["note"]]).toEqual([
      "number 9",
      "number 9",
    ]);
  });

  it("is counted as an update", async () => {
    const held = vendor([]);
    await made(held);
    held.answer = answer;
    await harness.twoWay(held);
    expect(harness.lastRun().summary).toMatch(/updated [1-9]/);
  });
});

describe("an answer meeting a person's write", () => {
  it("is retried at the row's new version, not held", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "Edited" });
    held.entries = [];
    held.answer = (change) => {
      harness.server.edit(row.id, { note: "the person's", link: "x" });
      return {
        source_id: "a:1",
        properties: {
          ...change.item.properties,
          note: "the vendor's",
          link: "y",
        },
      };
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["note"]).toBe("the person's");
    expect(harness.lastRun().summary).toContain("skipped 0");
  });
});
