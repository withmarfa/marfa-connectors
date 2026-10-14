import { afterEach, beforeEach, expect, it } from "vitest";
import type { Entry, PendingInbound } from "../src/define.js";
import { Harness, testType, vendor } from "./harness.js";

let harness: Harness;
const retry = { mode: "replay" as const, context: "a".repeat(64) };
const bad = ["one", "two"].map((id) => ({
  source_id: id,
  properties: { title: id },
}));
const good = { source_id: "good", properties: { title: "Good" } };
const records = () => harness.kept()["inbound"] as PendingInbound[];
function refuse(message = "bad") {
  for (const entry of bad)
    harness.server.entryRefusals.set(entry.source_id, {
      status: 400,
      code: "invalid_properties",
      message,
    });
}
async function park(
  entries: Entry[] = bad,
  mode: "replay" | "refetch" = "replay",
) {
  refuse();
  const source = vendor();
  source.read = async (ctx) => {
    const scope = ctx.forScope("A", { retry: { ...retry, mode } });
    await scope.upsert(testType.id, [...entries, good]);
    await scope.state.checkpoint("page", 1);
  };
  expect(await harness.once(source)).toBe(0);
  expect(records()).toHaveLength(2);
  harness.clock.advance(24 * 60 * 60 * 1000);
}
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

it.each(["replay", "refetch"] as const)(
  "continues new imports after an unchanged acknowledged %s retry batch is refused again",
  async (mode) => {
    await park(bad, mode);
    const before = records().map((record) => record.attemptedAt);
    const source = vendor();
    source.read = async (ctx) => {
      const a = ctx.forScope("A", { retry: { ...retry, mode } });
      await a.upsert(testType.id, bad);
      expect(await a.state.checkpoint("page", 2)).toEqual({ committed: true });
      const b = ctx.forScope("B", { retry });
      await b.upsert(testType.id, [{ ...good, source_id: "new" }]);
      expect(await b.state.checkpoint("next", 1)).toEqual({ committed: true });
    };
    expect(await harness.once(source)).toBe(0);
    expect(harness.server.row("new").properties["title"]).toBe("Good");
    expect(records()).toHaveLength(2);
    expect(records().map((record) => record.attemptedAt)).not.toEqual(before);
    expect(harness.kept()["state"]).toEqual({ page: 2, next: 1 });
  },
);
it.each(["new", "intent", "context", "mode", "scope", "unacknowledged"])(
  "still fails a systemic batch with %s refusal evidence",
  async (kind) => {
    if (kind !== "new" && kind !== "unacknowledged") await park();
    else refuse();
    const source = vendor();
    source.read = async (ctx) => {
      const scope = ctx.forScope(kind === "scope" ? "B" : "A", {
        retry:
          kind === "context"
            ? { ...retry, context: "b".repeat(64) }
            : kind === "mode"
              ? { ...retry, mode: "refetch" }
              : retry,
      });
      if (kind === "unacknowledged") {
        harness.clock.advance(-24 * 60 * 60 * 1000);
        for (const entry of bad) await scope.upsert(testType.id, [entry]);
        harness.clock.advance(24 * 60 * 60 * 1000);
      }
      await scope.upsert(
        testType.id,
        kind === "intent"
          ? bad.map((entry) => ({ ...entry, properties: { title: "Changed" } }))
          : bad,
      );
      await scope.state.checkpoint("page", 2);
    };
    expect(await harness.once(source)).toBe(1);
    expect(harness.lastRun().error).toContain("every one");
    expect(harness.kept()["state"]).not.toEqual({ page: 2 });
  },
);
it("still fails new systemic refusals mixed with retained retries", async () => {
  await park();
  const fresh = bad.map((entry) => ({
    ...entry,
    source_id: `new-${entry.source_id}`,
  }));
  for (const entry of fresh)
    harness.server.entryRefusals.set(entry.source_id, {
      status: 400,
      code: "invalid_properties",
      message: "bad",
    });
  const source = vendor();
  source.read = async (ctx) => {
    const scope = ctx.forScope("A", { retry });
    await scope.upsert(testType.id, [...bad, ...fresh]);
    await scope.state.checkpoint("page", 2);
  };
  expect(await harness.once(source)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ page: 1 });
  expect(records()).toHaveLength(2);
});
it.each([401, 503])(
  "still fails a retry batch after HTTP %s",
  async (status) => {
    await park();
    harness.server.refuseNext(
      "POST /items/bulk",
      status,
      status === 401 ? "unauthorized" : "service_unavailable",
    );
    const source = vendor();
    source.read = async (ctx) => {
      const scope = ctx.forScope("A", { retry });
      await scope.upsert(testType.id, bad);
      await scope.state.checkpoint("page", 2);
    };
    expect(await harness.once(source)).toBe(1);
    expect(harness.kept()["state"]).toEqual({ page: 1 });
    expect(records()).toHaveLength(2);
  },
);
it("blocks a retry checkpoint when its refreshed records exceed the journal bound", async () => {
  const large = bad.map((entry) => ({
    ...entry,
    properties: { title: "x".repeat(32090) },
  }));
  await park(large);
  const before = structuredClone(records());
  refuse("x".repeat(3000));
  const source = vendor();
  let checkpoint: unknown;
  source.read = async (ctx) => {
    const scope = ctx.forScope("A", { retry });
    await scope.upsert(testType.id, large);
    checkpoint = await scope.state.checkpoint("page", 2);
  };
  await harness.once(source);
  expect(checkpoint).toEqual({ committed: false, reason: "state-oversized" });
  expect(records()).toEqual(before);
  expect(harness.kept()["state"]).toEqual({ page: 1 });
});
