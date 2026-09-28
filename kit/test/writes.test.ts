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
  properties: { title: "One", note: "first" },
  occurred_at: "2026-09-01T10:00:00.000Z",
};
const two = { source_id: "a:2", properties: { title: "Two" } };

function patches() {
  return harness.server.requests.filter(
    (request) => request.method === "PATCH",
  );
}
function bulks() {
  return harness.server.requestsTo("POST", "/items/bulk");
}

describe("a row holding null", () => {
  it("is unchanged by an entry that leaves the key out, and changed by one that fills it", async () => {
    // A person's client can write null onto a row; to the vendor the key
    // is one the row does not have.
    harness.server.insert("a:1", { title: "One", note: null }, "test.entry");
    expect(
      await harness.once(
        vendor([{ source_id: "a:1", properties: { title: "One" } }]),
      ),
    ).toBe(0);
    expect(patches()).toHaveLength(0);
    expect(harness.server.row("a:1").version).toBe(1);
    expect(harness.lastRun().summary).toMatch(
      /^created 0, updated 0, .*unchanged 1/,
    );

    expect(await harness.once(vendor([one]))).toBe(0);
    expect(patches()).toHaveLength(1);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      note: "first",
    });
  });
});

describe("new rows", () => {
  it("go through the bulk door at version 0, not atomic, at the feed tier, under the source", async () => {
    expect(await harness.once(vendor([one, two]))).toBe(0);
    expect(bulks()).toHaveLength(1);
    expect(bulks()[0]?.body).toEqual({
      items: [
        {
          type: "test.entry",
          source: "test",
          source_id: "a:1",
          properties: { title: "One", note: "first" },
          occurred_at: "2026-09-01T10:00:00.000Z",
          tier: "feed",
          version: 0,
        },
        {
          type: "test.entry",
          source: "test",
          source_id: "a:2",
          properties: { title: "Two" },
          tier: "feed",
          version: 0,
        },
      ],
      atomic: false,
    });
    expect(
      harness.server.rows.map((row) => [row.source_id, row.version, row.tier]),
    ).toEqual([
      ["a:1", 1, "feed"],
      ["a:2", 1, "feed"],
    ]);
  });

  it("look up the rows the entries name by their natural keys, and list the type only while nothing is kept", async () => {
    await harness.once(vendor([one]));
    expect(harness.server.requestsTo("GET", "/items")).toHaveLength(1);
    await harness.once(vendor([one, two]));
    expect(
      harness.server
        .requestsTo("POST", "/items/lookup")
        .slice(-1)
        .map((r) => r.body),
    ).toEqual([{ type: "test.entry", source: "test", source_ids: ["a:2"] }]);
    expect(harness.server.requestsTo("GET", "/items")).toHaveLength(1);
  });

  it("write one row for an entry the vendor repeats", async () => {
    const again = { ...one, properties: { title: "One, later" } };
    expect(await harness.once(vendor([one, two, again]))).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, later",
    });
    expect(harness.lastRun().summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0",
    );
  });

  it("go through the bulk door in pages of 500, and all compare unchanged after", async () => {
    const many = Array.from({ length: 1201 }, (_, index) => ({
      source_id: `a:${String(index)}`,
      properties: { title: `Entry ${String(index)}` },
    }));
    expect(await harness.once(vendor(many))).toBe(0);
    expect(
      bulks().map(
        (request) => (request.body as { items: unknown[] }).items.length,
      ),
    ).toEqual([500, 500, 201]);
    expect(harness.server.rows).toHaveLength(1201);
    expect(await harness.once(vendor(many))).toBe(0);
    expect(bulks()).toHaveLength(3);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1201, skipped 0",
    );
  });

  it("write the connector's own type alone, never a row of a type inheriting from it", async () => {
    harness.server.types.set("test.entry.child", {
      id: "test.entry.child",
      parent: "test.entry",
    });
    harness.server.insert("c:1", { title: "A child" }, "test.entry.child");
    const held = vendor([
      { source_id: "c:1", properties: { title: "From the vendor" } },
    ]);
    held.archived = ["c:1"];
    expect(await harness.once(held)).toBe(0);
    const child = harness.server.rows.find(
      (row) => row.type === "test.entry.child",
    );
    expect(child?.properties).toEqual({ title: "A child" });
    expect(child?.state).toBe("active");
    expect(
      harness.server
        .requestsTo("POST", "/items/lookup")
        .map((request) => (request.body as { type: string }).type),
    ).toEqual(["test.entry"]);
    expect(harness.lastRun().summary).toContain("skipped 1");
    expect(harness.lastRun().summary).toContain("type_mismatch");
  });
});

