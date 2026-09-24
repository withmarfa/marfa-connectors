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

/** Equal as JSON, whatever order an object's keys arrive in. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => same(value, b[index]))
    );
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = new Map(
    Object.entries(b).filter(([, value]) => value !== undefined),
  );
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && same(value, right.get(key)))
  );
}

/** Two spellings of one instant are the same time. */
export function sameInstant(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const left = Date.parse(a);
  return Number.isNaN(left) ? a === b : left === Date.parse(b);
}
