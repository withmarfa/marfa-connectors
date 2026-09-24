import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
    expect(await harness.stateFile()).toHaveProperty("state", {});
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
  it("is not written again, having been seen in the bin", async () => {
    await harness.once(vendor([one, two]));
    harness.server.row("a:1").state = "trashed";
    await harness.once(vendor([one, two]));
    harness.server.purge("a:1");
    expect(await harness.once(vendor([one, two]))).toBe(0);
    expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:2"]);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 1",
    );
  });

  it("is written again once a person takes it out of the bin and the kit sees it", async () => {
    await harness.once(vendor([one]));
    harness.server.row("a:1").state = "trashed";
    await harness.once(vendor([one]));
    harness.server.row("a:1").state = "active";
    await harness.once(vendor([one]));
    harness.server.purge("a:1");
    await harness.once(vendor([one]));
    expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:1"]);
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
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t1" } });
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
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t1" } });
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
    expect(await harness.stateFile()).toMatchObject({ state: { token: "t1" } });
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

describe("the state directory", () => {
  it("is made when it does not exist", async () => {
    const nested = join(harness.stateDir, "not", "yet");
    expect(await harness.once(vendor([one]), { MARFA_STATE_DIR: nested })).toBe(
      0,
    );
    expect(
      JSON.parse(await readFile(join(nested, "test.json"), "utf8")),
    ).toHaveProperty("state");
    await rm(nested, { recursive: true, force: true });
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
  it("is refused when it cannot name a state file", async () => {
    const connector = { ...testConnector(vendor()), name: "Test Connector" };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(2);
    expect(harness.server.requests).toEqual([]);
    expect(await harness.once(vendor())).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });
});
