import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  registration,
  rowsOf,
  trash,
  purge,
} from "./connector.js";
import { ProofServer } from "./server.js";
import type { Action } from "./checkpoint-connector.js";

const issue = "proof.checkpoint.issue",
  comment = "proof.checkpoint.comment",
  related = "proof.checkpoint.related";
const source = "proof-checkpoint";
const entry = resolve(import.meta.dirname, "checkpoint-connector.js");
async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}
function answer(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

class Control {
  actions: Action[] = [];
  observe: (event: Record<string, unknown>) => Promise<void> | void = () =>
    undefined;
  error: unknown;
  observing: Promise<void> = Promise.resolve();
  url = "";
  readonly server = createServer((req, res) => {
    void (async () => {
      if (req.method === "POST") {
        try {
          const event = JSON.parse(await body(req)) as Record<string, unknown>;
          this.observing = Promise.resolve(this.observe(event));
          await this.observing;
          answer(res, 200, { ok: true });
        } catch (error) {
          this.error = error;
          answer(res, 500, { error: "observation failed" });
        }
      } else answer(res, 200, this.actions);
    })();
  });
  checkObservation(): void {
    if (this.error !== undefined)
      throw new Error("proof observation failed", { cause: this.error });
  }
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("no control address");
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
interface Request {
  method: string;
  path: string;
  input: Record<string, unknown>;
}
export class Proxy {
  url = "";
  error: unknown;
  before: (
    request: Request,
  ) =>
    | Promise<number | { status: number; value: unknown } | undefined>
    | number
    | { status: number; value: unknown }
    | undefined = () => undefined;
  after: (request: Request, response: Response) => Promise<boolean> | boolean =
    () => false;
  requests: Request[] = [];
  readonly server;
  constructor(private readonly upstream: string) {
    this.server = createServer((req, res) => {
      void this.forward(req, res).catch((error: unknown) => {
        this.error = error;
        res.destroy();
      });
    });
  }
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("no proxy address");
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
  private async forward(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? "/";
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("#")
    ) {
      answer(res, 400, {
        error: {
          code: "validation_error",
          message: "proof proxy requires an origin-form target",
        },
      });
      return;
    }
    const target = new URL(this.upstream);
    const query = path.indexOf("?");
    target.pathname = query === -1 ? path : path.slice(0, query);
    target.search = query === -1 ? "" : path.slice(query);
    target.hash = "";
    const text = await body(req);
    const method = req.method ?? "GET";
    const request = {
      method,
      path,
      input: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
    this.requests.push(request);
    const cut = await this.before(request);
    if (cut !== undefined) {
      if (typeof cut === "number")
        answer(res, cut, {
          error: { code: "internal_error", message: "proof cut" },
        });
      else answer(res, cut.status, cut.value);
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (
        value !== undefined &&
        !["host", "connection", "content-length"].includes(key)
      )
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const response = await fetch(target, {
      redirect: "manual",
      signal: controller.signal,
      method,
      headers,
      ...(text !== "" && { body: text }),
    });
    const responseHeaders = Object.fromEntries(
      [...response.headers].filter(
        ([key]) =>
          ![
            "content-length",
            "content-encoding",
            "transfer-encoding",
            "connection",
          ].includes(key),
      ),
    );
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      res.writeHead(response.status, responseHeaders);
      if (response.body !== null)
        for await (const chunk of response.body) res.write(chunk);
      res.end();
      return;
    }
    const acknowledgment = response.clone();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (await this.after(request, acknowledgment)) {
      res.destroy();
      return;
    }
    res.writeHead(
      response.status,
      Object.fromEntries(
        [...response.headers].filter(
          ([key]) =>
            ![
              "content-length",
              "content-encoding",
              "transfer-encoding",
              "connection",
            ].includes(key),
        ),
      ),
    );
    res.end(bytes);
  }
}
async function setup(
  marfa: MarfaClient,
  url: string,
  control: Control,
  proxy?: Proxy,
) {
  const minted = await marfa.POST("/keys", {
    body: {
      label: "Checkpoint proof",
      source,
      type_permissions: { [issue]: "write", [comment]: "write" },
      edge_permissions: { [related]: "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
      default_tier: "feed",
    },
  });
  if (minted.data === undefined) throw new Error("checkpoint key refused");
  const own = createClient({ baseUrl: url, credential: minted.data.key });
  const connector = new ConnectorUnderProof(
    "proof-checkpoint",
    proxy?.url ?? url,
    minted.data.key,
    { PROOF_CONTROL_URL: control.url },
    entry,
  );
  const registered = async () => registration(own, minted.data.id);
  const state = async () => {
    const { data } = await own.GET("/connectors/{id}/state", {
      params: { path: { id: (await registered()).id } },
    });
    if (data === undefined) throw new Error("state refused");
    return data.state;
  };
  const agreements = async (ids: string[]) => {
    const { data } = await own.POST("/connectors/{id}/agreements/lookup", {
      params: { path: { id: (await registered()).id } },
      body: { item_ids: ids },
    });
    if (data === undefined) throw new Error("agreements refused");
    return data.data;
  };
  return { own, connector, registered, state, agreements };
}
const row = (id: string, targets: string[] = []) => ({
  source_id: id,
  properties: { title: id },
  ...(targets.length > 0 && {
    connections: { [related]: targets.map((id) => ({ type: issue, id })) },
  }),
});
function vendorState(kept: Record<string, unknown>) {
  return kept["state"];
}

export async function proveCheckpoint(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  const control = new Control();
  await control.start();
  const proxy = new Proxy(url);
  await proxy.start();
  try {
    const test = await setup(marfa, url, control, proxy);
    await check(
      "kit checkpoints: completed rows, edges and missing targets precede progress and survive a later failure and restart",
      async () => {
        control.actions = [
          {
            scope: "A",
            entries: [row("target"), row("a", ["target", "later"])],
          },
          { scope: "A", type: comment, entries: [row("comment", ["a"])] },
          {
            scope: "A",
            key: "vendors",
            mapEntry: "A",
            value: { page: 1 },
            alias: true,
            observe: "A",
            fail: true,
          },
        ];
        control.observe = async (event) => {
          assert.deepEqual(event["result"], { committed: true });
          assert.deepEqual(event["acknowledged"], { A: { page: 1 } });
          assert.deepEqual(vendorState(await test.state()), {
            vendors: { A: { page: 1 } },
          });
          const rows = await rowsOf(marfa, issue, source);
          const a = rows.get("a"),
            target = rows.get("target");
          assert.ok(a && target);
          const held = await test.agreements([a.id]);
          assert.deepEqual(
            (held[0]?.record as Record<string, unknown>)["pending"],
            { [related]: [`${issue} later`] },
          );
          const comments = await rowsOf(marfa, comment, source);
          const note = required(comments.get("comment"));
          assert.equal((await test.agreements([note.id])).length, 1);
          const noteEdges = await marfa.GET("/items/{id}/edges", {
            params: { path: { id: note.id }, query: { edge_type: related } },
          });
          assert.ok(noteEdges.data);
          assert.ok(JSON.stringify(noteEdges.data).includes(a.id));
          const edges = await marfa.GET("/items/{id}/edges", {
            params: { path: { id: a.id }, query: { edge_type: related } },
          });
          assert.ok(edges.data);
          assert.ok(JSON.stringify(edges.data).includes(target.id));
        };
        const failed = await test.connector.once();
        control.checkObservation();
        assert.equal(failed.code, 1);
        assert.deepEqual(
          vendorState(await test.state()),
          {
            vendors: { A: { page: 1 } },
          },
          failed.output,
        );
        const before = await rowsOf(marfa, issue, source);
        control.actions = [
          {
            scope: "B",
            entries: [row("later")],
            key: "vendors",
            mapEntry: "B",
            value: 1,
          },
        ];
        control.observe = () => undefined;
        assert.equal((await test.connector.once()).code, 0);
        const after = await rowsOf(marfa, issue, source);
        assert.equal(after.get("a")?.version, before.get("a")?.version);
        const held = await test.agreements([required(after.get("a")).id]);
        assert.equal(
          (held[0]?.record as Record<string, unknown>)["pending"],
          undefined,
        );
        return "A page 1 and comment/issue intent inspected before deliberate failure; detached A survives restart; later target resolves without reseeding A";
      },
    );
    await check(
      "kit checkpoints: a refused scope cannot leak a speculative validator into a shared map",
      async () => {
        control.actions = [
          {
            scope: "refused",
            entries: [
              { source_id: "invalid-title", properties: { title: 123 } },
            ],
          },
          {
            scope: "refused",
            key: "vendors",
            mapEntry: "refused",
            value: { validator: "speculative" },
            observe: "refused",
          },
          {
            scope: "accepted",
            key: "vendors",
            mapEntry: "accepted",
            value: { validator: "acknowledged" },
          },
        ];
        control.observe = (event) => {
          assert.deepEqual(event["result"], {
            committed: false,
            reason: "row-refused",
          });
        };
        const result = await test.connector.once();
        control.checkObservation();
        assert.equal(result.code, 0, result.output);
        const map = (
          vendorState(await test.state()) as Record<string, unknown>
        )["vendors"] as Record<string, unknown>;
        assert.equal(map["refused"], undefined);
        assert.deepEqual(map["accepted"], { validator: "acknowledged" });
        assert.deepEqual(map["A"], { page: 1 });
        return "real per-row validation refusal blocks its candidate; B builds the shared map from acknowledged state, retains A and excludes speculative refusal validator";
      },
    );
    await check(
      "kit checkpoints: a lost state response never sends an older final envelope",
      async () => {
        let cuts = 0;
        proxy.after = (request) => {
          if (request.method === "PUT" && request.path.endsWith("/state")) {
            cuts++;
            return true;
          }
          return false;
        };
        const before = proxy.requests.length;
        control.actions = [{ scope: "lost", key: "lost", value: 2 }];
        control.observe = () => undefined;
        const failed = await test.connector.once();
        assert.equal(failed.code, 1);
        assert.equal(cuts, 1);
        assert.equal(
          proxy.requests
            .slice(before)
            .filter(
              (request) =>
                request.method === "PUT" && request.path.endsWith("/state"),
            ).length,
          1,
        );
        assert.equal(
          (vendorState(await test.state()) as Record<string, unknown>)["lost"],
          2,
        );
        proxy.after = () => false;
        control.actions = [];
        assert.equal((await test.connector.once()).code, 0);
        assert.equal(
          (vendorState(await test.state()) as Record<string, unknown>)["lost"],
          2,
        );
        return "server applied lost=2; exactly one state write despite failed answer; fresh process reloads 2";
      },
    );
    await check(
      "kit checkpoints: agreement batches acknowledged before a later cut do not advance vendor progress",
      async () => {
        let batches = 0;
        proxy.before = (request) =>
          request.method === "POST" &&
          request.path.endsWith("/agreements") &&
          ++batches === 2
            ? 503
            : undefined;
        control.actions = [
          {
            scope: "batch",
            entries: Array.from({ length: 501 }, (_, n) =>
              row(`batch-${String(n)}`),
            ),
            key: "batch",
            value: 1,
          },
        ];
        assert.equal((await test.connector.once()).code, 1);
        assert.equal(
          (vendorState(await test.state()) as Record<string, unknown>)["batch"],
          undefined,
        );
        const rows = await rowsOf(marfa, issue, source);
        assert.equal(
          (await test.agreements([required(rows.get("batch-0")).id])).length,
          1,
        );
        proxy.before = () => undefined;
        control.actions = [
          {
            scope: "batch",
            entries: [row("batch-500")],
            key: "batch",
            value: 1,
          },
        ];
        assert.equal((await test.connector.once()).code, 0);
        return "first 500 agreement acknowledgments survive second-batch 503; position withheld, final retry retains intent, replay commits";
      },
    );
    await check(
      "kit checkpoints: an edge can land before a cut without advancing its scope",
      async () => {
        let cut = false;
        proxy.before = (request) => {
          if (
            !cut &&
            request.method === "POST" &&
            request.path.endsWith("/agreements")
          ) {
            cut = true;
            return 503;
          }
          return undefined;
        };
        control.actions = [
          {
            scope: "edge-cut",
            entries: [row("edge-before-cut", ["a"])],
            key: "edge-cut",
            value: 1,
          },
        ];
        const failed = await test.connector.once();
        assert.equal(failed.code, 1, failed.output);
        assert.equal(cut, true);
        const rows = await rowsOf(marfa, issue, source),
          from = required(rows.get("edge-before-cut")),
          target = required(rows.get("a"));
        const edges = await marfa.GET("/items/{id}/edges", {
          params: { path: { id: from.id }, query: { edge_type: related } },
        });
        assert.ok(edges.data);
        assert.ok(JSON.stringify(edges.data).includes(target.id));
        assert.equal(
          (vendorState(await test.state()) as Record<string, unknown>)[
            "edge-cut"
          ],
          undefined,
        );
        proxy.before = () => undefined;
        return "actual edge inspected after first agreement request returned 503; position absent; final checked retry may retain its agreement";
      },
    );
    await check(
      "kit checkpoints: a state refusal after edge and agreement acknowledgment keeps earlier progress",
      async () => {
        proxy.before = (request) =>
          request.method === "PUT" && request.path.endsWith("/state")
            ? 400
            : undefined;
        control.actions = [
          {
            scope: "cut",
            entries: [row("cut-edge", ["a"])],
            key: "cut",
            value: 1,
          },
        ];
        assert.equal((await test.connector.once()).code, 1);
        const rows = await rowsOf(marfa, issue, source),
          cut = rows.get("cut-edge");
        assert.ok(cut);
        assert.equal((await test.agreements([cut.id])).length, 1);
        assert.equal(
          (vendorState(await test.state()) as Record<string, unknown>)["cut"],
          undefined,
        );
        assert.deepEqual(
          (
            (vendorState(await test.state()) as Record<string, unknown>)[
              "vendors"
            ] as Record<string, unknown>
          )["A"],
          { page: 1 },
        );
        proxy.before = () => undefined;
        return "real edge and agreement landed before explicit state 400; prior A remains, cut position absent";
      },
    );
    await check(
      "kit checkpoints: the pinned clear acknowledgment counts deleted rows rather than accepted IDs",
      async () => {
        const registered = await test.registered(),
          process = randomUUID();
        const taken = await test.own.POST("/connectors/{id}/hold", {
          params: { path: { id: registered.id } },
          body: { process },
        });
        assert.ok(taken.data);
        try {
          const rows = await rowsOf(marfa, issue, source);
          const item = rows.get("cut-edge");
          assert.ok(item);
          const clear = () =>
            test.own.POST("/connectors/{id}/agreements", {
              params: { path: { id: registered.id } },
              body: { process, clear: [item.id] },
            });
          assert.deepEqual((await clear()).data, {
            written: 0,
            cleared: 1,
            skipped: [],
          });
          assert.deepEqual((await clear()).data, {
            written: 0,
            cleared: 0,
            skipped: [],
          });
        } finally {
          await test.own.DELETE("/connectors/{id}/hold", {
            params: { path: { id: registered.id }, query: { process } },
          });
        }
        return "readable row clear deletes 1, repeated clear deletes 0, both acknowledge without skipped IDs";
      },
    );
    await check(
      "kit checkpoints: a real skipped agreement blocks only its scope",
      async () => {
        control.actions = [
          {
            scope: "skip",
            entries: [row("purged-prerequisite")],
            observe: "purge",
          },
          {
            scope: "skip",
            key: "vendors",
            mapEntry: "skip",
            value: 1,
            observe: "blocked",
          },
          {
            scope: "independent",
            key: "vendors",
            mapEntry: "independent",
            value: 1,
          },
        ];
        control.observe = async (event) => {
          if (event["event"] === "purge") {
            const item = (await rowsOf(marfa, issue, source)).get(
              "purged-prerequisite",
            );
            assert.ok(item);
            await trash(marfa, item.id);
            await purge(marfa, item.id);
          } else
            assert.deepEqual(event["result"], {
              committed: false,
              reason: "agreement-skipped",
            });
        };
        assert.equal((await test.connector.once()).code, 1);
        control.checkObservation();
        const state = (
          vendorState(await test.state()) as Record<string, unknown>
        )["vendors"] as Record<string, unknown>;
        assert.equal(state["skip"], undefined);
        assert.equal(state["independent"], 1);
        return "real purge made the agreement door skip; skip position absent, independent position acknowledged, final run failed";
      },
    );
  } finally {
    await proxy.stop();
    await control.stop();
  }

  await check(
    "kit checkpoints: real short holds and successors fence connection drain, agreement batches and state cuts",
    async () => {
      const server = new ProofServer(1000);
      const control = new Control();
      await control.start();
      let proxy: Proxy | undefined;
      try {
        const booted = await server.boot();
        const marfa = createClient({
          baseUrl: booted.url,
          credential: booted.key,
        });
        proxy = new Proxy(booted.url);
        await proxy.start();
        const test = await setup(marfa, booted.url, control, proxy);
        for (const [index, cut] of [
          "connection-drain",
          "agreement-batch",
          "state-write",
        ].entries()) {
          const ordinal = index + 1;
          const sourceId = `old-${String(ordinal)}`;
          let blockRenewals = false;
          let batches = 0;
          let firstBatch: {
            item_id: string;
            record: Record<string, unknown>;
            waiting: boolean;
          }[] = [];
          const entries =
            cut === "agreement-batch"
              ? [
                  row(sourceId),
                  ...Array.from({ length: 500 }, (_, n) =>
                    row(`${sourceId}-${String(n)}`),
                  ),
                ]
              : [row(sourceId, ["missing"])];
          const preseeded: string[] = [];
          if (cut === "agreement-batch") {
            for (let at = 0; at < entries.length; at += 500) {
              const page = entries.slice(at, at + 500);
              const made = await test.own.POST("/items/bulk", {
                body: {
                  atomic: false,
                  items: page.map((entry) => ({
                    ...entry,
                    type: issue,
                    source,
                    tier: "feed" as const,
                    version: 0,
                  })),
                },
              });
              assert.ok(made.data);
              assert.equal(made.data.results.length, page.length);
              for (const result of made.data.results) {
                assert.equal(result.outcome, "created");
                assert.ok(result.id !== undefined);
                preseeded.push(result.id);
              }
            }
            assert.equal(new Set(preseeded).size, 501);
            const actual = await rowsOf(marfa, issue, source);
            for (const [index, entry] of entries.entries()) {
              const found = required(actual.get(entry.source_id));
              assert.equal(found.id, preseeded[index]);
              assert.deepEqual(found.properties, entry.properties);
              assert.equal(found.tier, "feed");
            }
            for (let at = 0; at < preseeded.length; at += 500)
              assert.deepEqual(
                await test.agreements(preseeded.slice(at, at + 500)),
                [],
              );
          }
          let takeover: Promise<void> | undefined;
          const from = proxy.requests.length;
          const replace = async (): Promise<void> => {
            blockRenewals = true;
            await new Promise((done) => setTimeout(done, 1250));
            const registered = await test.registered();
            const process = randomUUID();
            const taken = await test.own.POST("/connectors/{id}/hold", {
              params: { path: { id: registered.id } },
              body: { process },
            });
            assert.ok(taken.data);
            assert.equal(taken.data.ttl_ms, 1000);
            const kept = await test.own.PUT("/connectors/{id}/state", {
              params: { path: { id: registered.id } },
              body: {
                process,
                state: { state: { successor: ordinal }, conditions: {} },
              },
            });
            assert.ok(kept.data);
            const held = required(
              (await rowsOf(marfa, issue, source)).get(sourceId),
            );
            const written = await test.own.POST("/connectors/{id}/agreements", {
              params: { path: { id: registered.id } },
              body: {
                process,
                set: [
                  {
                    item_id: held.id,
                    record: { successor: ordinal },
                    waiting: false,
                  },
                ],
              },
            });
            assert.ok(written.data);
            await test.own.DELETE("/connectors/{id}/hold", {
              params: { path: { id: registered.id }, query: { process } },
            });
          };
          proxy.before = async (request) => {
            if (
              blockRenewals &&
              request.method === "POST" &&
              request.path.endsWith("/hold")
            )
              return 503;
            const agreements =
              request.method === "POST" && request.path.endsWith("/agreements");
            if (agreements) {
              batches += 1;
              if (cut === "agreement-batch") {
                const set = request.input["set"] as typeof firstBatch;
                assert.ok(Array.isArray(set));
                if (batches === 1) {
                  assert.equal(set.length, 500);
                  assert.deepEqual(
                    set.map((entry) => entry.item_id),
                    preseeded.slice(0, 500),
                  );
                  firstBatch = structuredClone(set);
                } else if (batches === 2) {
                  assert.equal(set.length, 1);
                  assert.equal(set[0]?.item_id, preseeded[500]);
                  const durable = await test.agreements(
                    firstBatch.map((entry) => entry.item_id),
                  );
                  assert.equal(durable.length, 500);
                  const byId = new Map(
                    durable.map((entry) => [entry.item_id, entry]),
                  );
                  for (const expected of firstBatch) {
                    const actual = required(byId.get(expected.item_id));
                    assert.deepEqual(actual.record, expected.record);
                    assert.equal(actual.waiting, expected.waiting);
                    assert.equal(actual.waiting, false);
                  }
                }
              }
            }
            if (
              takeover === undefined &&
              ((cut === "agreement-batch" && agreements && batches === 2) ||
                (cut === "state-write" &&
                  request.method === "PUT" &&
                  request.path.endsWith("/state")))
            ) {
              takeover = replace();
              await takeover;
            }
            return undefined;
          };
          control.actions = [
            {
              scope: sourceId,
              entries,
              ...(cut === "connection-drain" && { observe: "lapse" }),
            },
            { scope: sourceId, key: sourceId, value: 1 },
          ];
          control.observe = () => {
            takeover = replace();
            return takeover;
          };
          const stopped = await test.connector.once();
          assert.equal(stopped.code, 1, stopped.output);
          if (cut === "agreement-batch")
            assert.match(
              stopped.output,
              /created 0, updated 0, archived 0, unchanged 501, skipped 0/,
            );
          if (takeover === undefined)
            throw new Error(
              `the ${cut} cut was not reached: ${stopped.output}`,
            );
          await takeover;
          control.checkObservation();
          const held = required(
            (await rowsOf(marfa, issue, source)).get(sourceId),
          );
          assert.deepEqual(vendorState(await test.state()), {
            successor: ordinal,
          });
          assert.deepEqual((await test.agreements([held.id]))[0]?.record, {
            successor: ordinal,
          });
          const old: unknown = proxy.requests
            .slice(from)
            .find(
              (request) =>
                request.method === "POST" && request.path.endsWith("/hold"),
            )?.input["process"];
          assert.equal(typeof old, "string");
          if (typeof old !== "string") throw new Error("no old hold process");
          const id = (await test.registered()).id;
          // Exercise the actual server fence too, after successor release,
          // rather than relying only on the old kit's local expiry timer.
          const staleState = await test.own.PUT("/connectors/{id}/state", {
            params: { path: { id } },
            body: {
              process: old,
              state: { state: { stale: true }, conditions: {} },
            },
          });
          const staleAgreement = await test.own.POST(
            "/connectors/{id}/agreements",
            {
              params: { path: { id } },
              body: {
                process: old,
                set: [
                  { item_id: held.id, waiting: false, record: { stale: true } },
                ],
              },
            },
          );
          assert.equal(staleState.response.status, 409);
          assert.equal(staleAgreement.response.status, 409);
          assert.deepEqual(vendorState(await test.state()), {
            successor: ordinal,
          });
          assert.deepEqual((await test.agreements([held.id]))[0]?.record, {
            successor: ordinal,
          });
        }
        return "MARFA_CONNECTOR_HOLD_MS=1000; three actual cut points; successor state/agreement survive release; stale state and agreement doors each return 409";
      } finally {
        await proxy?.stop();
        await control.stop();
        await server.stop();
      }
    },
  );
}
