import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector, type Entry } from "../src/define.js";
import { intentOf } from "../src/inbound-retry.js";
import { start } from "../src/main.js";
import { Harness, testFields, testType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

interface Plan {
  entries: Entry[];
}

function connector(plan: Plan) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [{ type: testType, fields: testFields }],
    env: {},
    async run(context) {
      await context.upsert(testType.id, plan.entries);
    },
  });
}

const once = (plan: Plan) =>
  start(connector(plan), harness.runtime(["--once"]));

describe("an entry's tier", () => {
  it("is the feed unless the entry names the library", async () => {
    const plan: Plan = {
      entries: [
        { source_id: "plain", properties: { title: "Plain" } },
        { source_id: "kept", properties: { title: "Kept" }, tier: "library" },
        { source_id: "named", properties: { title: "Named" }, tier: "feed" },
      ],
    };
    expect(await once(plan)).toBe(0);
    expect(
      ["plain", "kept", "named"].map((id) => harness.server.row(id).tier),
    ).toEqual(["feed", "library", "feed"]);
  });

  it("sets the tier of a new row only, and leaves a row where it is", async () => {
    const plan: Plan = {
      entries: [{ source_id: "a", properties: { title: "One" } }],
    };
    expect(await once(plan)).toBe(0);
    expect(harness.server.row("a").tier).toBe("feed");

    plan.entries = [
      { source_id: "a", properties: { title: "Two" }, tier: "library" },
    ];
    expect(await once(plan)).toBe(0);
    expect(harness.server.row("a").properties["title"]).toBe("Two");
    expect(harness.server.row("a").tier).toBe("feed");
  });

  it("is kept in a retry's record", () => {
    const entry: Entry = {
      source_id: "a",
      properties: { title: "One" },
      tier: "library",
    };
    expect(intentOf(testType.id, entry).entry.tier).toBe("library");
    expect(
      Object.hasOwn(
        intentOf(testType.id, { source_id: "b", properties: {} }).entry,
        "tier",
      ),
    ).toBe(false);
  });
});
