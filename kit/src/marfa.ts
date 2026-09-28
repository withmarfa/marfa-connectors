import {
  pages,
  type components,
  type MarfaClient,
  type operations,
} from "@withmarfa/client";
import type { ConnectionDefinition, Item, TypeDefinition } from "./define.js";

export type BulkResult = components["schemas"]["BulkResultEntry"];
/** A delivery as a listing answers it: the client reads each `[name, value]`
 *  header pair as a plain array. */
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

/** Keys one lookup names at most. */
const lookupCap = 500;
export type RunReport = NonNullable<
  operations["reportConnectorRun"]["requestBody"]
>["content"]["application/json"];

/**
 * The server said no, in its own envelope. `status` is absent on one entry
 * of a bulk answer, which the page's own status does not describe.
 */
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

/** The doors a connector uses, with every refusal thrown as a {@link Refusal}. */
export class Marfa {
  constructor(private readonly client: MarfaClient) {}

  /** Registers the key, and answers its registration and its own source. */
  async register(
    name: string,
    description: string | undefined,
  ): Promise<{ id: string; source: string }> {
    const { data, error, response } = await this.client.POST("/connectors", {
      body: { name, ...(description !== undefined && { description }) },
    });
    if (data === undefined) throw refusal(response, error);
    return { id: data.id, source: data.source };
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

  /**
   * The key this client bears, as the server holds it, or `undefined` from
   * a server with no door for a key to read itself.
   */
  async currentKey(): Promise<Key | undefined> {
    const { data, error, response } = await this.client.GET("/keys/current");
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return data;
  }

  /** The type as the server answers it, or `undefined` when it has none. */
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

  /** Each row, in any state, with its outbound edges of the named types, every page of them. */
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

  /** Upserts edges on their ends and type, each answered on its own. */
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

  /** Stores bytes by their content, answering their `sha256:` hash; bytes already held answer theirs. */
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

  /** Every row whose type is this one or inherits from it, in every state. */
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

  /**
   * Rows in any state by link, natural key or id, with the tombstones the
   * type keeps for the keys named, asked in pages the door's cap allows.
   */
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

  /** Moves the named tombstones' `settled_at` to `at`, where that is later. */
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

  /** One row as it now stands, or `undefined` once it is purged or in the bin, which no read but its restore reaches. */
  async item(id: string): Promise<Item | undefined> {
    const { data, error, response } = await this.client.GET("/items/{id}", {
      params: { path: { id } },
    });
    if (response.status === 404) return undefined;
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  /** The row's snapshots, oldest first: what it held before each update. */
  async versions(id: string): Promise<Version[]> {
    const { data, error, response } = await this.client.GET(
      "/items/{id}/versions",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  /**
   * Lays properties over a row's at the version it was read at, leaving the
   * rest as they are: what the link is written with, since the row is the
   * vendor's to fill and the link is one property of it.
   */
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

  /**
   * The log from a cursor, as frames: the first names the head, then
   * every retained event after the cursor and whatever was written while
   * they were replayed, then the marker naming where the stream has
   * reached, then whatever is written after. Narrowed to the types and their
   * subtrees, without edges, and ended by the signal.
   */
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

  /**
   * Creates rows through the bulk door, each claiming at version 0 that no
   * row holds its natural key, and each answered on its own.
   */
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

  /**
   * Replaces a row's properties on the version it was read at. On a version
   * another write has since moved, the server merges this write's changes,
   * a cleared field included, over what landed since, and the version it
   * answers, more than one step on, shows that it did.
   */
  async update(
    id: string,
    version: number,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
  ): Promise<Item> {
    const { data, error, response } = await this.client.PATCH("/items/{id}", {
      params: { path: { id } },
      body: {
        version,
        properties,
        properties_mode: "replace",
        ...(occurredAt !== undefined && { occurred_at: occurredAt }),
      },
    });
    if (data === undefined) throw refusal(response, error);
    return data.item;
  }

  /** The registration's webhook endpoints, retired ones included. */
  async endpoints(id: string): Promise<InboundEndpoint[]> {
    const { data, error, response } = await this.client.GET(
      "/connectors/{id}/endpoints",
      { params: { path: { id } } },
    );
    if (data === undefined) throw refusal(response, error);
    return data.data;
  }

  /** The deliveries not yet handled, oldest first, at most `limit`. */
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

  /** Marks deliveries, two hundred to a request; the first mark stands. */
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

  /**
   * Takes or renews the registration's hold for this process: when it
   * expires, whether this process held it without a lapse, or `elsewhere`
   * when another process holds it until then.
   */
  async hold(
    id: string,
    process: string,
  ): Promise<
    | { elsewhere: false; until: string; renewed: boolean }
    | { elsewhere: true; until: string }
  > {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/hold",
      { params: { path: { id } }, body: { process } },
    );
    if (data !== undefined) {
      return {
        elsewhere: false,
        until: data.expires_at,
        renewed: data.renewed,
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

  /** The state document kept for the key's own source, `{}` where none is. */
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

  /** The agreements the instance holds for the rows named, at most 500. */
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

  /** Every row whose agreement is marked waiting. */
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

  /** Writes and clears agreements, at most 500 of each to a request. */
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
