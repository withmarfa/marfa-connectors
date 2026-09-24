import { describe, expect, it } from "vitest";
import { systemClock } from "../src/runtime.js";

function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => {
        resolve(false);
      }, ms),
    ),
  ]);
}

describe("the system clock", () => {
  it("sleeps for as long as it is asked, past the longest delay a timer holds", async () => {
    const short = new AbortController();
    expect(await settledWithin(systemClock.sleep(5, short.signal), 200)).toBe(
      true,
    );

    const long = new AbortController();
    const sleeping = systemClock.sleep(2 ** 31 + 5000, long.signal);
    expect(await settledWithin(sleeping, 50)).toBe(false);
    long.abort();
    expect(await settledWithin(sleeping, 50)).toBe(true);
  });
});
