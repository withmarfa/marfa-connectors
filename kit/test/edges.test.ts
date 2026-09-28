import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { Harness, testConnector, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One" } };
const two = { source_id: "a:2", properties: { title: "Two" } };

function bulkSizes(): number[] {
  return harness.server
    .requestsTo("POST", "/items/bulk")
    .map((request) => (request.body as { items: unknown[] }).items.length);
}

describe("rows too big for one request", () => {
  it("are split until each page fits, and every row lands", async () => {
    harness.server.bodyCap = 100_000;
    const big = Array.from({ length: 20 }, (_, index) => ({
      source_id: `a:${String(index)}`,
      properties: { title: "x".repeat(20_000) },
    }));
    expect(await harness.once(vendor(big))).toBe(0);
    expect(harness.server.rows).toHaveLength(20);
    expect(bulkSizes()[0]).toBe(20);
    expect(bulkSizes().length).toBeGreaterThan(1);
    expect(harness.lastRun().summary).toBe(
      "created 20, updated 0, archived 0, unchanged 0, skipped 0",
    );
  });

  it("leave a row no request can carry refused, and the rest landed", async () => {
    harness.server.bodyCap = 50_000;
    const held = vendor([
      one,
      { source_id: "a:big", properties: { title: "x".repeat(60_000) } },
    ]);
    held.token = "t1";
    expect(await harness.once(held)).toBe(0);
    expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:1"]);
    expect(harness.lastRun().summary).toContain("a:big");
    expect(harness.kept()).toHaveProperty("state", {});
  });

  it("refuse one update and leave the others landed", async () => {
    await harness.once(vendor([one, two]));
    harness.server.bodyCap = 50_000;
    await harness.once(
      vendor([
        { source_id: "a:1", properties: { title: "x".repeat(60_000) } },
        { source_id: "a:2", properties: { title: "Two, changed" } },
      ]),
    );
    expect(harness.server.row("a:2").properties).toEqual({
      title: "Two, changed",
    });
    expect(harness.lastRun().summary).toMatch(
      /^created 0, updated 1, archived 0, unchanged 0, skipped 1\./,
    );
  });
});

describe("a row a person purged", () => {
  it("is written again while the vendor still has it, since nothing remembers it", async () => {
    await harness.once(vendor([one, two]));
    harness.server.row("a:1").state = "trashed";
    await harness.once(vendor([one, two]));
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 1",
    );
    harness.server.purge("a:1");
    expect(await harness.once(vendor([one, two]))).toBe(0);
    expect(harness.server.rows.map((row) => row.source_id)).toEqual([
      "a:2",
      "a:1",
    ]);
    expect(harness.lastRun().summary).toBe(
      "created 1, updated 0, archived 0, unchanged 1, skipped 0",
    );
  });

  it("keeps nothing of the bin in the connector's state", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    harness.server.row("a:1").state = "trashed";
    await harness.once(held);
    expect(harness.kept()).toMatchObject({
      state: { token: "t1" },
      conditions: {},
    });
  });
});

describe("a row trashed while a run is writing", () => {
  it("answers an update item_not_found, which is skipped and holds the state", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    harness.server.afterList = () => {
      harness.server.row("a:1").state = "trashed";
      harness.server.afterList = undefined;
    };
    held.token = "t2";
    held.entries = [
      { source_id: "a:1", properties: { title: "One, changed" } },
    ];
    expect(await harness.once(held)).toBe(0);
    expect(harness.lastRun().summary).toMatch(/skipped 1\./);
    expect(harness.kept()).toMatchObject({ state: { token: "t1" } });
  });

  it("answers an archive invalid_transition, which is skipped and holds the state", async () => {
    const held = vendor([one]);
    held.token = "t1";
    await harness.once(held);
    harness.server.afterList = () => {
      harness.server.row("a:1").state = "trashed";
      harness.server.afterList = undefined;
    };
    held.token = "t2";
    held.entries = [];
    held.archived = ["a:1"];
    expect(await harness.once(held)).toBe(0);
    expect(harness.lastRun().summary).toMatch(/skipped 1\./);
    expect(harness.kept()).toMatchObject({ state: { token: "t1" } });
  });

  it("is not archived when it was already in the bin, and holds nothing", async () => {
    const held = vendor([one]);
    await harness.once(held);
    harness.server.row("a:1").state = "trashed";
    held.token = "t1";
    held.entries = [];
    held.archived = ["a:1"];
    expect(await harness.once(held)).toBe(0);
    expect(
      harness.server.requests.filter((request) =>
        request.path.endsWith("/transition"),
      ),
    ).toEqual([]);
    expect(harness.kept()).toMatchObject({ state: { token: "t1" } });
  });
});

describe("a stop before a write", () => {
  it("sends no create and no archive", async () => {
    await harness.once(vendor([one]));
    const before = harness.server.requests.length;
    harness.server.afterList = () => {
      harness.stop();
      harness.server.afterList = undefined;
    };
    const held = vendor([two]);
    held.archived = ["a:1"];
    expect(await harness.once(held)).toBe(0);
    const since = harness.server.requests.slice(before);
    expect(since.some((request) => request.path === "/items/bulk")).toBe(false);
    expect(since.some((request) => request.path.endsWith("/transition"))).toBe(
      false,
    );
    expect(harness.lastRun().error).toContain("stopped");
  });
});

describe("a row's own time", () => {
  it("is written in ISO form whatever form the vendor gives it in", async () => {
    await harness.once(
      vendor([{ ...one, occurred_at: "Wed, 16 Sep 2026 08:00:00 +0100" }]),
    );
    expect(harness.server.row("a:1").occurred_at).toBe(
      "2026-09-16T07:00:00.000Z",
    );
  });
});

describe("a connector's name", () => {
  it("is refused past the server's 200 characters, before any request", async () => {
    const connector = { ...testConnector(vendor()), name: "t".repeat(201) };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(2);
    expect(harness.server.requests).toEqual([]);
    const fits = { ...testConnector(vendor()), name: "Test Connector" };
    expect(await start(fits, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });
});

describe("the connector's state", () => {
  it("is the key's own source's, so two accounts keep theirs apart", async () => {
    const first = vendor([one]);
    first.token = "t-first";
    expect(await harness.once(first)).toBe(0);

    harness.server.keySource = "test/account 2";
    const second = vendor([{ source_id: "b:1", properties: { title: "B" } }]);
    second.token = "t-second";
    expect(await harness.once(second)).toBe(0);

    expect(harness.server.states.get("test")).toMatchObject({
      state: { token: "t-first" },
    });
    expect(harness.server.states.get("test/account 2")).toMatchObject({
      state: { token: "t-second" },
    });
  });
});
