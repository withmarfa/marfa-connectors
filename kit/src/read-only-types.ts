import type { Spec } from "./rows.js";

/** The types this connector writes into Marfa but takes no edits back for,
 *  so that an edit made in Marfa is put back on the next run: every type
 *  that is not carried back (`carries`, and `onChange` at all). Worked out
 *  from the running configuration, since `carries` may read it. A type
 *  carried back is not listed, even where some of its fields or rows are
 *  held read only. A connector declares at most ten types, far under the
 *  1,000 a registration may name. */
export function readOnlyTypesOf(specs: Iterable<Spec>): string[] {
  return [
    ...new Set([...specs].filter((spec) => !spec.twoWay).map((s) => s.type)),
  ];
}
