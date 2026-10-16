import { createHash } from "node:crypto";
import type {
  EnvDeclaration,
  Item,
  RunContext,
  TypeDefinition,
  Entry,
  ConnectionDefinition,
} from "@withmarfa/connector";
import { assetsIn, openAsset, type Asset } from "./assets.js";
import { batches, query, type Client } from "./github.js";

export const fileFields = [
  "github_id",
  "title",
  "url",
  "blob_ref",
  "mime_type",
  "private",
  "github_parents",
];
export const fileTypes = ["github.file", "github.file.image"] as const;
export const fileKinds = fileTypes.map((id) => ({
  type: {
    id,
    label: id.endsWith("image") ? "GitHub image" : "GitHub file",
    description:
      "Bytes retained from a signed attachment in a GitHub issue or comment.",
    parent: id.endsWith("image") ? "core.file.image" : "core.file",
    link_field: "github_id",
    fields: {
      github_id: {
        type: "string",
        required: true,
        description: "The immutable GitHub asset UUID.",
      },
      private: {
        type: "boolean",
        description:
          "Whether any known parent is private or has unknown visibility.",
      },
      github_parents: {
        type: "object",
        description:
          "Parent node IDs with their type, repository, and last known visibility.",
      },
    },
  } satisfies TypeDefinition,
  fields: fileFields,
}));
export const filesConnection: ConnectionDefinition = {
  id: "attached-to",
  cardinality: "many-to-many",
  source_type_constraints: [...fileTypes],
  target_type_constraints: ["github.issue", "github.comment"],
};
type Context = Pick<
  RunContext<EnvDeclaration>,
  | "held"
  | "derive"
  | "upsert"
  | "known"
  | "inspect"
  | "signal"
  | "log"
  | "secret"
>;
type Provenance = Record<
  string,
  { type: string; repository: string; private: boolean }
