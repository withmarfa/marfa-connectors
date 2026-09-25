import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = {
  source_id: "a:1",
  properties: { title: "One", note: "first", vendor_id: "v1" },
  occurred_at: "2026-09-01T10:00:00.000Z",
};
const two = {
  source_id: "a:2",
  properties: { title: "Two", vendor_id: "v2" },
};

function streams() {
  return harness.server.requestsTo("GET", "/events");
}

async function watchState(): Promise<{
  cursor?: string;
  written: Record<string, { version: number; state: string }>;
}> {
  const stored = (await harness.stateFile()) as {
    watch?: { cursor?: string; written: Record<string, never> };
  };
  return stored.watch ?? { written: {} };
}

/** A run of the two-way connector whose vendor sends nothing new. */
async function quietRun(held: Vendor): Promise<number> {
  held.changes.length = 0;
  return harness.twoWay(held);
}

describe("the events request", () => {
  it("is sent by a connector with onChange, and not by one without", async () => {
    await harness.once(vendor([one]));
    expect(streams()).toHaveLength(0);
    // The witness: the same run with a push sends one.
    await harness.twoWay(vendor([one]));
    expect(streams()).toHaveLength(1);
    expect(streams()[0]?.query.get("type")).toBe("test.entry");
    expect(streams()[0]?.query.get("edges")).toBe("none");
    expect(streams()[0]?.headers["last-event-id"]).toBe("0");
  });
});

describe("the cursor", () => {
  it("is kept at the head read and advanced by the next run", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    // Nothing was in the log when the read was made: the head was 0.
    expect((await watchState()).cursor).toBe("0");

    expect(await quietRun(held)).toBe(0);
    // The two creates were read, both the connector's own.
    expect((await watchState()).cursor).toBe(String(harness.server.head));
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 2, conflicts 0/);
    expect(held.changes).toHaveLength(0);
    expect(streams()[1]?.headers["last-event-id"]).toBe("0");

    // The next read resumes from where the last one reached.
    await quietRun(held);
    expect(streams()[2]?.headers["last-event-id"]).toBe(
      String(harness.server.head),
    );
  });

  it("is committed only when every push landed, and held with the run failed when one throws", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const before = (await watchState()).cursor;
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, by a person" });
    harness.server.edit(second.id, { title: "Two, by a person" });

    // The vendor sends nothing while the pushes are tried, so what the
    // runs do is the log's alone.
    held.entries = [];
    held.pushFail = { id: second.id, error: new Error("the vendor is down") };
    expect(await quietRun(held)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("the vendor is down");
    expect(held.changes.map((change) => change.item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect((await watchState()).cursor).toBe(before);

    // The one that did not land is offered again; the one that did is
    // remembered as carried, and the cursor moves once every push lands.
    expect(await quietRun(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
    expect((await watchState()).cursor).toBe(String(harness.server.head));
  });
});

describe("what is carried back", () => {
  it("is a row of the type under another source, and not another type or a subtype", async () => {
    harness.server.types.set("test.sub", {
      id: "test.sub",
      parent: "test.entry",
      fields: {},
    });
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    harness.server.insert(
      undefined,
      { title: "Other" },
      "test.other",
      "person",
    );
    harness.server.insert(undefined, { title: "Sub" }, "test.sub", "person");
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );

    await quietRun(held);
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["created", theirs.id]],
    );
  });

  it("is a later version of a row, never the connector's own", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { note: "by a person" });

    await quietRun(held);
    expect(
      held.changes.map((change) => [change.kind, change.item.version]),
    ).toEqual([["updated", 2]]);
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 1/);
  });

  it("is a person's transition at the connector's own version", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.transition(row.id, "archived");

    await quietRun(held);
    expect(
      held.changes.map((change) => [change.kind, change.item.state]),
    ).toEqual([["archived", "archived"]]);
  });

  it("is one change per row, the latest kind with the latest row", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });
    harness.server.edit(first.id, { title: "One, edited twice" });
    harness.server.trash(first.id);

    await quietRun(held);
    // In the order of each row's latest frame: the second row's edit, then
    // the first row's trash.
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [
        ["updated", second.id],
        ["trashed", first.id],
      ],
    );
    expect(held.changes[1]?.item.properties["title"]).toBe("One, edited twice");
    expect(held.changes[1]?.item.state).toBe("trashed");
  });

  it("is every row once after a lost state, created only where the vendor has no id, and nothing on the run after", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    await quietRun(held);
    expect(held.changes).toHaveLength(1);

    await rm(join(harness.stateDir, "test.json"));
    await quietRun(held);
    const kinds = new Map(
      held.changes.map((change) => [change.item.id, change.kind]),
    );
    expect(kinds).toEqual(
      new Map([
        [harness.server.row("a:1").id, "updated"],
        [harness.server.row("a:2").id, "updated"],
        [theirs.id, "created"],
      ]),
    );

    await quietRun(held);
    expect(held.changes).toHaveLength(0);
  });

  it("is every row once, with a condition, when the log no longer holds the cursor", async () => {
    harness.server.types.set("test.sub", {
      id: "test.sub",
      parent: "test.entry",
      fields: {},
    });
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    // Listed under the type's filter with the rest, and not the
    // connector's to carry.
    harness.server.insert(undefined, { title: "Sub" }, "test.sub", "person");

    harness.server.tooOld = true;
    await quietRun(held);
    expect(held.changes.map((change) => change.kind).sort()).toEqual([
      "updated",
      "updated",
    ]);
    expect(held.changes.map((change) => change.item.type)).toEqual([
      "test.entry",
      "test.entry",
    ]);
    expect(harness.lastRun().summary).toContain("every row of the type");
    expect((await watchState()).cursor).toBe(String(harness.server.head));

    harness.server.tooOld = false;
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
  });
});

