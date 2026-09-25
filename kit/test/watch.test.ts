import { rm } from "node:fs/promises";
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

    held.pushFail = { id: second.id, error: new Error("the vendor is down") };
    expect(await quietRun(held)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("the vendor is down");
    expect(held.changes.map((change) => change.item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect((await watchState()).cursor).toBe(before);

    // Offered again, both of them, and the cursor moves once both land.
    expect(await quietRun(held)).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([
      first.id,
      second.id,
    ]);
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
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);

    harness.server.tooOld = true;
    await quietRun(held);
    expect(held.changes.map((change) => change.kind).sort()).toEqual([
      "updated",
      "updated",
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

    // The frame that would show the head reached never comes, and the
    // quiet window is never ended, so the request's own timeout ends it.
    held.entries = [];
    harness.server.withholdHead = true;
    harness.requestTimeoutMs = 200;
    harness.quietMs = 60_000;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([first.id]);
    expect((await watchState()).cursor).toBe(String(harness.server.head - 1));

    harness.server.withholdHead = false;
    harness.requestTimeoutMs = 5000;
    harness.quietMs = 100;
    await quietRun(held);
    expect(held.changes.map((change) => change.item.id)).toEqual([second.id]);
  });

  it("takes a stream gone quiet after its announcement as caught up", async () => {
    const held = vendor([one, two]);
    await harness.twoWay(held);
    await quietRun(held);
    const first = harness.server.row("a:1");
    const second = harness.server.row("a:2");
    harness.server.edit(first.id, { title: "One, edited" });
    harness.server.edit(second.id, { title: "Two, edited" });

    // The head is a frame this reader is never sent; the read ends when the
    // quiet window the test wakes runs out.
    held.entries = [];
    harness.server.withholdHead = true;
    held.changes.length = 0;
    const run = harness.twoWay(held);
    // Every quiet window the read opens is ended by the test, the first
    // beside a frame that was already there, the last with nothing more.
    const waking = (async () => {
      for (;;) await harness.clock.wake(100);
    })();
    expect(await Promise.race([run, waking])).toBe(0);
    expect(held.changes.map((change) => change.item.id)).toEqual([first.id]);
    expect((await watchState()).cursor).toBe(String(harness.server.head - 1));
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
