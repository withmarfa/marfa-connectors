import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, linkedType, vendor, type Vendor } from "./harness.js";

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

function watchState(): { cursor?: string } {
  const cursor = harness.kept()["cursor"];
  return typeof cursor === "string" ? { cursor } : {};
}

/** A run of the two-way connector whose vendor sends nothing new. */
async function quietRun(held: Vendor): Promise<number> {
  held.changes.length = 0;
  return harness.twoWay(held);
}

describe("the events request", () => {
  it("is sent by every connector, since what one only reads is watched too", async () => {
    await harness.once(vendor([one]));
    expect(streams()).toHaveLength(1);
    // The two-way connector's type names its link.
    harness.server.types.set(linkedType.id, { ...linkedType });
    await harness.twoWay(vendor([one]));
    expect(streams()).toHaveLength(2);
    expect(streams()[1]?.query.get("type")).toBe("test.entry");
    expect(streams()[1]?.query.get("edges")).toBe("none");
    expect(streams()[0]?.headers["last-event-id"]).toBe("0");
  });
});

describe("the cursor", () => {
  it("is kept at the head read and advanced by the next run", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    // Nothing was in the log when the read was made: the head was 0.
    expect(watchState().cursor).toBe("0");

    expect(await quietRun(held)).toBe(0);
    // The two creates were read, both the connector's own.
    expect(watchState().cursor).toBe(String(harness.server.head));
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 2, conflicts 0/);
    expect(held.changes).toHaveLength(0);
    expect(streams()[1]?.headers["last-event-id"]).toBe("0");

    // The next read resumes from where the last one reached.
    await quietRun(held);
    expect(streams()[2]?.headers["last-event-id"]).toBe(
      String(harness.server.head),
    );
  });

  it("moves once what the log named is kept, and a push that throws leaves its row waiting for the next run", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
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
    expect(watchState().cursor).toBe(String(harness.server.head));
    expect(harness.server.agreements.get(second.id)?.waiting).toBe(true);

    // The one that did not land is offered again, though the log has moved
    // on; the one that did is carried.
    expect(await quietRun(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
    expect(harness.server.agreements.get(second.id)?.waiting).toBe(false);
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

  it("is a person's transition, which moves no version", async () => {
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

  it("after the connector's state is cleared, is a create only where the vendor has no id, and nothing for the rest until the vendor sends them", async () => {
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

    harness.server.states.clear();
    harness.server.agreements.clear();
    held.entries = [];
    await quietRun(held);
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["created", theirs.id]],
    );
    expect(harness.lastRun().summary).toContain(
      "2 rows the log named have nothing agreed with the vendor yet",
    );

    // The vendor's entries seed what was agreed, and carry nothing back.
    held.entries = [one, two];
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
  });
  it("compares every row with what was agreed, with a condition, when the log no longer holds the cursor", async () => {
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
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });

    harness.server.tooOld = true;
    held.entries = [];
    await quietRun(held);
    expect(held.changes.map((change) => [change.kind, change.item.id])).toEqual(
      [["updated", row.id]],
    );
    expect(harness.lastRun().summary).toContain(
      "every row of the connector's types was compared with what was last agreed",
    );
    expect(watchState().cursor).toBe(String(harness.server.head));

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
    expect(watchState().cursor).toBe(String(harness.server.head - 1));
    // Said in the log, with the server's reason, so a stream that keeps
    // ending short is visible.
    expect(harness.lines).toContainEqual(
      expect.stringContaining(
        "the server ended the stream: replay_failed; the rest of the log is read next run",
      ),
    );

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
    expect(watchState().cursor).toBe(String(harness.server.head - 1));
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
    expect(watchState().cursor).toBe(String(harness.server.head));
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
    expect(watchState().cursor).toBe(String(harness.server.head));
  });

  it("keeps its cursor where the marker names a position behind it", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    harness.server.edit(harness.server.row("a:1").id, { title: "One, edited" });
    harness.server.edit(harness.server.row("a:2").id, { title: "Two, edited" });
    await quietRun(held);
    const before = watchState().cursor;
    expect(
      Number(before),
      "the cursor is not past the position the marker names below, so it cannot be moved back",
    ).toBeGreaterThan(1);
    harness.server.liveCursor = "1";
    expect(await quietRun(held)).toBe(0);
    expect(
      watchState().cursor,
      "a marker behind the cursor moved it back, so the next run reads again what it already took",
    ).toBe(before);
    await quietRun(held);
    expect(streams().at(-1)?.headers["last-event-id"]).toBe(before);
  });

  it("fails the run and holds the cursor when the events request is refused", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const before = watchState().cursor;
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    harness.server.refuseNext("GET /events", 503, "unavailable");
    expect(await quietRun(held)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(held.changes).toEqual([]);
    expect(watchState().cursor).toBe(before);
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
  it("keeps a person's change to another field beside the vendor's, and carries it on the next run", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.afterRead = () => {
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterRead = undefined;
    };
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
        changed_at: new Date(
          Date.parse(row.updated_at) + 120_000,
        ).toISOString(),
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    // The server merged the vendor's title beside the person's note.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by the vendor",
      note: "by a person, since the read",
      vendor_id: "v1",
    });
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/updated 1, .*conflicts 0/);
    expect(harness.lastRun().summary).not.toContain("held");

    held.entries = [];
    await quietRun(held);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["updated", ["note"]]]);
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
  });
  it("carries the person's row back where the write was refused and the person's change is later", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    const earlier = new Date(
      Date.parse(row.updated_at) - 120_000,
    ).toISOString();
    harness.server.afterRead = () => {
      harness.server.edit(row.id, {
        title: "One, by a person, since the read",
      });
      harness.server.afterRead = undefined;
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

describe("what was agreed", () => {
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

  it("seeds a row from the vendor after the connector's state is cleared, carrying nothing", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const written = harness.server.row("a:1").updated_at;
    harness.server.states.clear();
    harness.server.agreements.clear();
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
    expect(harness.lastRun().summary).toMatch(/conflicts 0/);
    expect(harness.lastRun().summary).toContain(
      "took the vendor's values where they differed",
    );
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
    // connector's write over it: the edit waits, then the write, which is
    // what was agreed, lets it go, and nothing is carried.
    const kept = harness.server.states.get("test");
    delete kept?.["cursor"];
    held.entries = [];
    await quietRun(held);
    expect(held.changes).toHaveLength(0);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 1/);
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
  it("fails the run, and what it did not carry waits for the next", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });

    held.entries = [];
    held.changes.length = 0;
    held.vendorIdFor = (change) => {
      if (change.item.id === first.id) harness.stop();
      return undefined;
    };
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(held.changes.map((change) => change.item.id)).toEqual([first.id]);

    held.vendorIdFor = undefined;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
  });
});