describe("a read that ends early", () => {
  it("keeps what it read when the server ends the stream, and continues next run", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });

    // The vendor sends nothing, so what is carried back is the log's alone.
    held.entries = [];
    harness.server.incompleteAfter = 1;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([first.id]);
    expect((await watchState()).cursor).toBe(String(harness.server.head - 1));

    harness.server.incompleteAfter = undefined;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
  });

  it("keeps what it read when the request times out, and continues next run", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });

    // The stream stalls after the first frame, never saying it is live,
    // so nothing but the request's own timeout ends the read; what was
    // read stands and the cursor is the last id received.
    held.entries = [];
    harness.server.stallAfter = 1;
    harness.requestTimeoutMs = 200;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([first.id]);
    expect((await watchState()).cursor).toBe(String(harness.server.head - 1));
    expect(harness.lines).toContainEqual(
      expect.stringContaining("the read timed out"),
    );

    harness.server.stallAfter = undefined;
    harness.requestTimeoutMs = 5000;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
  });

  it("ends at the marker and adopts its cursor, past a frame it was never sent", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });

    // The head is another type's frame, which this reader is never sent.
    // The marker names it all the same, so the read ends there and the
    // next run resumes past it.
    harness.server.insert(
      undefined,
      { title: "Other" },
      "test.other",
      "person",
    );
    held.entries = [];
    expect(await quietRun(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect((await watchState()).cursor).toBe(String(harness.server.head));
    // The read was whole, so nothing is deferred to the next run.
    expect(harness.lines).not.toContainEqual(
      expect.stringContaining("is read next run"),
    );

    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(streams().at(-1)?.headers["last-event-id"]).toBe(
      String(harness.server.head),
    );
  });

  it("keeps the last id read where the marker names no position", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    // A server whose head read outran its budget sends the marker with no
    // cursor; the read still ends there, and resumes from the last frame.
    harness.server.liveCursorNull = true;
    expect(await quietRun(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([row.id]);
    expect((await watchState()).cursor).toBe(String(harness.server.head));
  });

  it("fails the run and holds the cursor when the events request is refused", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const before = (await watchState()).cursor;
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    harness.server.refuseNext("GET /events", 503, "unavailable");
    expect(await quietRun(held)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(held.changes).toEqual([]);
    expect((await watchState()).cursor).toBe(before);
    // The witness: the next run reads the change.
    expect(await quietRun(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([row.id]);
  });
});

describe("a row changed on both sides", () => {
  it("takes the vendor's change where it is the later one, and carries nothing back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const edited = harness.server.edit(row.id, { title: "One, by a person" });
    const later = new Date(
      Date.parse(edited.updated_at) + 60_000,
    ).toISOString();

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: later,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
    expect(harness.lastRun().summary).toContain("the vendor's change");
  });

  it("keeps the change made in Marfa where it is the later one, and carries it back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const edited = harness.server.edit(row.id, { title: "One, by a person" });
    const earlier = new Date(
      Date.parse(edited.updated_at) - 60_000,
    ).toISOString();

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: earlier,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["updated", row.id]],
    );
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
    expect(harness.lastRun().summary).toContain("the change made in Marfa");
  });

  it("gives a vendor that names no time the loss", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes).toHaveLength(1);
  });

  it("still lets a trash in Marfa win over the vendor, and carries the trash back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    const later = new Date(Date.parse(row.updated_at) + 60_000).toISOString();

    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: later,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(harness.server.row("a:1").properties["title"]).toBe("One");
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);
    expect(harness.lastRun().summary).toMatch(/skipped 1/);
  });
});

