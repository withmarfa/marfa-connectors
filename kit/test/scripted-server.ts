import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION } from "@withmarfa/client";

/**
 * The doors a connector uses, answering as the real server does for the
 * cases the kit's rules turn on: a create at version 0 over an existing
 * row, a trashed row under a bulk upsert, a stale version, a replacing
 * update. The proof holds the kit to the real server; this holds each rule
 * to a test that can script what the real server cannot be asked for.
 */

export interface Row {
  id: string;
  type: string;
  source: string;
  source_id: string;
  properties: Record<string, unknown>;
  state: "active" | "archived" | "trashed";
  tier: "feed" | "library";
  version: number;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  outcome: string;
  started_at: string;
  finished_at: string;
  summary?: string;
  error?: string;
}

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface Refusal {
  status: number;
  code: string;
  message: string;
}

export class ScriptedServer {
  readonly key = "marfa_k1_scripted";
  readonly source: string;
  url = "";
  rows: Row[] = [];
  types = new Map<string, Record<string, unknown>>();
  runs: Run[] = [];
  heartbeats = 0;
  registrations = 0;
  requests: Request[] = [];
  /** Keyed `METHOD /path`, answered once each in place of the door. */
  private readonly refusals = new Map<string, Refusal[]>();
  /** Bulk entries refused by `source_id`, as the server refuses one entry. */
  readonly entryRefusals = new Map<string, Refusal>();
  /** Called after an own-rows page is answered, before the next request. */
  afterList: (() => void) | undefined;
  private readonly http = createServer((req, res) => {
    void this.answer(req, res);
  });
  private sequence = 0;
  private clock = Date.parse("2026-09-25T00:00:00.000Z");

