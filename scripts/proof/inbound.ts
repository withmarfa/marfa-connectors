import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  lastRun,
  mintAsReadmeSays,
  registration,
  rowsOf,
} from "./connector.js";

const entry = resolve(import.meta.dirname, "inbound-connector.js");
const secret = "proof-webhook-secret-value";

/** The stub vendor: things by id, and every path it was asked for. */
async function serveThings(): Promise<{
  url: string;
  things: Map<string, string>;
  asked: string[];
  close: () => Promise<void>;
}> {
  const things = new Map([
    ["t1", "First"],
    ["t2", "Second"],
  ]);
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    asked.push(path);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/things") {
      json(
        200,
        [...things].map(([id, title]) => ({ id, title })),
      );
      return;
    }
    const id = decodeURIComponent(path.replace(/^\/things\//, ""));
    const title = things.get(id);
    if (title === undefined) json(404, {});
    else json(200, { id, title });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`,
    things,
    asked,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

/** A delivery as GitHub sends one: signed over the raw body, with its id. */
function signed(
  said: Record<string, unknown>,
  delivery: string,
  key = secret,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(said);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", key).update(body).digest("hex")}`,
    },
  };
}

async function post(
  url: string,
  path: string,
  delivery: { body: string; headers: Record<string, string> },
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
}

