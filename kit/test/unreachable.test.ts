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

describe("a change the vendor cannot be reached for", () => {
  it("waits, while the run carries the rest, reads the vendor and says why", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });
    held.unreachable = new Set([first.id]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(harness.lastRun().summary).toContain(
      `${first.id} cannot be reached`,
    );

    held.unreachable = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      held.changes.map((change) => [change.item.id, [...change.changed]]),
    ).toEqual([[first.id, ["title"]]]);
  });

  it("to create keeps its first try's time for the next", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const made = harness.server.insert(
      undefined,
      { title: "Made in Marfa" },
      "test.entry",
      "person",
    );
    held.unreachable = new Set([made.id]);
    expect(await harness.twoWay(held)).toBe(0);
    held.unreachable = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    const [retried] = held.changes;
    expect(retried?.kind).toBe("created");
    expect(typeof retried?.attempted).toBe("string");
  });

  it("to make a restored row again waits for the next run, which offers it again", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.entries = [];
    held.gone = new Map([[row.id, "v1-again"]]);
    held.unreachable = new Set([row.id]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toContain(`${row.id} cannot be reached`);
    held.unreachable = undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
      "v1-again",
    );
  });
});

describe("a remake", () => {
  it("is told its first try's time on the next, so what that try made is found rather than made twice", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.entries = [];
    held.gone = new Map([[row.id, "v1-again"]]);
    held.remakeFail = { id: row.id, error: new Error("the answer was lost") };
    expect(await harness.twoWay(held)).toBe(1);
    expect(await harness.twoWay(held)).toBe(0);
    const [first, second] = held.remakes ?? [];
    expect(first?.change.attempted).toBeUndefined();
    expect(typeof second?.change.attempted).toBe("string");
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
      "v1-again",
    );
  });

  it("that makes nothing leaves no first try behind", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    await harness.twoWay(held);
    expect(harness.server.agreements.get(row.id)?.record["attempted"]).toBe(
      undefined,
    );
  });
});

describe("a purge the vendor cannot be reached for", () => {
  it("waits, while the run carries the other purges and succeeds", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.trash(first.id);
    harness.server.trash(second.id);
    held.entries = [];
    await harness.twoWay(held);
    harness.server.purge("a:1");
    harness.server.purge("a:2");
    held.unreachable = new Set([first.id]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(held.changes.map((change) => change.item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    held.unreachable = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["purged", first.id]],
    );
  });
});

describe("a remake the vendor could not be reached for", () => {
  it("leaves no first try behind once the row is back in the bin", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.entries = [];
    held.gone = new Map([[row.id, "v1-again"]]);
    held.unreachable = new Set([row.id]);
    await harness.twoWay(held);
    harness.server.trash(row.id);
    await harness.twoWay(held);
    held.unreachable = undefined;
    harness.server.restore(row.id);
    held.remakes = [];
    await harness.twoWay(held);
    expect(held.remakes.map((remake) => remake.change.attempted)).toEqual([
      undefined,
    ]);
  });
});

describe("changes waiting on one scope", () => {
  it("raise one condition, saying how many wait, cleared once they are carried", async () => {
    const three = {
      source_id: "a:3",
      properties: { title: "Three", vendor_id: "v3" },
    };
    const held = vendor([one, two, three]);
    await harness.twoWay(held);
    const ids = ["a:1", "a:2", "a:3"].map((id) => harness.server.row(id).id);
    for (const id of ids) harness.server.edit(id, { title: "Edited" });
    const [first = "", second = "", third = ""] = ids;
    held.unreachableIn = new Map([
      [first, "the shelf"],
      [second, "the shelf"],
    ]);
    held.unreachable = new Set([third]);
    expect(await harness.twoWay(held)).toBe(0);
    const summary = harness.lastRun().summary ?? "";
    expect(summary).toContain("2 changes wait: the shelf cannot be reached");
    expect(summary.match(/the shelf/g)).toHaveLength(1);
    expect(summary).toContain(`${third} cannot be reached`);
    const raised = () =>
      Object.keys(harness.kept()["conditions"] as Record<string, string>);
    expect(raised().sort()).toEqual(
      ["unreachable-in:the shelf", `unreachable:${third}`].sort(),
    );

    held.unreachableIn = undefined;
    held.unreachable = undefined;
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id).sort()).toEqual(
      [...ids].sort(),
    );
    expect(raised()).toEqual([]);
    expect(
      harness.lines.some((line) =>
        line.includes("cleared: 2 changes wait: the shelf"),
      ),
    ).toBe(true);
  });
});

describe("a change the vendor is not to take", () => {
  it("puts back an edit, says why, and is not tried again", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited", note: "A note" });
    harness.server.edit(second.id, { title: "Two, edited" });
    held.declined = new Set([first.id]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(harness.server.byId(first.id).properties["title"]).toBe("One");
    expect(harness.server.byId(first.id).properties["note"]).toBeUndefined();
    expect(harness.server.byId(second.id).properties["title"]).toBe(
      "Two, edited",
    );
    expect(harness.lastRun().summary).toContain(
      `${first.id} is not the vendor's to take; title, note were put back`,
    );
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("leaves a trash in Marfa alone, says why, and carries the restore", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.declined = new Set([row.id]);
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);
    expect(harness.server.byId(row.id).state).toBe("trashed");
    expect(harness.lastRun().summary).toContain(
      `${row.id} is not the vendor's to take`,
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toHaveLength(1);
    held.declined = undefined;
    harness.server.restore(row.id);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual([
      "trashed",
      "restored",
    ]);
  });

  it("to make a restored row again leaves it restored in Marfa, and says why", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.entries = [];
    held.gone = new Map([[row.id, "v1-again"]]);
    held.declined = new Set([row.id]);
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().summary).toContain(
      `${row.id} is not the vendor's to take`,
    );
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.remakes).toHaveLength(1);
    expect(held.changes).toEqual([]);
    expect(harness.server.byId(row.id).state).toBe("active");
  });
});
