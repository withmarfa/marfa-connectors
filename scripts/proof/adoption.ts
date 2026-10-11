import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  createClient,
  type MarfaClient,
  type components,
} from "@withmarfa/client";
import { ConnectorUnderProof, registration, rowsOf } from "./connector.js";
import { check } from "./check.js";
import type { ProofServer } from "./server.js";

export async function proveAdoption(
  url: string,
  admin: MarfaClient,
  manager: MarfaClient,
  mint: ProofServer["mintKey"],
): Promise<void> {
  const parent = "proof.adoption.parent",
    child = "proof.adoption.child",
    source = "proof-adoption";
  const policies = {
    roles: ["container"],
    version_policy: { max_versions: 10 },
    merge_policy: {
      default: "keep_both_copies" as const,
      fields: { title: "last_writer_wins" as const },
    },
  };
  const stored = (
    required = false,
  ): components["schemas"]["TypeDefinitionInput"] => ({
    id: child,
    parent,
    label: "Adoption row",
    version: 4,
    ...policies,
    fields: {
      title: { type: "string", required: true },
      link: { type: "url" },
      extra: {
        type: "string",
        maxLength: 120,
        required,
        description: "Child refinement",
      },
    },
  });
  assert.ok(
    (
      await admin.POST("/types", {
        body: {
          id: parent,
          version: 4,
          fields: {
            title: { type: "string", required: true },
            extra: { type: "string", maxLength: 120 },
          },
          ...policies,
        },
      })
    ).data,
  );
  assert.ok((await admin.POST("/types", { body: stored() })).data);
  const key = await mint({
    label: "adoption proof",
    source,
    permissions: [],
    type_permissions: { [child]: "write" },
    metadata_permissions: { types: "write" },
    extension_permissions: {},
    edge_permissions: {},
    profile_permissions: {},
    default_tier: "feed",
  });
  const own = createClient({ baseUrl: url, credential: key.key });
  const run = (mode: string, addition = false) =>
    new ConnectorUnderProof(
      "adoption",
      url,
      key.key,
      { PROOF_MODE: mode, PROOF_ADDITION: String(addition) },
      resolve(import.meta.dirname, "adoption-connector.js"),
    ).once();
  const normalized = () =>
    own.POST("/types/normalize", { body: stored() }).then((answer) => {
      assert.ok(answer.data, JSON.stringify(answer.error));
      return answer.data;
    });
  await check(
    "kit adoption: canonical equivalence does not rewrite, required child refinements refuse, optional additions preserve declared metadata",
    async () => {
      const before = await normalized();
      assert.ok(before.registered_type);
      assert.equal((await run("type")).code, 0);
      assert.deepEqual(await normalized(), before);
      assert.ok(
        (
          await admin.PUT("/types/{id}", {
            params: { path: { id: child } },
            body: stored(true),
          })
        ).data,
      );
      const required = await normalized();
      assert.equal((await run("type")).code, 1);
      assert.deepEqual(await normalized(), required);
      assert.ok(
        (
          await admin.PUT("/types/{id}", {
            params: { path: { id: child } },
            body: stored(),
          })
        ).data,
      );
      const result = await run("type", true);
      assert.equal(result.code, 0, result.output);
      const after = await normalized();
      assert.equal(after.registered_type?.version, 4);
      assert.deepEqual(
        after.registered_type?.roles,
        before.registered_type.roles,
      );
      assert.deepEqual(
        after.registered_type?.version_policy,
        before.registered_type.version_policy,
      );
      assert.deepEqual(
        after.registered_type?.merge_policy,
        before.registered_type.merge_policy,
      );
      assert.deepEqual(
        after.registered_type?.fields["extra"],
        before.registered_type.fields["extra"],
      );
      assert.ok(after.registered_type?.fields["note"]);
      assert.equal((await run("type", true)).code, 0);
      assert.deepEqual(await normalized(), after);
      return "registry SDK normalization preserves child refinements and parent-equal policies/version; required refinement stops the process; repeat is stable";
    },
  );
  await check(
    "kit adoption: separate problems survive checkpoint/failure, fresh-process unrelated success, heartbeat and report, then acknowledged recovery",
    async () => {
      const failed = await run("fail", true);
      assert.equal(failed.code, 1, failed.output);
      const connector = await registration(own, key.id);
      const snapshot = async () => {
        const answer = await own.GET("/connectors/{id}/state", {
          params: { path: { id: connector.id } },
        });
        assert.ok(answer.data, JSON.stringify(answer.error));
        const detail = await manager.GET("/connectors/{id}", {
          params: { path: { id: connector.id } },
        });
        assert.ok(detail.data);
        assert.deepEqual(detail.data.problems, answer.data.problems);
        assert.equal(Object.hasOwn(answer.data.state, "conditions"), false);
        return answer.data;
      };
      const expected = { "vendor:A": "Vendor A is unavailable" };
      assert.deepEqual((await snapshot()).problems, expected);
      assert.equal((await run("skip", true)).code, 0);
      assert.deepEqual((await snapshot()).problems, expected);
      assert.ok(
        (
          await own.POST("/connectors/{id}/heartbeat", {
            params: { path: { id: connector.id } },
          })
        ).data,
      );
      const at = new Date().toISOString();
      assert.ok(
        (
          await own.POST("/connectors/{id}/runs", {
            params: { path: { id: connector.id } },
            body: {
              outcome: "succeeded",
              started_at: at,
              finished_at: at,
              summary: "Independent report",
            },
          })
        ).data,
      );
      assert.deepEqual((await snapshot()).problems, expected);
      const recovered = await run("recover", true);
      assert.equal(recovered.code, 0, recovered.output);
      assert.deepEqual((await snapshot()).problems, {});
      assert.match(recovered.output, /cleared/);
      assert.equal((await rowsOf(own, child, source)).size, 2);
      return "problem remains visible through manager and own snapshots, private state has no conditions, recovery writes A and announces clearance after save";
    },
  );
  await check(
    "kit adoption: independent snapshot limits and opaque problems are atomic, and successor keys retain source snapshots",
    async () => {
      const connector = await registration(own, key.id);
      const params = { path: { id: connector.id } };
      assert.ok(
        (
          await own.POST("/connectors/{id}/hold", {
            params,
            body: { process: "bounds" },
          })
        ).data,
      );
      assert.equal(
        (
          await own.POST("/connectors/{id}/hold", {
            params,
            body: { process: "bounds" },
          })
        ).data?.renewed,
        true,
      );
      const state = {
        payload: "x".repeat(
          512 * 1024 - Buffer.byteLength(JSON.stringify({ payload: "" })),
        ),
      };
      const keyLength =
        512 * 1024 - Buffer.byteLength(JSON.stringify({ "": "x" }));
      const problems = { ["k".repeat(keyLength)]: "x" };
      const write = (
        nextState: Record<string, unknown>,
        nextProblems: Record<string, string>,
      ) =>
        own.PUT("/connectors/{id}/state", {
          params,
          body: { process: "bounds", state: nextState, problems: nextProblems },
        });
      assert.ok((await write(state, problems)).data);
      for (const [nextState, nextProblems] of [
        [{ payload: state.payload + "x" }, problems],
        [state, { ["k".repeat(keyLength + 1)]: "x" }],
        [state, { ["é".repeat(Math.floor(keyLength / 2) + 1)]: "x" }],
        [
          state,
          Object.fromEntries(
            Array.from({ length: 201 }, (_, i) => [String(i), "x"]),
          ),
        ],
        [state, { problem: "x".repeat(501) }],
        [state, { problem: "😀".repeat(251) }],
      ] as const) {
        assert.equal(
          (await write(nextState, nextProblems)).response.status,
          400,
        );
        const kept = await own.GET("/connectors/{id}/state", { params });
        assert.deepEqual(kept.data?.state, state);
        assert.deepEqual(kept.data?.problems, problems);
      }
      const opaque = Object.fromEntries(
        Array.from({ length: 198 }, (_, i) => [String(i), "x"]),
      );
      Object.defineProperty(opaque, "__proto__", {
        value: "😀".repeat(250),
        enumerable: true,
      });
      opaque.toString = "x".repeat(500);
      assert.ok((await write({ kept: true }, opaque)).data);
      assert.ok(
        (
          await own.PUT("/connectors/{id}/state", {
            params,
            body: { process: "bounds", state: { kept: true } },
          })
        ).data,
      );
      assert.deepEqual(
        (await own.GET("/connectors/{id}/state", { params })).data?.problems,
        opaque,
      );
      assert.ok(
        (
          await manager.DELETE("/keys/{id}", {
            params: { path: { id: key.id } },
          })
        ).data,
      );
      const successor = await mint({
        label: "adoption successor",
        source,
        permissions: [],
        type_permissions: { [child]: "write" },
        metadata_permissions: {},
        extension_permissions: {},
        edge_permissions: {},
        profile_permissions: {},
      });
      const fresh = createClient({ baseUrl: url, credential: successor.key });
      const registered = await fresh.POST("/connectors", {
        body: { name: "adoption successor" },
      });
      assert.ok(registered.data);
      assert.deepEqual(registered.data.problems, opaque);
      const freshParams = { path: { id: registered.data.id } };
      assert.deepEqual(
        (await fresh.GET("/connectors/{id}/state", { params: freshParams }))
          .data?.state,
        { kept: true },
      );
      assert.equal((await write({ stale: true }, {})).response.status, 401);
      assert.ok(
        (await fresh.DELETE("/connectors/{id}/state", { params: freshParams }))
          .data,
      );
      assert.deepEqual(
        (await fresh.GET("/connectors/{id}/state", { params: freshParams }))
          .data?.problems,
        {},
      );
      assert.deepEqual(
        (await fresh.GET("/connectors/{id}/state", { params: freshParams }))
          .data?.state,
        {},
      );
      return "both exact512KiB snapshots accepted together, each over-limit refused without mutation, UTF16/count/UTF8/opaque keys checked, revoked writer fenced and successor reads then explicitly clears both";
    },
  );
}
