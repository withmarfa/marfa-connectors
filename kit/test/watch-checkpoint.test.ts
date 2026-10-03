import { afterEach, beforeEach, expect, it } from "vitest";
import { Harness, testType, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

it("acknowledges watch agreement work before rescanning a row on restart", async () => {
  const entry = { source_id: "one", properties: { title: "One" } };
  const held = vendor();
  held.read = async (context) => {
    const scope = context.forScope("list");
    const page = scope.state.get("page") as number | undefined;
    await scope.upsert(testType.id, [entry]);
    expect(await scope.state.checkpoint("page", (page ?? 0) + 1)).toEqual({
      committed: true,
    });
  };
  expect(await harness.once(held)).toBe(0);
  const first = harness.server.row("one");
  const version = first.version;
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ page: 2 });
  expect(harness.server.row("one").id).toBe(first.id);
  expect(harness.server.row("one").version).toBe(version);
});

it.each([400, 503])(
  "does not enter the reader or save state after watch prerequisite %i",
  async (status) => {
    const held = vendor([{ source_id: "one", properties: { title: "One" } }]);
    expect(await harness.once(held)).toBe(0);
    const kept = structuredClone(harness.kept());
    const from = harness.server.requests.length;
    let read = false;
    held.read = () => {
      read = true;
      return Promise.resolve();
    };
    harness.server.refuseNext(
      "POST /connectors/connector-1/agreements",
      status,
      "internal_error",
    );
    expect(await harness.once(held)).toBe(1);
    expect(read).toBe(false);
    const requests = harness.server.requests.slice(from);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" && request.path.endsWith("/agreements"),
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "PUT" && request.path.endsWith("/state"),
      ),
    ).toHaveLength(0);
    expect(harness.kept()).toEqual(kept);
  },
);

it("keeps caller root ownership distinct from a later scoped rescan", async () => {
  const held = vendor();
  held.read = async (context) => {
    const entry = { source_id: "shared", properties: { title: "Shared" } };
    await context.upsert(testType.id, [entry]);
    const scope = context.forScope("list");
    await scope.upsert(testType.id, [entry]);
    expect(await scope.state.checkpoint("page", 1)).toEqual({
      committed: false,
      reason: "scope-overlap",
    });
    expect(
      await context.forScope("independent").state.checkpoint("other", 1),
    ).toEqual({ committed: true });
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.kept()["state"]).toEqual({ other: 1 });
});

it.each(["root", "scoped"] as const)(
  "keeps an unawaited %s operation from saving final state",
  async (kind) => {
    const held = vendor();
    let operation: Promise<void> | undefined;
    held.read = (context) => {
      const reader = kind === "root" ? context : context.forScope("list");
      operation = reader
        .upsert(testType.id, [
          { source_id: "in-flight", properties: { title: "In flight" } },
        ])
        .then(
          () => undefined,
          () => undefined,
        );
      return Promise.resolve();
    };
    expect(await harness.once(held)).toBe(1);
    await operation;
    expect(
      harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
    ).toHaveLength(0);
    expect(harness.lastRun().error).toContain("not awaited");
  },
);
