import { execFile, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { components, MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

export type Item = components["schemas"]["Item"];

export interface KeyFlags {
  label: string;
  source: string;
  typePermission: string;
}

export function keyBody(flags: KeyFlags) {
  return {
    label: flags.label,
    source: flags.source,
    type_permissions: { [flags.typePermission]: "write" as const },
    metadata_permissions: { types: "write" as const },
    default_tier: "feed" as const,
  };
}

export class ConnectorUnderProof {
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly key: string,
    private readonly env: Record<string, string>,
    private readonly entry = join(root, "connectors", name, "dist/main.js"),
  ) {}

  once(): Promise<{ code: number; output: string }> {
    return this.run(["--once"]);
  }

  /** A run told to stop once `until` says so, as a stop or a reboot would. */
  stopped(
    args: readonly string[],
    until: () => Promise<void>,
  ): Promise<{ code: number | null; output: string }> {
    const child = spawn("node", [this.entry, ...args], {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: this.url,
        MARFA_API_KEY: this.key,
        ...this.env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<{ code: number | null; output: string }>(
      (done) => {
        child.once("close", (code) => {
          done({ code, output });
        });
      },
    );
    void until().then(() => child.kill("SIGTERM"));
    return exited;
  }

  async run(
    args: readonly string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; output: string }> {
    try {
      const { stderr } = await run("node", [this.entry, ...args], {
        env: {
          PATH: process.env["PATH"],
          MARFA_API_URL: this.url,
          MARFA_API_KEY: this.key,
          ...this.env,
          ...env,
        },
      });
      return { code: 0, output: stderr };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return {
        code: failed.code ?? -1,
        output: failed.stderr ?? String(error),
      };
    }
  }
}

async function mint(marfa: MarfaClient, flags: KeyFlags) {
  const { data, error } = await marfa.POST("/keys", { body: keyBody(flags) });
  if (data === undefined)
    throw new Error(`the key was refused: ${JSON.stringify(error)}`);
  return data;
}

export type Minted = Awaited<ReturnType<typeof mint>>;

export async function mintWithTheReadmeKeyFlags(
  marfa: MarfaClient,
  flags: KeyFlags,
): Promise<Minted> {
  let minted: Minted | undefined;
  await check(
    `${flags.label}: its key is minted through the API, not by the CLI, with the permissions the template's README names`,
    async () => {
      const key = await mint(marfa, flags);
      minted = key;
      const types = JSON.stringify(key.type_permissions);
      const metadata = JSON.stringify(key.metadata_permissions);
      const permissions = JSON.stringify(key.permissions);
      const rest = JSON.stringify([
        key.edge_permissions,
        key.extension_permissions,
        key.profile_permissions,
      ]);
      if (
        key.source !== flags.source ||
        key.default_tier !== "feed" ||
        types !== JSON.stringify({ [flags.typePermission]: "write" }) ||
        metadata !== JSON.stringify({ types: "write" }) ||
        permissions !== "[]" ||
        rest !== "[{},{},{}]"
      ) {
        throw new Error(
          `source ${key.source}, type_permissions ${types}, metadata ${metadata}, permissions ${permissions}, edge, extension and profile ${rest}, default tier ${key.default_tier}`,
        );
      }
      return `source ${key.source}, type_permissions ${types}, metadata ${metadata}, permissions ${permissions}, no other map, default tier ${key.default_tier}`;
    },
  );
  if (minted === undefined) throw new Error("the key check answered nothing");
  return minted;
}

export async function fieldsOf(marfa: MarfaClient, id: string) {
  const { data, error } = await marfa.GET("/types/{id}", {
    params: { path: { id } },
  });
  if (data === undefined)
    throw new Error(`the type ${id} was refused: ${JSON.stringify(error)}`);
  return {
    fields: Object.keys(data.fields),
    parent: data.parent,
    compatible_with: data.compatible_with,
  };
}

export async function witnessTypeAnswers(marfa: MarfaClient): Promise<string> {
  const id = "proof.witness";
  const { error, response } = await marfa.POST("/types", {
    body: {
      id,
      label: "Proof Witness",
      parent: "core.bookmark",
      compatible_with: ["core.bookmark"],
      fields: { witness: { type: "string" } },
    },
  });
  if (!response.ok) {
    throw new Error(`the witness type was refused: ${JSON.stringify(error)}`);
  }
  const served = await fieldsOf(marfa, id);
  const bookmark = await fieldsOf(marfa, "core.bookmark");
  if (
    served.parent !== "core.bookmark" ||
    JSON.stringify(served.compatible_with) !== '["core.bookmark"]' ||
    !served.fields.includes("witness") ||
    !bookmark.fields.every((field) => served.fields.includes(field))
  ) {
    throw new Error(
      `parent ${String(served.parent)}, compatible_with ${JSON.stringify(served.compatible_with)}, fields ${served.fields.join(", ")}`,
    );
  }
  return `${id} answers parent ${served.parent}, compatible_with ${JSON.stringify(served.compatible_with)}, and its own witness field beside its parent's ${String(bookmark.fields.length)}`;
}

export async function typeHeld(marfa: MarfaClient, id: string) {
  const { data, error, response } = await marfa.GET("/types/{id}", {
    params: { path: { id } },
  });
  if (data !== undefined) return true;
  if (response.status === 404) return false;
  throw new Error(`the type ${id} was refused: ${JSON.stringify(error)}`);
}

export async function registeredAsKindOf(
  marfa: MarfaClient,
  type: string,
  parent: string,
  wasHeld: boolean,
  rows: Iterable<Item>,
): Promise<{ own: string[]; inherited: number }> {
  if (wasHeld) {
    throw new Error(`${type} was on the server before the connector ran`);
  }
  const served = await fieldsOf(marfa, type);
  const core = await fieldsOf(marfa, parent);
  if (served.parent !== parent || served.compatible_with !== undefined) {
    throw new Error(
      `parent ${String(served.parent)}, compatible_with ${JSON.stringify(served.compatible_with)}`,
    );
  }
  const missing = core.fields.filter((field) => !served.fields.includes(field));
  const unknown = [...rows]
    .flatMap((row) => Object.keys(row.properties))
    .filter((field) => !served.fields.includes(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${type} lacks ${parent}'s ${missing.join(", ") || "nothing"}; written outside the type: ${unknown.join(", ") || "nothing"}`,
    );
  }
  return {
    own: served.fields.filter((field) => !core.fields.includes(field)).sort(),
    inherited: core.fields.length,
  };
}

export async function runsOf(marfa: MarfaClient, keyId: string) {
  const { id } = await registration(marfa, keyId);
  const { data, error } = await marfa.GET("/connectors/{id}/runs", {
    params: { path: { id } },
  });
  if (data === undefined)
    throw new Error(`the runs were refused: ${JSON.stringify(error)}`);
  return data.data;
}

export async function lastRun(marfa: MarfaClient, keyId: string) {
  const found = await registration(marfa, keyId);
  if (found.last_run === null) throw new Error("no run is reported");
  return found.last_run;
}

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

// A transition changes state without moving the version, so both are compared.
export function moved(
  before: Map<string, Item>,
  after: Map<string, Item>,
): string[] {
  return [...after.values()].flatMap((row) => {
    const was = before.get(row.source_id ?? "");
    if (was?.version === row.version && was.state === row.state) return [];
    const state =
      was?.state === row.state ? "" : ` ${String(was?.state)}→${row.state}`;
    return [
      `${row.source_id ?? row.id} ${String(was?.version)}→${String(row.version)}${state}`,
    ];
  });
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

export async function edit(
  marfa: MarfaClient,
  row: Item,
  properties: Record<string, unknown>,
): Promise<Item> {
  const { data, error } = await marfa.PATCH("/items/{id}", {
    params: { path: { id: row.id } },
    body: { version: row.version, properties, properties_mode: "merge" },
  });
  if (data === undefined)
    throw new Error(`the edit was refused: ${JSON.stringify(error)}`);
  return data.item;
}

export async function create(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
): Promise<Item> {
  const { data, error } = await marfa.POST("/items", {
    body: { type, properties },
  });
  if (data === undefined)
    throw new Error(`the create was refused: ${JSON.stringify(error)}`);
  return data.item;
}

export async function trash(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.DELETE("/items/{id}", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the trash was refused: ${JSON.stringify(error)}`);
}

export async function restore(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.POST("/items/{id}/restore", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the restore was refused: ${JSON.stringify(error)}`);
}

export async function purge(marfa: MarfaClient, id: string): Promise<void> {
  const { error, response } = await marfa.POST("/items/{id}/purge", {
    params: { path: { id } },
  });
  if (!response.ok)
    throw new Error(`the purge was refused: ${JSON.stringify(error)}`);
}

export async function promote(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
  from: Item | undefined,
): Promise<Item> {
  const { data, error } = await marfa.POST("/items", {
    body: {
      type,
      properties,
      tier: "library",
      ...(from !== undefined && { edges: { "derived-from": [from.id] } }),
    },
  });
  if (data === undefined)
    throw new Error(`the promotion was refused: ${JSON.stringify(error)}`);
  return data.item;
}

export async function promoteAndFind(
  marfa: MarfaClient,
  type: string,
  properties: Record<string, unknown>,
  from: Item,
  other: Item,
): Promise<{ copy: Item; found: Item[] }> {
  await promote(marfa, type, properties, undefined);
  await promote(marfa, type, properties, other);
  const copy = await promote(marfa, type, properties, from);
  const found = await derivedFrom(marfa, type, from);
  const everyOne = await marfa.GET("/items", { params: { query: { type } } });
  const count = everyOne.data?.data.length ?? 0;
  if (count < 3) {
    throw new Error(
      `the type holds ${String(count)} items, not the three made`,
    );
  }
  if (found.map((candidate) => candidate.id).join() !== copy.id) {
    throw new Error(
      `the edge filter found ${String(found.length)} of the type's ${String(count)} items`,
    );
  }
  return { copy, found };
}

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
