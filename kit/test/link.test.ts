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
  it("writes the vendor's id onto a row's link property, and the write is the connector's own", async () => {
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

describe("a vendor that lists every entry", () => {
  it("makes no conflict of a change in Marfa where its entry has not changed since the two sides agreed", async () => {
    // Stamped long before the connector's own write.
    const listed = { ...one, changed_at: "2026-09-01T00:00:00.000Z" };
    const held = vendor([listed]);
    expect(await harness.twoWay(held)).toBe(0);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    // The same entry again, as a vendor that lists everything sends it.
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    expect(harness.lastRun().summary).toMatch(
      /^created 0, updated 0, archived 0, unchanged 0, skipped 0, pushed 1, own 1, conflicts 0$/,
    );

    // The vendor's copy of the carried change comes back under a new
    // time; a second edit made since is carried too, and no conflict.
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by a person" },
        changed_at: "2026-09-25T00:00:30.000Z",
      },
    ];
    harness.server.edit(row.id, { title: "One, by a person, twice" });
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person, twice",
    );
    expect(
      held.changes.map((change) => change.item.properties["title"]),
    ).toEqual(["One, by a person, twice"]);
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 0, conflicts 0$/);

    // The witness: an entry stamped after the agreement is a conflict.
    harness.server.edit(row.id, { title: "One, by a person again" });
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: new Date(
          Date.parse(harness.server.row("a:1").updated_at) + 60_000,
        ).toISOString(),
      },
    ];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
  });
});

describe("a row the connector wrote before its link existed", () => {
  it("is not carried to the vendor, and is linked by the vendor's entry as it comes", async () => {
    // Written by the one-way connector, so it carries no link value.
    expect(
      await harness.once(
        vendor([{ source_id: "a:1", properties: { title: "One" } }]),
      ),
    ).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties["vendor_id"]).toBeUndefined();

    // The two-way connector's first run replays the create; the vendor's
    // entry carries the link and finds the row by its natural key.
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.rows).toHaveLength(1);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1");
    expect(harness.lastRun().summary).toContain(
      "1 row the connector wrote before its link existed is not carried to the vendor",
    );

    // Linked, its next change is carried like any other.
    harness.server.edit(row.id, { title: "One, by a person" });
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    // The condition is not raised again, and the run says it cleared.
    expect(harness.lastRun().summary).not.toContain("before its link existed");
    expect(harness.lines).toContainEqual(
      expect.stringContaining(
        "cleared: 1 row the connector wrote before its link existed",
      ),
    );
  });
});

describe("a row restored after its trash was carried back", () => {
  it("is not archived on the vendor's deletion, and the restore is carried", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);

    // The vendor lists the entry as deleted, which is what the carried
    // trash asked of it; the person has restored the row since.
    harness.server.restore(row.id);
    held.archived = ["v1"];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").state).toBe("active");
    expect(held.changes.map((change) => change.kind)).toEqual(["restored"]);
    expect(harness.lastRun().summary).toMatch(/archived 0, .*skipped 1/);

    // The witness: with no restore pending, the vendor's deletion archives.
    held.archived = ["v1"];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(harness.lastRun().summary).toMatch(/archived 1/);
  });
});

describe("a restored row the vendor may no longer have", () => {
  it("is offered to remake before the vendor is read, and carried after the read where the vendor still has it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.transition(row.id, "archived");
    await harness.twoWay(held);
    harness.server.transition(row.id, "active");
    held.changes.length = 0;
    const runs = held.runs;
    await harness.twoWay(held);
    expect(held.remakes?.map((r) => [r.change.kind, r.runsBefore])).toEqual([
      ["restored", runs],
    ]);
    expect(held.changes.map((change) => change.kind)).toEqual(["restored"]);
  });

  it("is made again before the read where the vendor no longer has it, and not carried again after", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    held.gone = new Map([[row.id, "v1-again"]]);
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes).toEqual([]);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
      "v1-again",
    );
    expect(harness.server.byId(row.id).state).toBe("active");
    expect(harness.lastRun().summary).toMatch(/pushed 1/);
  });

  it("is offered to remake when edited after the restore, as an update that says so", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await harness.twoWay(held);
    harness.server.restore(row.id);
    harness.server.edit(row.id, { title: "One, back and edited" });
    held.changes.length = 0;
    await harness.twoWay(held);
    const offered = held.remakes?.at(-1)?.change;
    expect([offered?.kind, offered?.restored]).toEqual(["updated", true]);
    expect(
      held.changes.map((change) => [change.kind, change.restored]),
    ).toEqual([["updated", true]]);

    // A trash after the edit is a trash, with nothing to make again.
    harness.server.restore(row.id);
    harness.server.edit(row.id, { title: "One, again" });
    harness.server.trash(row.id);
    held.changes.length = 0;
    const offers = held.remakes?.length ?? 0;
    await harness.twoWay(held);
    expect(held.remakes?.length ?? 0).toBe(offers);
    expect(
      held.changes.map((change) => [change.kind, change.restored]),
    ).toEqual([["trashed", undefined]]);
  });
});

describe("what the two sides agree on, after each kind of agreement", () => {
  it("is the vendor's entry as written, so listing it again after an edit in Marfa is no conflict", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    // The vendor changes the entry, and the change is written.
    const changed = {
      ...one,
      properties: { ...one.properties, title: "One, by the vendor" },
      changed_at: "2026-09-27T00:00:00.000Z",
    };
    held.entries = [changed];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    // A person edits the row; the vendor lists the same entry again.
    harness.server.edit(harness.server.row("a:1").id, {
      title: "One, by a person",
    });
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    // The write of the vendor's change is read back as the connector's own.
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 1, conflicts 0$/);
  });

  it("is the vendor's entry as found unchanged, which a row made in Marfa gains once the vendor lists it", async () => {
    // Made in Marfa and carried: what was agreed on is the row without
    // its link, until the vendor's listing of it, link and all, is found
    // unchanged and becomes the agreement.
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    const held = vendor([]);
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-theirs" : undefined;
    expect(await harness.twoWay(held)).toBe(0);
    held.entries = [
      {
        source_id: "v-theirs",
        properties: { title: "Theirs", vendor_id: "v-theirs" },
        changed_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().summary).toMatch(/unchanged 1/);
    // A person edits the row; the vendor lists the same entry again.
    harness.server.edit(theirs.id, { title: "Theirs, by a person" });
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(theirs.id).properties["title"]).toBe(
      "Theirs, by a person",
    );
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 0, conflicts 0$/);
  });
});

describe("a row relinked by the vendor's entry", () => {
  it("is not found under its old value in the same run", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    // The vendor now lists the entry under a new id, and deletes the old
    // one: the row moves to the new id, and the deletion finds nothing.
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, vendor_id: "v1-new" },
        changed_at: "2026-09-27T00:00:00.000Z",
      },
    ];
    held.archived = ["v1"];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1-new");
    expect(harness.server.row("a:1").state).toBe("active");
    expect(harness.lastRun().summary).toMatch(/updated 1, archived 0/);
  });
});
