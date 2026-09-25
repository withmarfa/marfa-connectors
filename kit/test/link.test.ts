import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = {
  source_id: "a:1",
  properties: { title: "One", vendor_id: "v1" },
  changed_at: "2026-09-26T00:00:00.000Z",
};

function patches() {
  return harness.server.requests.filter(
    (request) => request.method === "PATCH",
  );
}

describe("a person's row of the type", () => {
  it("is found by its link and updated, never created a second time", async () => {
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs", vendor_id: "v1" },
      "test.entry",
      "person",
    );
    const held = vendor([
      {
        source_id: "a:1",
        properties: { title: "One, from the vendor", vendor_id: "v1" },
        // Later than the person's create, so the vendor's word wins.
        changed_at: "2026-09-26T00:00:00.000Z",
      },
    ]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
    const row = harness.server.byId(theirs.id);
    expect(row.source).toBe("person");
    expect(row.version).toBe(2);
    expect(row.properties).toEqual({
      title: "One, from the vendor",
      vendor_id: "v1",
    });
    expect(harness.lastRun().summary).toMatch(/^created 0, updated 1/);
  });

  it("is archived by its link value", async () => {
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs", vendor_id: "v1" },
      "test.entry",
      "person",
    );
    const held = vendor([]);
    held.archived = ["v1"];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(theirs.id).state).toBe("archived");
    expect(harness.lastRun().summary).toMatch(/archived 1/);
  });
});

describe("the connector's own row", () => {
  it("is found by its natural key when it predates the link, and linked by the write", async () => {
    harness.server.insert("a:1", { title: "One" }, "test.entry");
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      vendor_id: "v1",
    });
    expect(harness.lastRun().summary).toMatch(/^created 0, updated 1/);
  });

  it("is created under the connector's source with its link, and its events are its own", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.source).toBe("test");
    expect(row.properties["vendor_id"]).toBe("v1");

    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/own 1/);
  });
});

describe("setLink", () => {
  it("writes the vendor's id onto a row's link field, and the write is the connector's own", async () => {
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    const held = vendor([]);
    held.vendorIdFor = (change) =>
      change.kind === "created" ? "v-theirs" : undefined;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["created"]);
    expect(harness.server.byId(theirs.id).properties).toEqual({
      title: "Theirs",
      vendor_id: "v-theirs",
    });
    // Laid over the row's properties, not replacing them.
    expect(patches()[0]?.body).toMatchObject({
      version: 1,
      properties: { vendor_id: "v-theirs" },
    });
    expect(
      (patches()[0]?.body as { properties_mode?: string }).properties_mode,
    ).toBeUndefined();

    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 1/);
  });

  it("retries once at the current version when the row moved since the change", async () => {
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    // The row moves as the first write is on its way and the write is
    // refused as colliding, so the retry has to name the version the row
    // moved to: one at the version the change showed would be stale too.
    harness.server.beforeAnswer = (request) => {
      if (request.method === "PATCH" && request.path.endsWith(theirs.id)) {
        harness.server.edit(theirs.id, { title: "Theirs, moved" });
        harness.server.beforeAnswer = undefined;
      }
    };
    harness.server.refuseNext(
      `PATCH /items/${theirs.id}`,
      409,
      "version_conflict",
    );
    const held = vendor([]);
    held.vendorIdFor = () => "v-theirs";
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      patches().map((request) => (request.body as { version: number }).version),
    ).toEqual([1, 2]);
    expect(harness.server.byId(theirs.id).properties).toEqual({
      title: "Theirs, moved",
      vendor_id: "v-theirs",
    });
    expect(harness.server.byId(theirs.id).version).toBe(3);
  });

  it("refuses a value another row of the type carries, naming both", async () => {
    const holder = harness.server.insert(
      undefined,
      { title: "Holder", vendor_id: "v-taken" },
      "test.entry",
      "person",
    );
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    const held = vendor([]);
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-taken" : undefined;
    expect(await harness.twoWay(held)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain(holder.id);
    expect(harness.lastRun().error).toContain(theirs.id);
    expect(
      harness.server.byId(theirs.id).properties["vendor_id"],
    ).toBeUndefined();
    expect(patches()).toHaveLength(0);
  });
});

describe("a row the vendor has not been told about", () => {
  it("is carried before the vendor is read, so a run that failed after the vendor answered makes no twin", async () => {
    const held = vendor([]);
    expect(await harness.twoWay(held)).toBe(0);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    // The vendor makes its copy and answers an id, then the write of that
    // id onto the row is refused, so the run fails with the vendor ahead
    // of Marfa.
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-theirs" : undefined;
    harness.server.refuseNext(`PATCH /items/${theirs.id}`, 503, "unavailable");
    expect(await harness.twoWay(held)).toBe(1);
    expect(
      harness.server.byId(theirs.id).properties["vendor_id"],
    ).toBeUndefined();

    // The vendor now lists what it made. Read first, that would be a new
    // entry and a second row; carried first, the row is linked and the
    // entry finds it.
    held.entries = [
      {
        source_id: "v-theirs",
        properties: { title: "Theirs", vendor_id: "v-theirs" },
        changed_at: "2026-09-24T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(
      harness.server.rows.filter(
        (row) => row.properties["vendor_id"] === "v-theirs",
      ),
    ).toHaveLength(1);
    expect(harness.server.byId(theirs.id).properties["vendor_id"]).toBe(
      "v-theirs",
    );
    expect(held.changes.map((change) => change.kind)).toEqual([
      "created",
      "created",
    ]);
    expect(harness.lastRun().summary).toMatch(
      /^created 0, updated 0, archived 0, unchanged 1, skipped 0, pushed 1/,
    );
  });

  it("is carried before the rest, which follow the vendor's read in log order", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    const mine = harness.server.row("a:1");
    harness.server.edit(mine.id, { title: "One, edited" });
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-theirs" : undefined;
    held.changes.length = 0;
    // The vendor sends nothing this run, so the edit is not contested.
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    // The edit was logged before the create, and is carried after it.
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [
        ["created", theirs.id],
        ["updated", mine.id],
      ],
    );
  });
});
