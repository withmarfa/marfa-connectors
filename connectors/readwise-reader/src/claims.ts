import type { OutboundIntent } from "@withmarfa/connector";
import { readerIdentity } from "@withmarfa/readwise";

/**
 * Reader objects a create made for a row that a trash or purge then
 * overtook, by the row's ID. Marfa cannot link a row in the bin or keep a
 * tombstone for a purged row that was never linked, so the connector keeps
 * the claim itself: the import skips what is claimed, and a restored row
 * takes its claimed object back instead of creating another.
 */
export const claimsKey = "claims";
export const claimLimit = 1000;

export function readClaims(value: unknown): Map<string, string> {
  if (value === undefined) return new Map();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, entry]) =>
        key.length === 0 || typeof entry !== "string" || entry.length === 0,
    ) ||
    Object.keys(value).length > claimLimit
  )
    throw new Error("Reader claims are invalid");
  return new Map(Object.entries(value as Record<string, string>));
}

export function claimKind(type: string): "document" | "highlight" {
  return type === "readwise.highlight" ? "highlight" : "document";
}

/** The claim a pending settlement step records, before the sync keeps it. */
export function pendingClaim(
  intent: OutboundIntent,
  account: string,
): [string, string] | undefined {
  if (
    intent.acknowledged ||
    intent.request === null ||
    typeof intent.request !== "object" ||
    Array.isArray(intent.request)
  )
    return undefined;
  const request = intent.request as Readonly<Record<string, unknown>>;
  if (
    request["kind"] !== "claim" ||
    request["account"] !== account ||
    typeof request["id"] !== "string"
  )
    return undefined;
  return [
    intent.change.item.id,
    readerIdentity(account, claimKind(intent.change.item.type), request["id"]),
  ];
}

/** The Reader ID a claim names, if it is of this kind and account. */
export function claimedId(
  canonical: string | undefined,
  account: string,
  kind: "document" | "highlight",
): string | undefined {
  const prefix = `${account}:reader-${kind}:`;
  return canonical?.startsWith(prefix)
    ? canonical.slice(prefix.length)
    : undefined;
}
