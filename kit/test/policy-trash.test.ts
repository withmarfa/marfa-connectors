import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector, type Change, type Item } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(() => harness.close());

function fixture(policy = true) {
  let seed = true;
  const changes: Change[] = [];
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [
      {
        type: linkedType,
        fields: ["title", "note", "vendor_id"],
        ...(policy
          ? {
              policy: (item: Item | undefined) => ({
                owned: item?.properties["note"] !== "adopted",
              }),
            }
          : {}),
      },
    ],
    async run(context) {
      if (!seed) return;
      await context.upsert(linkedType.id, [
        {
          source_id: "one",
          properties: { title: "Original", vendor_id: "vendor-one" },
        },
      ]);
      seed = false;
    },
    onChange(change) {
      changes.push(change);
      return Promise.resolve();
    },
  });
  return {
    changes,
    once: () => start(connector, harness.runtime(["--once"])),
  };
}

it.each([false, true])(
  "carries a trash exactly once when ownership permits it; policy=%s",
  async (policy) => {
    const f = fixture(policy);
    expect(await f.once(), harness.lines.join("\n")).toBe(0);
    const row = harness.server.row("one");
    harness.server.trash(row.id);
    expect(await f.once(), harness.lines.join("\n")).toBe(0);
    expect(f.changes.map((change) => change.kind)).toEqual(["trashed"]);
    expect(row.state).toBe("trashed");
    expect(await f.once(), harness.lines.join("\n")).toBe(0);
    expect(f.changes.map((change) => change.kind)).toEqual(["trashed"]);
    expect(harness.server.row("one").state).toBe("trashed");
  },
);

it("does not carry a trash when the row was adopted", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.row("one");
  harness.server.touch("one", { note: "adopted" });
  harness.server.trash(row.id);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.changes).toEqual([]);
  expect(harness.server.row("one").state).toBe("trashed");
});

it.each([1, 2])(
  "rechecks a trash's current ownership at admission %s",
  async (at) => {
    const f = fixture();
    await f.once();
    const row = harness.server.row("one");
    harness.server.trash(row.id);
    let reads = 0;
    harness.server.beforeAnswer = (request) => {
      const body = request.body as { ids?: string[] } | undefined;
      if (
        (request.method === "GET" && request.path === `/items/${row.id}`) ||
        (request.method === "POST" &&
          request.path === "/items/lookup" &&
          body?.ids?.includes(row.id))
      ) {
        reads += 1;
        if (reads === at) harness.server.touch("one", { note: "adopted" });
      }
    };
    expect(await f.once(), harness.lines.join("\n")).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(at);
    expect(f.changes).toEqual([]);
    expect(harness.server.row("one").state).toBe("trashed");
    expect(harness.server.row("one").properties["note"]).toBe("adopted");
  },
);

it.each(["restore", "purge"] as const)(
  "uses the current lifecycle when a row changes after trash observation: %s",
  async (operation) => {
    const f = fixture();
    await f.once();
    const row = harness.server.row("one");
    harness.server.trash(row.id);
    let raced = false;
    harness.server.beforeAnswer = (request) => {
      const body = request.body as { ids?: string[] } | undefined;
      if (
        !raced &&
        ((request.method === "GET" && request.path === `/items/${row.id}`) ||
          (request.method === "POST" &&
            request.path === "/items/lookup" &&
            body?.ids?.includes(row.id)))
      ) {
        raced = true;
        if (operation === "restore") harness.server.restore(row.id);
        else harness.server.purge("one");
      }
    };
    const cursor = harness.kept()["cursor"];
    expect(await f.once(), harness.lines.join("\n")).toBe(
      operation === "purge" ? 1 : 0,
    );
    expect(raced).toBe(true);
    expect(f.changes).toEqual([]);
    expect(harness.server.rows).toHaveLength(operation === "restore" ? 1 : 0);
    if (operation === "restore") {
      expect(harness.server.row("one").state).toBe("active");
    } else {
      expect(harness.kept()["cursor"]).toEqual(cursor);
      harness.server.beforeAnswer = undefined;
      expect(await f.once(), harness.lines.join("\n")).toBe(0);
      expect(f.changes.map((change) => change.kind)).toEqual(["purged"]);
      expect(harness.server.rows).toEqual([]);
    }
  },
);
