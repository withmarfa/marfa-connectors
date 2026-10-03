import { expect, it, vi } from "vitest";
import { Hold } from "../src/hold.js";
import { Logger } from "../src/log.js";
import type { Marfa } from "../src/marfa.js";
import { ManualClock } from "./harness.js";

it.each([1000, 1001, 5000, 1, 12, 180000])(
  "uses a valid integer renewal timeout within the share of a %i ms hold",
  async (ttl) => {
    const clock = new ManualClock();
    const lines: string[] = [];
    const signals: AbortSignal[] = [];
    const marfa = {
      hold: (_id: string, _process: string, signal: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve({
          elsewhere: false,
          renewed: true,
          until: new Date(clock.now().getTime() + ttl).toISOString(),
          ttlMs: ttl,
        });
      },
    } as unknown as Marfa;
    const hold = new Hold(
      marfa,
      "connector",
      "process",
      new Logger((line) => lines.push(line), clock),
      clock,
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(await hold.take()).toEqual({ held: true });
      expect(await hold.renew()).toBeUndefined();
      expect({ calls: signals.length, diagnostics: lines }).toEqual({
        calls: 2,
        diagnostics: [],
      });
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(Math.floor(ttl / 12));
      expect(signals[1]?.aborted).toBe(false);
      if (ttl === 1) {
        await new Promise((done) => setTimeout(done, 5));
        expect(signals[1]?.aborted).toBe(true);
      }
    } finally {
      hold.abandon();
      timeout.mockRestore();
    }
  },
);
