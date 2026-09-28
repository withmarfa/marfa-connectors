import {
  pages,
  type components,
  type MarfaClient,
  type operations,
} from "@withmarfa/client";
import type { Item, TypeDefinition } from "./define.js";

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
  ) {
    super(
      `${status === undefined ? "" : `${String(status)} `}${code}: ${detail}`,
    );
  }
}

function refusal(response: Response, error: unknown): Refusal {
  const envelope = (
    error as { error?: { code?: unknown; message?: unknown } } | undefined
  )?.error;
  const code = typeof envelope?.code === "string" ? envelope.code : "unknown";
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : response.statusText;
  return new Refusal(response.status, code, message);
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

  /**
   * Every row whose type is this one or inherits from it, in every state:
   * under one source, or under every source when none is named.
   */
  async ownRows(type: string, source?: string): Promise<Item[]> {
    const rows: Item[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET("/items", {
        params: {
          query: {
            type,
            ...(source !== undefined && { source }),
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
  ): Promise<ReadableStream<Uint8Array>> {
    const { data, error, response } = await this.client.GET("/events", {
      params: {
        query: { type: types.join(","), edges: "none" },
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
   * Takes or renews the registration's hold for this process: when it lasts
   * until, or `elsewhere` when another process holds it until then.
   */
  async hold(
    id: string,
    process: string,
  ): Promise<{ until: string; elsewhere: boolean }> {
    const { data, error, response } = await this.client.POST(
      "/connectors/{id}/hold",
      { params: { path: { id } }, body: { process } },
    );
    if (data !== undefined) return { until: data.held_until, elsewhere: false };
    const refused = refusal(response, error);
    const until = (
      error as { error?: { details?: { held_until?: unknown } } } | undefined
    )?.error?.details?.held_until;
    if (refused.code === "connector_held" && typeof until === "string") {
      return { until, elsewhere: true };
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

  async archive(id: string): Promise<void> {
    const { data, error, response } = await this.client.POST(
      "/items/{id}/transition",
      {
        params: { path: { id } },
        body: { state: "archived" },
      },
    );
    if (data === undefined) throw refusal(response, error);
  }
}
