import { describe, expect, it } from "vitest";
import type { ScriptedServer } from "./scripted-server.js";

/** The most a quiet run's requests to Marfa may grow for each row held. */
export const rowsPerRequest = 200;

/** A connector, its vendor holding `size` of its items, ready to run. */
export interface Held {
  readonly marfa: ScriptedServer;
  /** One run of the connector, which throws if it fails. */
  run(): Promise<void>;
  stop(): Promise<void>;
}

export interface QuietRun {
  /** Starts Marfa and the vendor, the vendor holding `size` items. */
  hold(size: number): Promise<Held>;
  /** Two sizes, the larger holding a few hundred rows more in Marfa. */
  sizes: readonly [number, number];
  /** Runs the first sync takes before a run finds nothing new. */
  settle?: number;
}

/** The requests one run sends to Marfa once nothing changed at the vendor,
 *  and the rows Marfa then holds. */
export async function quietCost(
  connector: QuietRun,
  size: number,
): Promise<{ requests: number; rows: number; asked: string[] }> {
  const held = await connector.hold(size);
  try {
    for (let at = 0; at < (connector.settle ?? 2); at += 1) await held.run();
    const before = held.marfa.requests.length;
    await held.run();
    const asked = held.marfa.requests
      .slice(before)
      .map(
        (one) =>
          `${one.method} ${one.path.replace(/\/[0-9a-f-]{16,}/g, "/{id}")}`,
      );
    return {
      requests: asked.length,
      rows: held.marfa.rows.length,
      asked,
    };
  } finally {
    await held.stop();
  }
}

/**
 * The test every connector runs: a run that finds nothing new at the vendor
 * sends Marfa no more than one request more for each 200 rows Marfa holds,
 * so what it asks costs little however much the connector has written.
 */
export function quietRun(connector: QuietRun): void {
  describe("a run with nothing new at the vendor", () => {
    it("sends Marfa few requests, whatever it holds", async () => {
      const [small, large] = await Promise.all(
        connector.sizes.map((size) => quietCost(connector, size)),
      );
      if (small === undefined || large === undefined) throw new Error("none");
      expect(large.rows - small.rows).toBeGreaterThanOrEqual(rowsPerRequest);
      expect(
        large.requests - small.requests,
        `${String(small.requests)} requests at ${String(small.rows)} rows, ${String(large.requests)} at ${String(large.rows)}: ${tally(large.asked)}`,
      ).toBeLessThanOrEqual((large.rows - small.rows) / rowsPerRequest);
    }, 120_000);
  });
}

function tally(asked: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const one of asked) counts.set(one, (counts.get(one) ?? 0) + 1);
  return [...counts]
    .sort(([, a], [, b]) => b - a)
    .map(([one, count]) => `${String(count)} ${one}`)
    .join(", ");
}