>;
interface Note {
  body: string;
  assets: string[];
  pending: boolean;
  not_kept: Record<string, string>;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function parentsOf(value: unknown): Provenance {
  const out: Provenance = {};
  for (const [id, valueAt] of Object.entries(object(value))) {
    const at = object(valueAt);
    if (
      (at["type"] === "github.issue" || at["type"] === "github.comment") &&
      typeof at["repository"] === "string"
    )
      out[id] = {
        type: at["type"],
        repository: at["repository"],
        private: at["private"] !== false,
      };
  }
  return out;
}
function noteOf(value: unknown): Note | undefined {
  const at = object(value);
  if (
    typeof at["body"] !== "string" ||
    typeof at["pending"] !== "boolean" ||
    !Array.isArray(at["assets"]) ||
    !at["assets"].every((id: unknown) => typeof id === "string")
  )
    return;
  return {
    body: at["body"],
    pending: at["pending"],
    assets: at["assets"],
    not_kept: Object.fromEntries(
      Object.entries(object(at["not_kept"])).filter(
        (one): one is [string, string] => typeof one[1] === "string",
      ),
    ),
  };
}
function properties(row: Item): Record<string, unknown> {
  return Object.fromEntries(
    fileFields
      .filter((field) => row.properties[field] !== undefined)
      .map((field) => [field, row.properties[field]]),
  );
}
function fileEntry(
  id: string,
  values: Record<string, unknown>,
  parents: Provenance,
): Entry {
  return {
    source_id: id,
    properties: {
      ...values,
      github_id: id,
      github_parents: parents,
      private: Object.values(parents).some((p) => p.private),
    },
    connections: {
      "attached-to": Object.entries(parents).map(([node, parent]) => ({
        type: parent.type,
        id: node,
      })),
    },
  };
}
/** Ordinary entries must carry the last attachment accounting, not clear it. */
export async function fileNotes(
  context: Pick<Context, "inspect" | "known">,
  type: string,
  entries: readonly Entry[],
): Promise<Entry[]> {
  if (entries.length === 0) return [];
  const ids = entries.map((entry) => String(entry.properties["github_id"]));
  const prior = await context.inspect(type, { links: ids });
  const known = await context.known(type, ids);
  const notes = new Map(
    prior.items.flatMap((row) => {
      const id = row.properties["github_id"];
      return typeof id === "string" && known.has(id)
        ? [[id, row.properties["github_files"]] as const]
        : [];
    }),
  );
  return entries.map((entry) => ({
    ...entry,
    properties: {
      ...entry.properties,
      github_files: notes.get(String(entry.properties["github_id"])),
    },
  }));
}
async function existing(
  context: Context,
  id: string,
): Promise<{ row: Item | undefined; removed: boolean }> {
  const found: Awaited<ReturnType<Context["inspect"]>>[] = [];
  for (const type of fileTypes)
    found.push(await context.inspect(type, { links: [id] }));
  const rows = found.flatMap((one) => one.items);
  if (rows.length > 1)
    throw new Error("A GitHub asset has conflicting file types");
  return {
    row: rows[0],
    removed:
      found.some((one) => one.tombstones.length > 0) ||
      rows.some((row) => row.state === "trashed"),
  };
}
async function keep(
  context: Context,
  parent: Item,
  asset: Asset,
  options: { fetch?: typeof fetch },
): Promise<string | undefined> {
  const prior = await existing(context, asset.id);
  if (prior.removed) return "The retained file was removed in Marfa";
  const parents = parentsOf(prior.row?.properties["github_parents"]);
  const node = String(parent.properties["github_id"]);
  parents[node] = {
    type: parent.type,
    repository: String(parent.properties["repository"]),
    private: parent.properties["private"] !== false,
  };
  const known =
    prior.row !== undefined &&
    (await context.known(prior.row.type, [asset.id])).has(asset.id) &&
    typeof prior.row.properties["blob_ref"] === "string" &&
    typeof prior.row.properties["mime_type"] === "string";
  if (known && prior.row) {
    await context.upsert(prior.row.type, [
      fileEntry(asset.id, properties(prior.row), parents),
    ]);
    return;
  }
  context.secret(asset.url);
  let opened: Awaited<ReturnType<typeof openAsset>> | undefined;
  try {
    opened = await openAsset(asset.url, context.signal, options);
    const kind = opened.mime_type.startsWith("image/")
      ? fileTypes[1]
      : fileTypes[0];
    if (prior.row && prior.row.type !== kind)
      throw new Error("GitHub asset media type changed");
    const entry = fileEntry(
      asset.id,
      {
        title: asset.title,
        url: `https://github.com/user-attachments/assets/${asset.id}`,
      },
      parents,
    );
    const content = opened;
    entry.file = { key: asset.id, load: () => Promise.resolve(content) };
    await context.upsert(kind, [entry]);
    const after = await existing(context, asset.id);
    if (
      !after.row ||
      !(await context.known(kind, [asset.id])).has(asset.id) ||
      typeof after.row.properties["blob_ref"] !== "string"
    )
      return "The signed asset could not be kept; retry waits for fresh HTML";
    return;
  } catch (error) {
    if (context.signal.aborted) throw error;
    return "The signed asset could not be kept; retry waits for fresh HTML";
  } finally {
    if (opened && !opened.bytes.locked)
      await opened.bytes.cancel().catch(() => undefined);
  }
}
/** Only stable parent identities and safe outcomes survive a signed URL's lifetime. */
export async function preserveFiles(
  context: Context,
  client: Client,
  repository: string,
  options: {
    fetch?: typeof fetch;
    checkpoint?: (parent: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const all: Item[] = [];
  for (const type of ["github.issue", "github.comment"])
    all.push(...(await context.held(type, { state: "any" })));
  const held = all.filter(
    (row) =>
      row.state !== "trashed" && row.properties["repository"] === repository,
  );
  const candidates = held.filter((row) => {
    const body =
      typeof row.properties["body"] === "string" ? row.properties["body"] : "";
    const note = noteOf(row.properties["github_files"]);
    return (
      (note !== undefined ||
        /user-attachments\/|private-user-images\.githubusercontent\.com|github-production-user-asset-|objects\.githubusercontent\.com/.test(
          body,
        )) &&
      (note?.pending === true ||
        note?.body !== createHash("sha256").update(body).digest("hex"))
    );
  });
  for (const type of ["github.issue", "github.comment"]) {
    const parents = candidates.filter((row) => row.type === type);
    const byId = new Map(
      parents.map((row) => [String(row.properties["github_id"]), row]),
    );
    const variant = type === "github.issue" ? "Issue" : "IssueComment";
    const operation = type === "github.issue" ? "FileIssues" : "FileComments";
    for (const ids of batches([...byId.keys()])) {
      const answer = (await query(
        client,
        `query ${operation}($ids: [ID!]!) { nodes(ids: $ids) { ... on ${variant} { id bodyHTML } } }`,
        { ids },
      )) as { nodes: ({ id: string; bodyHTML: string } | null)[] };
      for (const id of ids) {
        const parent = byId.get(id);
        if (parent === undefined) continue;
        const node = answer.nodes.find((one) => one?.id === id);
        if (!node || typeof node.bodyHTML !== "string") {
          context.log.condition(
            `github-files:${id}`,
            "Attachment HTML could not be read; retained files and retry metadata are unchanged",
          );
          continue;
        }
        const parsed = assetsIn(node.bodyHTML);
        const note: Note = {
          body: createHash("sha256")
            .update(
              typeof parent.properties["body"] === "string"
                ? parent.properties["body"]
                : "",
            )
            .digest("hex"),
          assets: [],
          pending: false,
          not_kept: Object.fromEntries(
            parsed.unsigned.map((url) => [
              url,
              "GitHub did not sign this upload for API download",
            ]),
          ),
        };
        for (const asset of parsed.assets) {
          const reason = await keep(context, parent, asset, options);
          if (reason) {
            note.not_kept[
              `https://github.com/user-attachments/assets/${asset.id}`
            ] = reason;
            if (reason.startsWith("The signed")) note.pending = true;
          } else note.assets.push(asset.id);
        }
        if (
          parsed.assets.length === 0 &&
          (typeof parent.properties["body"] === "string"
            ? parent.properties["body"]
            : ""
          ).includes("user-attachments/assets/")
        ) {
          note.pending = true;
          note.not_kept["rendered-assets"] =
            "GitHub did not return a signed asset address; retry waits for fresh HTML";
        }
        if (
          note.assets.length > 0 &&
          !note.pending &&
          (!options.checkpoint || !(await options.checkpoint(id)))
        ) {
          note.pending = true;
          note.not_kept["acknowledgment"] =
            "Retained bytes await an acknowledged attachment write";
        }
        await context.derive(type, [id], { github_files: note });
        if (note.pending)
          context.log.condition(
            `github-files:${id}`,
            "Some GitHub attachments could not be kept; their last good copies remain and fresh HTML will be requested next run",
          );
      }
    }
  }
}
export async function markFilesPrivate(
  context: Context,
  repository: string,
  hidden: boolean,
): Promise<void> {
  for (const type of fileTypes)
    for (const row of await context.held(type, { state: "any" })) {
      if (row.state === "trashed") continue;
      const parents = parentsOf(row.properties["github_parents"]);
      let changed = false;
      for (const parent of Object.values(parents))
        if (parent.repository === repository && parent.private !== hidden) {
          parent.private = hidden;
          changed = true;
        }
      if (changed)
        await context.upsert(type, [
          fileEntry(
            String(row.properties["github_id"]),
            properties(row),
            parents,
          ),
        ]);
    }
}
