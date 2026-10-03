import { createHash } from "node:crypto";
import type { Entry, InboundEntry, PendingInbound } from "./define.js";
import { cleaned, instant } from "./values.js";

export interface UpsertAttempt {
  intent: ReturnType<typeof intentOf>;
  fingerprint: string;
  context: string;
  identity: PendingInbound["identity"];
}

export function checkedJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value))
    throw new Error("retry intent must be lossless JSON");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("retry intent must be lossless JSON");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error("retry intent must be lossless JSON");
  seen.add(value);
  try {
    return Array.isArray(value)
      ? Array.from(value, (item) => checkedJson(item, seen))
      : Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, checkedJson(item, seen)]),
        );
  } finally {
    seen.delete(value);
  }
}
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(checkedJson(value)))
    .digest("hex");
}
export function intentOf(
  type: string,
  entry: Entry,
): { operation: "upsert"; type: string; entry: InboundEntry } {
  if (entry.file !== undefined)
    throw new Error("file retry intent is not reconstructable JSON");
  if (typeof entry.source_id !== "string" || entry.source_id.length === 0)
    throw new Error("retry identity needs a source ID");
  const allowed = new Set([
    "source_id",
    "properties",
    "occurred_at",
    "changed_at",
    "movedFrom",
    "connections",
    "file",
  ]);
  if (Object.keys(entry).some((key) => !allowed.has(key)))
    throw new Error("retry entry contains unknown operation fields");
  return checkedJson({
    operation: "upsert",
    type,
    entry: {
      source_id: entry.source_id,
      properties: cleaned(entry.properties),
      ...(entry.occurred_at !== undefined && {
        occurred_at: instant(entry.occurred_at),
      }),
      ...(entry.changed_at !== undefined && {
        changed_at: instant(entry.changed_at),
      }),
      ...(entry.movedFrom !== undefined && { movedFrom: entry.movedFrom }),
      ...(entry.connections !== undefined && {
        connections: entry.connections,
      }),
    },
  }) as { operation: "upsert"; type: string; entry: InboundEntry };
}
export function identityKey(type: string, sourceId: string): string {
  return JSON.stringify([type, sourceId]);
}
export function fitsJournal(records: readonly PendingInbound[]): boolean {
  return (
    records.length <= 128 &&
    Buffer.byteLength(JSON.stringify(records), "utf8") <= 64 * 1024
  );
}
export function readJournal(value: unknown): PendingInbound[] {
  if (value === undefined) return [];
  checkedJson(value);
  if (!Array.isArray(value) || !fitsJournal(value as PendingInbound[]))
    throw new Error("invalid inbound retry journal bounds");
  const identities = new Set<string>();
  for (const raw of value) {
    const record = raw as Record<string, unknown> | null;
    const identity = record?.["identity"] as
      Record<string, unknown> | undefined;
    if (
      record?.["operation"] !== "upsert" ||
      typeof record["scope"] !== "string" ||
      record["scope"].length === 0 ||
      typeof identity?.["type"] !== "string" ||
      identity["type"].length === 0 ||
      typeof identity["sourceId"] !== "string" ||
      identity["sourceId"].length === 0 ||
      (identity["link"] !== undefined && typeof identity["link"] !== "string")
    )
      throw new Error("invalid inbound retry identity");
    for (const name of ["fingerprint", "context"])
      if (
        typeof record[name] !== "string" ||
        !/^[a-f0-9]{64}$/.test(record[name])
      )
        throw new Error("invalid inbound retry digest");
    for (const name of ["attemptedAt", "dueAt"])
      if (
        typeof record[name] !== "string" ||
        !Number.isFinite(Date.parse(record[name]))
      )
        throw new Error("invalid inbound retry time");
    if (
      !["invalid_properties", "request_too_large"].includes(
        String(record["code"]),
      ) ||
      typeof record["reason"] !== "string" ||
      !["refetch", "replay"].includes(String(record["mode"]))
    )
      throw new Error("invalid inbound retry record");
    const key = identityKey(identity["type"], identity["sourceId"]);
    if (identities.has(key))
      throw new Error("duplicate inbound retry identity");
    identities.add(key);
    if (record["mode"] === "replay") {
      const saved = record["intent"] as Record<string, unknown> | undefined;
      if (
        saved?.["operation"] !== "upsert" ||
        saved["type"] !== identity["type"]
      )
        throw new Error("invalid inbound replay operation");
      const intent = intentOf(identity["type"], saved["entry"] as Entry);
      if (
        intent.entry.source_id !== identity["sourceId"] ||
        digest(intent) !== record["fingerprint"]
      )
        throw new Error("invalid inbound replay intent");
    }
  }
  return structuredClone(value as PendingInbound[]);
}
