import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION } from "@withmarfa/client";

/**
 * The doors a connector uses, answering as the real server does for the
 * cases the kit's rules turn on:
 * - a create at version 0 over an existing row answers `ancestor_unavailable`;
 * - a bulk upsert over a trashed row skips it;
 * - an update on the current version replaces or merges as asked;
 * - an update on a stale version merges its changes with what landed since,
 *   and under `replace` a field the ancestor had and the body leaves out is
 *   one of them, cleared, unless the row no longer holds it; a field or the
 *   own time it changes that also changed there answers `version_conflict`,
 *   and a value echoed from the version named is not a change;
 * - every write reaches a log the stream replays from a cursor, ids in the
 *   order the writes were made, each frame carrying the row as it then was,
 *   narrowed to a type and its subtree, the first frame naming the head and
 *   a marker after the replay naming where the stream has reached.
 * It lets a test script what the real server cannot be asked for: another
 * writer between a read and a write, a refusal, a delay, a cursor the log
 * no longer holds, a stream that ends early or whose replay never finishes.
 */

export interface Row {
  id: string;
  type: string;
  source: string;
  source_id: string | undefined;
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
  headers: Record<string, string | undefined>;
  body: unknown;
}

/** One event as the log holds it. */
export interface Event {
  id: number;
  event: string;
  item: Row;
}

interface Refusal {
  status: number;
  code: string;
  message: string;
}

/**
 * What a version held, written when a write leaves the version, at that
 * write's moment; a transition writes one of its own version too, without
 * moving it, as the real server does.
 */
interface Snapshot {
  version: number;
  properties: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

type Send = (status: number, payload: unknown) => void;
type Refuse = (status: number, code: string, message?: string) => void;

function changedKeys(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  keys: Iterable<string>,
): Set<string> {
  const changed = new Set<string>();
  for (const key of keys) {
    if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) changed.add(key);
  }
  return changed;
}

export class ScriptedServer {
  readonly key = "marfa_k1_scripted";
  readonly source: string;
  /** The calling key's own source, the connector's unless a test says not. */
  keySource: string;
  /**
   * What the calling key holds beside its source: nothing unless a test
   * says so, which is narrower than any connector's type and so passes
   * the kit's check on start.
   */
  grants: {
    sources?: string[];
    permissions?: string[];
    is_operator?: boolean;
    type_permissions?: Record<string, string>;
    metadata_permissions?: Record<string, string>;
    edge_permissions?: Record<string, string>;
    extension_permissions?: Record<string, string>;
    profile_permissions?: Record<string, string>;
  } = {};
  url = "";
  rows: Row[] = [];
  types = new Map<string, Record<string, unknown>>();
  runs: Run[] = [];
  heartbeats = 0;
  registrations = 0;
  requests: Request[] = [];
  /** Every write, in the order made. */
  readonly log: Event[] = [];
  /** Bulk entries refused by `source_id`, as the server refuses one entry. */
  readonly entryRefusals = new Map<string, Refusal>();
  /** Called after an own-rows page is answered, before the next request. */
  afterList: (() => void) | undefined;
  /** Awaited before a request is answered, with the request as it arrived. */
  beforeAnswer: ((request: Request) => Promise<void> | void) | undefined;
  /** A body over this many bytes is refused whole, as the server's cap refuses it. */
  bodyCap: number | undefined;
  /** The stream answers `catchup_too_old` to any cursor. */
  tooOld = false;
  /** The stream ends with `stream_incomplete` after this many frames. */
  incompleteAfter: number | undefined;
  /** The stream never says it is live, and stays open: a replay that never finishes. */
  withholdLive = false;
  /** The stream stops writing after this many frames and stays open, as a slow server does. */
  stallAfter: number | undefined;
  /** The marker names no position, as the server's does when its head read outran its budget. */
  liveCursorNull = false;
  /** The marker names this position in place of the head, as a server whose log was reset would. */
  liveCursor: string | undefined;
  /** Keyed `METHOD /path`, answered once each in place of the door. */
  private readonly refusals = new Map<string, Refusal[]>();
  /** Each row's properties and own time at every version it has had. */
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly http = createServer((req, res) => {
    void this.answer(req, res);
  });
  private sequence = 0;
  private clock = Date.parse("2026-09-25T00:00:00.000Z");

