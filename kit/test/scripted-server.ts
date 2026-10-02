import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION } from "@withmarfa/client";

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
  trashed_with?: string;
  trashed_by_cascade?: true;
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

export interface Delivery {
  id: string;
  endpoint_id: string;
  received_at: string;
  method: string;
  query: string;
  headers: [string, string][];
  body: Buffer;
  duplicate_of: string | null;
  handled_at: string | null;
  outcome: string | null;
}

interface Held {
  waiting: boolean;
  record: Record<string, unknown>;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  version: number;
}

export type Event =
  | { id: number; event: string; item: Row }
  | { id: number; event: string; edge: EdgeRow; purged_with?: string };

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
type Refuse = (
  status: number,
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => void;

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
  keySource: string;
  grants: {
    sources?: string[];
    oauth_client_id?: string;
    permissions?: string[];
    is_operator?: boolean;
    type_permissions?: Record<string, string>;
    metadata_permissions?: Record<string, string>;
    edge_permissions?: Record<string, string>;
    extension_permissions?: Record<string, string>;
    profile_permissions?: Record<string, string>;
    enforcement_override?: Record<string, unknown>;
  } = {};
  url = "";
  rows: Row[] = [];
  edges: EdgeRow[] = [];
  readonly edgeTypes = new Map<string, Record<string, unknown>>([
    [
      "attached-to",
      {
        id: "attached-to",
        cardinality: "many-to-many",
        source_type_constraints: ["*"],
        target_type_constraints: ["*"],
        cascade_on_delete: "orphan",
        property_schema: {},
        reverse_name: "has-attachment",
        written_at: "source",
        shipped: true,
      },
    ],
    [
      "in-thread",
      {
        id: "in-thread",
        cardinality: "many-to-one",
        source_type_constraints: ["*"],
        target_type_constraints: ["*"],
        cascade_on_delete: "orphan",
        property_schema: {
          position: { type: "number", description: "Ordering." },
        },
        written_at: "source",
        shipped: true,
      },
    ],
  ]);
  readonly blobs = new Map<string, { bytes: Buffer; mime_type: string }>();
  uploads = 0;
  /** Mirrors the server's cap of 50 edges per type in a lookup. */
  edgePageCap = 50;
  types = new Map<string, Record<string, unknown>>();
  runs: Run[] = [];
  heartbeats = 0;
  registrations = 0;
  requests: Request[] = [];
  readonly log: Event[] = [];
  readonly entryRefusals = new Map<string, Refusal>();
  afterRead: ((request: Request) => void) | undefined;
  beforeAnswer: ((request: Request) => Promise<void> | void) | undefined;
  bodyCap: number | undefined;
  tooOld = false;
  incompleteAfter: number | undefined;
  withholdLive = false;
  stallAfter: number | undefined;
  liveCursorNull = false;
  liveCursor: string | undefined;
  endpoints: { id: string; retired_at: string | null }[] = [
    { id: "endpoint-1", retired_at: null },
  ];
  readonly deliveries: Delivery[] = [];
  holder: { process: string; until: number } | undefined;
  holdMs = 180_000;
  readonly holds: { process: string; released: boolean }[] = [];
  readonly tombstones = new Map<
    string,
    { purged_at: string; settled_at: string }
  >();
  readonly states = new Map<string, Record<string, unknown>>();
  private readonly agreementsBySource = new Map<string, Map<string, Held>>();

  get connectorState(): Record<string, unknown> | undefined {
    return this.states.get(this.keySource);
  }

  get agreements(): Map<string, Held> {
    let held = this.agreementsBySource.get(this.keySource);
    if (held === undefined) {
      held = new Map();
      this.agreementsBySource.set(this.keySource, held);
    }
    return held;
  }
  private readonly refusals = new Map<string, Refusal[]>();
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly http = createServer((req, res) => {
    void this.answer(req, res);
  });
  private sequence = 0;
  private clock = Date.parse("2026-09-25T00:00:00.000Z");
  private wall = this.clock;

  private readonly minted: {
    type_permissions: Record<string, string>;
    edge_permissions: Record<string, string>;
  };

  constructor(
    source: string,
    minted: { types?: readonly string[]; edges?: readonly string[] } = {},
  ) {
    this.source = source;
    this.keySource = source;
    this.minted = {
      type_permissions: Object.fromEntries(
        (minted.types ?? []).map((type) => [type, "write"]),
      ),
      edge_permissions: Object.fromEntries(
        (minted.edges ?? []).map((edge) => [edge, "write"]),
      ),
    };
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

  deliver(
    body: string | Buffer,
    headers: [string, string][] = [],
    duplicateOf: string | null = null,
  ): Delivery {
    const delivery: Delivery = {
      id: `delivery-${String(this.deliveries.length + 1)}`,
      endpoint_id: "endpoint-1",
      received_at: this.now(),
      method: "POST",
      query: "",
      headers,
      body: typeof body === "string" ? Buffer.from(body) : body,
      duplicate_of: duplicateOf,
      handled_at: null,
      outcome: null,
    };
    this.deliveries.push(delivery);
    return delivery;
  }

  private deliveryView(delivery: Delivery): Record<string, unknown> {
    const original =
      delivery.duplicate_of === null
        ? undefined
        : this.deliveries.find(
            (candidate) => candidate.id === delivery.duplicate_of,
          );
    return {
      id: delivery.id,
      endpoint_id: delivery.endpoint_id,
      received_at: delivery.received_at,
      method: delivery.method,
      query: delivery.query,
      headers: delivery.headers,
      size: delivery.body.length,
      sha256: "",
      duplicate_of:
        original === undefined
          ? null
          : { id: original.id, outcome: original.outcome },
      handled_at: delivery.handled_at,
      outcome: delivery.outcome,
    };
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

  touch(sourceId: string, properties: Record<string, unknown>): void {
    const row = this.row(sourceId);
    this.write(row, { ...row.properties, ...properties });
  }

  rewrite(
    sourceId: string,
    properties: Record<string, unknown>,
    occurredAt?: string,
  ): void {
    const row = this.row(sourceId);
    this.write(row, properties, occurredAt);
  }

  edit(id: string, properties: Record<string, unknown>): Row {
    const row = this.byId(id);
    this.write(row, { ...row.properties, ...properties });
    return row;
  }

  transition(id: string, state: Row["state"]): Row {
    const row = this.byId(id);
    this.snapshot(row);
    row.state = state;
    if (state !== "trashed") this.leaveBin(row);
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

  cascadeTrash(id: string, root: string): Row {
    const row = this.byId(id);
    // Announced as it was before the trash, as `trash` is.
    const before = {
      ...row,
      state: "trashed" as const,
      trashed_with: root,
      trashed_by_cascade: true as const,
    };
    row.state = "trashed";
    row.trashed_with = root;
    row.trashed_by_cascade = true;
    row.updated_at = this.now();
    this.announce("item.deleted", before);
    return row;
  }

  restore(id: string): Row {
    const row = this.byId(id);
    this.snapshot(row);
    row.state = "active";
    this.leaveBin(row);
    row.updated_at = this.now();
    this.announce("item.restored", row);
    return row;
  }

  private leaveBin(row: Row): void {
    Reflect.deleteProperty(row, "trashed_with");
    Reflect.deleteProperty(row, "trashed_by_cascade");
  }

  purge(sourceId: string): void {
    const row = this.row(sourceId);
    this.purgeById(row.id);
  }

  linkOf(row: Pick<Row, "type" | "properties">): string | undefined {
    const field = this.types.get(row.type)?.["link_field"];
    if (typeof field !== "string") return undefined;
    const value = row.properties[field];
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  private linkHolder(
    type: string,
    properties: Record<string, unknown>,
    except: string | undefined,
  ): Row | undefined {
    const value = this.linkOf({ type, properties });
    if (value === undefined) return undefined;
    return this.rows.find(
      (row) =>
        row.id !== except && row.type === type && this.linkOf(row) === value,
    );
  }

  private reclaim(row: Row): void {
    const link = this.linkOf(row);
    if (link !== undefined)
      this.tombstones.delete(`${row.type}\u0000link:${link}`);
    if (row.source_id !== undefined) {
      this.tombstones.delete(
        `${row.type}\u0000key:${row.source}:${row.source_id}`,
      );
    }
  }

  purgeById(id: string): void {
    const row = this.byId(id);
    this.rows = this.rows.filter((candidate) => candidate.id !== id);
    const at = this.now();
    const link = this.linkOf(row);
    if (link !== undefined) {
      this.tombstones.set(`${row.type}\u0000link:${link}`, {
        purged_at: at,
        settled_at: at,
      });
    }
    if (row.source_id !== undefined) {
      this.tombstones.set(
        `${row.type}\u0000key:${row.source}:${row.source_id}`,
        { purged_at: at, settled_at: at },
      );
    }
    // A row's agreement goes with it, as the instance's foreign key takes it.
    for (const held of this.agreementsBySource.values()) held.delete(id);
    for (const edge of this.edges.filter(
      (candidate) => candidate.source_id === id || candidate.target_id === id,
    )) {
      this.announceEdge("edge.deleted", edge, id);
    }
    this.edges = this.edges.filter(
      (edge) => edge.source_id !== id && edge.target_id !== id,
    );
    this.announce("item.purged", row);
  }

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

  get head(): number {
    return this.log[this.log.length - 1]?.id ?? 0;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  advance(ms: number): void {
    this.clock += ms;
    this.wall += ms;
  }

  private announce(event: string, row: Row): void {
    this.log.push({ id: this.log.length + 1, event, item: { ...row } });
  }

  private announceEdge(
    event: string,
    edge: EdgeRow,
    purgedWith?: string,
  ): void {
    this.log.push({
      id: this.log.length + 1,
      event,
      edge: { ...edge },
      ...(purgedWith !== undefined && { purged_with: purgedWith }),
    });
  }

  private heldElsewhere(process: unknown): boolean {
    return (
      this.holder !== undefined &&
      this.holder.process !== process &&
      this.holder.until > this.wall
    );
  }

  private heldBy(process: unknown): boolean {
    return (
      this.holder !== undefined &&
      this.holder.process === process &&
      this.holder.until > this.wall
    );
  }

  private refuseHeld(res: ServerResponse): void {
    res.writeHead(409, {
      "Content-Type": "application/json",
      "X-Marfa-Contract": String(CONTRACT_VERSION),
    });
    res.end(
      JSON.stringify({
        error: {
          code: "connector_held",
          status: 409,
          message: "this process does not hold this connector",
          details:
            this.holder !== undefined && this.holder.until > this.wall
              ? { expires_at: new Date(this.holder.until).toISOString() }
              : {},
        },
      }),
    );
  }

  drawEdge(sourceId: string, targetId: string, edgeType: string): EdgeRow {
    const at = this.now();
    this.sequence += 1;
    const edge: EdgeRow = {
      id: `edge-${String(this.sequence)}`,
      source_id: sourceId,
      target_id: targetId,
      edge_type: edgeType,
      properties: {},
      created_at: at,
      updated_at: at,
      version: 1,
    };
    this.edges.push(edge);
    this.announceEdge("edge.created", edge);
    return edge;
  }

  removeEdge(id: string): void {
    const edge = this.edges.find((candidate) => candidate.id === id);
    if (edge === undefined) throw new Error(`no scripted edge ${id}`);
    this.edges = this.edges.filter((candidate) => candidate.id !== id);
    this.announceEdge("edge.deleted", edge);
  }

  targetsOf(sourceId: string, edgeType: string): string[] {
    return this.edges
      .filter(
        (edge) => edge.source_id === sourceId && edge.edge_type === edgeType,
      )
      .map((edge) => edge.target_id);
  }

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
    const raw = Buffer.concat(chunks);
    const text = raw.toString("utf8");
    const body: unknown =
      text === "" || req.url?.startsWith("/blobs") === true
        ? undefined
        : JSON.parse(text);
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
    const refuse: Refuse = (status, code, message = code, details) => {
      send(status, {
        error: { code, message, ...(details !== undefined && { details }) },
      });
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
        ...this.minted,
        extension_permissions: {},
        metadata_permissions: {},
        profile_permissions: {},
        created_at: this.now(),
        expires_at: null,
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
    if (
      method === "POST" &&
      parts[0] === "connectors" &&
      parts[2] === "endpoints"
    ) {
      this.sequence += 1;
      const endpoint = {
        id: `endpoint-${String(this.endpoints.length + 1)}`,
        retired_at: null,
      };
      this.endpoints.push(endpoint);
      send(201, {
        ...endpoint,
        connector_id: parts[1],
        label: input["label"] ?? null,
        duplicate_header:
          typeof input["duplicate_header"] === "string"
            ? input["duplicate_header"].toLowerCase()
            : null,
        path: `/inbound/in_${String(this.sequence).padStart(24, "0")}`,
        created_at: this.now(),
      });
      return;
    }
    if (
      method === "DELETE" &&
      parts[0] === "connectors" &&
      parts[2] === "endpoints"
    ) {
      const endpoint = this.endpoints.find(
        (candidate) => candidate.id === parts[3],
      );
      if (endpoint === undefined) {
        refuse(404, "endpoint_not_found");
        return;
      }
      endpoint.retired_at ??= this.now();
      send(200, {
        ...endpoint,
        connector_id: parts[1],
        label: null,
        duplicate_header: null,
        path: "/inbound/****abcd",
        created_at: this.now(),
      });
      return;
    }
    if (
      method === "GET" &&
      parts[0] === "connectors" &&
      parts[2] === "endpoints"
    ) {
      send(200, {
        data: this.endpoints.map((endpoint) => ({
          ...endpoint,
          connector_id: parts[1],
          label: null,
          duplicate_header: null,
          path: "/inbound/****abcd",
          created_at: this.now(),
        })),
        next_cursor: null,
      });
      return;
    }
    if (
      method === "GET" &&
      parts[0] === "connectors" &&
      parts[2] === "deliveries" &&
      parts[4] === "body"
    ) {
      const delivery = this.deliveries.find(
        (candidate) => candidate.id === parts[3],
      );
      if (delivery === undefined) {
        refuse(404, "delivery_not_found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "X-Marfa-Contract": String(CONTRACT_VERSION),
      });
      res.end(delivery.body);
      return;
    }
    if (
      method === "GET" &&
      parts[0] === "connectors" &&
      parts[2] === "deliveries"
    ) {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const waiting = this.deliveries.filter(
        (delivery) => delivery.handled_at === null,
      );
      const page = waiting.slice(from, from + limit);
      send(200, {
        data: page.map((delivery) => this.deliveryView(delivery)),
        next_cursor:
          from + limit < waiting.length ? String(from + limit) : null,
      });
      return;
    }
    if (
      method === "POST" &&
      parts[0] === "connectors" &&
      parts[2] === "deliveries" &&
      parts[3] === "handled"
    ) {
      const ids = input["ids"] as string[];
      if (ids.length === 0 || ids.length > 200) {
        refuse(400, "validation_error");
        return;
      }
      const marked = ids.map((id) =>
        this.deliveries.find((delivery) => delivery.id === id),
      );
      if (marked.some((delivery) => delivery === undefined)) {
        refuse(404, "delivery_not_found");
        return;
      }
      for (const delivery of marked) {
        if (delivery?.handled_at !== null) continue;
        delivery.handled_at = this.now();
        delivery.outcome = String(input["outcome"]);
      }
      send(200, {
        data: marked.map((delivery) =>
          delivery === undefined ? null : this.deliveryView(delivery),
        ),
      });
      return;
    }
    if (parts[0] === "connectors" && parts[2] === "hold") {
      const process =
        method === "DELETE"
          ? (url.searchParams.get("process") ?? "")
          : String(input["process"]);
      const now = this.wall;
      if (method === "DELETE") {
        if (this.holder?.process === process) this.holder = undefined;
        this.holds.push({ process, released: true });
        send(200, { ok: true });
        return;
      }
      if (this.heldElsewhere(process)) {
        this.refuseHeld(res);
        return;
      }
      const renewed =
        this.holder?.process === process && this.holder.until > now;
      this.holder = { process, until: now + this.holdMs };
      this.holds.push({ process, released: false });
      res.setHeader("Date", new Date(now).toUTCString());
      send(200, {
        expires_at: new Date(this.holder.until).toISOString(),
        ttl_ms: this.holdMs,
        renewed,
      });
      return;
    }
    if (
      parts[0] === "connectors" &&
      parts[2] === "state" &&
      (method === "GET" || method === "PUT")
    ) {
      if (method === "PUT") {
        const state = input["state"];
        if (typeof state !== "object" || state === null) {
          refuse(400, "validation_error");
          return;
        }
        if (!this.heldBy(input["process"])) {
          this.refuseHeld(res);
          return;
        }
        if (Buffer.byteLength(JSON.stringify(state)) > 512 * 1024) {
          refuse(400, "validation_error", "a state is at most 512 KiB");
          return;
        }
        this.states.set(
          this.keySource,
          structuredClone(state) as Record<string, unknown>,
        );
      }
      send(200, {
        state: this.connectorState ?? {},
        updated_at: this.connectorState === undefined ? null : this.now(),
      });
      return;
    }
    if (
      method === "POST" &&
      parts[0] === "connectors" &&
      parts[2] === "agreements" &&
      parts[3] === "find"
    ) {
      const ids = input["item_ids"] as string[];
      if (ids.length > 500) {
        refuse(400, "validation_error");
        return;
      }
      send(200, {
        data: ids.flatMap((id) => {
          const held = this.agreements.get(id);
          return held === undefined
            ? []
            : [{ item_id: id, ...structuredClone(held) }];
        }),
      });
      return;
    }
    if (
      method === "POST" &&
      parts[0] === "connectors" &&
      parts[2] === "agreements"
    ) {
      const set = (input["set"] ?? []) as {
        item_id: string;
        waiting: boolean;
        record: Record<string, unknown>;
      }[];
      const clear = (input["clear"] ?? []) as string[];
      if (set.length > 500 || clear.length > 500) {
        refuse(400, "validation_error");
        return;
      }
      if (!this.heldBy(input["process"])) {
        this.refuseHeld(res);
        return;
      }
      if (
        set.some(
          (entry) =>
            Buffer.byteLength(JSON.stringify(entry.record)) > 16 * 1024,
        )
      ) {
        refuse(400, "validation_error", "a record is at most 16 KiB");
        return;
      }
      const skipped: string[] = [];
      for (const entry of set) {
        if (!this.rows.some((row) => row.id === entry.item_id)) {
          skipped.push(entry.item_id);
          continue;
        }
        this.agreements.set(entry.item_id, {
          waiting: entry.waiting,
          record: structuredClone(entry.record),
          updated_at: this.now(),
        });
      }
      for (const id of clear) this.agreements.delete(id);
      send(200, {
        written: set.length - skipped.length,
        cleared: clear.length,
        skipped,
      });
      return;
    }
    if (
      method === "GET" &&
      parts[0] === "connectors" &&
      parts[2] === "agreements"
    ) {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const waiting = [...this.agreements]
        .filter(([, held]) => held.waiting)
        .map(([id, held]) => ({ item_id: id, ...structuredClone(held) }));
      send(200, {
        data: waiting.slice(from, from + limit),
        next_cursor:
          from + limit < waiting.length ? String(from + limit) : null,
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
      this.afterRead?.(request);
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
    if (method === "POST" && url.pathname === "/blobs") {
      const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      const mime = req.headers["content-type"] ?? "application/octet-stream";
      this.blobs.set(hash, { bytes: raw, mime_type: mime });
      this.uploads += 1;
      send(201, { hash, mime_type: mime, size_bytes: raw.length });
      return;
    }
    if (method === "GET" && url.pathname === "/edge-types") {
      send(200, { data: [...this.edgeTypes.values()], next_cursor: null });
      return;
    }
    if (method === "POST" && url.pathname === "/edge-types") {
      const id = String(input["id"]);
      if (this.edgeTypes.has(id)) {
        refuse(409, "conflict", `the edge type ${id} exists`);
        return;
      }
      const stored = {
        source_type_constraints: [],
        target_type_constraints: [],
        cascade_on_delete: "orphan",
        property_schema: {},
        written_at: "source",
        ...input,
        shipped: false,
      };
      this.edgeTypes.set(id, stored);
      send(201, { edge_type: stored });
      return;
    }
    if (method === "POST" && url.pathname === "/edges/bulk") {
      const entries = (input["edges"] ?? []) as Record<string, string>[];
      const results = entries.map((entry, index) =>
        this.upsertEdge(entry, index),
      );
      send(200, {
        counts: {
          created: results.filter((r) => r.outcome === "created").length,
          updated: results.filter((r) => r.outcome === "updated").length,
          skipped: 0,
          errored: results.filter((r) => r.outcome === "errored").length,
        },
        results,
      });
      return;
    }
    if (method === "DELETE" && parts[0] === "edges" && parts[1] !== undefined) {
      const edge = this.edges.find((candidate) => candidate.id === parts[1]);
      if (edge === undefined) {
        refuse(404, "edge_not_found");
        return;
      }
      this.removeEdge(edge.id);
      send(200, { ok: true });
      return;
    }
    if (
      method === "GET" &&
      parts[0] === "items" &&
      parts[2] === "edges" &&
      parts[1] !== undefined
    ) {
      const type = url.searchParams.get("edge_type");
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const all = this.edges.filter(
        (edge) =>
          edge.source_id === parts[1] &&
          (type === null || edge.edge_type === type),
      );
      send(200, {
        data: all.slice(from, from + limit),
        next_cursor: from + limit < all.length ? String(from + limit) : null,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/items/lookup") {
      send(200, this.lookup(input));
      this.afterRead?.(request);
      return;
    }
    if (method === "POST" && url.pathname === "/items/tombstones") {
      const type = String(input["type"]);
      const until = String(input["settled_at"]);
      const keys = this.tombstoneKeys(type, input);
      for (const key of keys) {
        const held = this.tombstones.get(key);
        if (held !== undefined && until > held.settled_at) {
          held.settled_at = until;
        }
      }
      send(200, { tombstones: this.tombstonesOf(keys) });
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
    const filter = /^edge\[([^\]]+)\] eq "([^"]+)"$/.exec(
      query.get("filter") ?? "",
    );
    if (query.get("filter") !== null && filter === null) {
      send(400, { error: { code: "validation_error" } });
      return;
    }
    const matches = this.rows.filter(
      (row) =>
        this.ofType(row, type) &&
        (query.get("source") === null || row.source === query.get("source")) &&
        (state === "any" || row.state === state) &&
        (filter === null ||
          this.edges.some(
            (edge) =>
              edge.source_id === row.id &&
              edge.edge_type === filter[1] &&
              edge.target_id === filter[2],
          )),
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
    // Up to ten types, comma-separated, as the real stream takes them.
    const types = query.get("type")?.split(",") ?? [null];
    let sent = 0;
    let lastSent: number | undefined;
    const edges = query.get("edges") !== "none";
    for (const event of this.log) {
      if (cursor === undefined || event.id <= cursor) continue;
      if ("edge" in event) {
        if (!edges) continue;
      } else if (!types.some((type) => this.ofType(event.item, type))) {
        continue;
      }
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
        "edge" in event
          ? {
              type: event.event,
              edge: event.edge,
              ...(event.purged_with !== undefined && {
                purged_with: event.purged_with,
              }),
            }
          : { type: event.event, item: this.wire(event.item) },
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

  private tombstoneKeys(
    type: string,
    input: Record<string, unknown>,
  ): string[] {
    const links = (input["links"] ?? []) as string[];
    const sourceIds = (input["source_ids"] ?? []) as string[];
    return [
      ...links.map((link) => `${type}\u0000link:${link}`),
      ...sourceIds.map(
        (sourceId) => `${type}\u0000key:${String(input["source"])}:${sourceId}`,
      ),
    ];
  }

  private tombstonesOf(keys: readonly string[]): Record<string, unknown>[] {
    return keys.flatMap((key) => {
      const held = this.tombstones.get(key);
      const name = key
        .slice(key.indexOf("\u0000") + 1)
        .replace(/^(link|key:[^:]*):/, "");
      return held === undefined ? [] : [{ key: name, ...held }];
    });
  }

  private upsertEdge(
    entry: Record<string, string>,
    index: number,
  ): {
    index: number;
    outcome: "created" | "updated" | "errored";
    id?: string;
    error?: { code: string; message: string };
  } {
    const source = this.rows.find((row) => row.id === entry["source_id"]);
    const target = this.rows.find((row) => row.id === entry["target_id"]);
    const kind = this.edgeTypes.get(String(entry["edge_type"]));
    if (source === undefined || target === undefined || kind === undefined) {
      return {
        index,
        outcome: "errored",
        error: { code: "item_not_found", message: "an end is missing" },
      };
    }
    const allowed = (constraints: unknown, type: string) =>
      !Array.isArray(constraints) ||
      constraints.length === 0 ||
      constraints.includes("*") ||
      constraints.includes(type);
    if (
      !allowed(kind["source_type_constraints"], source.type) ||
      !allowed(kind["target_type_constraints"], target.type)
    ) {
      return {
        index,
        outcome: "errored",
        error: {
          code: "edge_constraint_violation",
          message: "an end's type is outside the edge type's constraints",
        },
      };
    }
    if (source.state === "trashed" || target.state === "trashed") {
      return {
        index,
        outcome: "errored",
        error: { code: "item_not_found", message: "an end is in the bin" },
      };
    }
    const held = this.edges.find(
      (edge) =>
        edge.source_id === source.id &&
        edge.target_id === target.id &&
        edge.edge_type === entry["edge_type"],
    );
    if (held !== undefined) return { index, outcome: "updated", id: held.id };
    // As the server counts them: one-to-many or one-to-one caps a
    // target at one inbound edge, many-to-one or one-to-one a source.
    const cardinality = String(kind["cardinality"]);
    const ofType = this.edges.filter(
      (edge) => edge.edge_type === entry["edge_type"],
    );
    if (
      (["one-to-many", "one-to-one"].includes(cardinality) &&
        ofType.some((edge) => edge.target_id === target.id)) ||
      (["many-to-one", "one-to-one"].includes(cardinality) &&
        ofType.some((edge) => edge.source_id === source.id))
    ) {
      return {
        index,
        outcome: "errored",
        error: {
          code: "edge_constraint_violation",
          message: `the edge type is ${cardinality}`,
        },
      };
    }
    const made = this.drawEdge(
      source.id,
      target.id,
      String(entry["edge_type"]),
    );
    return { index, outcome: "created", id: made.id };
  }

  private hydrated(id: string): Record<string, unknown> {
    const byType = new Map<string, EdgeRow[]>();
    for (const edge of this.edges.filter((edge) => edge.source_id === id)) {
      byType.set(edge.edge_type, [...(byType.get(edge.edge_type) ?? []), edge]);
    }
    return Object.fromEntries(
      [...byType].map(([type, edges]) => [
        type,
        {
          data: edges.slice(0, this.edgePageCap),
          next_cursor:
            edges.length > this.edgePageCap ? String(this.edgePageCap) : null,
        },
      ]),
    );
  }

  private lookup(input: Record<string, unknown>): unknown {
    const type = String(input["type"]);
    const links = input["links"] as string[] | undefined;
    const sourceIds = input["source_ids"] as string[] | undefined;
    const ids = input["ids"] as string[] | undefined;
    const rows =
      links !== undefined
        ? links.flatMap((link) =>
            this.rows.filter(
              (row) => row.type === type && this.linkOf(row) === link,
            ),
          )
        : sourceIds !== undefined
          ? sourceIds.flatMap((sourceId) =>
              this.rows.filter(
                (row) =>
                  row.source === input["source"] && row.source_id === sourceId,
              ),
            )
          : (ids ?? []).flatMap((id) =>
              this.rows.filter((row) => row.id === id),
            );
    const include = (input["include"] ?? []) as string[];
    return {
      data: rows.map((row) =>
        include.includes("edges")
          ? { ...this.wire(row), edges: this.hydrated(row.id) }
          : this.wire(row),
      ),
      tombstones:
        ids === undefined
          ? this.tombstonesOf(this.tombstoneKeys(type, input))
          : [],
    };
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
      const holder = this.linkHolder(
        String(entry["type"]),
        (entry["properties"] ?? {}) as Record<string, unknown>,
        undefined,
      );
      if (holder !== undefined) {
        return {
          index,
          outcome: "errored",
          error: {
            code: "link_taken",
            message: "another item holds the link",
            details: { existing_id: holder.id },
          },
        };
      }
      const row = this.newRow(
        String(entry["type"]),
        source,
        sourceId,
        (entry["properties"] ?? {}) as Record<string, unknown>,
        entry["occurred_at"] as string | undefined,
        entry["tier"] === "library" ? "library" : "feed",
      );
      this.reclaim(row);
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
    // The door reads the row as every read does, the bin left out.
    if (row === undefined || row.state === "trashed") {
      refuse(404, "item_not_found");
      return;
    }
    const version = input["version"];
    if (typeof version !== "number") {
      refuse(400, "missing_required_field");
      return;
    }
    const properties = (input["properties"] ?? {}) as Record<string, unknown>;
    const occurredAt = input["occurred_at"];
    const holder = this.linkHolder(
      row.type,
      input["properties_mode"] === "replace"
        ? properties
        : { ...row.properties, ...properties },
      row.id,
    );
    if (holder !== undefined) {
      refuse(409, "link_taken", "another item holds the link", {
        existing_id: holder.id,
      });
      return;
    }
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
