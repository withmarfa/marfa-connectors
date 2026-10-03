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