describe("compare first", () => {
  it("writes nothing for a row that has not changed", async () => {
    await harness.once(vendor([one, two]));
    const written = bulks().length + patches().length;
    expect(written).toBe(1);

    await harness.once(vendor([one, two]));
    expect(bulks().length + patches().length).toBe(written);
    expect(harness.server.rows.map((row) => row.version)).toEqual([1, 1]);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 2, skipped 0",
    );
  });

  it("reads an instant the server spells another way as unchanged", async () => {
    await harness.once(vendor([one]));
    for (const spelling of [
      "2026-09-01T10:00:00Z",
      "2026-09-01T10:00:00+00:00",
    ]) {
      harness.server.row("a:1").occurred_at = spelling;
      expect(await harness.once(vendor([one]))).toBe(0);
      expect(patches()).toEqual([]);
    }
    await harness.once(
      vendor([{ ...one, occurred_at: "2026-09-01T10:00:01.000Z" }]),
    );
    expect(patches()).toHaveLength(1);
  });

  it("reads property order and an equal instant as unchanged", async () => {
    await harness.once(vendor([one]));
    const reordered = {
      source_id: "a:1",
      properties: { note: "first", title: "One" },
      occurred_at: "2026-09-01T11:00:00+01:00",
    };
    await harness.once(vendor([reordered]));
    expect(patches()).toEqual([]);
    expect(harness.server.row("a:1").version).toBe(1);
  });

  it("updates a changed row alone, with the version it read, replacing its properties with what they should hold", async () => {
    await harness.once(vendor([one, two]));
    const changed = {
      ...one,
      properties: { title: "One, renamed", note: "first" },
    };
    await harness.once(vendor([changed, two]));

    expect(patches()).toHaveLength(1);
    const row = harness.server.row("a:1");
    expect(patches()[0]?.path).toBe(`/items/${row.id}`);
    // The row's own time did not move, so it is not sent.
    expect(patches()[0]?.body).toEqual({
      version: 1,
      properties: { title: "One, renamed", note: "first" },
      properties_mode: "replace",
    });
    expect(row.version).toBe(2);
    expect(harness.server.row("a:2").version).toBe(1);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 1, archived 0, unchanged 1, skipped 0",
    );
  });

  it("clears a property the vendor no longer has, whether absent or null", async () => {
    await harness.once(vendor([one]));
    expect(harness.server.row("a:1").properties).toHaveProperty(
      "note",
      "first",
    );

    await harness.once(
      vendor([{ ...one, properties: { title: "One", note: null } }]),
    );
    expect(harness.server.row("a:1").properties).toEqual({ title: "One" });
    expect(harness.server.row("a:1").version).toBe(2);

    await harness.once(vendor([{ ...one, properties: { title: "One" } }]));
    expect(harness.server.row("a:1").version).toBe(2);
  });

  it("moves a row whose own time changed", async () => {
    await harness.once(vendor([one]));
    await harness.once(
      vendor([{ ...one, occurred_at: "2026-09-02T10:00:00.000Z" }]),
    );
    expect(harness.server.row("a:1").occurred_at).toBe(
      "2026-09-02T10:00:00.000Z",
    );
    expect(harness.server.row("a:1").version).toBe(2);
  });
});

describe("a trashed row", () => {
  it("is left alone, where the same change to an active row is written", async () => {
    await harness.once(vendor([one, two]));
    harness.server.row("a:1").state = "trashed";

    const changed = [
      { ...one, properties: { title: "One, changed" } },
      { ...two, properties: { title: "Two, changed" } },
    ];
    await harness.once(vendor(changed));
    expect(harness.server.row("a:2").properties).toEqual({
      title: "Two, changed",
    });
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      note: "first",
    });
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(harness.server.row("a:1").version).toBe(1);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 1, archived 0, unchanged 0, skipped 1",
    );
  });

  it("is not archived", async () => {
    await harness.once(vendor([one, two]));
    harness.server.row("a:1").state = "trashed";
    const held = vendor([]);
    held.archived = ["a:1", "a:2"];
    await harness.once(held);
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(harness.server.row("a:2").state).toBe("archived");
  });
});

describe("archive", () => {
  it("archives an active row once, and names no row it does not hold", async () => {
    await harness.once(vendor([one, two]));
    const held = vendor([]);
    held.archived = ["a:1", "a:9"];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(harness.server.row("a:2").state).toBe("active");
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 1, unchanged 0, skipped 0",
    );

    await harness.once(held);
    expect(
      harness.server.requestsTo(
        "POST",
        `/items/${harness.server.row("a:1").id}/transition`,
      ),
    ).toHaveLength(1);
  });

  it("updates an archived row's properties and never makes it active again", async () => {
    await harness.once(vendor([one]));
    harness.server.row("a:1").state = "archived";
    await harness.once(
      vendor([{ ...one, properties: { title: "One, again" } }]),
    );
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, again",
    });
  });
});