  constructor(source: string) {
    this.source = source;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => {
      this.http.listen(0, "127.0.0.1", resolve);
    });
    const { port } = this.http.address() as AddressInfo;
    this.url = `http://127.0.0.1:${String(port)}`;
    return this;
  }

  async stop(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.http.close(() => {
        resolve();
      });
    });
  }

  /** The next request to `route` is answered with this refusal. */
  refuseNext(route: string, status: number, code: string, message = code): void {
    const queue = this.refusals.get(route) ?? [];
    queue.push({ status, code, message });
    this.refusals.set(route, queue);
  }

  row(sourceId: string): Row {
    const row = this.rows.find((candidate) => candidate.source_id === sourceId);
    if (row === undefined) throw new Error(`no row ${sourceId}`);
    return row;
  }

  /** Another writer changes a row, moving its version. */
  touch(sourceId: string, properties: Record<string, unknown>): void {
    const row = this.row(sourceId);
    row.properties = { ...row.properties, ...properties };
    row.version += 1;
    row.updated_at = this.now();
  }

  /** A row created by another process holding the same key. */
  insert(sourceId: string, properties: Record<string, unknown>, type: string): Row {
    const row = this.newRow(type, this.source, sourceId, properties, undefined, "feed");
    this.rows.push(row);
    return row;
  }

  requestsTo(method: string, path: string): Request[] {
    return this.requests.filter(
      (request) => request.method === method && request.path === path,
    );
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private newRow(
    type: string,
    source: string,
    sourceId: string,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
    tier: "feed" | "library",
  ): Row {
    const at = this.now();
    this.sequence += 1;
    return {
      id: `0190a000-0000-7000-8000-${String(this.sequence).padStart(12, "0")}`,
      type,
      source,
      source_id: sourceId,
      properties,
      state: "active",
      tier,
      version: 1,
      occurred_at: occurredAt ?? at,
      created_at: at,
      updated_at: at,
    };
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const method = req.method ?? "GET";
    this.requests.push({ method, path: url.pathname, query: url.searchParams, body });

    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "X-Marfa-Contract": String(CONTRACT_VERSION),
      });
      res.end(JSON.stringify(payload));
    };
    const refuse = (status: number, code: string, message = code): void => {
      send(status, { error: { code, message } });
    };

    if (req.headers.authorization !== `Bearer ${this.key}`) {
      refuse(401, "unauthorized");
      return;
    }
    const route = `${method} ${url.pathname}`;
    const scripted = this.refusals.get(route)?.shift();
    if (scripted !== undefined) {
      refuse(scripted.status, scripted.code, scripted.message);
      return;
    }

    const parts = url.pathname.split("/").filter((part) => part !== "");
    const input = (body ?? {}) as Record<string, unknown>;

    if (method === "POST" && url.pathname === "/connectors") {
      this.registrations += 1;
      const at = this.now();
      send(this.registrations === 1 ? 201 : 200, {
        id: "connector-1",
        key_id: "key-1",
        source: this.source,
        name: input["name"],
        description: input["description"] ?? null,
        registered_at: at,
        updated_at: at,
        last_heartbeat_at: null,
        last_run: null,
      });
      return;
    }
    if (method === "POST" && parts[0] === "connectors" && parts[2] === "heartbeat") {
      this.heartbeats += 1;
      send(200, { last_heartbeat_at: this.now() });
      return;
    }
    if (method === "POST" && parts[0] === "connectors" && parts[2] === "runs") {
      const run = input as unknown as Run;
      const long = (value: unknown): boolean =>
        typeof value === "string" && value.length > 2000;
      if (long(run.summary) || long(run.error)) {
        refuse(400, "validation_error", "summary or error over 2000 characters");
        return;
      }
      this.runs.push(run);
      send(201, { ...run, id: `run-${String(this.runs.length)}`, reported_at: this.now() });
      return;
    }
    if (method === "GET" && parts[0] === "types" && parts[1] !== undefined) {
      const type = this.types.get(parts[1]);
      if (type === undefined) {
        refuse(404, "type_not_found");
        return;
      }
      send(200, type);
      return;
    }
    if (method === "POST" && url.pathname === "/types") {
      const id = String(input["id"]);
      if (this.types.has(id)) {
        refuse(409, "conflict");
        return;
      }
      this.types.set(id, input);
      send(201, { type: input });
      return;
    }
    if (method === "GET" && url.pathname === "/items") {
      this.listItems(url.searchParams, send);
      this.afterList?.();
      return;
    }
    if (method === "POST" && url.pathname === "/items/bulk") {
      send(200, this.bulk(input));
      return;
    }
    if (method === "PATCH" && parts[0] === "items" && parts[1] !== undefined) {
      this.update(parts[1], input, send, refuse);
      return;
    }
    if (method === "POST" && parts[0] === "items" && parts[2] === "transition") {
      const row = this.rows.find((candidate) => candidate.id === parts[1]);
      if (row === undefined) {
        refuse(404, "item_not_found");
        return;
      }
      const state = input["state"] as Row["state"];
      if (row.state === "trashed" && state === "archived") {
        refuse(400, "invalid_transition");
        return;
      }
      row.state = state;
      row.version += 1;
      row.updated_at = this.now();
      send(200, { item: row, metadata: { item_id: row.id, tags: [], extensions: {} } });
      return;
    }
    refuse(404, "not_found", `no scripted door for ${route}`);
  }

  private listItems(
    query: URLSearchParams,
    send: (status: number, payload: unknown) => void,
  ): void {
    const state = query.get("state") ?? "active";
    const matches = this.rows.filter(
      (row) =>
        (query.get("type") === null || row.type === query.get("type")) &&
        (query.get("source") === null || row.source === query.get("source")) &&
        (state === "any" || row.state === state),
    );
    const limit = Number(query.get("limit") ?? "50");
    const start = Number(query.get("cursor") ?? "0");
    const page = matches.slice(start, start + limit);
    const next = start + limit < matches.length ? String(start + limit) : null;
    send(200, { data: page.map((row) => ({ ...row })), next_cursor: next });
  }

  private bulk(input: Record<string, unknown>): unknown {
    const entries = input["items"] as Record<string, unknown>[];
    const results = entries.map((entry, index) => {
      const sourceId = String(entry["source_id"]);
      const source = typeof entry["source"] === "string" ? entry["source"] : this.source;
      const refusal = this.entryRefusals.get(sourceId);
      if (refusal !== undefined) {
        return { index, outcome: "errored", error: { code: refusal.code, message: refusal.message } };
      }
      const existing = this.rows.find(
        (row) => row.source === source && row.source_id === sourceId,
      );
      if (existing?.state === "trashed") {
        return { index, outcome: "skipped", id: existing.id, reason: "trashed" };
      }
      if (existing !== undefined) {
        if (entry["version"] === 0) {
          return {
            index,
            outcome: "errored",
            error: { code: "ancestor_unavailable", message: "no row was expected" },
          };
        }
        existing.properties = {
          ...existing.properties,
          ...(entry["properties"] as Record<string, unknown>),
        };
        existing.version += 1;
        return { index, outcome: "updated", id: existing.id };
      }
      const row = this.newRow(
        String(entry["type"]),
        source,
        sourceId,
        (entry["properties"] ?? {}) as Record<string, unknown>,
        entry["occurred_at"] as string | undefined,
        entry["tier"] === "library" ? "library" : "feed",
      );
      this.rows.push(row);
      return { index, outcome: "created", id: row.id };
    });
    const count = (outcome: string): number =>
      results.filter((result) => result.outcome === outcome).length;
    return {
      counts: {
        created: count("created"),
        updated: count("updated"),
        skipped: count("skipped"),
        errored: count("errored"),
      },
      results,
    };
  }

  private update(
    id: string,
    input: Record<string, unknown>,
    send: (status: number, payload: unknown) => void,
    refuse: (status: number, code: string, message?: string) => void,
  ): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.state === "trashed") {
      refuse(404, "item_not_found");
      return;
    }
    if (typeof input["version"] !== "number") {
      refuse(400, "missing_required_field");
      return;
    }
    if (input["version"] !== row.version) {
      refuse(409, "version_conflict");
      return;
    }
    const properties = (input["properties"] ?? {}) as Record<string, unknown>;
    row.properties =
      input["properties_mode"] === "replace"
        ? properties
        : { ...row.properties, ...properties };
    if (typeof input["occurred_at"] === "string") row.occurred_at = input["occurred_at"];
    row.version += 1;
    row.updated_at = this.now();
    send(200, { item: { ...row }, metadata: { item_id: row.id, tags: [], extensions: {} } });
  }
}
