import { createHash } from "node:crypto";

/** The properties a write sends: a key that is absent or `null` is cleared. */
export function cleaned(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

/** A short name for a value's content: keys in one order, nulls and absent keys alike. */
export function fingerprint(value: unknown): string {
  return createHash("sha1").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, held]) => held !== undefined && held !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined || value === null ? "null" : JSON.stringify(value);
}

/**
 * A time in the one form every row's own time is written in when it parses;
 * one that doesn't, such as a vendor's own spelling, is passed on for the server to judge.
 */
export function instant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}
