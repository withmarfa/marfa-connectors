import assert from "node:assert/strict";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";

export async function proveRetryArchive(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  await check(
    "retry deletion distinguishes refused inserts from existing and hidden rows",
    async () => {
      const type = "proof.retry-archive",
        other = "proof.retry-archive-other",
        source = "proof-retry-archive";
      for (const id of [type, other]) {
        const registered = await marfa.POST("/types", {
          body: {
            id,
            label: "Retry archive proof",
            link_field: "vendor_id",
            fields: {
              title: { type: "string", required: true },
              vendor_id: { type: "string" },
            },
          },
        });
        assert.ok(
          registered.data,
          `type refused: ${JSON.stringify(registered.error)}`,
        );
      }
      const minted = await marfa.POST("/keys", {
        body: {
          label: "Retry archive proof",
          source,
          type_permissions: { [type]: "write" },
          default_tier: "feed",
        },
      });
      assert.ok(minted.data, `key refused: ${JSON.stringify(minted.error)}`);
      const own = createClient({ baseUrl: url, credential: minted.data.key });
      const refuse = async (id: string, version = 0) => {
        const answer = await own.POST("/items/bulk", {
          body: {
            atomic: false,
            items: [
              {
                type,
                source,
                source_id: id,
                version,
                properties: { title: 42, vendor_id: id },
                tier: "feed",
              },
            ],
          },
        });
        assert.ok(answer.data, `bulk refused: ${JSON.stringify(answer.error)}`);
        const result = answer.data.results[0];
        assert.ok(result);
        return result;
      };
      const absent = await refuse("new");
      assert.equal(absent.error?.code, "invalid_properties");
      assert.equal(absent.id, undefined);
      const created = await own.POST("/items", {
        body: {
          type,
          source,
          source_id: "existing",
          properties: { title: "Existing", vendor_id: "existing" },
        },
      });
      assert.ok(created.data);
      const existing = await refuse("existing", created.data.item.version);
      assert.equal(existing.error?.code, "invalid_properties");
      assert.equal(existing.id, created.data.item.id);
      const moved = await marfa.PATCH("/items/{id}", {
        params: { path: { id: created.data.item.id } },
        body: { type: other, retype: true, version: created.data.item.version },
      });
      assert.ok(moved.data, `retype refused: ${JSON.stringify(moved.error)}`);
      for (const selector of [
        { links: ["existing"] },
        { source, source_ids: ["existing"] },
      ]) {
        const lookup = await own.POST("/items/lookup", {
          body: { type, ...selector },
        });
        assert.ok(lookup.data);
        assert.deepEqual(lookup.data.data, []);
      }
      const hidden = await refuse("existing");
      assert.equal(hidden.error?.code, "type_not_permitted");
      assert.equal(hidden.id, undefined);
      const retained = await marfa.GET("/items/{id}", {
        params: { path: { id: created.data.item.id } },
      });
      assert.equal(retained.data?.item.type, other);
      return "invalid insert has no row id; existing property refusal has its id; hidden retyped row is refused before property validation and remains intact";
    },
  );
}
