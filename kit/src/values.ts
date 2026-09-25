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

/**
 * Equal as JSON, whatever order an object's keys arrive in. A key holding
 * `null` is a key the object does not have: a write clears what it sends
 * as `null`, and a row a person's client wrote `null` onto is not changed
 * by an entry that leaves the key out.
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => same(value, b[index]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || b === null) {
    return false;
  }
  const held = ([, value]: [string, unknown]): boolean =>
    value !== undefined && value !== null;
  const left = Object.entries(a).filter(held);
  const right = new Map(Object.entries(b).filter(held));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && same(value, right.get(key)))
  );
}

/**
 * A time in the one form every row's own time is written in. A vendor's
 * spelling, RFC 822 or a microsecond timestamp, is otherwise stored as
 * sent. One that does not parse is passed on for the server to judge.
 */
export function instant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/** Two spellings of one instant are the same time. */
export function sameInstant(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const left = Date.parse(a);
  return Number.isNaN(left) ? a === b : left === Date.parse(b);
}