describe("a resync", () => {
  it("reads the head before the rows, so a change landing between the two is not lost", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");

    harness.server.tooOld = true;
    harness.server.afterRead = () => {
      harness.server.edit(row.id, { title: "One, edited during the resync" });
      harness.server.afterRead = undefined;
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

describe("a person's edit found while the vendor is read", () => {
  it("is carried in the same run beside the vendor's change to another field", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.beforeAnswer = (request) => {
      if (request.path === "/items/lookup") {
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
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by the vendor",
      note: "by a person",
      vendor_id: "v1",
    });
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["updated", ["note"]]]);
    expect(harness.lastRun().summary).toMatch(/conflicts 0/);

    held.entries = [];
    await quietRun(held);
    expect(held.changes).toEqual([]);
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
  it("is nothing, where the vendor won a field both sides changed", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
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
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/conflicts 1/);

    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/pushed 0, own 1, conflicts 0/);
  });
});

describe("a purge and a transition met by what was agreed", () => {
  it("carries a purge back after the trash it already carried", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);
    // The purge's frame shows the row as the carried trash left it; the row
    // is gone all the same.
    harness.server.purgeById(row.id);
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["purged"]);
    expect(harness.lastRun().summary).toMatch(/pushed 1, own 0/);
    expect(harness.server.agreements.get(row.id)).toBeUndefined();
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

  it("merges a vendor change from before a restore, and still carries the restore", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["trashed"]);
    // The vendor changed the item after the trash reached it and before the
    // person's restore, which is the later change.
    const echoedAt = harness.server.row("a:1").updated_at;
    const restored = harness.server.restore(row.id);
    expect(Date.parse(restored.updated_at) > Date.parse(echoedAt)).toBe(true);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, closed at the vendor" },
        changed_at: echoedAt,
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    // A field only the vendor changed is taken, and the restore still goes.
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, closed at the vendor",
    );
    expect(harness.server.row("a:1").state).toBe("active");
    expect(held.changes.map((change) => change.kind)).toEqual(["restored"]);
    expect(harness.lastRun().summary).toMatch(/conflicts 0/);

    // The witness: a vendor change later than the restore lands, and the
    // restore needs no carrying.
    harness.server.trash(row.id);
    await quietRun(held);
    const again = harness.server.restore(row.id);
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, edited at the vendor" },
        changed_at: new Date(
          Date.parse(again.updated_at) + 60_000,
        ).toISOString(),
      },
    ];
    held.changes.length = 0;
    await harness.twoWay(held);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, edited at the vendor",
    );
    // The vendor has the row, so the restore has nothing left to carry.
    expect(held.changes).toEqual([]);
    expect(harness.lastRun().summary).toMatch(/conflicts 0/);
  });

  it("carries a person's archive made between the read and the pull as the transition it is", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    // Between the log's read and the rows' lookup, so only the lookup
    // shows the row in a state the two sides did not agree on.
    harness.server.beforeAnswer = (request) => {
      if (request.path === "/items/lookup") {
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

describe("what a failed run leaves", () => {
  it("carries an archive made beside the vendor's change on the next run, though the run failed after writing it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.transition(row.id, "archived");
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, by the vendor" },
      },
    ];
    held.failAfter = new Error("the vendor went away");
    expect(await quietRun(held)).toBe(1);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(held.changes).toEqual([]);

    held.failAfter = undefined;
    held.entries = [];
    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["archived"]);
  });
});

