import { expect, it } from "vitest";
import { defineConnector } from "../src/define.js";
import { start } from "../src/main.js";
import { Unreachable } from "../src/rows.js";
import { Harness, linkedType } from "./harness.js";

it("carries a policy-free sibling trash while recovering another row's journal", async () => {
  const harness = await Harness.create();
  const sent: string[] = [];
  let seed = true;
  let fail = true;
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    async run(context) {
      if (!seed) return;
      await context.upsert(
        linkedType.id,
        ["one", "two"].map((id) => ({
          source_id: id,
          properties: { title: id, vendor_id: `vendor-${id}` },
        })),
      );
      seed = false;
    },
    async onChange(change, context) {
      sent.push(`${String(change.item.source_id)}:${change.kind}`);
      if (change.item.source_id === "two") return;
      const intent =
        context.outbound.get(change.item.id) ??
        (await context.outbound.save(change, {
          request: { title: "Captured" },
          baseline: null,
        }));
      if (fail) throw new Unreachable("lost answer");
      await context.outbound.acknowledge(change.item.id, intent.token);
    },
  });
  const once = () => start(connector, harness.runtime(["--once"]));
  try {
    expect(await once()).toBe(0);
    harness.server.edit(harness.server.row("one").id, { title: "Captured" });
    expect(await once()).toBe(0);
    expect(harness.kept()["outbound"]).toHaveLength(1);
    harness.server.trash(harness.server.row("two").id);
    fail = false;
    expect(await once()).toBe(0);
    expect(sent).toContain("two:trashed");
  } finally {
    await harness.close();
  }
});
