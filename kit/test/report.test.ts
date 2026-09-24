import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, secretToken, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One" } };
const two = { source_id: "a:2", properties: { title: "Two" } };

describe("a run's report", () => {
  it("carries the counts as its summary, with when it started and finished", async () => {
    await harness.once(vendor([one, two]));
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toBe("created 2, updated 0, archived 0, unchanged 0, skipped 0");
    expect(run.error).toBeUndefined();
    expect(Date.parse(run.finished_at)).toBeGreaterThanOrEqual(Date.parse(run.started_at));
  });

  it("carries a failure's text, capped to what the server takes", async () => {
    const failing = vendor([one]);
    failing.fail = new Error(`the vendor answered: ${"x".repeat(5000)}`);
    expect(await harness.once(failing)).toBe(1);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/^the vendor answered: x+/);
    expect(run.error?.length).toBeLessThanOrEqual(2000);
    expect(run.summary).toBe("created 0, updated 0, archived 0, unchanged 0, skipped 0");
  });

  it("is reported once per run, and a run is never retried inside itself", async () => {
    const failing = vendor([one]);
    failing.fail = new Error("the vendor answered 503");
    await harness.once(failing);
    expect(failing.runs).toBe(1);
    expect(harness.server.runs).toHaveLength(1);
  });
});

describe("a condition", () => {
  it("is reported on the first run it holds, not on the next, and said to be cleared when it stops", async () => {
    const held = vendor([one]);
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 1, updated 0, archived 0, unchanged 0, skipped 0. the feed x answers 410",
    );
    const warned = harness.lines.filter((line) => line.includes("the feed x answers 410"));
    expect(warned).toHaveLength(1);

    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0",
    );
    expect(harness.lines.filter((line) => line.includes("the feed x answers 410"))).toHaveLength(1);

    held.conditions = [];
    await harness.once(held);
    expect(harness.lines.filter((line) => line.includes("cleared"))).toHaveLength(1);

    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("the feed x answers 410");
  });

  it("survives a failed run without being said to have cleared", async () => {
    const held = vendor([one]);
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    held.conditions = [];
    held.fail = new Error("the vendor is down");
    await harness.once(held);
    expect(harness.lines.some((line) => line.includes("cleared"))).toBe(false);
  });
});

describe("secrets", () => {
  it("never reach a log line, a summary or an error", async () => {
    const leaky = vendor([one]);
    leaky.logs = [`calling the vendor with ${secretToken}`];
    leaky.conditions = [["token", `the token ${secretToken} is about to expire`]];
    leaky.fail = new Error(`401 for Bearer ${secretToken} and key ${harness.server.key}`);
    await harness.once(leaky);

    const reported = harness.server.runs.map((run) => `${run.summary ?? ""} ${run.error ?? ""}`);
    for (const text of [...harness.lines, ...reported]) {
      expect(text).not.toContain(secretToken);
      expect(text).not.toContain(harness.server.key);
    }
    expect(harness.lines.join("\n")).toContain("calling the vendor with [redacted]");
    expect(harness.lastRun().error).toContain("401 for Bearer [redacted] and key [redacted]");
  });
});
