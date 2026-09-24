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
    expect(run.summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0",
    );
    expect(run.error).toBeUndefined();
    expect(Date.parse(run.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(run.started_at),
    );
  });

  it("carries a failure's text, capped to what the server takes", async () => {
    const failing = vendor([one]);
    failing.fail = new Error(`the vendor answered: ${"x".repeat(5000)}`);
    expect(await harness.once(failing)).toBe(1);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/^the vendor answered: x+/);
    expect(run.error?.length).toBeLessThanOrEqual(2000);
    expect(run.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 0, skipped 0",
    );
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
    const warned = harness.lines.filter((line) =>
      line.includes("the feed x answers 410"),
    );
    expect(warned).toHaveLength(1);

    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0",
    );
    expect(
      harness.lines.filter((line) => line.includes("the feed x answers 410")),
    ).toHaveLength(1);

    held.conditions = [];
    await harness.once(held);
    expect(
      harness.lines.filter((line) => line.includes("cleared")),
    ).toHaveLength(1);

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

    held.fail = undefined;
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    expect(harness.lastRun().summary).not.toContain("the feed x answers 410");
  });

  it("is reported on the next run when the report that carried it did not land", async () => {
    const held = vendor([one]);
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    harness.server.refuseNext(
      "POST /connectors/connector-1/runs",
      503,
      "unavailable",
    );
    await harness.once(held);
    expect(harness.server.runs).toEqual([]);
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("the feed x answers 410");
  });
});

describe("secrets", () => {
  it("never reach a log line, a summary or an error", async () => {
    const leaky = vendor([one]);
    leaky.logs = [`calling the vendor with ${secretToken}`];
    leaky.conditions = [
      ["token", `the token ${secretToken} is about to expire`],
    ];
    leaky.fail = new Error(
      `401 for Bearer ${secretToken} and key ${harness.server.key}`,
    );
    await harness.once(leaky);

    const reported = harness.server.runs.map(
      (run) => `${run.summary ?? ""} ${run.error ?? ""}`,
    );
    for (const text of [...harness.lines, ...reported]) {
      expect(text).not.toContain(secretToken);
      expect(text).not.toContain(harness.server.key);
    }
    expect(harness.lines.join("\n")).toContain(
      "calling the vendor with [redacted]",
    );
    expect(harness.lastRun().error).toContain(
      "401 for Bearer [redacted] and key [redacted]",
    );
  });

  it("never reach the state file, nor a URL that carries one encoded", async () => {
    const token = "tok/with+marks=value";
    const leaky = vendor([one]);
    leaky.logs = [
      `GET https://vendor.example.com/?token=${encodeURIComponent(token)}`,
    ];
    leaky.conditions = [["token", `the token ${token} is about to expire`]];
    await harness.once(leaky, { TEST_TOKEN: token });
    expect(JSON.stringify(await harness.stateFile())).not.toContain(token);
    expect(JSON.stringify(await harness.stateFile())).toContain(
      "[redacted] is about to expire",
    );
    const said = harness.lines.join("\n");
    expect(said).not.toContain(encodeURIComponent(token));
    expect(said).toContain("?token=[redacted]");
  });
});
