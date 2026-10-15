import {
  Refused,
  Unreachable,
  type Change,
  type Entry,
  type JsonValue,
  type WatchContext,
} from "@withmarfa/connector";
import {
  RateLimited,
  isReaderManaged,
  mapReaderHighlight,
  mapReaderSource,
  readerIdentity,
  type ReaderDocument,
  type ReaderPage,
  type ReaderReader,
} from "@withmarfa/readwise";
import { env, parseConfig, type ReaderConfig } from "./config.js";
import {
  ReaderWriteClient,
  ReaderWriteRefused,
  type ReaderBody,
} from "./reader-write-client.js";
type Context = WatchContext<typeof env>;
interface Plan {
  account: string;
  base: string;
  kind:
    | "update"
    | "delete"
    | "source-create"
    | "highlight-create"
    | "source-create-update";
  id: string;
  body: ReaderBody;
  updates: ReaderBody;
}
const approved = new WeakMap<
  Context,
  { client: ReaderWriteClient; purges: Set<string> }
>();
const sourceFields: Record<string, string> = {
  title: "title",
  author: "author",
  description: "summary",
  notes: "notes",
  tags: "tags",
  reader_location: "location",
  category: "category",
  language: "language",
  published_at: "published_date",
  image_url: "image_url",
};
const highlightFields: Record<string, string> = { note: "notes", tags: "tags" };
const locations = ["new", "later", "archive", "feed"];
const categories = ["article", "email", "rss", "pdf", "epub", "tweet", "video"];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    return false;
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      return false;
  return true;
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new Refused("Reader creation requires string values");
  return value;
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function body(change: Change): ReaderBody {
  const highlight = change.item.type === "readwise.highlight";
  const mapping = highlight ? highlightFields : sourceFields;
  const values: ReaderBody = {};
  const fields =
    change.kind === "created"
      ? Object.keys(change.item.properties)
      : [...change.changed];
  for (const field of fields) {
    const key = mapping[field];
    if (key === undefined) continue;
    const value = change.item.properties[field];
    if (key === "tags") {
      if (
        value != null &&
        (!Array.isArray(value) || value.some((tag) => typeof tag !== "string"))
      )
        throw new Refused("Reader tags must be strings");
      values[key] = value == null ? [] : (value as string[]);
    } else {
      if (value != null && typeof value !== "string")
        throw new Refused(`Reader ${field} must be a string`);
      values[key] = value ?? "";
    }
  }
  validateBody(values, highlight ? "highlight" : "source");
  return values;
}
function validateBody(
  value: unknown,
  kind: "source" | "highlight" | "source-create" | "highlight-create",
): asserts value is ReaderBody {
  if (!object(value)) throw new Refused("invalid saved Reader request body");
  const allowed =
    kind === "source-create"
      ? ["url"]
      : kind === "highlight-create"
        ? ["parent_id", "content", "notes", "tags"]
        : kind === "highlight"
          ? Object.values(highlightFields)
          : Object.values(sourceFields);
  for (const [key, entry] of Object.entries(value)) {
    if (
      !allowed.includes(key) ||
      (key === "tags"
        ? !Array.isArray(entry) || entry.some((tag) => typeof tag !== "string")
        : typeof entry !== "string")
    )
      throw new Refused("invalid saved Reader request field");
    if (key === "location" && !locations.includes(entry as string))
      throw new Refused("Reader location must be new, later, archive or feed");
    if (key === "category" && !categories.includes(entry as string))
      throw new Refused("unsupported Reader source category");
  }
  if (kind === "source-create") {
    if (typeof value["url"] !== "string")
      throw new Refused("Reader creation needs a stable URL");
    let url: URL;
    try {
      url = new URL(value["url"]);
    } catch {
      throw new Refused("Reader creation needs a stable HTTP URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Refused("Reader creation needs a stable HTTP URL");
  }
  if (
    kind === "highlight-create" &&
    (!id(value["parent_id"]) ||
      typeof value["content"] !== "string" ||
      value["content"].length === 0)
  )
    throw new Refused("highlight creation needs a parent and passage");
}
function plan(value: unknown, config: ReaderConfig, change: Change): Plan {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !==
      "account,base,body,id,kind,updates" ||
    value["account"] !== config.account ||
    value["base"] !== config.readerBase ||
    ![
      "update",
      "delete",
      "source-create",
      "highlight-create",
      "source-create-update",
    ].includes(String(value["kind"])) ||
    typeof value["id"] !== "string"
  )
    throw new Refused("invalid or changed Reader intent context");
  const result = value as unknown as Plan;
  const highlight = change.item.type === "readwise.highlight";
  const create = change.kind === "created";
  if (create) {
    if (
      highlight
        ? result.kind !== "highlight-create" || result.id !== ""
        : !["source-create", "source-create-update"].includes(result.kind) ||
          (result.kind === "source-create" ? result.id !== "" : !id(result.id))
    )
      throw new Refused("Reader intent no longer matches its captured create");
  } else if (
    !["update", "delete"].includes(result.kind) ||
    !id(result.id) ||
    result.id !== change.item.properties["reader_id"] ||
    (result.kind === "delete") !== (change.kind === "purged")
  )
    throw new Refused("Reader intent no longer matches its captured change");
  validateBody(
    result.body,
    result.kind === "source-create" || result.kind === "highlight-create"
      ? result.kind
      : highlight
        ? "highlight"
        : "source",
  );
  validateBody(result.updates, highlight ? "highlight" : "source");
  if (
    result.kind === "delete" &&
    (Object.keys(result.body).length || Object.keys(result.updates).length)
  )
    throw new Refused("invalid Reader delete intent");
  return result;
}
function validateBaseline(
  value: unknown,
  operation: Plan,
  change: Change,
): void {
  if (operation.kind === "delete") {
    if (value !== null && (!object(value) || Object.keys(value).length !== 0))
      throw new Refused("invalid saved Reader delete baseline");
    return;
  }
  if (
    operation.kind === "update" ||
    operation.kind === "source-create-update"
  ) {
    validateBody(
      value,
      change.item.type === "readwise.highlight" ? "highlight" : "source",
    );
    if (
      Object.keys(value).sort().join(",") !==
      Object.keys(operation.body).sort().join(",")
    )
      throw new Refused("invalid saved Reader update baseline");
    return;
  }
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "existing,ids" ||
    !Array.isArray(value["ids"]) ||
    value["ids"].some((entry) => !id(entry)) ||
    new Set(value["ids"]).size !== value["ids"].length
  )
    throw new Refused("invalid saved Reader create baseline");
  const existing = value["existing"];
  if (existing === null) return;
  if (
    operation.kind === "highlight-create" ||
    !object(existing) ||
    Object.keys(existing).sort().join(",") !== "fields,id" ||
    !id(existing["id"]) ||
    !value["ids"].includes(existing["id"])
  )
    throw new Refused("invalid saved Reader create baseline");
  validateBody(existing["fields"], "source");
  if (
    Object.keys(existing["fields"]).sort().join(",") !==
    Object.keys(operation.updates).sort().join(",")
  )
    throw new Refused("invalid saved Reader create baseline");
}
/** No filtered or partial listing can prove a deletion cascade or a new identity. */
export async function completeInventory(
  reader: ReaderReader,
  context?: Pick<Context, "waitUntil">,
): Promise<ReaderDocument[]> {
  const rows = new Map<string, ReaderDocument>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
    let page: ReaderPage;
    try {
      page = await reader.page(cursor === undefined ? {} : { cursor });
    } catch (error) {
      if (!(error instanceof RateLimited) || context === undefined) throw error;
      await context.waitUntil(error.until);
      continue;
    }
    if (total !== undefined && page.count + rows.size !== total)
      throw new Unreachable(
        "Reader inventory changed while proving completeness",
      );
    total ??= page.count;
    for (const row of page.results) {
      if (rows.has(row.id))
        throw new Unreachable(
          "Reader complete inventory contains duplicate identities",
        );
      rows.set(row.id, row);
    }
    if (page.nextPageCursor === null) {
      if (rows.size !== total)
        throw new Unreachable("Reader inventory is not complete");
      return [...rows.values()];
    }
    if (cursors.has(page.nextPageCursor) || page.results.length === 0)
      throw new Unreachable("Reader inventory is not complete");
    cursor = page.nextPageCursor;
    cursors.add(cursor);
  }
  throw new Unreachable(
    "Reader inventory exceeds the complete traversal limit",
  );
}
async function inspectPurges(
  inventory: { purges: readonly Change[] },
  context: Context,
): Promise<void> {
  approved.delete(context);
  const config = parseConfig(context.env);
  const client = new ReaderWriteClient(
    config.readerBase,
    context.env.READWISE_ACCESS_TOKEN,
    context.signal,
  );
  const purges = new Set<string>();
  if (!config.inboundOnly && config.propagatePurge) {
    for (const change of inventory.purges) {
      if (change.kind !== "purged")
        throw new Refused("invalid purge preflight inventory");
      if (
        isReaderManaged(
          change.item.type,
          change.item.properties,
          config.account,
        )
      )
        purges.add(String(change.item.properties["reader_id"]));
    }
    if (purges.size > 0) {
      const rows = await completeInventory(client, context);
      const cascade = new Set(purges);
      for (;;) {
        const count = cascade.size;
        for (const row of rows)
          if (row.parent_id && cascade.has(row.parent_id)) cascade.add(row.id);
        if (count === cascade.size) break;
      }
      if (cascade.size > 20)
        throw new Refused(
          `Reader purge preflight blocks ${String(cascade.size)} deletions; the limit is 20`,
        );
    }
  }
  approved.set(context, { client, purges });
}
function values(row: ReaderDocument, keys: readonly string[]): ReaderBody {
  const result: ReaderBody = {};
  for (const key of keys) {
    const value: unknown = row[key as keyof ReaderDocument];
    result[key] =
      key === "tags"
        ? Object.keys(row.tags ?? {}).sort()
        : typeof value === "string"
          ? value
          : "";
  }
  return result;
}
function equal(left: ReaderBody, right: ReaderBody): boolean {
  const normal = (value: ReaderBody) =>
    JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [
          key,
          Array.isArray(entry) ? [...entry].sort() : entry,
        ]),
    );
  return normal(left) === normal(right);
}
function answer(
  change: Change,
  row: ReaderDocument,
  config: ReaderConfig,
): Entry {
  const mapping =
    change.item.type === "readwise.highlight"
      ? mapReaderHighlight
      : mapReaderSource;
  const result = mapping(config.account, row, {
    ...(change.item.source_id != null && { sourceId: change.item.source_id }),
    properties: change.item.properties,
  });
  if (result.textFiles.length > 0)
    throw new Refused(
      "Reader write readback requires content preservation before acknowledgment",
    );
  return result.entry;
}
function assertKind(change: Change, row: ReaderDocument): void {
  if (
    (change.item.type === "readwise.highlight") !==
      (row.category === "highlight") ||
    row.category === "note"
  )
    throw new Refused("Reader identity has a different document kind");
}
async function performChange(
  change: Change,
  context: Context,
): Promise<Entry | undefined> {
  const config = parseConfig(context.env);
  if (config.inboundOnly || change.kind === "trashed") return;
  if (!["readwise.source", "readwise.highlight"].includes(change.item.type))
    throw new Refused("unsupported Reader row type");
  const create = change.kind === "created";
  const props = change.item.properties;
  if (
    create
      ? props["reader_create"] !== true ||
        props["account"] !== config.account ||
        props["reader_id"] != null ||
        props["canonical_key"] != null
      : !isReaderManaged(change.item.type, props, config.account)
  )
    throw new Refused(
      "Reader does not own this row or its explicit create request",
    );
  if (change.kind === "purged" && !config.propagatePurge) return;
  const gate = approved.get(context);
  if (gate === undefined)
    throw new Refused(
      "Reader requires successful batch preflight before writes",
    );
  const { client } = gate;
  let held = context.outbound.get(change.item.id);
  const recovered = held !== undefined;
  if (held === undefined) {
    const updates = change.kind === "purged" ? {} : body(change);
    let operation: Plan;
    let baseline: JsonValue;
    if (create) {
      const highlight = change.item.type === "readwise.highlight";
      const request: ReaderBody = highlight
        ? {
            parent_id: string(props["reader_parent_id"]),
            content: string(props["text"]),
            ...updates,
          }
        : { url: string(props["url"]) };
      validateBody(request, highlight ? "highlight-create" : "source-create");
      if (highlight) {
        const parent = await client.document(String(request["parent_id"]));
        if (
          parent === undefined ||
          ["highlight", "note"].includes(parent.category)
        )
          throw new Refused(
            "Reader highlight parent is missing or not a document",
          );
      }
      const inventory = await completeInventory(client, context);
      const existing = highlight
        ? []
        : inventory.filter((row) => row.source_url === request["url"]);
      if (existing.length > 1)
        throw new Refused("Reader URL matches multiple documents");
      const previous = existing[0];
      baseline = {
        ids: inventory.map((row) => row.id),
        existing:
          previous === undefined
            ? null
            : {
                id: previous.id,
                fields: values(previous, Object.keys(updates)),
              },
      };
      operation = {
        account: config.account,
        base: config.readerBase,
        kind: highlight ? "highlight-create" : "source-create",
        id: "",
        body: request,
        updates: highlight ? {} : updates,
      };
    } else {
      const readerId = String(props["reader_id"]);
      if (change.kind === "purged" && !gate.purges.has(readerId))
        throw new Refused(
          "Reader purge was absent from the approved preflight",
        );
      const before = await client.document(readerId);
      if (before === undefined && change.kind !== "purged")
        throw new Refused(
          "Reader update target is missing; it is never recreated",
        );
      if (before !== undefined) assertKind(change, before);
      if (change.kind !== "purged" && Object.keys(updates).length === 0) return;
      baseline =
        before === undefined
          ? null
          : json(values(before, Object.keys(updates)));
      operation = {
        account: config.account,
        base: config.readerBase,
        kind: change.kind === "purged" ? "delete" : "update",
        id: readerId,
        body: change.kind === "purged" ? {} : updates,
        updates: {},
      };
    }
    held = await context.outbound.save(change, {
      request: json(operation),
      baseline,
    });
  }
  let operation = plan(held.request, config, held.change);
  validateBaseline(held.baseline, operation, held.change);
  if (held.acknowledged) return;
  const retryProvenNotApplied = held.requestNotApplied === true;
  if (retryProvenNotApplied)
    await context.outbound.prepareRetry(change.item.id, held.token);
  let readerId = operation.id;
  if (operation.kind === "delete") {
    if (!gate.purges.has(readerId))
      throw new Refused("Reader purge was absent from the approved preflight");
    if ((await client.document(readerId)) !== undefined)
      await client.delete(readerId);
    if ((await client.document(readerId)) !== undefined)
      throw new Unreachable("Reader deletion is not yet confirmed");
    await context.outbound.acknowledge(change.item.id, held.token);
    return;
  }
  if (operation.kind === "highlight-create") {
    if (
      !object(held.baseline) ||
      !Array.isArray(held.baseline["ids"]) ||
      held.baseline["ids"].some((value) => !id(value))
    )
      throw new Refused("invalid saved Reader highlight inventory");
    if (recovered && !retryProvenNotApplied) {
      const before = new Set(held.baseline["ids"]);
      const matches = (await completeInventory(client, context)).filter(
        (row) =>
          !before.has(row.id) &&
          row.category === "highlight" &&
          row.parent_id === operation.body["parent_id"] &&
          row.content === operation.body["content"] &&
          equal(
            values(
              row,
              Object.keys(operation.body).filter(
                (key) => !["parent_id", "content"].includes(key),
              ),
            ),
            Object.fromEntries(
              Object.entries(operation.body).filter(
                ([key]) => !["parent_id", "content"].includes(key),
              ),
            ),
          ),
      );
      if (matches.length !== 1)
        throw new Refused(
          "Reader highlight creation remains uncertain; no automatic retry or ambiguous adoption",
        );
      readerId = matches[0]?.id ?? "";
    } else readerId = await client.save(operation.body);
  } else if (operation.kind === "source-create") {
    const baseline = held.baseline;
    if (!object(baseline)) throw new Refused("invalid Reader create baseline");
    const previous = baseline["existing"];
    if (
      object(previous) &&
      id(previous["id"]) &&
      (await client.document(previous["id"])) === undefined
    )
      throw new Refused("Reader URL target is missing; it is never recreated");
    if (recovered) {
      const matches = (await completeInventory(client, context)).filter(
        (candidate) => candidate.source_url === operation.body["url"],
      );
      if (matches.length > 1)
        throw new Refused("Reader URL matches multiple documents");
      readerId = matches[0]?.id ?? (await client.save(operation.body));
    } else readerId = await client.save(operation.body);
  }
  let row = await client.document(readerId);
  if (row === undefined)
    throw new Refused("Reader write target is missing; it is never recreated");
  assertKind(held.change, row);
  if (
    operation.kind === "highlight-create" &&
    (row.parent_id !== operation.body["parent_id"] ||
      row.content !== operation.body["content"])
  )
    throw new Refused(
      "Reader creation confirmation does not match the saved highlight",
    );
  if (
    operation.kind === "source-create" &&
    row.source_url !== operation.body["url"]
  )
    throw new Refused(
      "Reader creation confirmation does not match the saved URL",
    );
  if (operation.kind === "source-create") {
    const previous = object(held.baseline) ? held.baseline["existing"] : null;
    const baseline = object(previous)
      ? previous["fields"]
      : values(row, Object.keys(operation.updates));
    validateBody(baseline, "source");
    if (
      (object(previous) && previous["id"] !== readerId) ||
      (!equal(values(row, Object.keys(operation.updates)), baseline) &&
        !equal(values(row, Object.keys(operation.updates)), operation.updates))
    )
      throw new Refused(
        "Reader fields changed after the saved baseline; pending intent retained",
      );
    held = await context.outbound.advance(change.item.id, held.token, {
      request: json({
        ...operation,
        kind: "source-create-update",
        id: readerId,
        body: operation.updates,
        updates: {},
      }),
      baseline: json(baseline),
    });
    operation = plan(held.request, config, held.change);
    row = await client.document(readerId);
    if (row === undefined)
      throw new Refused(
        "Reader update target is missing; it is never recreated",
      );
    assertKind(held.change, row);
  }
  const updates =
    operation.kind === "update" || operation.kind === "source-create-update"
      ? operation.body
      : operation.updates;
  if (
    Object.keys(updates).length > 0 &&
    !equal(values(row, Object.keys(updates)), updates)
  ) {
    validateBody(
      held.baseline,
      change.item.type === "readwise.highlight" ? "highlight" : "source",
    );
    if (!equal(values(row, Object.keys(updates)), held.baseline))
      throw new Refused(
        "Reader fields changed after the saved baseline; pending intent retained",
      );
    await client.update(readerId, updates);
    row = await client.document(readerId);
    if (row === undefined)
      throw new Unreachable("Reader update readback is missing");
    assertKind(held.change, row);
  }
  if (create)
    await context.setLink(
      held.change.item,
      readerIdentity(
        config.account,
        change.item.type === "readwise.highlight" ? "highlight" : "document",
        readerId,
      ),
    );
  const result = answer(held.change, row, config);
  await context.outbound.acknowledge(change.item.id, held.token, result);
  return result;
}

function mappedFailure(error: unknown): never {
  if (error instanceof RateLimited)
    throw new Unreachable(error.message, {
      scope: "Reader",
      retryAt: error.until,
    });
  throw error;
}
export async function preflight(
  inventory: { purges: readonly Change[] },
  context: Context,
): Promise<void> {
  try {
    await inspectPurges(inventory, context);
  } catch (error) {
    mappedFailure(error);
  }
}
export async function onChange(
  change: Change,
  context: Context,
): Promise<Entry | undefined> {
  try {
    return await performChange(change, context);
  } catch (error) {
    // A reconciliation refusal is not evidence that the saved request never applied.
    if (
      error instanceof Refused &&
      !(error instanceof ReaderWriteRefused) &&
      context.outbound.get(change.item.id) !== undefined
    )
      throw new Unreachable(error.message);
    mappedFailure(error);
  }
}
