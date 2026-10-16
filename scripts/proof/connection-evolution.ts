import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createClient } from "@withmarfa/client";
import { check } from "./check.js";
import { ConnectorUnderProof, item, rowsOf } from "./connector.js";
import type { ProofServer } from "./server.js";

export async function proveConnectionEvolution(
  url: string,
  mintKey: ProofServer["mintKey"],
  updateKey: ProofServer["updateKey"],
): Promise<void> {
  await check(
    "a connector upgrade widens stored connection endpoints without changing existing items or edges",
    async () => {
      const source = "proof-connection-evolution",
        type = "proof.evolution.entry",
        extra = "proof.evolution.extra",
        connection = "proof.evolution.in-repository";
      const key = await mintKey({
        label: "Connection evolution proof",
        source,
        type_permissions: { [type]: "write", [extra]: "write" },
        edge_permissions: { [connection]: "write" },
        metadata_permissions: { types: "write", edge_types: "write" },
        default_tier: "feed",
      });
      const client = createClient({ baseUrl: url, credential: key.key });
      const runner = new ConnectorUnderProof(
        source,
        url,
        key.key,
        {},
        resolve(import.meta.dirname, "connection-evolution-connector.js"),
      );
      const run = async (mode: "original" | "widened") =>
        runner.run(["--once"], { PROOF_EVOLUTION: mode });
      const initial = await run("original");
      assert.equal(initial.code, 0, initial.output);
      const rows = await rowsOf(client, type, source);
      const original = rows.get("original"),
        target = rows.get("target");
      assert.ok(original);
      assert.ok(target);
      const edges = async (id: string) => {
        const result = await client.GET("/items/{id}/edges", {
          params: {
            path: { id },
            query: { edge_type: connection },
          },
        });
        assert.ok(result.data, JSON.stringify(result.error));
        return result.data.data;
      };
      const held = await edges(original.id);
      assert.equal(held.length, 1);
      assert.equal(held[0]?.target_id, target.id);
      const definition = async () => {
        const result = await client.GET("/edge-types");
        assert.ok(result.data, JSON.stringify(result.error));
        const found = result.data.data.find((one) => one.id === connection);
        assert.ok(found);
        return found;
      };
      const before = await definition();
      assert.match(initial.output, /metadata edge_types=write/);
      await updateKey(key.id, {
        metadata_permissions: { types: "write", edge_types: "read" },
      });
      const current = await client.GET("/keys/current");
      assert.equal(current.data?.metadata_permissions["edge_types"], "read");
      const refused = await run("widened");
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /403/);
      assert.deepEqual(await definition(), before);
      assert.deepEqual(await item(client, original.id), original);
      assert.deepEqual(await edges(original.id), held);
      assert.equal((await rowsOf(client, extra, source)).size, 0);

      await updateKey(key.id, {
        metadata_permissions: { types: "write", edge_types: "write" },
      });
      const upgraded = await run("widened");
      assert.equal(upgraded.code, 0, upgraded.output);
      const added = (await rowsOf(client, extra, source)).get("new");
      assert.ok(added);
      const addedEdges = await edges(added.id);
      assert.equal(addedEdges.length, 1);
      assert.equal(addedEdges[0]?.target_id, target.id);
      assert.deepEqual(await definition(), {
        ...before,
        source_type_constraints: [type, extra],
      });
      assert.deepEqual(await item(client, original.id), original);
      assert.deepEqual(await item(client, target.id), target);
      assert.deepEqual(await edges(original.id), held);
      await updateKey(key.id, {
        metadata_permissions: { types: "write", edge_types: "read" },
      });
      const repeated = await run("widened");
      assert.equal(repeated.code, 0, repeated.output);
      assert.deepEqual(await item(client, original.id), original);
      assert.deepEqual(await item(client, target.id), target);
      assert.deepEqual(await item(client, added.id), added);
      assert.deepEqual(await edges(original.id), held);
      assert.deepEqual(await edges(added.id), addedEdges);
      return "registration authority is required again; the added source imports, existing identifiers and versions remain exact, and a restart is a no-op";
    },
  );
}