describe("a create", () => {
  it("carries an edit a person made while the vendor made the row", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = (change) => {
      harness.server.edit(theirs.id, { note: "added meanwhile" });
      return change.item.id === theirs.id ? "v-theirs" : undefined;
    };
    await quietRun(held);
    // The link merged beside the edit, which the next run carries.
    expect(harness.server.byId(theirs.id).properties).toMatchObject({
      note: "added meanwhile",
      vendor_id: "v-theirs",
    });
    held.vendorIdFor = undefined;
    await quietRun(held);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["updated", ["note"]]]);
  });

  it("says when one was sent before and no link came back", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    held.pushFail = { id: theirs.id, error: new Error("lost the answer") };
    expect(await quietRun(held)).toBe(1);
    expect(held.changes[0]?.attempted).toBeUndefined();

    await quietRun(held);
    expect(held.changes.map((change) => change.kind)).toEqual(["created"]);
    expect(held.changes[0]?.attempted).toEqual(expect.any(String));
  });
});

describe("the link", () => {
  it("is put back where a person changed it, before anything is carried by it", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { vendor_id: "v-mistaken", note: "edited" });
    held.entries = [];
    await quietRun(held);
    expect(harness.server.row("a:1").properties["vendor_id"]).toBe("v1");
    expect(
      held.changes.map((change) => [
        change.item.properties["vendor_id"],
        [...change.changed],
      ]),
    ).toEqual([["v1", ["note"]]]);
    expect(harness.lastRun().summary).toContain(
      "was changed in Marfa and put back",
    );
  });
});