describe("a field Marfa mirrors", () => {
  it("is put back on the next run from what the kit last wrote, though the vendor sends nothing", async () => {
    await harness.once(vendor([one]));
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "One, by a person" });
    expect(await harness.once(vendor([]))).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe("One");
    expect(harness.lastRun().summary).toContain(
      "title on " + row.id + " was changed in Marfa and put back",
    );
    expect(harness.server.agreements.get(row.id)?.waiting).toBe(false);
  });
});

describe("the state", () => {
  it("is kept when every write landed", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.kept()).toMatchObject({ state: { token: "t1" } });
  });

  it("is held where a create meets a row another process made first, and a field another writer changed is put back from the vendor", async () => {
    const held = vendor([one, two]);
    held.token = "t1";
    await harness.once(held);

    // Once the run has read what the entries name, and before it writes.
    harness.server.afterRead = (request) => {
      if (!JSON.stringify(request.body).includes("a:3")) return;
      harness.server.touch("a:1", { note: "by another writer" });
      harness.server.insert(
        "a:3",
        { title: "Three, by another writer" },
        "test.entry",
      );
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [
      { ...one, properties: { title: "One, changed" } },
      two,
      { source_id: "a:3", properties: { title: "Three" } },
    ];
    expect(await harness.once(held)).toBe(0);

    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toMatch(
      /^created 0, updated 1, archived 0, unchanged 1, skipped 1\./,
    );
    expect(run.summary).toContain("held");
    expect(run.summary).toContain("note on");
    expect(harness.kept()).toMatchObject({ state: { token: "t1" } });
    // Marfa mirrors a vendor it only reads: the vendor cleared the note, so
    // the other writer's note is put back to that.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, changed",
    });

    expect(await harness.once(held)).toBe(0);
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });
    expect(harness.server.row("a:3").properties).toEqual({ title: "Three" });
    expect(
      harness.server.rows.filter((row) => row.source_id === "a:3"),
    ).toHaveLength(1);
  });

  it("puts the vendor's value back over another writer's change to the same field, and names it", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    harness.server.afterRead = () => {
      harness.server.touch("a:1", { title: "One, by another writer" });
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [
      { ...one, properties: { title: "One, by the vendor", note: "first" } },
    ];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.row("a:1").properties["title"]).toBe(
      "One, by the vendor",
    );
    expect(harness.lastRun().summary).toMatch(/updated 1/);
    expect(harness.lastRun().summary).toContain(
      "title on " +
        harness.server.row("a:1").id +
        " was changed in Marfa and put back",
    );
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });
  });

  it("lands a clear beside another writer's change to another field, and puts that change back on the next run", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    // The witness: the field is there to be cleared.
    expect(harness.server.row("a:1").properties["note"]).toBe("first");

    harness.server.afterRead = () => {
      harness.server.touch("a:1", { title: "One, by another writer" });
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [{ ...one, properties: { title: "One" } }];
    expect(await harness.once(held)).toBe(0);
    // The server merged the clear beside the other writer's title.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by another writer",
    });
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });

    // The next run reads the other writer's title from the log, and puts it
    // back from the vendor, which Marfa mirrors.
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.row("a:1").properties).toEqual({ title: "One" });
    expect(harness.lastRun().summary).toContain("put back");
  });

  it("puts a clear back over another writer's change to the same field", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.server.row("a:1").properties["note"]).toBe("first");

    harness.server.afterRead = () => {
      harness.server.touch("a:1", { note: "by another writer" });
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [{ ...one, properties: { title: "One" } }];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.row("a:1").properties).toEqual({ title: "One" });
    expect(harness.lastRun().summary).toMatch(/updated 1/);
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });
  });

  it("clears a property named like a member every object has, by what the row holds", async () => {
    const entry = {
      source_id: "a:1",
      properties: { title: "One", toString: "x" },
    };
    const held = vendor([entry]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      toString: "x",
    });

    harness.server.afterRead = () => {
      harness.server.touch("a:1", { title: "One, by another writer" });
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [{ ...entry, properties: { title: "One" } }];
    expect(await harness.once(held)).toBe(0);
    // Cleared as any other property is, and never taken from what every
    // object answers for the name.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by another writer",
    });
  });

  it("takes a clear of such a property both writers made as an echo", async () => {
    const entry = {
      source_id: "a:1",
      properties: { title: "One", toString: "x" },
    };
    const held = vendor([entry]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One",
      toString: "x",
    });

    harness.server.afterRead = () => {
      harness.server.rewrite("a:1", { title: "One" });
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [{ ...entry, properties: { title: "One, by the vendor" } }];
    expect(await harness.once(held)).toBe(0);
    // Judged by what the row holds: the other writer already cleared it,
    // so the vendor's clear is nothing new and its title lands.
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by the vendor",
    });
    expect(harness.server.row("a:1").version).toBe(3);
  });

  it("takes a clear both writers made as an echo, and lands the rest", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.server.row("a:1").properties["note"]).toBe("first");

    harness.server.afterRead = () => {
      harness.server.rewrite("a:1", { title: "One" });
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [{ ...one, properties: { title: "One, by the vendor" } }];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, by the vendor",
    });
    expect(harness.server.row("a:1").version).toBe(3);
    expect(harness.lastRun().summary).toMatch(/updated 1/);
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });
  });

  it("does not move a row's own time back to the value it read when another writer moved it since", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.server.row("a:1").occurred_at).toBe(one.occurred_at);

    harness.server.afterRead = () => {
      harness.server.rewrite(
        "a:1",
        harness.server.row("a:1").properties,
        "2026-09-02T10:00:00.000Z",
      );
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [
      { ...one, properties: { title: "One, changed", note: "first" } },
    ];
    expect(await harness.once(held)).toBe(0);

    // The vendor did not move the own time, so it is not sent, and the
    // other writer's stands beside the vendor's title.
    expect(harness.server.row("a:1").occurred_at).toBe(
      "2026-09-02T10:00:00.000Z",
    );
    expect(harness.server.row("a:1").properties["title"]).toBe("One, changed");
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });
  });

  it("writes the vendor's own time over another writer's move of it", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    expect(harness.server.row("a:1").occurred_at).toBe(one.occurred_at);

    harness.server.afterRead = () => {
      harness.server.rewrite(
        "a:1",
        harness.server.row("a:1").properties,
        "2026-09-02T10:00:00.000Z",
      );
      harness.server.afterRead = undefined;
    };
    held.token = "t2";
    held.entries = [{ ...one, occurred_at: "2026-09-03T10:00:00.000Z" }];
    expect(await harness.once(held)).toBe(0);

    // The two moves collide; the row is read again and the vendor's lands.
    expect(harness.server.row("a:1").occurred_at).toBe(
      "2026-09-03T10:00:00.000Z",
    );
    expect(harness.server.row("a:1").version).toBe(3);
    expect(harness.kept()).toMatchObject({ state: { token: "t2" } });
  });

  it("cleared on the instance costs a full read, and writes no row twice", async () => {
    const held = vendor([one, two]);
    held.token = "t1";
    await harness.once(held);
    harness.server.row("a:1").state = "trashed";
    await harness.once(held);
    harness.server.states.clear();
    harness.server.agreements.clear();

    held.entries = [{ ...one, properties: { title: "One, changed" } }, two];
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(bulks()).toHaveLength(1);
    expect(patches()).toEqual([]);
    expect(harness.server.row("a:1").state).toBe("trashed");
    expect(harness.server.row("a:1").version).toBe(1);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 1",
    );
  });

  it("reads a state document the kit did not write as empty", async () => {
    harness.server.states.set("test", {
      state: "not an object",
      conditions: 7,
    });
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(harness.lastRun().summary).toBe(
      "created 1, updated 0, archived 0, unchanged 0, skipped 0",
    );
    expect(harness.kept()).toMatchObject({ state: {}, conditions: {} });
  });
});

