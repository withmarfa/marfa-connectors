import { createHash } from "node:crypto";

export function cleaned(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

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

export function instant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}
