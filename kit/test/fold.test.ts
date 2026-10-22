import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

function entry(key: string, link: string, extra: object = {}) {
  return {
    source_id: key,
    properties: { title: "One", vendor_id: link },
    changed_at: "2026-09-26T00:00:00.000Z",
    ...extra,
  };
}

/** The older row under the old link, then the vendor's new entry read before
 *  the move was known: a second row under the new link. */
async function twoRows(held: Vendor) {
  held.entries = [entry("old", "v-old")];
  expect(await harness.twoWay(held)).toBe(0);
  held.entries = [entry("new", "v-new")];
  expect(await harness.twoWay(held)).toBe(0);
  const older = harness.server.row("old");
  const duplicate = harness.server.row("new");
  expect(harness.server.rows).toHaveLength(2);
  return { older: older.id, duplicate: duplicate.id };
}

function moved(): ReturnType<typeof entry> {
  return entry("new", "v-new", { movedFrom: "v-old" });
}

describe("a row the vendor moved, whose new link already has a row", () => {
  it("keeps the older row with its edits and archives the duplicate", async () => {
    const held = vendor();
    held.mergeMoved = true;
    const { older, duplicate } = await twoRows(held);
    harness.server.edit(older, { note: "mine" });
    held.entries = [moved()];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    const kept = harness.server.byId(older);
    expect(kept.state).toBe("active");
    expect(kept.properties["vendor_id"]).toBe("v-new");
    expect(kept.properties["note"]).toBe("mine");
    const gone = harness.server.byId(duplicate);
    expect(gone.state).toBe("archived");
    expect(gone.properties["vendor_id"]).toBe("v-old");
    expect(harness.lastRun().summary).toMatch(/archived 1/);
    expect(held.changes.map((change) => [change.item.id, change.kind])).toEqual(
      [[older, "updated"]],
    );
    expect(harness.problems()).toEqual({});
  });

  it("changes nothing on a second run", async () => {
    const held = vendor();
    held.mergeMoved = true;
    await twoRows(held);
    held.entries = [moved()];
    expect(await harness.twoWay(held)).toBe(0);
    const rows = structuredClone(harness.server.rows);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toEqual(rows);
    expect(harness.lastRun().summary).toMatch(
      /^created 0, updated 0, archived 0/,
    );
  });

  it("leaves both rows and says why where the duplicate was edited in Marfa", async () => {
    const held = vendor();
    held.mergeMoved = true;
    const { older, duplicate } = await twoRows(held);
    harness.server.edit(duplicate, { note: "a person's" });
    held.entries = [moved()];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(older).state).toBe("active");
    expect(harness.server.byId(older).properties["vendor_id"]).toBe("v-old");
    expect(harness.server.byId(duplicate).state).toBe("active");
    expect(harness.server.byId(duplicate).properties["note"]).toBe(
      "a person's",
    );
    const problem = harness.problems()[`duplicate:${duplicate}`];
    expect(problem).toContain(older);
    expect(problem).toContain(duplicate);
    expect(problem).toContain("note");
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.server.byId(older).state).toBe("active");
  });

  it("leaves both rows where a person made the row holding the new link", async () => {
    const held = vendor();
    held.mergeMoved = true;
    held.entries = [entry("old", "v-old")];
    expect(await harness.twoWay(held)).toBe(0);
    const theirs = harness.server.insert(
      undefined,
      { title: "One", vendor_id: "v-new" },
      "test.entry",
      "person",
    );
    held.entries = [moved()];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(theirs.id).state).toBe("active");
    expect(harness.server.row("old").properties["vendor_id"]).toBe("v-old");
    expect(harness.problems()[`duplicate:${theirs.id}`]).toContain("no record");
  });

  it("puts the duplicate's link back where the older row could not take it", async () => {
    const held = vendor();
    held.mergeMoved = true;
    const { older, duplicate } = await twoRows(held);
    held.entries = [moved()];
    harness.server.refuseNext(
      `PATCH /items/${older}`,
      422,
      "invalid_properties",
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(older).properties["vendor_id"]).toBe("v-old");
    expect(harness.server.byId(duplicate).properties["vendor_id"]).toBe(
      "v-new",
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(older).properties["vendor_id"]).toBe("v-new");
    expect(harness.server.byId(duplicate).state).toBe("archived");
  });

  it("is left as it was where the type does not ask to merge", async () => {
    const held = vendor();
    const { older, duplicate } = await twoRows(held);
    held.entries = [
      { ...moved(), properties: { title: "Two", vendor_id: "v-new" } },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(older).properties["vendor_id"]).toBe("v-old");
    expect(harness.server.byId(older).state).toBe("active");
    expect(harness.server.byId(duplicate).properties["title"]).toBe("Two");
    expect(harness.problems()).toEqual({});
  });
});
