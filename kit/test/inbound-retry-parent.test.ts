import { expect, it } from "vitest";
import { Harness, testType, vendor } from "./harness.js";
import { digest, intentOf } from "../src/inbound-retry.js";
import type { PendingInbound } from "../src/define.js";

it.each(["create", "update"])(
  "captures exact %s input before an asynchronous refusal",
  async (mode) => {
    const harness = await Harness.create();
    try {
      const entry = {
        source_id: "bad",
        properties: { title: 42 },
        occurred_at: "2020-01-01T00:00:00.000Z",
        movedFrom: ["old"],
        connections: {},
      };
      const attempted = intentOf(testType.id, entry);
      if (mode === "update") {
        const initial = vendor();
        initial.read = async (context) => {
          await context.upsert(testType.id, [
            { source_id: "good", properties: { title: "Good" } },
            { source_id: "bad", properties: { title: "Before" } },
          ]);
        };
        expect(await harness.once(initial)).toBe(0);
        harness.server.refuseNext(
          `PATCH /items/${harness.server.row("bad").id}`,
          400,
          "invalid_properties",
          "Bad title",
        );
      }
      harness.server.entryRefusals.set("bad", {
        status: 400,
        code: "invalid_properties",
        message: "Bad title",
      });
      let observed: unknown;
      harness.server.beforeAnswer = (request) => {
        if (
          (mode === "create" &&
            request.method === "POST" &&
            request.path === "/items/bulk") ||
          (mode === "update" &&
            request.method === "PATCH" &&
            request.path === `/items/${harness.server.row("bad").id}`)
        ) {
          observed = structuredClone(request.body);
          entry.properties.title = 99;
          entry.source_id = "mutated";
          entry.occurred_at = "2025-01-01T00:00:00.000Z";
          entry.movedFrom[0] = "mutated-old";
        }
      };
      const held = vendor();
      held.read = async (context) => {
        const scope = context.forScope("A", {
          retry: { mode: "replay", context: "a".repeat(64) },
        });
        await scope.upsert(testType.id, [
          { source_id: "good", properties: { title: "Good" } },
          entry,
        ]);
        expect(await scope.state.checkpoint("page", 1)).toEqual({
          committed: true,
        });
      };
      expect(await harness.once(held)).toBe(0);
      expect(JSON.stringify(observed)).toContain('"title":42');
      const record = (harness.kept()["inbound"] as PendingInbound[])[0];
      expect(record?.mode).toBe("replay");
      if (record?.mode !== "replay") throw new Error("missing replay witness");
      expect(record.intent).toEqual(attempted);
      expect(record.fingerprint).toBe(digest(attempted));
      expect(record.identity.sourceId).toBe("bad");
    } finally {
      await harness.close();
    }
  },
);
