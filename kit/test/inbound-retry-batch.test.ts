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
it.each(["replay", "refetch"] as const)(
  "journals a %s batch whose every row is newly refused, and checkpoints",
  async (mode) => {
    refuse();
    const source = vendor();
    source.read = async (ctx) => {
      const a = ctx.forScope("A", { retry: { ...retry, mode } });
      await a.upsert(testType.id, bad);
      expect(await a.state.checkpoint("page", 1)).toEqual({ committed: true });
      const b = ctx.forScope("B", { retry });
      await b.upsert(testType.id, [good]);
      expect(await b.state.checkpoint("next", 1)).toEqual({ committed: true });
    };
    expect(await harness.once(source)).toBe(0);
    expect(records().map((record) => record.identity.sourceId)).toEqual([
      "one",
      "two",
    ]);
    expect(harness.kept()["state"]).toEqual({ page: 1, next: 1 });
    expect(harness.server.row("good").properties["title"]).toBe("Good");
  },
);
it.each(["intent", "context", "unacknowledged"])(
  "journals an all-refused batch with %s refusal evidence",
  async (kind) => {
    if (kind === "unacknowledged") refuse();
    else await park();
    const source = vendor();
    source.read = async (ctx) => {
      const scope = ctx.forScope("A", {
        retry:
          kind === "context" ? { ...retry, context: "b".repeat(64) } : retry,
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
      expect(await scope.state.checkpoint("page", 2)).toEqual({
        committed: true,
      });
    };
    expect(await harness.once(source)).toBe(0);
    expect(harness.kept()["state"]).toEqual({ page: 2 });
    expect(records()).toHaveLength(2);
  },
);
it("journals new refusals beside retained retries", async () => {
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
    expect(await scope.state.checkpoint("page", 2)).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(source)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ page: 2 });
  expect(records()).toHaveLength(4);
});
it("blocks without failing a batch retried in a different mode", async () => {
  await park();
  const source = vendor();
  source.read = async (ctx) => {
    const scope = ctx.forScope("A", { retry: { ...retry, mode: "refetch" } });
    await scope.upsert(testType.id, bad);
    expect(await scope.state.checkpoint("page", 2)).toEqual({
      committed: false,
      reason: "row-refused",
    });
  };
  expect(await harness.once(source)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ page: 1 });
  expect(records().map((record) => record.mode)).toEqual(["replay", "replay"]);
});
it("still fails a batch whose retries another scope owns", async () => {
  await park();
  const source = vendor();
  source.read = async (ctx) => {
    const scope = ctx.forScope("B", { retry });
    await scope.upsert(testType.id, bad);
    await scope.state.checkpoint("page", 2);
  };
  expect(await harness.once(source)).toBe(1);
  expect(harness.lastRun().error).toContain("every one of the 2 rows");
  expect(harness.kept()["state"]).toEqual({ page: 1 });
});
it.each(["unknown", "validation_error"])(
  "still fails a retry batch whose every row is refused with %s",
  async (code) => {
    for (const entry of bad)
      harness.server.entryRefusals.set(entry.source_id, {
        status: 400,
        code,
        message: "bad",
      });
    const source = vendor();
    source.read = async (ctx) => {
      const scope = ctx.forScope("A", { retry });
      await scope.upsert(testType.id, bad);
      await scope.state.checkpoint("page", 1);
    };
    expect(await harness.once(source)).toBe(1);
    expect(harness.lastRun().error).toContain(
      `every one of the 2 rows written was refused`,
    );
    expect(harness.kept()).not.toHaveProperty("state.page");
    expect(harness.kept()["inbound"]).toBeUndefined();
  },
);
it("still fails an all-refused batch in a scope without a retry capability", async () => {
  refuse();
  const source = vendor();
  source.read = async (ctx) => {
    const scope = ctx.forScope("A");
    await scope.upsert(testType.id, bad);
    await scope.state.checkpoint("page", 1);
  };
  expect(await harness.once(source)).toBe(1);
  expect(harness.lastRun().error).toContain(
    "every one of the 2 rows written was refused: bad",
  );
  expect(harness.kept()["inbound"]).toBeUndefined();
});
it.each([129, 130])(
  "blocks %i refusals at the journal's capacity and says the journal is full",
  async (count) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      source_id: `bad-${String(index)}`,
      properties: { title: "Bad" },
    }));
    for (const entry of entries)
      harness.server.entryRefusals.set(entry.source_id, {
        status: 400,
        code: "invalid_properties",
        message: "Bad",
      });
    const source = vendor();
    let checkpoint: unknown;
    source.read = async (ctx) => {
      const scope = ctx.forScope("A", { retry: { ...retry, mode: "refetch" } });
      try {
        await scope.upsert(testType.id, entries);
      } finally {
        checkpoint = await scope.state.checkpoint("page", 1);
      }
    };
    const code = await harness.once(source);
    expect(checkpoint).toEqual({ committed: false, reason: "state-oversized" });
    expect(harness.kept()).not.toHaveProperty("state.page");
    expect(harness.kept()["inbound"]).toBeUndefined();
    expect(harness.problems()["retry-journal-full:A"]).toContain(
      "no room for another refusal from scope A",
    );
    // Past the journal, two or more refusals of one code are systemic again.
    if (count === 130) {
      expect(code).toBe(1);
      expect(harness.lastRun().error).toContain(
        "every one of the 130 rows written was refused",
      );
    } else expect(code).toBe(0);
  },
);
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
