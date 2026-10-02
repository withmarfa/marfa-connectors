import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

describe("a row of a type without a link, moved to another natural key", () => {
  it("is found by the key it was known by, takes the entry's, and is never created twice", async () => {
    const held = vendor([{ source_id: "old:1", properties: { title: "One" } }]);
    expect(await harness.once(held)).toBe(0);
    const { id, version } = harness.server.row("old:1");
    held.entries = [
      { source_id: "new:1", properties: { title: "One" }, movedFrom: "old:1" },
    ];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
    const after = harness.server.row("new:1");
    expect(after.id).toBe(id);
    expect(after.version).toBe(version + 1);
    expect(harness.lastRun().summary).toMatch(/^created 0, updated 1/);
    held.entries = [{ source_id: "new:1", properties: { title: "One" } }];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
    expect(harness.lastRun().summary).toMatch(/^created 0, updated 0/);
  });

  it("updates the row under its own key where both keys hold one, and leaves the other alone", async () => {
    const held = vendor([
      { source_id: "old:1", properties: { title: "Old" } },
      { source_id: "new:1", properties: { title: "New" } },
    ]);
    expect(await harness.once(held)).toBe(0);
    held.entries = [
      {
        source_id: "new:1",
        properties: { title: "New, changed" },
        movedFrom: "old:1",
      },
    ];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.server.row("new:1").properties["title"]).toBe(
      "New, changed",
    );
    expect(harness.server.row("old:1").properties["title"]).toBe("Old");
  });
});