describe("a row changed between the read and the write", () => {
  it("is written again over the person's change where the vendor's is later", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    const later = new Date(Date.parse(row.updated_at) + 120_000).toISOString();
    harness.server.afterList = () => {
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: later,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    // The first write merged over the person's note; the vendor's, later,
    // is then written whole over the row as it now stands.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by the vendor",
      note: "first",
      vendor_id: "v1",
    });
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/updated 1, .*conflicts 1/);
    expect(harness.lastRun().summary).not.toContain("held");
  });

  it("is put back whole where the person's change is later, and carried back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    const earlier = new Date(
      Date.parse(row.updated_at) - 120_000,
    ).toISOString();
    harness.server.afterList = () => {
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: earlier,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    // The merge is undone whole: the row as the person left it, at a new
    // version the connector wrote and does not carry back as a change of
    // its own; the person's state goes to the vendor instead.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      note: "by a person, since the read",
      vendor_id: "v1",
    });
    expect(
      held.changes.map((change) => [
        change.kind,
        change.item.properties["note"],
      ]),
    ).toEqual([["updated", "by a person, since the read"]]);
    expect(harness.lastRun().summary).not.toContain("held");
    expect((await watchState()).written[row.id]?.version).toBe(
      harness.server.row("a:1").version,
    );
  });

  it("carries the person's row back where the write was refused and the person's change is later", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    const earlier = new Date(
      Date.parse(row.updated_at) - 120_000,
    ).toISOString();
    harness.server.afterList = () => {
      harness.server.edit(row.id, {
        title: "One, by a person, since the read",
      });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: earlier,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person, since the read",
    );
    expect(
      held.changes.map((change) => change.item.properties["title"]),
    ).toEqual(["One, by a person, since the read"]);
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
    expect(harness.lastRun().summary).not.toContain("held");
  });
});

