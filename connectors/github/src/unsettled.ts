import type { State } from "@withmarfa/connector";

const key = "unsettled";

/** Every repository, where it is not known which a create may be in. */
export const everywhere = "*";

/** A repository where a create GitHub may have made waits to be found by its
 *  mark is not read this run, so what it made is never read in as a row of
 *  its own. */
export function unsettle(state: State, node: string): void {
  const held = state.get(key);
  const nodes = Array.isArray(held)
    ? held.filter((one): one is string => typeof one === "string")
    : [];
  state.set(key, [...new Set([...nodes, node])]);
}

/** What creates this run left unsettled, cleared for the next. */
export function takeUnsettled(state: State): Set<string> {
  const held = state.get(key);
  state.set(key, undefined);
  return new Set(
    Array.isArray(held)
      ? held.filter((one): one is string => typeof one === "string")
      : [],
  );
}
