import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import type { Entry } from "@withmarfa/connector";
import { check } from "./check.js";
import { Proxy } from "./checkpoint.js";
import {
  ConnectorUnderProof,
  registration,
  rowsOf,
  trash,
  purge,
  type Item,
} from "./connector.js";
import { ProofServer } from "./server.js";

const type = "proof.watch.item";
const entry = resolve(import.meta.dirname, "watch-checkpoint-connector.js");
const one = (id = "one", link = id): Entry => ({
  source_id: id,
  properties: { title: "Vendor title", note: "Vendor note", vendor_id: link },
});
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const agreements = (request: { method: string; path: string }) =>
  request.method === "POST" && request.path.endsWith("/agreements");
const states = (request: { method: string; path: string }) =>
  request.method === "PUT" && request.path.endsWith("/state");
function side(properties: Record<string, unknown>) {
  return Object.fromEntries(
    ["title", "note", "vendor_id"].map((field) => [
      field,
      createHash("sha1")
        .update(JSON.stringify(properties[field]))
        .digest("hex")
        .slice(0, 16),
    ]),
  );
}
interface Push {
  kind: string;
  changed: string[];
  item: Item;
}
interface Event {
  stage: string;
  result?: { committed: boolean; reason?: string };
}
class Control {
  entries: Entry[] = [one()];
  checkpoint = true;
  mode: "accept" | "refused" | "unreachable" = "accept";
  pushes: Push[] = [];
  events: Event[] = [];
  observe: (event: Event) => Promise<void> | void = () => undefined;
  error: unknown;
  url = "";
  readonly server = createServer((req, res) => {
    void this.answer(req, res).catch((error: unknown) => {
      this.error = error;
      res.destroy();
    });
  });
  private async answer(req: IncomingMessage, res: ServerResponse) {
    let text = "";
    for await (const chunk of req) text += (chunk as Buffer).toString();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.url === "/entries")
      res.end(
        JSON.stringify({ entries: this.entries, checkpoint: this.checkpoint }),
      );
    else if (req.url === "/observe") {
      const event = JSON.parse(text) as Event;
      this.events.push(event);
      await this.observe(event);
      res.end("{}");
    } else if (req.url === "/push") {
      const pushed = JSON.parse(text) as Push;
      this.pushes.push(pushed);
      res.statusCode =
        this.mode === "refused" ? 400 : this.mode === "unreachable" ? 503 : 200;
      const found = required(
        this.entries.find(
          (value) =>
            value.properties["vendor_id"] ===
            pushed.item.properties["vendor_id"],
        ),
      );
      if (this.mode === "accept")
        found.properties = { ...pushed.item.properties };
      res.end(JSON.stringify(found));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  }
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
interface Written {
  item_id: string;
  waiting: boolean;
  record: Record<string, unknown>;
}
class Fixture {
  readonly control = new Control();
  readonly proxy: Proxy;
  readonly own: MarfaClient;
  private connector: ConnectorUnderProof | undefined;
  private constructor(
    readonly source: string,
    url: string,
    readonly keyId: string,
    key: string,
  ) {
    this.control.entries = [one("one", `${source}:one`)];
    this.proxy = new Proxy(url);
    this.own = createClient({ baseUrl: url, credential: key });
  }
  static async create(
    admin: MarfaClient,
    url: string,
    source: string,
  ): Promise<Fixture> {
    const minted = await admin.POST("/keys", {
      body: {
        label: "Watch prerequisite proof",
        source,
        type_permissions: { [type]: "write" },
        metadata_permissions: { types: "write" },
        default_tier: "feed",
      },
    });
    const key = required(minted.data);
    const fixture = new Fixture(source, url, key.id, key.key);
    await fixture.control.start();
    await fixture.proxy.start();
    // Each fixture uses its own real source/key and connector process.
    fixture.connector = new ConnectorUnderProof(
      "proof-watch",
      fixture.proxy.url,
      key.key,
      { PROOF_CONTROL_URL: fixture.control.url, PROOF_SOURCE: source },
      entry,
    );
    return fixture;
  }
  async id() {
    return (await registration(this.own, this.keyId)).id;
  }
  async rows() {
    return rowsOf(this.own, type, this.source);
  }
  async held(ids: string[]): Promise<Written[]> {
    const answer = await this.own.POST("/connectors/{id}/agreements/lookup", {
      params: { path: { id: await this.id() } },
      body: { item_ids: ids },
    });
    return required(answer.data).data;
  }
  async state() {
    const answer = await this.own.GET("/connectors/{id}/state", {
      params: { path: { id: await this.id() } },
    });
    return required(answer.data).state;
  }
  async run() {
    const result = await required(this.connector).once();
    if (
      this.proxy.error instanceof Error &&
      this.proxy.error.name !== "AbortError"
    )
      throw this.proxy.error;
    if (this.control.error !== undefined)
      throw new Error("watch proof observation failed", {
        cause: this.control.error,
      });
    return result;
  }
  async succeeds(): Promise<void> {
    const result = await this.run();
    assert.equal(result.code, 0, result.output);
  }
  reset() {
    this.control.pushes = [];
    this.control.events = [];
    this.control.observe = () => undefined;
  }
  async stop() {
    await this.proxy.stop();
    await this.control.stop();
  }
}

async function edit(
  admin: MarfaClient,
  row: Item,
  title: string,
  note: string,
) {
  const answer = await admin.PATCH("/items/{id}", {
    params: { path: { id: row.id } },
    body: {
      version: row.version,
      properties: { title, note },
      properties_mode: "merge",
    },
  });
  return required(answer.data).item;
}

export async function proveWatchCheckpoint(
  admin: MarfaClient,
  url: string,
): Promise<void> {
  await check(
    "watch prerequisites: unchanged rows rescan after an actual agreement ACK and restart",
    async () => {
      const test = await Fixture.create(admin, url, "proof-watch-rescan");
      try {
        await test.succeeds();
        const row = required((await test.rows()).get("one"));
        const before = required((await test.held([row.id]))[0]);
        let acknowledged = false;
        test.proxy.after = async (request, response) => {
          if (agreements(request) && !acknowledged) {
            const answer = (await response.clone().json()) as {
              written: number;
              skipped: string[];
            };
            assert.equal(answer.written, 1);
            assert.deepEqual(answer.skipped, []);
            assert.deepEqual(
              required((await test.held([row.id]))[0]).record,
              before.record,
            );
            acknowledged = true;
          }
          return false;
        };
        test.control.observe = (event) => {
          if (event.stage === "before-rescan") assert.equal(acknowledged, true);
        };
        await test.succeeds();
        assert.equal(acknowledged, true);
        assert.deepEqual((await test.state())["state"], { page: 2 });
        assert.equal(
          required((await test.rows()).get("one")).version,
          row.version,
        );
        assert.deepEqual(
          required((await test.held([row.id]))[0]).record,
          before.record,
        );
        test.reset();
        test.proxy.after = () => false;
        await test.succeeds();
        assert.deepEqual((await test.state())["state"], { page: 3 });
        assert.equal(required((await test.rows()).get("one")).id, row.id);
        assert.equal(
          required((await test.rows()).get("one")).version,
          row.version,
        );
        return "real watch agreement acknowledged before rescan; pages 1,2,3 across separate processes; identical row ID/version/full record";
      } finally {
        await test.stop();
      }
    },
  );

  for (const mode of ["refused", "unreachable"] as const) {
    await check(
      `watch prerequisites: ${mode} intent survives page checkpoints and settles only after the real vendor accepts`,
      async () => {
        const test = await Fixture.create(admin, url, `proof-watch-${mode}`);
        try {
          await test.succeeds();
          const row = required((await test.rows()).get("one"));
          const changed = await edit(admin, row, "Person title", "Person note");
          test.control.mode = mode;
          test.control.checkpoint = false;
          test.reset();
          await test.succeeds();
          assert.equal(test.control.pushes.length, 1);
          assert.deepEqual(required(test.control.pushes[0]).changed.sort(), [
            "note",
            "title",
          ]);
          const pending = required((await test.held([row.id]))[0]);
          assert.equal(pending.waiting, true);
          assert.deepEqual(
            pending.record["vendor"],
            side(required(test.control.entries[0]).properties),
          );
          assert.deepEqual(
            pending.record["marfa"],
            side(required(test.control.entries[0]).properties),
          );
          assert.deepEqual(
            Object.keys(pending.record["waiting"] as object).sort(),
            ["note", "title"],
          );
          assert.equal(pending.record["state"], "active");
          assert.equal(pending.record["link"], `${test.source}:one`);
          if (mode === "refused") assert.ok(pending.record["refused"]);
          else assert.equal(pending.record["refused"], undefined);
          let ack = false;
          test.proxy.after = async (request, response) => {
            if (agreements(request) && !ack) {
              assert.equal(response.status, 200);
              assert.deepEqual(
                required((await test.held([row.id]))[0]).record,
                pending.record,
              );
              ack = true;
            }
            return false;
          };
          test.control.checkpoint = true;
          for (const page of [2, 3]) {
            test.reset();
            ack = false;
            test.control.observe = async (event) => {
              if (event.stage === "before-rescan") assert.equal(ack, true);
              if (event.stage === "checkpoint") {
                assert.deepEqual(event.result, { committed: true });
                assert.deepEqual((await test.state())["state"], { page });
                assert.deepEqual(
                  required((await test.held([row.id]))[0]).record,
                  pending.record,
                );
              }
            };
            const ran = await test.run();
            assert.equal(ran.code, 0, ran.output);
            assert.deepEqual(
              required((await test.held([row.id]))[0]).record,
              pending.record,
            );
            assert.equal(
              test.control.pushes.length,
              mode === "refused" ? 0 : 1,
            );
            assert.deepEqual(
              required((await test.rows()).get("one")).properties,
              changed.properties,
            );
          }
          test.reset();
          test.proxy.after = () => false;
          if (mode === "refused")
            await edit(
              admin,
              required((await test.rows()).get("one")),
              "Person changed intent",
              "Person changed note",
            );
          test.control.mode = "accept";
          await test.succeeds();
          assert.equal(test.control.pushes.length, 1);
          const settledRow = required((await test.rows()).get("one"));
          const settled = required((await test.held([row.id]))[0]);
          assert.equal(settled.waiting, false);
          assert.equal(settled.record["waiting"], undefined);
          assert.equal(settled.record["refused"], undefined);
          assert.deepEqual(
            settled.record["vendor"],
            side(settledRow.properties),
          );
          assert.deepEqual(
            settled.record["marfa"],
            side(settledRow.properties),
          );
          assert.equal(settled.record["link"], `${test.source}:one`);
          assert.equal(settled.record["state"], "active");
          assert.deepEqual(
            required(test.control.entries[0]).properties,
            settledRow.properties,
          );
          assert.equal(
            settledRow.properties["title"],
            mode === "refused" ? "Person changed intent" : "Person title",
          );
          assert.equal(
            settledRow.properties["note"],
            mode === "refused" ? "Person changed note" : "Person note",
          );
          test.reset();
          await test.succeeds();
          assert.equal(test.control.pushes.length, 0);
          assert.deepEqual(
            required((await test.held([row.id]))[0]).record,
            settled.record,
          );
          return `page2 and page3 ACK before late outbound drain; ${mode === "refused" ? "suppressed until real title/note change" : "one real retry each completed read"}; full pending ${JSON.stringify(pending.record)}; full settled ${JSON.stringify(settled.record)}`;
        } finally {
          await test.stop();
        }
      },
    );
  }

  await check(
    "watch prerequisites: unusable acknowledgments stop the reader, final retries and state saves",
    async () => {
      for (const cut of [
        "refused",
        "server-error",
        "malformed",
        "lost-applied",
        "skipped",
      ] as const) {
        const test = await Fixture.create(admin, url, `proof-watch-cut-${cut}`);
        try {
          await test.succeeds();
          const row = required((await test.rows()).get("one"));
          const kept = await test.state();
          test.reset();
          const from = test.proxy.requests.length;
          let reached = false;
          test.proxy.before = async (request) => {
            if (!agreements(request)) return undefined;
            reached = true;
            if (cut === "refused") return 400;
            if (cut === "server-error") return 503;
            if (cut === "malformed")
              return {
                status: 200,
                value: { written: -1, cleared: 0, skipped: [] },
              };
            if (cut === "skipped") {
              await trash(admin, required((await test.rows()).get("one")).id);
              await purge(admin, required((await test.rows()).get("one")).id);
            }
            return undefined;
          };
          test.proxy.after = async (request, response) => {
            if (!agreements(request)) return false;
            if (cut === "lost-applied") {
              assert.equal(response.status, 200);
              assert.deepEqual(await response.clone().json(), {
                written: 1,
                cleared: 0,
                skipped: [],
              });
              const expected = (request.input["set"] as Written[])[0];
              assert.deepEqual(
                required((await test.held([row.id]))[0]).record,
                required(expected).record,
              );
              return true;
            }
            if (cut === "skipped")
              assert.deepEqual(
                ((await response.clone().json()) as { skipped: string[] })
                  .skipped,
                [row.id],
              );
            return false;
          };
          const stopped = await test.run();
          assert.equal(stopped.code, 1, stopped.output);
          assert.equal(reached, true);
          assert.deepEqual(test.control.events, []);
          assert.deepEqual(test.control.pushes, []);
          const asked = test.proxy.requests.slice(from);
          assert.equal(asked.filter(agreements).length, 1);
          assert.equal(asked.filter(states).length, 0);
          assert.deepEqual(await test.state(), kept);
          if (cut !== "skipped") {
            test.proxy.before = () => undefined;
            test.proxy.after = () => false;
            test.reset();
            await test.succeeds();
            assert.deepEqual((await test.state())["state"], { page: 2 });
          }
        } finally {
          await test.stop();
        }
      }
      return "actual boundary 400/503, malformed count, lost-after-real-apply and real purge skip: reader absent, one prerequisite request, zero final state requests, original page/cursor retained; fresh processes recover non-purged cases";
    },
  );

  await check(
    "watch prerequisites: a later boundary batch failure retains the first 500 and never enters the reader",
    async () => {
      const test = await Fixture.create(admin, url, "proof-watch-batches");
      try {
        test.control.entries = Array.from({ length: 501 }, (_, n) =>
          one(String(n)),
        );
        await test.succeeds();
        const kept = await test.state();
        const rows = await test.rows();
        assert.equal(rows.size, 501);
        let first: Written[] = [],
          batches = 0;
        test.reset();
        const from = test.proxy.requests.length;
        test.proxy.before = async (request) => {
          if (!agreements(request)) return undefined;
          batches += 1;
          const set = request.input["set"] as Written[];
          if (batches === 1) {
            assert.equal(set.length, 500);
            first = structuredClone(set);
          }
          if (batches === 2) {
            assert.equal(set.length, 1);
            const durable = await test.held(
              first.map((value) => value.item_id),
            );
            assert.equal(durable.length, 500);
            const byId = new Map(
              durable.map((value) => [value.item_id, value]),
            );
            for (const expected of first) {
              const actual = required(byId.get(expected.item_id));
              assert.deepEqual(actual.record, expected.record);
              assert.equal(actual.waiting, expected.waiting);
            }
            return 503;
          }
          return undefined;
        };
        const stopped = await test.run();
        assert.equal(stopped.code, 1, stopped.output);
        assert.equal(batches, 2);
        assert.deepEqual(test.control.events, []);
        assert.equal(test.proxy.requests.slice(from).filter(states).length, 0);
        assert.deepEqual(await test.state(), kept);
        test.proxy.before = () => undefined;
        test.reset();
        await test.succeeds();
        assert.deepEqual((await test.state())["state"], { page: 2 });
        assert.equal((await test.rows()).size, 501);
        return "true 500+1 watch prerequisite batches; every first500 exact ID/record/waiting value inspected after server ACK; second503 blocks reader/cursor; fresh rescan commits page2";
      } finally {
        await test.stop();
      }
    },
  );

  await check(
    "watch prerequisites: a real 1-second hold fences the boundary behind its successor",
    async () => {
      const server = new ProofServer(1000);
      let test: Fixture | undefined;
      let takeover: Promise<void> | undefined;
      try {
        const boot = await server.boot();
        const ownAdmin = createClient({
          baseUrl: boot.url,
          credential: boot.key,
        });
        test = await Fixture.create(ownAdmin, boot.url, "proof-watch-fence");
        const fixture = test;
        await fixture.succeeds();
        const row = required((await fixture.rows()).get("one"));
        const id = await fixture.id();
        let cut = false,
          blockRenewals = false;
        const from = fixture.proxy.requests.length;
        fixture.reset();
        fixture.proxy.before = async (request) => {
          if (
            blockRenewals &&
            request.method === "POST" &&
            request.path.endsWith("/hold")
          )
            return 503;
          if (!agreements(request) || cut) return undefined;
          cut = true;
          blockRenewals = true;
          takeover = (async () => {
            await new Promise((done) => setTimeout(done, 1250));
            const process = randomUUID();
            const taken = await fixture.own.POST("/connectors/{id}/hold", {
              params: { path: { id } },
              body: { process },
            });
            assert.equal(required(taken.data).ttl_ms, 1000);
            const state = await fixture.own.PUT("/connectors/{id}/state", {
              params: { path: { id } },
              body: {
                process,
                state: { state: { successor: 141 }, conditions: {} },
              },
            });
            assert.ok(state.data);
            const written = await fixture.own.POST(
              "/connectors/{id}/agreements",
              {
                params: { path: { id } },
                body: {
                  process,
                  set: [
                    {
                      item_id: row.id,
                      waiting: false,
                      record: { successor: 141 },
                    },
                  ],
                },
              },
            );
            assert.equal(required(written.data).written, 1);
            const released = await fixture.own.DELETE("/connectors/{id}/hold", {
              params: { path: { id }, query: { process } },
            });
            assert.equal(released.response.ok, true);
          })();
          await takeover;
          return undefined;
        };
        const stopped = await fixture.run();
        assert.equal(stopped.code, 1, stopped.output);
        assert.equal(cut, true);
        if (takeover === undefined)
          throw new Error(`boundary takeover not reached: ${stopped.output}`);
        await takeover;
        assert.deepEqual(fixture.control.events, []);
        assert.deepEqual((await fixture.state())["state"], { successor: 141 });
        assert.deepEqual(required((await fixture.held([row.id]))[0]).record, {
          successor: 141,
        });
        const old = fixture.proxy.requests
          .slice(from)
          .find(
            (request) =>
              request.method === "POST" && request.path.endsWith("/hold"),
          )?.input["process"];
        assert.equal(typeof old, "string");
        if (typeof old !== "string") throw new Error("old hold missing");
        const staleState = await fixture.own.PUT("/connectors/{id}/state", {
          params: { path: { id } },
          body: {
            process: old,
            state: { state: { stale: true }, conditions: {} },
          },
        });
        const staleAgreement = await fixture.own.POST(
          "/connectors/{id}/agreements",
          {
            params: { path: { id } },
            body: {
              process: old,
              set: [
                { item_id: row.id, waiting: false, record: { stale: true } },
              ],
            },
          },
        );
        assert.equal(staleState.response.status, 409);
        assert.equal(staleAgreement.response.status, 409);
        assert.deepEqual((await fixture.state())["state"], { successor: 141 });
        assert.deepEqual(required((await fixture.held([row.id]))[0]).record, {
          successor: 141,
        });
        return "original ttl1000, actual boundary cut,1250ms successor wait; reader absent; successor state/agreement preserved; both real stale doors409";
      } finally {
        await takeover?.catch(() => undefined);
        await test?.stop();
        await server.stop();
      }
    },
  );
}