describe("what the memory holds", () => {
  it("carries a person's restore back after the trash it carried, and an archive undone", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);

    // The restore moves no version, so it stands at the version the trash
    // was carried back at.
    harness.server.restore(row.id);
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["restored"]);

    harness.server.transition(row.id, "archived");
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["archived"]);
    harness.server.transition(row.id, "active");
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["restored"]);
  });

  it("keeps the record of a write that landed when another held the run", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    // One write lands, one is refused: the state is held.
    harness.server.refuseNext(
      `PATCH /items/${harness.server.row("a:2").id}`,
      400,
      "invalid_properties",
    );
    held.entries = [
      { ...one, properties: { ...one.properties, title: "One, changed" } },
      { ...two, properties: { ...two.properties, title: "Two, changed" } },
    ];
    await quietRun(held);
    expect(harness.lastRun().summary).toContain("held");

    // The write that landed is the connector's own, and is not carried
    // back on the run after.
    held.entries = [];
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/own 1/);
  });

  it("carries a person's change back where the read was cut short before showing it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });

    // The stream never says it is live and the request times out before
    // the edit's frame arrives, so the read shows nothing; the row's
    // version is past the connector's last write all the same.
    harness.server.withholdLive = true;
    harness.server.beforeAnswer = async (request) => {
      if (request.path === "/events") {
        // Long enough that the request's timeout ends the read first.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    };
    harness.requestTimeoutMs = 200;
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
      },
    ];
    await quietRun(held);
    harness.server.beforeAnswer = undefined;
    harness.requestTimeoutMs = 5000;
    expect(harness.lines).toContainEqual(
      expect.stringContaining("the read timed out"),
    );
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["updated", row.id]],
    );
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
  });

  it("decides a row by the times after a lost state, where the log shows the connector's own create as anybody's", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const written = harness.server.row("a:1").updated_at;
    await rm(join(harness.stateDir, "test.json"));
    // The replay from the start of the log shows the connector's own create
    // with no memory to know it by, so the row reads as changed in Marfa
    // and the later change wins: the vendor's, here, being after the
    // create. A vendor naming no time loses that one round.
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, changed at the vendor" },
        changed_at: new Date(Date.parse(written) + 60_000).toISOString(),
      },
    ];
    await quietRun(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, changed at the vendor",
    );
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
  });

  it("drops a person's earlier change when the connector's own later write superseded it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const edited = harness.server.edit(row.id, { title: "One, by a person" });
    const later = new Date(
      Date.parse(edited.updated_at) + 60_000,
    ).toISOString();
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: later,
      },
    ];
    await quietRun(held);
    expect(held.changes).toHaveLength(0);

    // A read from the start of the log shows the person's edit before the
    // connector's write over it. The edit is from before the two sides
    // last agreed and the write is the connector's: neither is carried,
    // and the earlier frame does not make the later one read as
    // somebody else's.
    const file = join(harness.stateDir, "test.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      watch: { cursor?: string };
    };
    delete stored.watch.cursor;
    await writeFile(file, JSON.stringify(stored));
    held.entries = [];
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 3/);
  });
});

describe("a row purged or transitioned in Marfa", () => {
  it("is not created again while the vendor still has it; the purge is carried back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    harness.server.purgeById(row.id);

    await quietRun(held);
    expect(harness.server.rows).toHaveLength(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    expect(harness.lastRun().summary).toMatch(/created 0, .*skipped 1/);
  });

  it("takes the vendor's properties and still carries the transition back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.transition(row.id, "archived");
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
      },
    ];
    await quietRun(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(held.changes.map((change) => change.kind)).toEqual(["archived"]);
    expect(harness.lastRun().summary).toMatch(/conflicts 0/);
  });

  it("is created to the vendor when a person made it and edited it before the run", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    harness.server.edit(theirs.id, { title: "Theirs, edited" });
    await quietRun(held);
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["created", theirs.id]],
    );
  });

  it("is the connector's own after it archived the row", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    held.archived = ["v1"];
    held.entries = [];
    await quietRun(held);
    expect(harness.lastRun().summary).toMatch(/archived 1/);
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/own 1/);
  });
});

describe("a stop during the pushes", () => {
  it("fails the run and holds the cursor, so the rest are offered again", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });
    const before = (await watchState()).cursor;

    held.entries = [];
    held.changes.length = 0;
    held.vendorIdFor = (change) => {
      if (change.item.id === first.id) harness.stop();
      return undefined;
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(held.changes.map((change) => change.item.id)).toEqual([first.id]);
    expect((await watchState()).cursor).toBe(before);
  });
});

describe("a resync", () => {
  it("reads the head before the rows, so a change landing between the two is not lost", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");

    harness.server.tooOld = true;
    harness.server.afterList = () => {
      harness.server.edit(row.id, { title: "One, edited during the resync" });
      harness.server.afterList = undefined;
    };
    held.entries = [];
    await quietRun(held);
    harness.server.tooOld = false;
    // The edit's event sits past the cursor the resync committed.
    await quietRun(held);
    expect(
      held.changes.map((change) => change.item.properties["title"]),
    ).toEqual(["One, edited during the resync"]);
  });
});

describe("the snapshot a merge is judged by", () => {
  it("is the one that left the version, after a transition wrote one of its own", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    // A transition writes a snapshot of the version without moving it,
    // before the person's edit writes the one that leaves it.
    harness.server.transition(row.id, "archived");
    harness.server.transition(row.id, "active");
    await quietRun(held);
    const vendorChange = new Date(
      Date.parse(harness.server.row("a:1").updated_at) + 60_000,
    ).toISOString();
    harness.server.afterList = () => {
      // An hour on, so the edit is later than the vendor's change while
      // the transitions' snapshots are earlier than it.
      harness.server.advance(3_600_000);
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: vendorChange,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    // The person's edit came after the vendor's change: the row is put back
    // and carried back; a snapshot taken at the transition's earlier moment
    // would have let the vendor win.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      note: "by a person, since the read",
      vendor_id: "v1",
    });
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
  });
});