async function until(
  holds: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function deliveries(
  own: MarfaClient,
  connectorId: string,
  state: "pending" | "handled" | "any",
) {
  const { data, error } = await own.GET("/connectors/{id}/deliveries", {
    params: { path: { id: connectorId }, query: { state, limit: 200 } },
  });
  if (data === undefined)
    throw new Error(`the deliveries were refused: ${JSON.stringify(error)}`);
  return data.data;
}

export async function proveInbound(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  const vendor = await serveThings();
  let connector: ConnectorUnderProof | undefined;
  try {
    const key = await mintAsReadmeSays(marfa, {
      label: "proof-inbound",
      source: "proof-inbound",
      typePermission: "proof.thing",
    });
    const env = {
      PROOF_VENDOR_URL: vendor.url,
      PROOF_WEBHOOK_SECRET: secret,
    };
    const runner = new ConnectorUnderProof(
      "proof-inbound",
      url,
      key.key,
      env,
      entry,
    );
    connector = runner;
    const runOnce = async (): Promise<void> => {
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
    };
    const own = createClient({ baseUrl: url, credential: key.key });
    let connectorId = "";
    let path = "";
    let endpointId = "";
    const first = signed({ id: "t2" }, "11111111-1111-1111-1111-111111111111");

    await check(
      "inbound: the connector's first run registers it, and an endpoint made for it answers its address in full once",
      async () => {
        await runOnce();
        connectorId = (await registration(marfa, key.id)).id;
        const unmade = (await lastRun(marfa, key.id)).summary ?? "";
        if (!unmade.includes("no webhook endpoint is live")) {
          throw new Error(`the first run's report said: ${unmade}`);
        }
        const { data, error } = await own.POST("/connectors/{id}/endpoints", {
          params: { path: { id: connectorId } },
          body: { label: "stub vendor", duplicate_header: "X-GitHub-Delivery" },
        });
        if (data === undefined)
          throw new Error(`the endpoint was refused: ${JSON.stringify(error)}`);
        path = data.path;
        endpointId = data.id;
        const listed = await own.GET("/connectors/{id}/endpoints", {
          params: { path: { id: connectorId } },
        });
        const shown = listed.data?.data.find((row) => row.id === endpointId);
        if (
          !/^\/inbound\/[A-Za-z0-9_-]{43}$/.test(path) ||
          shown?.path !== `/inbound/****${path.slice(-4)}`
        ) {
          throw new Error(`made ${path}, listed ${String(shown?.path)}`);
        }
        return `the run said no endpoint was live; the endpoint answered /inbound/ and 43 characters, and is listed as ${shown.path}`;
      },
    );

    await check(
      "inbound: a delivery sent while the connector is stopped is stored byte for byte, and its signature verifies over what the server holds",
      async () => {
        const answer = await post(url, path, first);
        if (answer.status !== 202)
          throw new Error(`the door answered ${String(answer.status)}`);
        const [stored] = await deliveries(own, connectorId, "pending");
        if (stored === undefined) throw new Error("nothing is waiting");
        const body = await own.GET(
          "/connectors/{id}/deliveries/{delivery_id}/body",
          {
            params: { path: { id: connectorId, delivery_id: stored.id } },
            parseAs: "arrayBuffer",
          },
        );
        if (body.data === undefined) throw new Error("the body was refused");
        const bytes = Buffer.from(body.data);
        const header = stored.headers.find(
          ([name]) => name?.toLowerCase() === "x-hub-signature-256",
        )?.[1];
        const recomputed = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
        if (!bytes.equals(Buffer.from(first.body)) || header !== recomputed) {
          throw new Error(
            `stored ${String(bytes.length)} bytes, signature ${String(header)}`,
          );
        }
        return `202, ${String(bytes.length)} bytes stored as sent, and the stored signature recomputes over them`;
      },
    );

    await check(
      "inbound: the next run collects the delivery, writes what the vendor has, marks it processed and counts it in its report",
      async () => {
        await runOnce();
        const handled = await deliveries(own, connectorId, "handled");
        const rows = await rowsOf(marfa, "proof.thing", "proof-inbound");
        const summary = (await lastRun(marfa, key.id)).summary ?? "";
        if (
          handled.map((delivery) => delivery.outcome).join() !== "processed" ||
          rows.get("t2")?.properties["title"] !== "Second" ||
          !summary.includes("deliveries processed 1, rejected 0, duplicate 0")
        ) {
          throw new Error(
            `handled ${handled.map((delivery) => delivery.outcome).join()}, rows ${[...rows.keys()].join()}, report ${summary}`,
          );
        }
        return `the delivery is processed, t2 is written, and the report says ${summary.slice(summary.indexOf("deliveries"))}`;
      },
    );

    await check(
      "inbound: a redelivery repeating its delivery header is marked a duplicate and a forged delivery rejected, each counted",
      async () => {
        await post(url, path, first);
        await post(
          url,
          path,
          signed(
            { id: "t1" },
            "22222222-2222-2222-2222-222222222222",
            "a guess",
          ),
        );
        const waiting = await deliveries(own, connectorId, "pending");
        const repeat = waiting.find(
          (delivery) => delivery.duplicate_of !== null,
        );
        await runOnce();
        const every = await deliveries(own, connectorId, "any");
        const outcomes = every.map((delivery) => delivery.outcome).join();
        const summary = (await lastRun(marfa, key.id)).summary ?? "";
        if (
          repeat?.duplicate_of?.outcome !== "processed" ||
          outcomes !== "processed,duplicate,rejected" ||
          !summary.includes("deliveries processed 0, rejected 1, duplicate 1")
        ) {
          throw new Error(
            `duplicate_of ${JSON.stringify(repeat?.duplicate_of)}, outcomes ${outcomes}, report ${summary}`,
          );
        }
        return `the repeat named the processed delivery; outcomes ${outcomes}; the report says ${summary.slice(summary.indexOf("deliveries"))}`;
      },
    );

    await check(
      "inbound: running on a schedule, the connector takes a delivery within seconds and fetches only the thing it named",
      async () => {
        const child = spawn(
          "node",
          [entry, "--every", "1h", "--deliveries-every", "1s"],
          {
            env: {
              PATH: process.env["PATH"],
              MARFA_URL: url,
              MARFA_KEY: key.key,
              ...env,
            },
            stdio: "ignore",
          },
        );
        const exited = new Promise<number | null>((done) =>
          child.once("exit", (code) => {
            done(code);
          }),
        );
        try {
          const runsBefore = (await lastRun(marfa, key.id)).reported_at;
          await until(
            async () =>
              (await lastRun(marfa, key.id)).reported_at !== runsBefore,
            "the scheduled run",
          );
          vendor.things.set("t3", "Third");
          vendor.asked.length = 0;
          const sentAt = Date.now();
          await post(
            url,
            path,
            signed({ id: "t3" }, "33333333-3333-3333-3333-333333333333"),
          );
          await until(async () => {
            const rows = await rowsOf(marfa, "proof.thing", "proof-inbound");
            return rows.has("t3");
          }, "t3 being written");
          const took = Date.now() - sentAt;
          if (vendor.asked.join() !== "/things/t3") {
            throw new Error(`the vendor was asked for ${vendor.asked.join()}`);
          }
          return `t3 was written ${String(took)} ms after its delivery, and the vendor was asked for ${vendor.asked.join()} alone`;
        } finally {
          child.kill("SIGTERM");
          await exited;
        }
      },
    );

    await check(
      "inbound: a retired endpoint's address answers 404 and stores nothing",
      async () => {
        const before = (await deliveries(own, connectorId, "any")).length;
        const retired = await own.DELETE(
          "/connectors/{id}/endpoints/{endpoint_id}",
          { params: { path: { id: connectorId, endpoint_id: endpointId } } },
        );
        if (retired.data?.retired_at == null)
          throw new Error("the retirement was refused");
        const answer = await post(
          url,
          path,
          signed({ id: "t1" }, "44444444-4444-4444-4444-444444444444"),
        );
        const after = (await deliveries(own, connectorId, "any")).length;
        if (answer.status !== 404 || after !== before) {
          throw new Error(
            `the door answered ${String(answer.status)}; deliveries ${String(before)} then ${String(after)}`,
          );
        }
        return `404, and the connector still holds ${String(after)} deliveries`;
      },
    );
  } finally {
    await vendor.close();
  }
}
