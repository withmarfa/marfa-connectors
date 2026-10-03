import { afterEach, beforeEach, expect, it } from "vitest";
import { Harness, testType, vendor } from "./harness.js";
let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});
it("parks complete opted-in invalid creates with progress and detached retry intent", async () => {
  harness.server.entryRefusals.set("bad", {
    status: 400,
    code: "invalid_properties",
    message: "Bad title",
  });
  const held = vendor();
  held.read = async (context) => {
    const scope = context.forScope("A", {
      retry: { mode: "replay", context: "a".repeat(64) },
    });
    await scope.upsert(testType.id, [
      { source_id: "good", properties: { title: "Good" } },
      { source_id: "bad", properties: { title: 42 } },
    ]);
    expect(await scope.state.checkpoint("page", 1)).toEqual({
      committed: true,
    });
    const pending = scope.refusals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.record.identity.sourceId).toBe("bad");
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ page: 1 });
});

const retry = { mode: "replay" as const, context: "a".repeat(64) };
const bad = { source_id: "bad", properties: { title: "Bad" } };
function refused() {
  harness.server.entryRefusals.set("bad", {
    status: 400,
    code: "invalid_properties",
    message: "Bad title",
  });
}
function inbound() {
  return harness.kept()[
    "inbound"
  ] as import("../src/define.js").PendingInbound[];
}
it("suppresses unchanged intent until due, retries due or context changes, and settles changed input", async () => {
  refused();
  const held = vendor();
  let options = retry;
  let entry = bad;
  let page = 0;
  held.read = async (context) => {
    const scope = context.forScope("A", { retry: options });
    await scope.upsert(testType.id, [entry]);
    expect(await scope.state.checkpoint("page", ++page)).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held)).toBe(0);
  const first = structuredClone(inbound()[0]);
  expect(first).toBeDefined();
  const attempts = () =>
    harness.server.requests.filter(
      (request) => request.method === "POST" && request.path === "/items/bulk",
    ).length;
  const count = attempts();
  expect(await harness.once(held)).toBe(0);
  expect(attempts()).toBe(count);
  expect(inbound()[0]).toEqual(first);
  harness.clock.advance(24 * 60 * 60 * 1000);
  expect(await harness.once(held)).toBe(0);
  expect(attempts()).toBe(count + 1);
  expect(inbound()[0]?.attemptedAt).not.toBe(first?.attemptedAt);
  options = { ...retry, context: "b".repeat(64) };
  expect(await harness.once(held)).toBe(0);
  expect(attempts()).toBe(count + 2);
  harness.server.entryRefusals.delete("bad");
  entry = { ...bad, properties: { title: "Changed" } };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toBeUndefined();
  expect(
    harness.server.rows.find((row) => row.source_id === "bad")?.properties[
      "title"
    ],
  ).toBe("Changed");
});
it("returns detached acknowledged records and preserves omitted pending input", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    const scope = context.forScope("A", { retry });
    await scope.upsert(testType.id, [bad]);
    expect(scope.refusals.pending()).toEqual([]);
    expect(await scope.state.checkpoint("page", 1)).toEqual({
      committed: true,
    });
    const records = scope.refusals.pending();
    const record = records[0];
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("missing record");
    record.record.identity.sourceId = "mutated";
    expect(scope.refusals.pending()[0]?.record.identity.sourceId).toBe("bad");
  };
  expect(await harness.once(held)).toBe(0);
  const saved = structuredClone(inbound());
  held.read = async (context) => {
    const scope = context.forScope("A", { retry });
    expect(await scope.state.checkpoint("page", 2)).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toEqual(saved);
});
it("retains incapable and legacy callers' blocked progress", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    const scope = context.forScope("A");
    await scope.upsert(testType.id, [bad]);
    expect(await scope.state.checkpoint("page", 1)).toEqual({
      committed: false,
      reason: "row-refused",
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toBeUndefined();
  expect(harness.kept()["state"]).toEqual({});
  held.read = async (context) => {
    await context.upsert(testType.id, [bad]);
    context.state.set("page", 1);
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({});
});
it.each(["undeclared", "file"])(
  "blocks an unrepresented scoped %s omission",
  async (kind) => {
    const held = vendor();
    held.read = async (context) => {
      const scope = context.forScope("A", { retry });
      await scope.upsert(testType.id, [
        kind === "undeclared"
          ? { ...bad, properties: { title: "Bad", extra: true } }
          : {
              ...bad,
              file: {
                key: "x",
                load: () =>
                  Promise.resolve({
                    bytes: new Uint8Array([1]),
                    mime_type: "text/plain",
                  }),
              },
            },
      ]);
      expect(await scope.state.checkpoint("page", 1)).toEqual({
        committed: false,
        reason: "row-refused",
      });
    };
    expect(await harness.once(held)).toBe(0);
    expect(inbound()).toBeUndefined();
    expect(harness.kept()["state"]).toEqual({});
  },
);
it("keeps systemic same-code failures and excludes A speculation from B's shared map", async () => {
  refused();
  harness.server.entryRefusals.set("second", {
    status: 400,
    code: "invalid_properties",
    message: "Bad",
  });
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await expect(
      a.upsert(testType.id, [bad, { ...bad, source_id: "second" }]),
    ).rejects.toThrow("every one");
    expect(await a.state.checkpoint("vendors", { A: 1 })).toEqual({
      committed: false,
      reason: "row-refused",
    });
    const b = context.forScope("B", { retry });
    expect(
      await b.state.checkpoint("vendors", {
        ...(b.state.get("vendors") as object),
        B: 1,
      }),
    ).toEqual({ committed: true });
    expect(b.refusals.pending()).toEqual([]);
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toBeUndefined();
  expect(harness.kept()["state"]).toEqual({ vendors: { B: 1 } });
});
it.each(["unknown", "version_conflict", "link_taken", "type_mismatch"])(
  "does not park %s",
  async (code) => {
    harness.server.entryRefusals.set("bad", {
      status: 400,
      code,
      message: "Refused",
    });
    const held = vendor();
    held.read = async (context) => {
      const a = context.forScope("A", { retry });
      await a.upsert(testType.id, [bad]);
      expect(await a.state.checkpoint("page", 1)).toEqual({
        committed: false,
        reason: "row-refused",
      });
    };
    expect(await harness.once(held)).toBe(0);
    expect(inbound()).toBeUndefined();
  },
);
it("does not park lost key or incomplete file/replay input", async () => {
  harness.server.refuseNext("POST /items/bulk", 401, "unauthorized");
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, [bad]);
  };
  expect(await harness.once(held)).toBe(1);
  expect(inbound()).toBeUndefined();
});
it("does not save speculative intent after an applied/lost state response", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, [bad]);
    harness.server.loseStateAnswer = true;
    await a.state.checkpoint("page", 1);
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()["state"]).toEqual({ page: 1 });
  expect(inbound()).toHaveLength(1);
  expect(
    harness.server.requests.filter(
      (request) => request.method === "PUT" && request.path.endsWith("/state"),
    ),
  ).toHaveLength(1);
});
it("blocks journal capacity without leaking speculative entries to another scope", async () => {
  const entries = Array.from({ length: 129 }, (_, index) => ({
    source_id: `bad-${String(index)}`,
    properties: { title: "Bad" },
  }));
  for (const entry of entries)
    harness.server.entryRefusals.set(entry.source_id, {
      status: 400,
      code: "invalid_properties",
      message: "Bad",
    });
  // One successful operation avoids the existing all-same-code systemic stop.
  entries.push({ source_id: "good", properties: { title: "Good" } });
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, entries);
    expect((await a.state.checkpoint("map", { A: 1 })).committed).toBe(false);
    const b = context.forScope("B", { retry });
    expect(await b.state.checkpoint("map", { B: 1 })).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toBeUndefined();
  expect(harness.kept()["state"]).toEqual({ map: { B: 1 } });
});
it("blocks a complete oversized replay without truncating its identity or intent", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, [
      { ...bad, properties: { title: "x".repeat(65536) } },
    ]);
    expect((await a.state.checkpoint("page", 1)).committed).toBe(false);
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toBeUndefined();
  expect(harness.kept()["state"]).toEqual({});
});
it("keeps durable refusal visibility beyond 200 generic conditions", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    for (let index = 0; index < 200; index++)
      context.log.condition(
        `generic-${String(index)}`,
        `Generic ${String(index)}`,
      );
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, [bad]);
    expect(await a.state.checkpoint("page", 1)).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toHaveLength(1);
  const first = harness.lines.length;
  held.read = async (context) => {
    for (let index = 0; index < 200; index++)
      context.log.condition(
        `generic-${String(index)}`,
        `Generic ${String(index)}`,
      );
    const a = context.forScope("A", { retry });
    expect(await a.state.checkpoint("page", 2)).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toHaveLength(1);
  expect(harness.lines.slice(first).join("\n")).toContain(
    "durable retry intent waits",
  );
  expect(Object.keys(harness.kept()["conditions"] as object).length).toBe(200);
});
it("checks the complete envelope before acknowledging marker removal", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, [bad]);
    expect(await a.state.checkpoint("page", 1)).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  const saved = structuredClone(inbound());
  harness.server.entryRefusals.delete("bad");
  held.read = async (context) => {
    const a = context.forScope("A", {
      retry: { ...retry, context: "b".repeat(64) },
    });
    await a.upsert(testType.id, [bad]);
    expect(await a.state.checkpoint("huge", "x".repeat(524288))).toEqual({
      committed: false,
      reason: "state-oversized",
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toEqual(saved);
});
it("rejects nonlossless replay and malformed saved intent", async () => {
  refused();
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry });
    await a.upsert(testType.id, [
      { ...bad, properties: { title: { nested: undefined } } },
    ]);
    expect(await a.state.checkpoint("page", 1)).toEqual({
      committed: false,
      reason: "row-refused",
    });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()).toBeUndefined();
  harness.server.states.set("test", {
    state: {},
    conditions: {},
    inbound: [{ invalid: true }],
  });
  const saved = structuredClone(harness.kept());
  held.read = () => Promise.resolve();
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()).toEqual(saved);
});
it("parks only a singleton 413 after the existing recursive split", async () => {
  harness.server.beforeAnswer = (request) => {
    if (request.method !== "POST" || request.path !== "/items/bulk") return;
    const items = (request.body as { items: { source_id: string }[] }).items;
    if (items.length > 1 || items[0]?.source_id === "bad")
      harness.server.refuseNext("POST /items/bulk", 413, "request_too_large");
  };
  const held = vendor();
  held.read = async (context) => {
    const a = context.forScope("A", { retry: { ...retry, mode: "refetch" } });
    await a.upsert(testType.id, [
      { source_id: "good", properties: { title: "Good" } },
      bad,
    ]);
    expect(await a.state.checkpoint("page", 1)).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  expect(inbound()[0]?.code).toBe("request_too_large");
  expect(inbound()[0]?.mode).toBe("refetch");
  const pages = harness.server.requests
    .filter(
      (request) => request.method === "POST" && request.path === "/items/bulk",
    )
    .map((request) => (request.body as { items: unknown[] }).items.length);
  expect(pages).toEqual([2, 1, 1]);
});
it("binds consistent explicit capabilities and full context digests", async () => {
  const held = vendor();
  held.read = (context) => {
    expect(() =>
      context.forScope("A", { retry: { ...retry, context: "short" } }),
    ).toThrow("SHA-256");
    context.forScope("A", { retry });
    expect(() =>
      context.forScope("A", { retry: { ...retry, context: "b".repeat(64) } }),
    ).toThrow("consistent");
    return Promise.resolve();
  };
  expect(await harness.once(held)).toBe(0);
});
