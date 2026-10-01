import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, linkedType, vendor } from "./harness.js";

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

  it("is refused by the server where another row of the type carries the value, naming both", async () => {
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
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-theirs" : undefined;
    harness.server.refuseNext(`PATCH /items/${theirs.id}`, 503, "unavailable");
    expect(await harness.twoWay(held)).toBe(1);
    expect(
      harness.server.byId(theirs.id).properties["vendor_id"],
    ).toBeUndefined();

    // Read first, that would be a new entry and a second row; carried first,
    // the row is linked and the entry finds it.
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
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
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
    const listed = { ...one, changed_at: "2026-09-01T00:00:00.000Z" };
    const held = vendor([listed]);
    expect(await harness.twoWay(held)).toBe(0);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    expect(harness.lastRun().summary).toMatch(
      /^created 0, updated 0, archived 0, unchanged 1, skipped 0, pushed 1, own 1, conflicts 0$/,
    );

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

describe("a row the connector wrote before it declared a link", () => {
  it("starts once its type names the link, and is linked by the vendor's entry by its natural key, not carried as a create", async () => {
    expect(
      await harness.once(
        vendor([{ source_id: "a:1", properties: { title: "One" } }]),
      ),
    ).toBe(0);
    const row = harness.server.row("a:1");
    expect(row.properties["vendor_id"]).toBeUndefined();

    const held = vendor([one]);
    expect(await harness.twoWay(held)).not.toBe(0);
    expect(harness.lines.join("\n")).toContain(
      'link_field is "vendor_id" here and nothing on the server',
    );
    harness.server.types.set(linkedType.id, { ...linkedType });
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.rows).toHaveLength(1);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1");

    harness.server.edit(row.id, { title: "One, by a person" });
    held.entries = [];
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
  });

  it("is not found by its natural key for an entry naming another of the vendor's items", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    held.entries = [
      { ...one, properties: { ...one.properties, vendor_id: "v-other" } },
    ];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1");
    expect(harness.server.rows).toHaveLength(1);
    expect(harness.lastRun().summary).toContain(
      "a row linked to another of the vendor's items holds its natural key",
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

    harness.server.restore(row.id);
    held.archived = ["v1"];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").state).toBe("active");
    expect(held.changes.map((change) => change.kind)).toEqual(["restored"]);
    expect(harness.lastRun().summary).toMatch(/archived 0, .*skipped 1/);

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
    held.entries = [];
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

  it("is offered to remake with the fields edited after the restore, and carried as a restore that names them", async () => {
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
    expect([offered?.kind, [...(offered?.changed ?? [])]]).toEqual([
      "restored",
      ["title"],
    ]);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["restored", ["title"]]]);

    harness.server.restore(row.id);
    harness.server.edit(row.id, { title: "One, again" });
    harness.server.trash(row.id);
    held.changes.length = 0;
    const offers = held.remakes?.length ?? 0;
    await harness.twoWay(held);
    expect(held.remakes?.length ?? 0).toBe(offers);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["trashed", []]]);
  });
});

describe("what the two sides agree on, after each kind of agreement", () => {
  it("is the vendor's entry as written, so listing it again after an edit in Marfa is no conflict", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
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
    harness.server.edit(harness.server.row("a:1").id, {
      title: "One, by a person",
    });
    held.changes.length = 0;
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 1, conflicts 0$/);
  });

  it("is the vendor's entry as found unchanged, which a row made in Marfa gains once the vendor lists it", async () => {
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

describe("a row the vendor moved, relinked by its entry", () => {
  it("is not found under its old value in the same run", async () => {
    const held = vendor([one]);
    expect(await harness.twoWay(held)).toBe(0);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, vendor_id: "v1-new" },
        changed_at: "2026-09-27T00:00:00.000Z",
        movedFrom: "v1",
      },
    ];
    held.archived = ["v1"];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1-new");
    expect(harness.server.row("a:1").state).toBe("active");
    expect(harness.lastRun().summary).toMatch(/updated 1, archived 0/);
  });
});

describe("a link put back", () => {
  it("that another row took meanwhile waits with a condition, and the run goes on", async () => {
    const two = {
      source_id: "a:2",
      properties: { title: "Two", vendor_id: "v2" },
    };
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await harness.twoWay(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { vendor_id: "v9" });
    harness.server.edit(second.id, { vendor_id: "v1" });
    held.entries = [];
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().summary).toContain(
      `the vendor_id of ${first.id} was changed in Marfa and cannot be put back`,
    );
    expect(harness.server.byId(second.id).properties["vendor_id"]).toBe("v2");
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.byId(first.id).properties["vendor_id"]).toBe("v1");
  });
});