describe("an entry", () => {
  it("is refused where it carries a property the connector does not declare", async () => {
    const held = vendor([
      { ...one, properties: { ...one.properties, color: "red" } },
    ]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(0);
    expect(harness.lastRun().summary).toContain(
      "carries color, which the connector does not declare among its fields",
    );
  });

  it("is refused where it names no link, for a connector that declares one", async () => {
    const held = vendor([{ source_id: "a:1", properties: { title: "One" } }]);
    expect(await harness.twoWay(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(0);
    expect(harness.lastRun().summary).toContain("names no vendor_id");
  });
});

describe("a row in the bin", () => {
  it("is carried as a trash by the link the two sides agreed, where a person changed it first", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { vendor_id: "v-mistaken" });
    harness.server.trash(row.id);
    held.entries = [];
    expect(await quietRun(held)).toBe(0);
    expect(
      held.changes.map((change) => [
        change.kind,
        change.item.properties["vendor_id"],
      ]),
    ).toEqual([["trashed", "v1"]]);
    expect(await quietRun(held)).toBe(0);
    expect(held.changes).toEqual([]);
  });

  it("carries nothing, and keeps nothing, where its create never reached the vendor", async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    held.pushFail = { id: theirs.id, error: new Error("the vendor is down") };
    expect(await quietRun(held)).toBe(1);
    harness.server.trash(theirs.id);
    expect(await quietRun(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.server.agreements.get(theirs.id)).toBeUndefined();
  });
});

describe("a row made again", () => {
  it("carries an edit a person made while it was made, on the next run", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    held.entries = [];
    await quietRun(held);
    harness.server.restore(row.id);
    held.gone = new Map([[row.id, "v1-again"]]);
    held.duringRemake = () => {
      harness.server.edit(row.id, { note: "edited meanwhile" });
    };
    await quietRun(held);
    expect(held.changes).toEqual([]);
    held.duringRemake = undefined;
    await quietRun(held);
    expect(
      held.changes.map((change) => [change.kind, [...change.changed]]),
    ).toEqual([["updated", ["note"]]]);
  });
});

describe("the connector's state", () => {
  it("is not written over with nothing when it cannot be read", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.twoWay(held);
    const before = structuredClone(harness.kept());
    harness.server.refuseNext(
      "GET /connectors/connector-1/state",
      503,
      "unavailable",
    );
    held.token = "t2";
    expect(await quietRun(held)).toBe(1);
    expect(harness.kept()).toEqual(before);
  });
});

describe("an entry naming no time", () => {
  it("is written over what was agreed at a time, as a vendor that names none is", async () => {
    const held = vendor([{ ...one, changed_at: "2026-09-20T00:00:00.000Z" }]);
    await harness.twoWay(held);
    held.entries = [
      { ...one, properties: { ...one.properties, title: "One, untimed" } },
    ];
    await quietRun(held);
    expect(harness.server.row("a:1").properties["title"]).toBe("One, untimed");
  });
});

describe("a purge of a row the vendor moved", () => {
  it("is not written back under the item's new link", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.trash(row.id);
    harness.server.purgeById(row.id);
    held.entries = [
      {
        ...one,
        source_id: "a:1-moved",
        properties: { ...one.properties, vendor_id: "v1-moved" },
        movedFrom: "v1",
      },
    ];
    await quietRun(held);
    expect(harness.server.rows).toHaveLength(0);
  });
});

describe("an answered entry", () => {
  it("is what the vendor holds, so a value it normalizes is carried once and nothing loops", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "  One, spaced  " });
    held.entries = [];
    held.answer = (change) => ({
      source_id: "a:1",
      properties: {
        ...change.item.properties,
        title: String(change.item.properties["title"]).trim(),
      },
      changed_at: "2026-09-29T00:00:00.000Z",
    });
    await quietRun(held);
    expect(held.changes).toHaveLength(1);

    // The vendor lists what it holds; Marfa keeps what the person wrote.
    held.entries = [
      {
        ...one,
        properties: { ...one.properties, title: "One, spaced" },
        changed_at: "2026-09-29T00:00:00.000Z",
      },
    ];
    await quietRun(held);
    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "  One, spaced  ",
    );
  });
});

describe("a change a person undid", () => {
  it("is carried as nothing, and waits no more", async () => {
    const held = vendor([one]);
    await harness.twoWay(held);
    await quietRun(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, briefly" });
    harness.server.edit(row.id, { title: "One" });
    held.entries = [];
    await quietRun(held);
    expect(held.changes).toEqual([]);
    expect(harness.server.agreements.get(row.id)?.waiting).toBe(false);
  });
});
