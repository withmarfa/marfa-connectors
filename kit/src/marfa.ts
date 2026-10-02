import {
  pages,
  type components,
  type MarfaClient,
  type operations,
} from "@withmarfa/client";
import type { ConnectionDefinition, Item, TypeDefinition } from "./define.js";

export type BulkResult = components["schemas"]["BulkResultEntry"];
export type InboundDeliveryRow = Omit<
  components["schemas"]["InboundDelivery"],
  "headers"
> & { headers: string[][] };
export type InboundEndpoint = components["schemas"]["InboundEndpoint"];
export type InboundOutcome = NonNullable<InboundDeliveryRow["outcome"]>;
type Version = components["schemas"]["Version"];
export type Key = components["schemas"]["ApiKey"];
export type Tombstone = components["schemas"]["Tombstone"];
export type Edge = components["schemas"]["Edge"];
export type EdgeType = components["schemas"]["EdgeType"];

/** Edges one bulk request carries, well inside the door's 5000. */
const edgePage = 1000;

/** The server's cap on the keys one lookup names. */
const lookupCap = 500;
export type RunReport = NonNullable<
  operations["reportConnectorRun"]["requestBody"]
>["content"]["application/json"];

/** `status` is absent on one entry of a bulk answer, which the page's own
 *  status does not describe. */
export class Refusal extends Error {
  override name = "Refusal";

  constructor(
    readonly status: number | undefined,
    readonly code: string,
    readonly detail: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(
      `${status === undefined ? "" : `${String(status)} `}${code}: ${detail}`,
    );
  }
}

function refusal(response: Response, error: unknown): Refusal {
  const envelope = (
    error as
      | { error?: { code?: unknown; message?: unknown; details?: unknown } }
      | undefined
  )?.error;
  const code = typeof envelope?.code === "string" ? envelope.code : "unknown";
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : response.statusText;
  const details =
    typeof envelope?.details === "object" && envelope.details !== null
      ? (envelope.details as Record<string, unknown>)
      : {};
  return new Refusal(response.status, code, message, details);
}

export interface NewRow {
  source_id: string;
  properties: Record<string, unknown>;
  occurred_at?: string;
}

export class Marfa {
  constructor(private readonly client: MarfaClient) {}

  async register(
    name: string,
    description: string | undefined,
  ): Promise<string> {
    const { data, error, response } = await this.client.POST("/connectors", {
      body: { name, ...(description !== undefined && { description }) },
    });
    if (data === undefined) throw refusal(response, error);
    return data.id;
  }

