/**
 * The proof is a list of groups, each a function of `scripts/proof/` that
 * makes its statements against a booted server, and a CI run splits the list
 * into shards that each boot a server of their own. This file is the list's
 * data and the split, with nothing that boots or runs.
 *
 * A group belongs to exactly one shard, and it is the same one in every
 * process: the split depends only on the names and the weights below. A group
 * with no `seconds` is weighed at `unmeasuredSeconds`, so adding one needs
 * nothing more than its entry here and its runner in `main.ts`.
 */

/** Where a group makes its statements. */
export type Instance =
  /** The server every group but the Reader fixture shares. */
  | "shared"
  /** A server of its own, which the Reader fixture needs empty. */
  | "reader";

export interface Group {
  name: string;
  instance: Instance;
  /** The statements the group makes, which `main.ts` checks after it runs. */
  statements: number;
  /**
   * Seconds the group took in the CI run of 31 October 2026, 18:12 UTC, for
   * the split to weigh; refresh it when a group's time changes a lot.
   */
  seconds?: number;
}

/** What a shard that boots the shared server states before any group. */
export const setupStatements = 3;

/**
 * Seconds a group with no measured time is weighed at: more than most, so an
 * unmeasured group does not crowd a shard the measured ones already fill.
 */
export const unmeasuredSeconds = 60;

/** In the order the groups run within a shard. */
export const GROUPS = [
  { name: "adoption", instance: "shared", statements: 3, seconds: 2 },
  { name: "rss", instance: "shared", statements: 14, seconds: 98 },
  { name: "readwise", instance: "shared", statements: 6, seconds: 2 },
  { name: "todoist", instance: "shared", statements: 31, seconds: 11 },
  { name: "inbound", instance: "shared", statements: 11, seconds: 4 },
  { name: "keys", instance: "shared", statements: 6, seconds: 1 },
  { name: "tracker", instance: "shared", statements: 18, seconds: 15 },
  { name: "github", instance: "shared", statements: 18, seconds: 486 },
  { name: "github-coverage", instance: "shared", statements: 5, seconds: 62 },
  { name: "github-relations", instance: "shared", statements: 1, seconds: 45 },
  {
    name: "connection-evolution",
    instance: "shared",
    statements: 1,
    seconds: 1,
  },
  { name: "github-pulls", instance: "shared", statements: 1, seconds: 18 },
  { name: "parent-of", instance: "shared", statements: 1, seconds: 2 },
  { name: "checkpoint", instance: "shared", statements: 9, seconds: 20 },
  { name: "watch-checkpoint", instance: "shared", statements: 6, seconds: 19 },
  { name: "outbound", instance: "shared", statements: 1, seconds: 2 },
  { name: "inbound-retry", instance: "shared", statements: 6, seconds: 9 },
  { name: "retry-archive", instance: "shared", statements: 1, seconds: 1 },
  { name: "readwise-reader", instance: "reader", statements: 12, seconds: 120 },
] as const satisfies readonly Group[];

export type GroupName = (typeof GROUPS)[number]["name"];

/** The groups of shard `index` (from 1) of `count`, in the order they run. */
export function shardOf<T extends { name: string; seconds?: number }>(
  groups: readonly T[],
  index: number,
  count: number,
): T[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${String(count)} shards is not a count`);
  }
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new Error(`shard ${String(index)} is not one of ${String(count)}`);
  }
  const weight = (group: T): number => group.seconds ?? unmeasuredSeconds;
  // Longest first onto the lightest shard. Ties break on the name and the
  // lowest shard, so the answer never depends on the order of the list.
  const heaviestFirst = [...groups].sort(
    (a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name),
  );
  const loads = Array.from({ length: count }, () => 0);
  const mine = new Set<string>();
  for (const group of heaviestFirst) {
    let lightest = 0;
    for (let at = 1; at < count; at++) {
      if ((loads[at] ?? 0) < (loads[lightest] ?? 0)) lightest = at;
    }
    loads[lightest] = (loads[lightest] ?? 0) + weight(group);
    if (lightest === index - 1) mine.add(group.name);
  }
  return groups.filter((group) => mine.has(group.name));
}

/** `2/3` is shard 2 of 3. */
export function parseShard(text: string): { index: number; count: number } {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${text} is not a shard such as 2/3`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) throw new Error(`${text} is not a shard such as 2/3`);
  return { index, count };
}