  constructor(source: string) {
    this.source = source;
    this.keySource = source;
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
  refuseNext(
    route: string,
    status: number,
    code: string,
    message = code,
  ): void {
    const queue = this.refusals.get(route) ?? [];
    queue.push({ status, code, message });
    this.refusals.set(route, queue);
  }

  row(sourceId: string): Row {
    const row = this.rows.find((candidate) => candidate.source_id === sourceId);
    if (row === undefined) throw new Error(`no row ${sourceId}`);
    return row;
  }

  byId(id: string): Row {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error(`no row with id ${id}`);
    return row;
  }

  /** Another writer changes a row, moving its version. */
  touch(sourceId: string, properties: Record<string, unknown>): void {
    const row = this.row(sourceId);
    this.write(row, { ...row.properties, ...properties });
  }

  /**
   * Another writer replaces a row's properties whole, or moves its own
   * time, moving its version: what a person's edit or a folder's write does.
   */
  rewrite(
    sourceId: string,
    properties: Record<string, unknown>,
    occurredAt?: string,
  ): void {
    const row = this.row(sourceId);
    this.write(row, properties, occurredAt);
  }

  /** A person edits a row, by its id, laying properties over its own. */
  edit(id: string, properties: Record<string, unknown>): Row {
    const row = this.byId(id);
    this.write(row, { ...row.properties, ...properties });
    return row;
  }

  /** A person moves a row to a state, as the transition door does. */
  transition(id: string, state: Row["state"]): Row {
    const row = this.byId(id);
    this.snapshot(row);
    row.state = state;
    row.updated_at = this.now();
    this.announce("item.state_changed", row);
    return row;
  }

  /**
   * A person puts a row in the bin. The server writes no version for it,
   * and announces the row as it was before the trash with only its state
   * changed, where the row it holds after carries the trash's time: so a
   * trash's frame and the purge's after it differ in `updated_at`.
   */
  trash(id: string): Row {
    const row = this.byId(id);
    const before = { ...row, state: "trashed" as const };
    row.state = "trashed";
    row.updated_at = this.now();
    this.announce("item.deleted", before);
    return row;
  }

  /** A person brings a row back from the bin. */
  restore(id: string): Row {
    const row = this.byId(id);
    this.snapshot(row);
    row.state = "active";
    row.updated_at = this.now();
    this.announce("item.restored", row);
    return row;
  }

  /** A person empties the bin of this row. */
  purge(sourceId: string): void {
    const row = this.row(sourceId);
    this.purgeById(row.id);
  }

  purgeById(id: string): void {
    const row = this.byId(id);
    this.rows = this.rows.filter((candidate) => candidate.id !== id);
    this.announce("item.purged", row);
  }

  /**
   * A row created by another process holding the same key, or, under
   * another source, by a person.
   */
  insert(
    sourceId: string | undefined,
    properties: Record<string, unknown>,
    type: string,
    source = this.source,
  ): Row {
    const row = this.newRow(
      type,
      source,
      sourceId,
      properties,
      undefined,
      "feed",
    );
    this.rows.push(row);
    this.announce("item.created", row);
    return row;
  }

  requestsTo(method: string, path: string): Request[] {
    return this.requests.filter(
      (request) => request.method === method && request.path === path,
    );
  }

  /** The log's head: the id of the last event, or 0 with none. */
  get head(): number {
    return this.log[this.log.length - 1]?.id ?? 0;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Moves the server's clock on, so a later write is later by that much. */
  advance(ms: number): void {
    this.clock += ms;
  }

  private announce(event: string, row: Row): void {
    this.log.push({ id: this.log.length + 1, event, item: { ...row } });
  }

  /** A snapshot of the row as it stands, at this moment. */
  private snapshot(row: Row): void {
    this.snapshots.get(row.id)?.push({
      version: row.version,
      properties: row.properties,
      occurred_at: row.occurred_at,
      created_at: this.now(),
    });
  }

  private write(
    row: Row,
    properties: Record<string, unknown>,
    occurredAt?: string,
  ): void {
    this.snapshot(row);
    row.properties = properties;
    if (occurredAt !== undefined) row.occurred_at = occurredAt;
    row.version += 1;
    row.updated_at = this.now();
    this.announce("item.updated", row);
  }

  private newRow(
    type: string,
    source: string,
    sourceId: string | undefined,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
    tier: "feed" | "library",
  ): Row {
    const at = this.now();
    this.sequence += 1;
    const row: Row = {
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
    this.snapshots.set(row.id, []);
    return row;
  }

  private wire(row: Row): Record<string, unknown> {
    return {
      ...row,
      ...(row.source_id === undefined && { source_id: undefined }),
    };
  }

  private async answer(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const method = req.method ?? "GET";
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const request = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    };
    this.requests.push(request);

    const send: Send = (status, payload) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "X-Marfa-Contract": String(CONTRACT_VERSION),
      });
      res.end(JSON.stringify(payload));
    };
    const refuse: Refuse = (status, code, message = code) => {
      send(status, { error: { code, message } });
    };

