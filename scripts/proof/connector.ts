import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { components, MarfaClient } from "@withmarfa/client";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

export type Item = components["schemas"]["Item"];

/** The body `marfa keys create` sends for the flags the template's README names. */
export interface KeyFlags {
  label: string;
  source: string;
  typePermission: string;
  registersType: boolean;
}

export function keyBody(flags: KeyFlags) {
  return {
    label: flags.label,
    source: flags.source,
    type_permissions: { [flags.typePermission]: "write" as const },
    ...(flags.registersType && {
      metadata_permissions: { types: "write" as const },
    }),
    default_tier: "feed" as const,
  };
}

/** One connector, as a person would run it: its own key, its own state, `--once`. */
export class ConnectorUnderProof {
  private stateDir: string | undefined;

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly key: string,
    private readonly env: Record<string, string>,
  ) {}

  async once(): Promise<{ code: number; output: string }> {
    this.stateDir ??= await mkdtemp(join(tmpdir(), `proof-${this.name}-`));
    try {
      const { stderr } = await run(
        "node",
        [join(root, "connectors", this.name, "dist/main.js"), "--once"],
        {
          env: {
            PATH: process.env["PATH"],
            MARFA_URL: this.url,
            MARFA_KEY: this.key,
            MARFA_STATE_DIR: this.stateDir,
            ...this.env,
          },
        },
      );
      return { code: 0, output: stderr };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return {
        code: failed.code ?? -1,
        output: failed.stderr ?? String(error),
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.stateDir !== undefined) {
      await rm(this.stateDir, { recursive: true, force: true });
    }
  }
}

export async function mint(marfa: MarfaClient, flags: KeyFlags) {
  const { data, error } = await marfa.POST("/keys", { body: keyBody(flags) });
  if (data === undefined)
    throw new Error(`the key was refused: ${JSON.stringify(error)}`);
  return data;
}

/** Every row under the type and source, in every state, by `source_id`. */
export async function rowsOf(
  marfa: MarfaClient,
  type: string,
  source: string,
): Promise<Map<string, Item>> {
  const rows = new Map<string, Item>();
  let cursor: string | undefined;
  do {
    const { data, error } = await marfa.GET("/items", {
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
    if (data === undefined)
      throw new Error(`the listing was refused: ${JSON.stringify(error)}`);
    for (const row of data.data) {
      const item = "item" in row ? row.item : row;
      if (item.source_id !== undefined) rows.set(item.source_id, item);
    }
    cursor = data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

/** The rows whose version is not what it was. */
export function moved(
  before: Map<string, Item>,
  after: Map<string, Item>,
): string[] {
  return [...after.values()]
    .filter((row) => before.get(row.source_id ?? "")?.version !== row.version)
    .map(
      (row) =>
        `${row.source_id ?? row.id} ${String(before.get(row.source_id ?? "")?.version)}→${String(row.version)}`,
    );
}

export async function registration(marfa: MarfaClient, keyId: string) {
  const { data, error } = await marfa.GET("/connectors");
  if (data === undefined)
    throw new Error(`the listing was refused: ${JSON.stringify(error)}`);
  const found = data.data.find((connector) => connector.key_id === keyId);
  if (found === undefined)
    throw new Error("no registration carries the connector's key");
  return found;
}

export async function trash(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.DELETE("/items/{id}", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the trash was refused: ${JSON.stringify(error)}`);
}

/**
 * A person's promotion: a core-typed copy in the library, pointing back at
 * the feed row with a `derived-from` edge.
 */
export async function promote(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
  from: Item,
): Promise<Item> {
  const { data, error } = await marfa.POST("/items", {
    body: {
      type,
      properties,
      tier: "library",
      edges: { "derived-from": [from.id] },
    },
  });
  if (data === undefined)
    throw new Error(`the promotion was refused: ${JSON.stringify(error)}`);
  return data.item;
}

/** The items of a type holding a `derived-from` edge to the feed row. */
export async function derivedFrom(
  marfa: MarfaClient,
  type: string,
  from: Item,
): Promise<Item[]> {
  const { data, error } = await marfa.GET("/items", {
    params: { query: { type, filter: `edge[derived-from] eq "${from.id}"` } },
  });
  if (data === undefined)
    throw new Error(`the edge filter was refused: ${JSON.stringify(error)}`);
  return data.data.map((row) => ("item" in row ? row.item : row));
}

export async function item(marfa: MarfaClient, id: string): Promise<Item> {
  const { data, error } = await marfa.GET("/items/{id}", {
    params: { path: { id } },
  });
  if (data === undefined)
    throw new Error(`the read was refused: ${JSON.stringify(error)}`);
  return data.item;
}
