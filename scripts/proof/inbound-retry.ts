import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import type { Entry, PendingInbound } from "@withmarfa/connector";
import type { RetryConfig } from "./inbound-retry-connector.js";
import { ConnectorUnderProof, registration, rowsOf } from "./connector.js";
import { Proxy } from "./checkpoint.js";
import { check } from "./check.js";
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
class Source {
  config: RetryConfig = {
    mode: "replay",
    context: "a".repeat(64),
    maxLength: 10,
    page: 1,
    entries: [],
    retrySaved: false,
  };
  events: {
    result: { committed: boolean };
    pending: { record: PendingInbound; due: boolean }[];
  }[] = [];
  refetches: string[] = [];
  notModified = 0;
  answer: Entry | undefined;
  url = "";
  error: unknown;
  readonly server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) text += String(chunk);
        this.events.push(JSON.parse(text) as Source["events"][number]);
        res.end("{}");
      } else if (req.url === "/entries") {
        if (this.config.notModified === true) {
          assert.equal(req.headers["if-none-match"], '"owned"');
          this.notModified++;
          res.statusCode = 304;
          res.end();
        } else res.end(JSON.stringify(this.config.entries));
      } else if (req.url?.startsWith("/refetch/") === true) {
        this.refetches.push(decodeURIComponent(req.url.slice(9)));
        if (this.answer === undefined) {
          res.statusCode = 503;
          res.end("{}");
        } else res.end(JSON.stringify(this.answer));
      } else res.end(JSON.stringify(this.config));
    })().catch((error: unknown) => {
      this.error = error;
      res.destroy();
    });
  });
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    assert.ok(address !== null && typeof address !== "string");
    this.url = `http://127.0.0.1:${String(address.port)}`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((done) =>
      this.server.close(() => {
        done();
      }),
    );
  }
}
class Fixture {
  readonly source = `retry-${randomUUID()}`;
  readonly type = `proof.${this.source}.item`;
  readonly related = `proof.${this.source}.related`;
  readonly control = new Source();
  readonly proxy: Proxy;
  own!: MarfaClient;
  child!: ConnectorUnderProof;
  id = "";
  keyId = "";
  good: Entry;
  bad: Entry;
  constructor(
    private readonly url: string,
    private readonly admin: MarfaClient,
  ) {
    this.proxy = new Proxy(url);
    this.good = {
      source_id: "good",
      properties: { title: "Good", vendor_id: `${this.source}:good` },
    };
    this.bad = {
      source_id: "bad",
      properties: {
        title: "A complete title longer than ten",
        note: "Exact note",
        vendor_id: `${this.source}:bad`,
      },
      occurred_at: "2020-01-01T00:00:00.000Z",
      changed_at: "2020-01-02T00:00:00.000Z",
      movedFrom: ["old-link"],
      connections: {
        [this.related]: [{ type: this.type, id: `${this.source}:good` }],
      },
    };
    this.control.config.entries = [this.good, this.bad];
  }
  async start() {
    await this.control.start();
    await this.proxy.start();
    const key = required(
      (
        await this.admin.POST("/keys", {
          body: {
            label: "Owned retry proof",
            source: this.source,
            type_permissions: { [this.type]: "write" },
            edge_permissions: { [this.related]: "write" },
            metadata_permissions: { types: "write", edge_types: "write" },
            default_tier: "feed",
          },
        })
      ).data,
    );
    this.keyId = key.id;
    this.own = createClient({ baseUrl: this.url, credential: key.key });
    this.child = new ConnectorUnderProof(
      this.source,
      this.proxy.url,
      key.key,
      { PROOF_SOURCE: this.source, PROOF_CONTROL_URL: this.control.url },
      resolve(import.meta.dirname, "inbound-retry-connector.js"),
    );
  }
  async run() {
    const result = await this.child.once();
    if (this.control.error !== undefined)
      throw new Error("owned retry control failed", {
        cause: this.control.error,
      });
    if (
      this.proxy.error !== undefined &&
      !(
        this.proxy.error instanceof Error &&
        this.proxy.error.name === "AbortError"
      )
    )
      throw new Error("owned retry proxy failed", { cause: this.proxy.error });
    return result;
  }
  async snapshot() {
    this.id = (await registration(this.own, this.keyId)).id;
    const state = required(
      (
        await this.own.GET("/connectors/{id}/state", {
          params: { path: { id: this.id } },
        })
      ).data,
    ).state as {
      state?: { page?: number };
      inbound?: PendingInbound[];
      conditions: Record<string, string>;
    };
    const rows = [...(await rowsOf(this.own, this.type, this.source)).values()];
    const pages = Array.from(
      { length: Math.ceil(rows.length / 500) },
      (_, index) => rows.slice(index * 500, (index + 1) * 500),
    );
    const answers = await Promise.all(
      pages.map((page) =>
        this.own.POST("/connectors/{id}/agreements/lookup", {
          params: { path: { id: this.id } },
          body: { item_ids: page.map((row) => row.id) },
        }),
      ),
    );
    const agreements = answers.flatMap((answer) => required(answer.data).data);
    return { state, rows, agreements };
  }
  async repairSchema() {
    this.control.config.maxLength = 100;
    const result = await this.admin.PUT("/types/{id}", {
      params: { path: { id: this.type } },
      body: {
        label: "Retry item",
        link_field: "vendor_id",
        fields: {
          title: { type: "string", required: true, maxLength: 100 },
          vendor_id: { type: "string" },
          note: { type: "string" },
        },
      },
    });
    assert.ok(result.data, JSON.stringify(result.error));
  }
  async stop() {
    await this.proxy.stop();
    await this.control.stop();
  }
}
export async function proveInboundRetry(
  url: string,
  admin: MarfaClient,
): Promise<void> {
  for (const mode of ["replay", "refetch"] as const)
    await check(
      `kit inbound retries: ${mode} intent survives page advancement and a separate-process recovery`,
      async () => {
        const fixture = new Fixture(url, admin);
        try {
          await fixture.start();
          fixture.control.config.mode = mode;
          fixture.control.config.conditions = 200;
          const first = await fixture.run();
          assert.equal(first.code, 0, first.output);
          const initial = await fixture.snapshot();
          assert.equal(initial.state.state?.page, 1);
          assert.equal(initial.rows.length, 1);
          assert.equal(initial.rows[0]?.source_id, "good");
          assert.equal(initial.agreements.length, 1);
          assert.equal(initial.state.inbound?.length, 1);
          const record = required(initial.state.inbound[0]);
          assert.equal(record.identity.sourceId, "bad");
          assert.equal(record.code, "invalid_properties");
          if (record.mode === "replay")
            assert.deepEqual(record.intent.entry, fixture.bad);
          fixture.control.config.entries = [];
          fixture.control.config.notModified = true;
          fixture.control.config.page = 2;
          fixture.control.config.retrySaved = true;
          const beforeDue = await fixture.run();
          assert.equal(beforeDue.code, 0, beforeDue.output);
          assert.ok(beforeDue.output.includes("durable retry intent waits"));
          const unchanged = await fixture.snapshot();
          assert.deepEqual(unchanged.state.inbound, initial.state.inbound);
          assert.equal(fixture.control.refetches.length, 0);
          assert.equal(fixture.control.notModified, 1);
          if (mode === "replay") await fixture.repairSchema();
          else
            fixture.control.answer = {
              ...fixture.bad,
              properties: { ...fixture.bad.properties, title: "Fixed" },
            };
          fixture.control.config.context = "b".repeat(64);
          fixture.control.config.page = 3;
          const recovered = await fixture.run();
          assert.equal(recovered.code, 0, recovered.output);
          const settled = await fixture.snapshot();
          assert.equal(settled.state.state?.page, 3);
          assert.equal(settled.state.inbound, undefined);
          assert.equal(settled.rows.length, 2);
          assert.equal(settled.agreements.length, 2);
          const row = required(
            settled.rows.find((row) => row.source_id === "bad"),
          );
          assert.deepEqual(
            row.properties,
            mode === "replay"
              ? fixture.bad.properties
              : fixture.control.answer?.properties,
          );
          assert.equal(row.occurred_at, fixture.bad.occurred_at);
          const edges = required(
            (
              await fixture.own.GET("/items/{id}/edges", {
                params: { path: { id: row.id } },
              })
            ).data,
          );
          assert.ok(
            JSON.stringify(edges).includes(
              required(settled.rows.find((row) => row.source_id === "good")).id,
            ),
          );
          if (mode === "refetch")
            assert.deepEqual(fixture.control.refetches, ["bad"]);
          console.log(JSON.stringify({ mode, initial, unchanged, settled }));
          return "exact missing-create intent, no invented agreement, next pages and restart; row/edge/agreement land before marker clears";
        } finally {
          await fixture.stop();
        }
      },
    );
  await check(
    "kit inbound retries: incapable, omitted, systemic and unreachable input preserve conservative progress",
    async () => {
      for (const kind of [
        "incapable",
        "undeclared",
        "unlinked",
        "systemic",
        "unreadable",
        "capability-lost",
        "mode-changed",
        "root-state",
        "changed-current",
      ]) {
        const fixture = new Fixture(url, admin);
        try {
          await fixture.start();
          if (kind === "incapable") delete fixture.control.config.mode;
          if (kind === "undeclared")
            fixture.control.config.entries = [
              fixture.good,
              {
                ...fixture.good,
                source_id: "bad",
                properties: { ...fixture.good.properties, extra: true },
              },
            ];
          if (kind === "unlinked")
            fixture.control.config.entries = [
              fixture.good,
              { source_id: "bad", properties: { title: "Bad" } },
            ];
          if (kind === "systemic")
            fixture.control.config.entries = [
              fixture.bad,
              {
                ...fixture.bad,
                source_id: "bad-two",
                properties: {
                  ...fixture.bad.properties,
                  vendor_id: `${fixture.source}:bad-two`,
                },
              },
            ];
          if (kind === "unreadable") fixture.control.config.mode = "refetch";
          const first = await fixture.run();
          if (
            [
              "capability-lost",
              "mode-changed",
              "root-state",
              "changed-current",
            ].includes(kind)
          ) {
            assert.equal(first.code, 0, first.output);
            const saved = await fixture.snapshot();
            fixture.control.config.entries = [];
            fixture.control.config.page = 2;
            if (kind === "capability-lost") delete fixture.control.config.mode;
            if (kind === "mode-changed")
              fixture.control.config.mode = "refetch";
            if (kind === "root-state") fixture.control.config.rootState = true;
            if (kind === "changed-current") {
              fixture.control.config.context = "b".repeat(64);
              fixture.control.config.retrySaved = true;
              fixture.control.config.entries = [
                {
                  ...fixture.bad,
                  properties: {
                    ...fixture.bad.properties,
                    title: "Current",
                    note: "Newest",
                  },
                },
              ];
            }
            const blocked = await fixture.run();
            assert.equal(
              blocked.code,
              ["root-state", "changed-current"].includes(kind) ? 0 : 1,
              blocked.output,
            );
            const after = await fixture.snapshot();
            if (kind === "changed-current") {
              assert.equal(after.state.state?.page, 2);
              assert.equal(after.state.inbound, undefined);
              assert.equal(
                after.rows.find((row) => row.source_id === "bad")?.properties[
                  "title"
                ],
                "Current",
              );
              assert.equal(fixture.control.refetches.length, 0);
            } else {
              assert.equal(after.state.state?.page, 1);
              assert.deepEqual(after.state.inbound, saved.state.inbound);
            }
          } else if (kind === "unreadable") {
            assert.equal(first.code, 0, first.output);
            const saved = await fixture.snapshot();
            fixture.control.config.entries = [];
            fixture.control.config.context = "b".repeat(64);
            fixture.control.config.page = 2;
            fixture.control.config.retrySaved = true;
            const retry = await fixture.run();
            assert.equal(retry.code, 0, retry.output);
            const after = await fixture.snapshot();
            assert.deepEqual(after.state.inbound, saved.state.inbound);
            assert.deepEqual(fixture.control.refetches, ["bad"]);
          } else {
            assert.equal(first.code, 1, first.output);
            const saved = await fixture.snapshot();
            assert.notEqual(saved.state.state?.page, 1);
            assert.equal(saved.state.inbound, undefined);
          }
        } finally {
          await fixture.stop();
        }
      }
      return "no incapable advancement, no fabricated skipped intent, all-same-code failure unchanged, unreadable refetch retains exact marker";
    },
  );
  await check(
    "kit inbound retries: lost or refused state answers retain authoritative journal and fence later saves",
    async () => {
      for (const cut of ["refused", "lost"]) {
        const fixture = new Fixture(url, admin);
        try {
          await fixture.start();
          let saves = 0;
          fixture.proxy.before = (request) => {
            if (request.method === "PUT" && request.path.endsWith("/state")) {
              saves++;
              if (cut === "refused") return 400;
            }
            return undefined;
          };
          fixture.proxy.after = (request, response) =>
            request.method === "PUT" &&
            request.path.endsWith("/state") &&
            response.ok &&
            cut === "lost";
          const result = await fixture.run();
          assert.equal(result.code, 1, result.output);
          const snapshot = await fixture.snapshot();
          if (cut === "lost") {
            assert.equal(saves, 1);
            assert.equal(snapshot.state.state?.page, 1);
            assert.equal(snapshot.state.inbound?.length, 1);
          } else {
            assert.equal(snapshot.state.state?.page, undefined);
            assert.equal(snapshot.state.inbound, undefined);
          }
          fixture.proxy.before = () => undefined;
          fixture.proxy.after = () => false;
          const recovery = await fixture.run();
          assert.equal(recovery.code, 0, recovery.output);
          assert.equal((await fixture.snapshot()).state.inbound?.length, 1);
        } finally {
          await fixture.stop();
        }
      }
      return "applied/lost pair recovered from real server; definite refusal retains old pair; no ambiguous final overwrite";
    },
  );
  await check(
    "kit inbound retries: a real partial 500+1 agreement ACK cannot commit speculative retry intent",
    async () => {
      const fixture = new Fixture(url, admin);
      try {
        await fixture.start();
        const valid = Array.from({ length: 501 }, (_, index): Entry => ({
          source_id: `good-${String(index)}`,
          properties: {
            title: "Good",
            vendor_id: `${fixture.source}:good-${String(index)}`,
          },
        }));
        fixture.control.config.entries = [
          ...valid,
          { ...fixture.bad, connections: undefined },
        ];
        let batches = 0;
        let first: { item_id: string; record: unknown; waiting: boolean }[] =
          [];
        fixture.proxy.before = async (request) => {
          if (
            request.method !== "POST" ||
            !request.path.endsWith("/agreements")
          )
            return undefined;
          const set = request.input["set"] as typeof first;
          batches++;
          if (batches === 1) {
            assert.equal(set.length, 500);
            first = structuredClone(set);
            return undefined;
          }
          assert.equal(set.length, 1);
          const saved = await fixture.snapshot();
          for (const entry of first) {
            const actual = required(
              saved.agreements.find(
                (record) => record.item_id === entry.item_id,
              ),
            );
            assert.deepEqual(actual.record, entry.record);
            assert.equal(actual.waiting, entry.waiting);
          }
          assert.equal(saved.state.state?.page, undefined);
          assert.equal(saved.state.inbound, undefined);
          return 503;
        };
        const failed = await fixture.run();
        assert.equal(failed.code, 1, failed.output);
        assert.ok(batches >= 2);
        const partial = await fixture.snapshot();
        assert.equal(partial.agreements.length, 500);
        assert.equal(partial.state.inbound, undefined);
        assert.equal(partial.state.state?.page, undefined);
        fixture.proxy.before = () => undefined;
        const recovery = await fixture.run();
        assert.equal(recovery.code, 0, recovery.output);
        const recovered = await fixture.snapshot();
        assert.equal(recovered.agreements.length, 501);
        assert.equal(recovered.state.inbound?.length, 1);
        assert.equal(recovered.state.state?.page, 1);
        return "every first500 exact ID/record/waiting durable, secondbatch1 refused, marker/position stay old; restart ACKs complete pair";
      } finally {
        await fixture.stop();
      }
    },
  );
  await check(
    "kit inbound retries: mode-specific singleton413 bounds preserve a large point-refetch operation",
    async () => {
      const outcomes: unknown[] = [];
      for (const mode of ["refetch", "replay"] as const) {
        const fixture = new Fixture(url, admin);
        try {
          await fixture.start();
          const large: Entry = {
            ...fixture.bad,
            properties: {
              ...fixture.bad.properties,
              title: "Bad",
              note: "é".repeat(40000),
            },
          };
          const operationBytes = Buffer.byteLength(
            JSON.stringify({
              operation: "upsert",
              type: fixture.type,
              entry: large,
            }),
            "utf8",
          );
          assert.ok(operationBytes > 65536);
          fixture.control.config.mode = mode;
          fixture.control.config.entries = [fixture.good, large];
          fixture.control.answer = large;
          let gatewayLimit = 32000;
          const rejected: number[] = [];
          fixture.proxy.before = (request) => {
            if (request.method !== "POST" || request.path !== "/items/bulk")
              return undefined;
            const bytes = Buffer.byteLength(
              JSON.stringify(request.input),
              "utf8",
            );
            if (bytes <= gatewayLimit) return undefined;
            const items = request.input["items"] as unknown[];
            rejected.push(items.length);
            return {
              status: 413,
              value: {
                error: {
                  code: "request_too_large",
                  message: "owned gateway request-body limit",
                },
              },
            };
          };
          const first = await fixture.run();
          const initial = await fixture.snapshot();
          assert.deepEqual(rejected, [2, 1]);
          assert.equal(initial.rows.length, 1);
          assert.equal(initial.rows[0]?.source_id, "good");
          if (mode === "replay") {
            assert.equal(first.code, 1, first.output);
            assert.equal(initial.state.state?.page, undefined);
            assert.equal(initial.state.inbound, undefined);
            outcomes.push({ mode, operationBytes, rejected, initial });
            continue;
          }
          assert.equal(first.code, 0, first.output);
          assert.equal(initial.state.state?.page, 1);
          const record = required(initial.state.inbound?.[0]);
          assert.equal(record.mode, "refetch");
          assert.equal(record.code, "request_too_large");
          assert.equal(Object.hasOwn(record, "intent"), false);
          assert.ok(
            Buffer.byteLength(JSON.stringify(initial.state.inbound), "utf8") <=
              65536,
          );
          // This owned gateway alone imposes the refusal. Repair it before the
          // separate process point-fetches the unchanged complete operation.
          gatewayLimit = 1000000;
          fixture.control.config.context = "b".repeat(64);
          fixture.control.config.page = 2;
          fixture.control.config.entries = [];
          fixture.control.config.retrySaved = true;
          const recovery = await fixture.run();
          assert.equal(recovery.code, 0, recovery.output);
          const settled = await fixture.snapshot();
          assert.equal(settled.state.state?.page, 2);
          assert.equal(settled.state.inbound, undefined);
          const row = required(
            settled.rows.find((row) => row.source_id === "bad"),
          );
          assert.deepEqual(row.properties, large.properties);
          assert.equal(row.occurred_at, large.occurred_at);
          assert.equal(settled.agreements.length, 2);
          const edges = required(
            (
              await fixture.own.GET("/items/{id}/edges", {
                params: { path: { id: row.id } },
              })
            ).data,
          );
          assert.ok(
            JSON.stringify(edges).includes(
              required(settled.rows.find((row) => row.source_id === "good")).id,
            ),
          );
          assert.deepEqual(fixture.control.refetches, ["bad"]);
          outcomes.push({
            mode,
            operationBytes,
            rejected,
            initial,
            settled,
            refetches: fixture.control.refetches,
          });
        } finally {
          await fixture.stop();
        }
      }
      console.log(JSON.stringify({ modeSpecific413: outcomes }));
      return "same complete payload above64KiB: owned byte-limit2→1 split; replay blocks, bounded refetch record advances; actual point-fetch after gateway repair lands unchanged row/edge/agreement and clears";
    },
  );
}