  async heartbeat(id: string, signal: AbortSignal): Promise<void> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/heartbeat",
      { params: { path: { id } }, signal },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async report(id: string, run: RunReport): Promise<void> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/runs",
      {
        params: { path: { id } },
        body: run,
      },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async currentKey(): Promise<Key | undefined> {
    const { data, error, response } = await this.client.GET("/keys/current");
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async type(id: string): Promise<Record<string, unknown> | undefined> {
    const { data, error, response } = await this.client.GET("/types/{id}", {
      params: { path: { id } },
    });
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async registerType(type: TypeDefinition): Promise<void> {
    const { data, error, response } = await this.client.POST("/types", {
      body: type,
    });
    if (data === undefined) throw refusal(response, error);
  }

  /** Every edge type the instance holds, which the door answers in one page. */
  async edgeTypes(): Promise<EdgeType[]> {
    const { data, error, response } = await this.client.GET("/edge-types");
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  async registerEdgeType(type: ConnectionDefinition): Promise<void> {
    const { data, error, response } = await this.client.POST("/edge-types", {
      body: type,
    });
    if (data === undefined) throw refusal(response, error);
  }

  async edgesFrom(
    type: string,
    ids: readonly string[],
    edgeTypes: ReadonlySet<string>,
  ): Promise<Map<string, { item: Item; edges: Edge[] }>> {
    const found = new Map<string, { item: Item; edges: Edge[] }>();
    for (let at = 0; at < ids.length; at += lookupCap) {
      const { data, error, response } = await this.client.POST(
        "/items/lookup",
        {
          body: {
            type,
            ids: ids.slice(at, at + lookupCap),
            include: ["edges"],
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      for (const item of data.data) {
        const edges: Edge[] = [];
        for (const [edgeType, page] of Object.entries(item.edges ?? {})) {
          if (!edgeTypes.has(edgeType)) continue;
          edges.push(...page.data);
          if (page.next_cursor !== null) {
            edges.push(
              ...(await this.moreEdges(item.id, edgeType, page.next_cursor)),
            );
          }
        }
        const row: Item = { ...item };
        Reflect.deleteProperty(row, "edges");
        found.set(item.id, { item: row, edges });
      }
    }
    return found;
  }

  private async moreEdges(
    id: string,
    edgeType: string,
    from: string,
  ): Promise<Edge[]> {
    const edges: Edge[] = [];
    let cursor: string | null = from;
    while (cursor !== null) {
      const answer: {
        data?: { data: Edge[]; next_cursor: string | null };
        error?: unknown;
        response: Response;
      } = await this.client.GET("/items/{id}/edges", {
        params: {
          path: { id },
          query: { edge_type: edgeType, limit: 200, cursor },
        },
      });
      if (answer.data === undefined) {
        throw refusal(answer.response, answer.error);
      }
      edges.push(...answer.data.data);
      cursor = answer.data.next_cursor;
    }
    return edges;
  }

  async connect(
    edges: readonly {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
  ): Promise<BulkResult[]> {
    const results: BulkResult[] = [];
    for (let at = 0; at < edges.length; at += edgePage) {
      const page = edges.slice(at, at + edgePage);
      const { data, error, response } = await this.client.POST("/edges/bulk", {
        body: { edges: [...page], atomic: false },
      });
      if (data === undefined) throw refusal(response, error);
      results.push(
        ...data.results.map((result) => ({
          ...result,
          index: result.index + at,
        })),
      );
    }
    return results;
  }

  /** Makes a webhook endpoint, answering its path in full this once. */
  async createEndpoint(
    id: string,
    options: { label?: string; duplicateHeader?: string },
  ): Promise<InboundEndpoint> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/endpoints",
      {
        params: { path: { id } },
        body: {
          ...(options.label !== undefined && { label: options.label }),
          ...(options.duplicateHeader !== undefined && {
            duplicate_header: options.duplicateHeader,
          }),
        },
      },
    );
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  async retireEndpoint(id: string, endpointId: string): Promise<void> {
    const { data, error, response } = await this.client.DELETE(
      "/connectors/{id}/endpoints/{endpoint_id}",
      { params: { path: { id, endpoint_id: endpointId } } },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async upload(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ hash: string; mime_type: string }> {
    const { data, error, response } = await this.client.POST("/blobs", {
      body: bytes,
      bodySerializer: (body) => body,
      headers: { "Content-Type": mimeType },
    });
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** Removes an edge; one already gone is as good. */
  async disconnect(id: string): Promise<void> {
    const { error, response } = await this.client.DELETE("/edges/{id}", {
      params: { path: { id } },
    });
    if (response.ok || response.status === 404) return;
    throw refusal(response, error);
  }

  /** `/items?type=` matches subtypes, so callers filter by exact type. */
  async ownRows(type: string): Promise<Item[]> {
    const rows: Item[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET("/items", {
        params: {
          query: {
            type,
            state: "any",
            limit: 200,
            ...(cursor !== undefined && { cursor }),
          },
        },
      });
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    // A page asked for without `include` carries bare items.
    for await (const row of walk) rows.push("item" in row ? row.item : row);
    return rows;
  }

  async connectedTo(
    type: string,
    edgeType: string,
    targetId: string,
  ): Promise<Item[]> {
    const rows: Item[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET("/items", {
        params: {
          query: {
            type,
            filter: `edge[${edgeType}] eq ${JSON.stringify(targetId)}`,
            limit: 200,
            ...(cursor !== undefined && { cursor }),
          },
        },
      });
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    for await (const row of walk) rows.push("item" in row ? row.item : row);
    return rows;
  }

  async lookup(
    type: string,
    by:
      | { links: readonly string[] }
      | { source: string; source_ids: readonly string[] }
      | { ids: readonly string[] },
  ): Promise<{ data: Item[]; tombstones: Tombstone[] }> {
    const keys =
      "links" in by ? by.links : "ids" in by ? by.ids : by.source_ids;
    const found: { data: Item[]; tombstones: Tombstone[] } = {
      data: [],
      tombstones: [],
    };
    for (let at = 0; at < keys.length; at += lookupCap) {
      const page = keys.slice(at, at + lookupCap);
      const { data, error, response } = await this.client.POST(
        "/items/lookup",
        {
          body: {
            type,
            ...("links" in by
              ? { links: page }
              : "ids" in by
                ? { ids: page }
                : { source: by.source, source_ids: page }),
          },
        },
      );
      if (data === undefined) throw refusal(response, error);
      found.data.push(...data.data);
      found.tombstones.push(...data.tombstones);
    }
    return found;
  }

  async settleTombstones(
    type: string,
    by:
      | { links: readonly string[] }
      | { source: string; source_ids: readonly string[] },
    at: string,
  ): Promise<void> {
    const { data, error, response } = await this.client.POST(
      "/items/tombstones",
      {
        body: {
          type,
          settled_at: at,
          ...("links" in by
            ? { links: [...by.links] }
            : { source: by.source, source_ids: [...by.source_ids] }),
        },
      },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async transition(id: string, state: "active" | "archived"): Promise<Item> {
    const { data, error, response } = await this.client.POST(
      "/items/{id}/transition",
      { params: { path: { id } }, body: { state } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  /** One row as it stands, or `undefined` once purged or in the bin,
   *  which no read but its restore reaches. */
  async item(id: string): Promise<Item | undefined> {
    const { data, error, response } = await this.client.GET("/items/{id}", {
      params: { path: { id } },
    });
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  async versions(id: string): Promise<Version[]> {
    const { data, error, response } = await this.client.GET(
      "/items/{id}/versions",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  async merge(
    id: string,
    version: number,
    properties: Record<string, unknown>,
  ): Promise<Item> {
    const { data, error, response } = await this.client.PATCH("/items/{id}", {
      params: { path: { id } },
      body: { version, properties },
    });
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  /** The log from a cursor, as frames: head, retained events plus
   *  anything written meanwhile, a marker, then new events. */
  async events(
    types: readonly string[],
    cursor: string | undefined,
    signal: AbortSignal,
    edges: boolean,
  ): Promise<ReadableStream<Uint8Array>> {
    const { data, error, response } = await this.client.GET("/events", {
      params: {
        query: { type: types.join(","), edges: edges ? "all" : "none" },
        ...(cursor !== undefined && { header: { "Last-Event-ID": cursor } }),
      },
      parseAs: "stream",
      signal,
    });
    if (data === undefined || data === null) throw refusal(response, error);
    return data;
  }

  /** Creates rows through the bulk door, each claiming at version 0 that
   *  no row holds its natural key, and each answered on its own. */
  async create(
    type: string,
    source: string,
    rows: readonly NewRow[],
  ): Promise<BulkResult[]> {
    const { data, error, response } = await this.client.POST("/items/bulk", {
      body: {
        items: rows.map((row) => ({
          type,
          source,
          source_id: row.source_id,
          properties: row.properties,
          ...(row.occurred_at !== undefined && {
            occurred_at: row.occurred_at,
          }),
          tier: "feed" as const,
          version: 0,
        })),
        atomic: false,
      },
    });
    if (data === undefined) throw refusal(response, error);
    return data.results;
  }

  /** Replaces a row's properties at the version read; on a moved version
   *  the server merges over what landed, shown by a jump past one. */
  async update(
    id: string,
    version: number,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
    sourceId?: string,
  ): Promise<Item> {
    const { data, error, response } = await this.client.PATCH("/items/{id}", {
      params: { path: { id } },
      body: {
        version,
        properties,
        properties_mode: "replace",
        ...(occurredAt !== undefined && { occurred_at: occurredAt }),
        ...(sourceId !== undefined && { source_id: sourceId }),
      },
    });
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  async endpoints(id: string): Promise<InboundEndpoint[]> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/endpoints",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  async pendingDeliveries(
    id: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<InboundDeliveryRow[]> {
    const rows: InboundDeliveryRow[] = [];
    let cursor: string | undefined;
    do {
      const { data, error, response } = await this.client.GET(
        "/connectors/{id}/deliveries",
        {
          params: {
            path: { id },
            query: {
              state: "pending",
              limit: Math.min(200, limit - rows.length),
              ...(cursor !== undefined && { cursor }),
            },
          },
          signal,
        },
      );
      if (data === undefined) throw refusal(response, error);
      rows.push(...data.data);
      cursor = data.next_cursor ?? undefined;
    } while (cursor !== undefined && rows.length < limit);
    return rows;
  }

  async deliveryBody(
    id: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/deliveries/{delivery_id}/body",
      {
        params: { path: { id, delivery_id: deliveryId } },
        parseAs: "arrayBuffer",
        signal,
      },
    );
    if (data === undefined) throw refusal(response, error);
    return new Uint8Array(data);
  }

  /** The first mark stands. */
  async handled(
    id: string,
    ids: readonly string[],
    outcome: InboundOutcome,
  ): Promise<void> {
    for (let at = 0; at < ids.length; at += 200) {
      const { data, error, response } = await this.client.POST(
        "/connectors/{id}/deliveries/handled",
        {
          params: { path: { id } },
          body: { ids: ids.slice(at, at + 200), outcome },
        },
      );
      if (data === undefined) throw refusal(response, error);
    }
  }

  async hold(
    id: string,
    process: string,
    signal: AbortSignal,
  ): Promise<
    | {
        elsewhere: false;
        until: string;
        renewed: boolean;
        /** How long the instance holds it, by its own clock, where it says. */
        window: number | undefined;
      }
    | { elsewhere: true; until: string }
  > {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/hold",
      { params: { path: { id } }, body: { process }, signal },
    );
    if (data !== undefined) {
      const window =
        Date.parse(data.expires_at) -
        Date.parse(response.headers.get("date") ?? "");
      return {
        elsewhere: false,
        until: data.expires_at,
        renewed: data.renewed,
        window: Number.isFinite(window) && window > 0 ? window : undefined,
      };
    }
    const refused = refusal(response, error);
    const until = refused.details["expires_at"];
    if (refused.code === "connector_held" && typeof until === "string") {
      return { elsewhere: true, until };
    }
    throw refused;
  }

  async release(id: string, process: string): Promise<void> {
    const { data, error, response } = await this.client.DELETE(
      "/connectors/{id}/hold",
      { params: { path: { id }, query: { process } } },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async connectorState(id: string): Promise<unknown> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/state",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.state;
  }

  async putConnectorState(
    id: string,
    process: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const { data, error, response } = await this.client.PUT(
      "/connectors/{id}/state",
      { params: { path: { id } }, body: { process, state } },
    );
    if (data === undefined) throw refusal(response, error);
  }

  async findAgreements(
    id: string,
    itemIds: readonly string[],
  ): Promise<{ item_id: string; record: unknown }[]> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/agreements/find",
      { params: { path: { id } }, body: { item_ids: [...itemIds] } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  async waitingAgreements(id: string, signal: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET(
        "/connectors/{id}/agreements",
        {
          params: {
            path: { id },
            query: {
              waiting: "true",
              limit: 200,
              ...(cursor !== undefined && { cursor }),
            },
          },
          signal,
        },
      );
      if (data === undefined) throw refusal(response, error);
      return data;
    });
    for await (const row of walk) ids.push(row.item_id);
    return ids;
  }

  async writeAgreements(
    id: string,
    process: string,
    set: readonly { item_id: string; waiting: boolean; record: object }[],
    clear: readonly string[],
  ): Promise<void> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/agreements",
      {
        params: { path: { id } },
        body: {
          process,
          set: set.map((entry) => ({
            ...entry,
            record: entry.record as Record<string, unknown>,
          })),
          clear: [...clear],
        },
      },
    );
    if (data === undefined) throw refusal(response, error);
  }
}
