import { rm } from "node:fs/promises";
import { join } from "node:path";
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

  it("read the connector's own rows by type and source across every state", async () => {
    await harness.once(vendor([one]));
    const listing = harness.server.requestsTo("GET", "/items")[0];
    expect(listing?.query.get("type")).toBe("test.entry");
    expect(listing?.query.get("source")).toBe("test");
    expect(listing?.query.get("state")).toBe("any");
  });

  it("write one row for an entry the vendor repeats", async () => {
    const again = { ...one, properties: { title: "One, later" } };
    expect(await harness.once(vendor([one, two, again]))).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(harness.server.row("a:1").properties).toEqual({
      title: "One, later",
    });
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

  it("updates a changed row alone, with the version it read, replacing its properties", async () => {
    await harness.once(vendor([one, two]));
    const changed = {
      ...one,
      properties: { title: "One, renamed", note: "first" },
    };
    await harness.once(vendor([changed, two]));

    expect(patches()).toHaveLength(1);
    const row = harness.server.row("a:1");
    expect(patches()[0]?.path).toBe(`/items/${row.id}`);
    expect(patches()[0]?.body).toEqual({
      version: 1,
      properties: { title: "One, renamed", note: "first" },
      properties_mode: "replace",
      occurred_at: "2026-09-01T10:00:00.000Z",
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

describe("the state", () => {
  it("is kept when every write landed", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t1" } });
  });

  it("is held where it was when a write another process made first refuses one of this run's", async () => {
    const held = vendor([one, two]);
    held.token = "t1";
    await harness.once(held);

    harness.server.afterList = () => {
      harness.server.touch("a:1", { note: "by another writer" });
      harness.server.insert(
        "a:3",
        { title: "Three, by another writer" },
        "test.entry",
      );
      harness.server.afterList = undefined;
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
      /^created 0, updated 0, archived 0, unchanged 1, skipped 2\./,
    );
    expect(run.summary).toContain("held");
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t1" } });
    expect(
      harness.server.rows.filter((row) => row.source_id === "a:3"),
    ).toHaveLength(1);

    expect(await harness.once(held)).toBe(0);
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t2" } });
  });

  it("is lost at no cost but a full read: no row is written twice", async () => {
    const held = vendor([one, two]);
    held.token = "t1";
    await harness.once(held);
    await rm(join(harness.stateDir, "test.json"));

    expect(await harness.once(held)).toBe(0);
    expect(harness.server.rows).toHaveLength(2);
    expect(bulks()).toHaveLength(1);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 2, skipped 0",
    );
  });

  it("starts empty from a file it cannot read, and says so", async () => {
    await harness.once(vendor([one]));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(harness.stateDir, "test.json"), "{ not json");
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(harness.lines.join("\n")).toContain("state");
    expect(harness.server.rows).toHaveLength(1);
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
    expect(await harness.stateFile()).toHaveProperty("state", {});

    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 1",
    );

    harness.server.entryRefusals.delete("a:2");
    await harness.once(held);
    expect(harness.server.rows).toHaveLength(2);
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t1" } });
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
