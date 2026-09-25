import {
  pages,
  type components,
  type MarfaClient,
  type operations,
} from "@withmarfa/client";
import type { TypeDefinition } from "./define.js";

export type Item = components["schemas"]["Item"];
export type BulkResult = components["schemas"]["BulkResultEntry"];
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
   * Every row under the source whose type is this one or inherits from it,
   * in every state.
   */
  async ownRows(type: string, source: string): Promise<Item[]> {
    const rows: Item[] = [];
    const walk = pages(async (cursor) => {
      const { data, error, response } = await this.client.GET("/items", {
        params: {
          query: {
            type,
            source,
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