describe("a tie between the two sides", () => {
  it("goes to the change made in Marfa", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    const edited = harness.server.edit(row.id, { title: "One, by a person" });
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: edited.updated_at,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by a person",
    );
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);
  });
});

describe("what echoes after a conflict", () => {
  // Each case ends with a quiet run: the connector's own last write is
  // read back, and it is nobody else's.
  it("is nothing, where the vendor won over a person's edit made between the read and the pull", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.beforeAnswer = (request) => {
      if (request.method === "GET" && request.path === "/items") {
        harness.server.edit(row.id, { note: "by a person" });
        harness.server.beforeAnswer = undefined;
      }
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: "2027-01-01T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);

    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 2, conflicts 0/);
  });

  it("is nothing, after a put-back", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    const earlier = new Date(
      Date.parse(row.updated_at) - 120_000,
    ).toISOString();
    harness.server.afterList = () => {
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: earlier,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["updated"]);

    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 3, conflicts 0/);
  });

  it("is nothing, after the vendor's change was written again over a merge", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    const later = new Date(Date.parse(row.updated_at) + 120_000).toISOString();
    harness.server.afterList = () => {
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: later,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(held.changes).toEqual([]);

    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 3, conflicts 0/);
  });
});

describe("the person's moment, after a merge", () => {
  it("is the person's write, not the merge over it: a vendor later than the one and earlier than the other wins", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    let personsWrite: string | undefined;
    harness.server.afterList = () => {
      personsWrite = harness.server.edit(row.id, {
        note: "by a person, since the read",
      }).updated_at;
      harness.server.afterList = undefined;
    };
    // The server's clock moves a second per write, so half a second past
    // the person's write is before the merge that follows it.
    const entry = {
      ...one,
      properties: { ...one.properties, title: "One, by the vendor" },
      changed_at: "",
    };
    held.entries = [entry];
    harness.server.beforeAnswer = (request) => {
      if (request.method === "PATCH" && personsWrite !== undefined) {
        entry.changed_at = new Date(
          Date.parse(personsWrite) + 500,
        ).toISOString();
      }
    };
    held.changes.length = 0;
    await harness.twoWay(held);
    harness.server.beforeAnswer = undefined;
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by the vendor",
      note: "first",
      vendor_id: "v1",
    });
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);
  });
});

describe("a purge and a transition met by the memory", () => {
  it("carries a purge back after the trash it already carried", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);
    // The purge's frame shows the version and state the trash left, which
    // the memory holds as its own; the row is gone all the same.
    harness.server.purgeById(row.id);
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 0/);
    expect((await watchState()).written[row.id]).toBeUndefined();
  });

  it("does not create a person's linked row again after they purged it", async () => {
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs", vendor_id: "v-theirs" },
      "test.entry",
      "person",
    );
    const held = vendor([]);
    await harness.twoWay(held);
    harness.server.trash(theirs.id);
    harness.server.purgeById(theirs.id);
    // The vendor still lists the entry, by the link the row carried.
    held.entries = [
      {
        source_id: "v-theirs",
        properties: { title: "Theirs", vendor_id: "v-theirs" },
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.rows).toHaveLength(0);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    expect(harness.lastRun().summary).toMatch(/created 0, .*skipped 1/);
  });

  it("carries a person's archive made between the read and the pull as the transition it is", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    // Between the log's read and the rows' listing, so the listing shows
    // the row in a state the memory does not hold, at the same version.
    harness.server.beforeAnswer = (request) => {
      if (request.method === "GET" && request.path === "/items") {
        harness.server.transition(row.id, "archived");
        harness.server.beforeAnswer = undefined;
      }
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    // A transition touches no property: the vendor's write proceeds, the
    // archive is carried back, and nothing is a conflict.
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(held.changes.map((change) => change.kind)).toEqual(["archived"]);
    expect(harness.lastRun().summary).toMatch(/conflicts 0/);
  });
});