    if (req.headers.authorization !== `Bearer ${this.key}`) {
      refuse(401, "unauthorized");
      return;
    }
    await this.beforeAnswer?.(request);
    if (this.bodyCap !== undefined && Buffer.byteLength(text) > this.bodyCap) {
      refuse(413, "request_too_large");
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

    if (method === "GET" && url.pathname === "/keys/current") {
      send(200, {
        id: "key-1",
        label: "scripted",
        source: this.keySource,
        sources: [],
        permissions: [],
        default_tier: "feed",
        is_operator: false,
        type_permissions: {},
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        profile_permissions: {},
        created_at: this.now(),
        last_used_at: null,
        ...this.grants,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/connectors") {
      this.registrations += 1;
      const at = this.now();
      send(this.registrations === 1 ? 201 : 200, {
        id: "connector-1",
        key_id: "key-1",
        source: this.keySource,
        name: input["name"],
        description: input["description"] ?? null,
        registered_at: at,
        updated_at: at,
        last_heartbeat_at: null,
        last_run: null,
      });
      return;
    }
    if (
      method === "POST" &&
      parts[0] === "connectors" &&
      parts[2] === "heartbeat"
    ) {
      this.heartbeats += 1;
      send(200, { last_heartbeat_at: this.now() });
      return;
    }
    if (method === "POST" && parts[0] === "connectors" && parts[2] === "runs") {
      const run = input as unknown as Run;
      const long = (value: unknown): boolean =>
        typeof value === "string" && value.length > 2000;
      if (long(run.summary) || long(run.error)) {
        refuse(
          400,
          "validation_error",
          "summary or error over 2000 characters",
        );
        return;
      }
      this.runs.push(run);
      send(201, {
        ...run,
        id: `run-${String(this.runs.length)}`,
        reported_at: this.now(),
      });
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
        refuse(409, "type_already_exists");
        return;
      }
      this.types.set(id, input);
      send(201, { type: input });
      return;
    }
    if (method === "GET" && url.pathname === "/events") {
      this.stream(url.searchParams, headers["last-event-id"], res);
      return;
    }
    if (method === "GET" && url.pathname === "/items") {
      this.listItems(url.searchParams, send);
      this.afterList?.();
      return;
    }
    if (method === "POST" && url.pathname === "/items") {
      const source =
        typeof input["source"] === "string" ? input["source"] : this.keySource;
      const row = this.newRow(
        String(input["type"]),
        source,
        typeof input["source_id"] === "string" ? input["source_id"] : undefined,
        (input["properties"] ?? {}) as Record<string, unknown>,
        input["occurred_at"] as string | undefined,
        input["tier"] === "feed" ? "feed" : "library",
      );
      this.rows.push(row);
      this.announce("item.created", row);
      send(201, {
        item: this.wire(row),
        metadata: { item_id: row.id, tags: [], extensions: {} },
      });
      return;
    }
    if (method === "POST" && url.pathname === "/items/bulk") {
      send(200, this.bulk(input));
      return;
    }
    const id = parts[1];
    if (parts[0] === "items" && id !== undefined) {
      const row = this.rows.find((candidate) => candidate.id === id);
      if (method === "GET" && parts.length === 2) {
        // A trashed row is read back by no door but its restore.
        if (row === undefined || row.state === "trashed") {
          refuse(404, "item_not_found");
          return;
        }
        send(200, {
          item: this.wire(row),
          metadata: { item_id: row.id, tags: [], extensions: {} },
        });
        return;
      }
      if (method === "GET" && parts[2] === "versions") {
        if (row === undefined) {
          refuse(404, "item_not_found");
          return;
        }
        // The snapshots of what each update left behind: every version but
        // the current one.
        const data = (this.snapshots.get(id) ?? []).map((snapshot, at) => ({
          id: `${id}-${String(at)}`,
          item_id: id,
          version: snapshot.version,
          properties: snapshot.properties,
          created_at: snapshot.created_at,
        }));
        send(200, { data, next_cursor: null });
        return;
      }
      if (method === "PATCH" && parts.length === 2) {
        this.update(id, input, send, refuse);
        return;
      }
      if (method === "DELETE" && parts.length === 2) {
        if (row === undefined) {
          refuse(404, "item_not_found");
          return;
        }
        this.trash(id);
        send(200, { ok: true });
        return;
      }
      if (method === "POST" && parts[2] === "restore") {
        if (row === undefined) {
          refuse(404, "item_not_found");
          return;
        }
        if (row.state !== "trashed") {
          refuse(400, "invalid_transition");
          return;
        }
        this.restore(id);
        send(200, {
          item: this.wire(row),
          metadata: { item_id: row.id, tags: [], extensions: {} },
        });
        return;
      }
      if (method === "DELETE" && parts[2] === "purge") {
        if (row === undefined) {
          refuse(404, "item_not_found");
          return;
        }
        if (row.state !== "trashed") {
          refuse(400, "invalid_transition");
          return;
        }
        this.purgeById(id);
        send(200, { ok: true });
        return;
      }
      if (method === "POST" && parts[2] === "transition") {
        if (row === undefined) {
          refuse(404, "item_not_found");
          return;
        }
        const state = input["state"] as Row["state"];
        if (row.state === "trashed" && state === "archived") {
          refuse(400, "invalid_transition");
          return;
        }
        this.transition(id, state);
        send(200, {
          item: this.wire(row),
          metadata: { item_id: row.id, tags: [], extensions: {} },
        });
        return;
      }
    }
    refuse(404, "not_found", `no scripted door for ${route}`);
  }

  /** Whether a row's type is the one named or inherits from it. */
  private ofType(row: Row, type: string | null): boolean {
    return (
      type === null ||
      row.type === type ||
      this.types.get(row.type)?.["parent"] === type
    );
  }

  private listItems(query: URLSearchParams, send: Send): void {
    const state = query.get("state") ?? "active";
    const type = query.get("type");
    const matches = this.rows.filter(
      (row) =>
        this.ofType(row, type) &&
        (query.get("source") === null || row.source === query.get("source")) &&
        (state === "any" || row.state === state),
    );
    const limit = Number(query.get("limit") ?? "50");
    const start = Number(query.get("cursor") ?? "0");
    const page = matches.slice(start, start + limit);
    const next = start + limit < matches.length ? String(start + limit) : null;
    send(200, { data: page.map((row) => this.wire(row)), next_cursor: next });
  }

  /**
   * The stream: a comment, the head, then every event after the cursor of
   * the type asked for, each frame carrying the row as it then was, then
   * the marker naming where the stream has reached (which on the real
   * server follows anything written during the replay too); and then it
   * stays open, as the real one does, until the reader closes it.
   */
  private stream(
    query: URLSearchParams,
    lastEventId: string | undefined,
    res: ServerResponse,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Marfa-Contract": String(CONTRACT_VERSION),
    });
    const frame = (event: string, data: unknown, id?: number): void => {
      res.write(
        `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    };
    res.write(": connected\n\n");
    const cursor = lastEventId === undefined ? undefined : Number(lastEventId);
    if (cursor !== undefined && this.tooOld) {
      // Carries the oldest retained id as its own, as the real frame does.
      frame(
        "catchup_too_old",
        {
          type: "catchup_too_old",
          min_retained_id: String(this.head + 1),
          requested: String(cursor),
        },
        this.head + 1,
      );
      res.end();
      return;
    }
    frame("stream_cursor", {
      type: "stream_cursor",
      cursor: String(this.head),
    });
    const type = query.get("type");
    let sent = 0;
    let lastSent: number | undefined;
    for (const event of this.log) {
      if (cursor === undefined || event.id <= cursor) continue;
      if (!this.ofType(event.item, type)) continue;
      if (this.stallAfter !== undefined && sent === this.stallAfter) return;
      if (this.incompleteAfter !== undefined && sent === this.incompleteAfter) {
        frame("stream_incomplete", {
          type: "stream_incomplete",
          reason: "replay_failed",
          cursor: lastSent === undefined ? null : String(lastSent),
        });
        res.end();
        return;
      }
      frame(
        event.event,
        { type: event.event, item: this.wire(event.item) },
        event.id,
      );
      sent += 1;
      lastSent = event.id;
    }
    // The replay is done: the marker names the furthest of the announced
    // head and the rows walked, withheld rows included, as the server's
    // does, and carries no id of its own. Never sent after a stream that
    // ended short.
    if (this.withholdLive) return;
    frame("stream_live", {
      type: "stream_live",
      cursor: this.liveCursorNull
        ? null
        : (this.liveCursor ?? String(this.head)),
    });
  }

  private bulk(input: Record<string, unknown>): unknown {
    const entries = input["items"] as Record<string, unknown>[];
    const results = entries.map((entry, index) => {
      const sourceId = String(entry["source_id"]);
      const source =
        typeof entry["source"] === "string" ? entry["source"] : this.source;
      const refusal = this.entryRefusals.get(sourceId);
      if (refusal !== undefined) {
        return {
          index,
          outcome: "errored",
          error: { code: refusal.code, message: refusal.message },
        };
      }
      const existing = this.rows.find(
        (row) => row.source === source && row.source_id === sourceId,
      );
      if (existing !== undefined && existing.type !== entry["type"]) {
        return {
          index,
          outcome: "errored",
          error: {
            code: "type_mismatch",
            message: `the key names a ${existing.type}`,
          },
        };
      }
      if (existing?.state === "trashed") {
        return {
          index,
          outcome: "skipped",
          id: existing.id,
          reason: "trashed",
        };
      }
      if (existing !== undefined) {
        if (entry["version"] === 0) {
          return {
            index,
            outcome: "errored",
            error: {
              code: "ancestor_unavailable",
              message: "no row was expected",
            },
          };
        }
        this.write(existing, {
          ...existing.properties,
          ...(entry["properties"] as Record<string, unknown>),
        });
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
      this.announce("item.created", row);
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
    send: Send,
    refuse: Refuse,
  ): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      refuse(404, "item_not_found");
      return;
    }
    if (row.state === "trashed") {
      refuse(400, "invalid_transition");
      return;
    }
    const version = input["version"];
    if (typeof version !== "number") {
      refuse(400, "missing_required_field");
      return;
    }
    const properties = (input["properties"] ?? {}) as Record<string, unknown>;
    const occurredAt = input["occurred_at"];
    if (version !== row.version) {
      const ancestor = this.snapshots
        .get(row.id)
        ?.find((snapshot) => snapshot.version === version);
      if (ancestor === undefined) {
        refuse(409, "ancestor_unavailable");
        return;
      }
      // Under `replace` the body is the whole of the caller's properties, so
      // a key the ancestor had and the body lacks is a change: a clear. One
      // the row no longer holds is a clear both writers made, an echo.
      const cleared =
        input["properties_mode"] === "replace"
          ? Object.keys(ancestor.properties).filter(
              (key) =>
                !Object.hasOwn(properties, key) &&
                Object.hasOwn(row.properties, key),
            )
          : [];
      const mine = changedKeys(ancestor.properties, properties, [
        ...Object.keys(properties),
        ...cleared,
      ]);
      const theirs = changedKeys(ancestor.properties, row.properties, [
        ...Object.keys(ancestor.properties),
        ...Object.keys(row.properties),
      ]);
      // The row's own time is compared against the version named as a
      // property is: an echo of the ancestor's value is not a change, and a
      // change collides with one made since.
      const movesTime =
        typeof occurredAt === "string" && occurredAt !== ancestor.occurred_at;
      const timeMovedSince = row.occurred_at !== ancestor.occurred_at;
      if (
        [...mine].some((key) => theirs.has(key)) ||
        (movesTime && timeMovedSince)
      ) {
        refuse(409, "version_conflict");
        return;
      }
      const merged = { ...row.properties };
      for (const key of mine) {
        if (Object.hasOwn(properties, key)) merged[key] = properties[key];
        else Reflect.deleteProperty(merged, key);
      }
      this.write(row, merged, movesTime ? occurredAt : undefined);
    } else {
      this.write(
        row,
        input["properties_mode"] === "replace"
          ? properties
          : { ...row.properties, ...properties },
        typeof occurredAt === "string" ? occurredAt : undefined,
      );
    }
    send(200, {
      item: this.wire(row),
      metadata: { item_id: row.id, tags: [], extensions: {} },
    });
  }
}
