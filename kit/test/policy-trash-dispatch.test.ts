import { expect, it } from "vitest";
import { defineConnector, type Change } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType } from "./harness.js";

it.each(["adopt", "restore", "edit", "witness"])(
  "rechecks after placement: %s",
  async (operation) => {
    const h = await Harness.create();
    try {
      h.server.grants = {
        type_permissions: { "test.entry": "write" },
        edge_permissions: { "test.blocks": "write" },
        metadata_permissions: { types: "write", edge_types: "write" },
      };
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
            readOnly: ["test.blocks"],
            policy: (item) => ({
              owned: item?.properties["note"] !== "adopted",
            }),
          },
        ],
        connections: [
          {
            id: "test.blocks",
            cardinality: "many-to-many",
            source_type_constraints: [linkedType.id],
            target_type_constraints: [linkedType.id],
          },
        ],
        async run(context) {
          if (!seed) return;
          await context.upsert(linkedType.id, [
            {
              source_id: "two",
              properties: { title: "Target", vendor_id: "two" },
            },
            {
              source_id: "one",
              properties: { title: "Source", vendor_id: "one" },
              connections: {
                "test.blocks": [{ type: linkedType.id, id: "two" }],
              },
            },
          ]);
          seed = false;
        },
        onChange(change) {
          changes.push(change);
          return Promise.resolve(undefined);
        },
      });
      const once = () => start(connector, h.runtime(["--once"]));
      expect(await once(), h.lines.join("\n")).toBe(0);
      changes.length = 0;
      const one = h.server.row("one");
      const two = h.server.row("two");
      h.server.trash(one.id);
      let sourceReads = 0;
      let raced = false;
      h.server.beforeAnswer = (request) => {
        const ids = (request.body as { ids?: string[] } | undefined)?.ids;
        if (request.path !== "/items/lookup") return;
        if (ids?.includes(one.id)) sourceReads += 1;
        if (
          sourceReads > 0 &&
          !raced &&
          ids?.includes(two.id) &&
          !ids.includes(one.id)
        ) {
          raced = true;
          if (operation === "adopt") h.server.touch("one", { note: "adopted" });
          if (operation === "restore") h.server.restore(one.id);
          if (operation === "edit")
            h.server.touch("one", { title: "Newer title" });
        }
      };
      expect(await once(), h.lines.join("\n")).toBe(0);
      expect(raced).toBe(true);
      expect(changes.map((c) => c.kind)).toEqual(
        operation === "witness" ? ["trashed"] : [],
      );
      h.server.beforeAnswer = undefined;
      if (operation === "adopt") h.server.touch("one", { note: "owned again" });
      expect(await once(), h.lines.join("\n")).toBe(0);
      expect(changes.map((change) => change.kind)).toEqual(
        operation === "restore" ? [] : ["trashed"],
      );
      if (operation === "edit")
        expect(changes[0]?.item.properties["title"]).toBe("Newer title");
    } finally {
      await h.close();
    }
  },
);