describe("a row the server refuses", () => {
  it("is skipped, holds the state, and is reported once while it lasts", async () => {
    const held = vendor([one, two]);
    held.token = "t1";
    harness.server.entryRefusals.set("a:2", {
      status: 400,
      code: "invalid_properties",
      message: "title is over its length cap",
    });
    expect(await harness.once(held)).toBe(0);
    expect(harness.lastRun().summary).toContain("a:2");
    expect(harness.lastRun().summary).toContain("invalid_properties");
    expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:1"]);
    expect(harness.kept()).toHaveProperty("state", {});

    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 1",
    );

    harness.server.entryRefusals.delete("a:2");
    await harness.once(held);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.kept()).toMatchObject({ state: { token: "t1" } });
  });

  it("fails the run when the refusal is the key's, not the row's", async () => {
    harness.server.entryRefusals.set("a:1", {
      status: 403,
      code: "type_not_permitted",
      message: "the key may not write test.entry",
    });
    expect(await harness.once(vendor([one]))).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("type_not_permitted");
  });

  it("fails the run on a server fault", async () => {
    await harness.once(vendor([one]));
    harness.server.refuseNext(
      `PATCH /items/${harness.server.row("a:1").id}`,
      500,
      "internal",
    );
    expect(
      await harness.once(vendor([{ ...one, properties: { title: "x" } }])),
    ).toBe(1);
    expect(harness.lastRun().error).toContain("500");
  });
});
