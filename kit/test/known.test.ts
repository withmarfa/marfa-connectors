import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType, testType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

it.each([false, true])(
  "proves acknowledged identities across row states, with linked IDs %s",
  async (linked) => {
    const type = linked ? linkedType : testType;
    const ids = ["active", "archived", "trashed", "purged"];
    const keys = ids.map((id) => (linked ? `vendor:${id}` : id));
    let checking = false;
    const connector = defineConnector({
      name: "test",
      description: "Identity lookup test",
      source: "test",
      types: [{ type, fields: ["title", "vendor_id"] }],
      env: {},
      async run(context) {
        if (!checking) {
          await context.upsert(
            type.id,
            ids.map((id) => ({
              source_id: id,
              properties: {
                title: id,
                ...(linked && { vendor_id: `vendor:${id}` }),
              },
            })),
          );
          return;
        }
        for (const reader of [context, context.forScope("identity")]) {
          expect(
            await reader.known(type.id, [...keys, "manual", "missing"]),
          ).toEqual(new Set(keys.slice(0, 3)));
          const detached = await reader.known(type.id, [keys[0] ?? ""]);
          (detached as Set<string>).clear();
          expect(await reader.known(type.id, [keys[0] ?? ""])).toEqual(
            new Set([keys[0]]),
          );
        }
      },
    });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    harness.server.transition(harness.server.row("archived").id, "archived");
    harness.server.trash(harness.server.row("trashed").id);
    harness.server.purge("purged");
    harness.server.insert(
      "manual",
      { title: "manual", ...(linked && { vendor_id: "manual" }) },
      type.id,
    );
    checking = true;
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.row("archived").state).toBe("archived");
    expect(harness.server.row("trashed").state).toBe("trashed");
  },
);

it("does not prove a refused new identity and preserves an existing agreement", async () => {
  let checking = false;
  const connector = defineConnector({
    name: "test",
    description: "Refused identity lookup test",
    source: "test",
    types: [{ type: testType, fields: ["title"] }],
    env: {},
    async run(context) {
      await context.upsert(testType.id, [
        { source_id: "known", properties: { title: "Before" } },
      ]);
      if (!checking) return;
      harness.server.refuseNext(
        `PATCH /items/${harness.server.row("known").id}`,
        400,
        "invalid_properties",
        "invalid title",
      );
      harness.server.entryRefusals.set("refused", {
        status: 400,
        code: "invalid_properties",
        message: "invalid title",
      });
      await context.forScope("refusal").upsert(testType.id, [
        { source_id: "known", properties: { title: "Refused update" } },
        { source_id: "refused", properties: { title: "Refused" } },
        { source_id: "other", properties: { title: "Other" } },
      ]);
      expect(
        await context.known(testType.id, ["known", "refused", "missing"]),
      ).toEqual(new Set(["known"]));
    },
  });
  expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
  checking = true;
  expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("known").properties["title"]).toBe("Before");
});

it("propagates a refused identity lookup instead of reporting absence", async () => {
  const connector = defineConnector({
    name: "test",
    description: "Unavailable identity lookup test",
    source: "test",
    types: [{ type: testType, fields: ["title"] }],
    env: {},
    async run(context) {
      harness.server.refuseNext("POST /items/lookup", 403, "permission_denied");
      await expect(context.known(testType.id, ["missing"])).rejects.toThrow();
    },
  });
  expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
});
