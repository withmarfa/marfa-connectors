import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { causeOf, MarfaUnreachable, Refusal } from "../src/marfa.js";
import { Harness, testConnector, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One" } };
const minute = 60_000;

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function every(held: Vendor, interval: string): Promise<number> {
  return start(testConnector(held), harness.runtime(["--every", interval]));
}

function said(): string {
  return harness.lines.join("\n");
}

describe("what failed, by its cause", () => {
  it("says Marfa for a cut connection, a timeout, a 5xx and a rate limit", () => {
    expect(causeOf(new MarfaUnreachable("fetch failed"))).toBe("marfa");
    for (const status of [408, 429, 500, 502, 503]) {
      expect(causeOf(new Refusal(status, "x", "x"))).toBe("marfa");
    }
  });

  it("says Marfa when a vendor's error wraps what Marfa did", () => {
    const wrapped = new Error("the vendor call failed", {
      cause: new MarfaUnreachable("fetch failed"),
    });
    expect(causeOf(wrapped)).toBe("marfa");
  });

  it("says key for a 401 and registration for a missing connector, by status and code", () => {
    expect(causeOf(new Refusal(401, "unauthorized", "no"))).toBe("key");
    expect(causeOf(new Refusal(404, "connector_not_found", "gone"))).toBe(
      "registration",
    );
    expect(causeOf(new Refusal(404, "item_not_found", "gone"))).toBe("vendor");
  });

  it("does not read the text of an error", () => {
    expect(causeOf(new TypeError("fetch failed"))).toBe("vendor");
    expect(causeOf(new Error("503 unavailable"))).toBe("vendor");
    expect(causeOf(new Refusal(400, "validation_error", "401 503"))).toBe(
      "vendor",
    );
  });
});

describe("a key with whitespace around it", () => {
  it("is trimmed, for Marfa's and the vendor's", async () => {
    let token: string | undefined;
    const connector = testConnector(vendor([one]));
    const code = await start(
      {
        ...connector,
        run: async (context) => {
          token = context.env.TEST_TOKEN;
          await connector.run(context);
        },
      },
      harness.runtime(["--once"], {
        MARFA_KEY: `\n${harness.server.key}\n`,
        MARFA_URL: ` ${harness.server.url} `,
        TEST_TOKEN: "  tok_vendor_secret_value\t",
      }),
    );
    expect(code).toBe(0);
    expect(token).toBe("tok_vendor_secret_value");
    expect(harness.server.rows).toHaveLength(1);
  });
});

describe("a key the server refuses", () => {
  it("stops a start with a message that names MARFA_KEY and what to do", async () => {
    harness.server.revoked = true;
    expect(await harness.once(vendor([one]))).toBe(1);
    expect(said()).toContain("MARFA_KEY");
    expect(said()).toContain("revoked");
    expect(said()).toContain("mint");
    expect(harness.server.rows).toEqual([]);
  });

  it("stops a connector running under --every at once, with the key named, where it backed off before", async () => {
    const held = vendor([one]);
    const exit = every(held, "15m");
    await harness.clock.sleeping(15 * minute);
    harness.server.revoked = true;
    await harness.clock.wake(minute);
    expect(await exit).toBe(1);
    expect(said()).toContain("MARFA_KEY");
    expect(held.runs).toBe(1);
    expect(harness.clock.requested).not.toContain(30 * minute);
  });

  it("stops a run in flight whose key is revoked, and exits 1", async () => {
    const held = vendor([one]);
    let open!: () => void;
    held.gate = new Promise((resolve) => {
      open = resolve;
    });
    const exit = harness.once(held);
    await until(() => held.runs === 1);
    harness.server.revoked = true;
    await harness.clock.wake(minute);
    open();
    expect(await exit).toBe(1);
    expect(said()).toContain("MARFA_KEY");
  });
});

describe("a registration the server lost", () => {
  it("is registered again, and the connector goes on running", async () => {
    const held = vendor([one]);
    const exit = every(held, "15m");
    await harness.clock.sleeping(15 * minute);
    expect(harness.server.registrations).toBe(1);
    harness.server.lost = true;
    await harness.clock.wake(minute);
    await until(() => harness.server.registrations === 2);
    await until(() => harness.server.runs.length === 2);
    expect(said()).toContain("registered again");
    expect(harness.lastRun().outcome).toBe("succeeded");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("stops a --once run in flight, exiting 1 and saying so", async () => {
    const held = vendor([one]);
    let open!: () => void;
    held.gate = new Promise((resolve) => {
      open = resolve;
    });
    const exit = harness.once(held);
    await until(() => held.runs === 1);
    harness.server.lost = true;
    await harness.clock.wake(minute);
    open();
    expect(await exit).toBe(1);
    expect(said()).toContain("registration");
  });

  it("is not registered again and again where the server keeps losing it", async () => {
    const held = vendor([one]);
    const exit = every(held, "15m");
    await harness.clock.sleeping(15 * minute);
    harness.server.lost = true;
    await harness.clock.wake(minute);
    await until(() => harness.server.registrations === 2);
    await harness.clock.sleeping(15 * minute);
    harness.server.lost = true;
    await harness.clock.wake(minute);
    expect(await exit).toBe(1);
    expect(harness.server.registrations).toBe(2);
    expect(said()).toContain("keeps losing");
  });
});

describe("a rate limit", () => {
  it("is waited out for the time Retry-After names, where it is longer than the usual wait", async () => {
    harness.server.refuseNext(
      "POST /connectors",
      429,
      "rate_limited",
      "slow down",
      "300",
    );
    const held = vendor([one]);
    const exit = every(held, "24h");
    await harness.clock.wake(300_000);
    await harness.clock.sleeping(24 * 60 * minute);
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("a run that failed because Marfa was unreachable", () => {
  it("checks cheaply, and runs again as soon as Marfa answers, not after the backoff", async () => {
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.sleeping(10 * minute);
    harness.server.refuseNext(
      "GET /connectors/connector-1/state",
      503,
      "unavailable",
    );
    await harness.clock.wake(10 * minute);
    await until(() => harness.server.runs.length === 2);
    expect(harness.server.runs[1]?.outcome).toBe("failed");
    harness.server.refuseNext(
      "POST /connectors/connector-1/heartbeat",
      503,
      "unavailable",
    );
    await harness.clock.wake(15_000);
    await harness.clock.wake(15_000);
    await until(() => harness.server.runs.length === 3);
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(harness.clock.requested).not.toContain(20 * minute);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("backs off as before where Marfa answers and the run fails again for it", async () => {
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.sleeping(10 * minute);
    for (let times = 0; times < 2; times += 1) {
      harness.server.refuseNext(
        "GET /connectors/connector-1/state",
        503,
        "unavailable",
      );
    }
    await harness.clock.wake(10 * minute);
    await harness.clock.wake(15_000);
    await until(() => harness.server.runs.length === 3);
    await harness.clock.sleeping(40 * minute);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("keeps the backoff for a failure that only says fetch failed in the vendor's own words, and looks for nothing", async () => {
    const held = vendor([one]);
    held.fail = new Error("fetch failed");
    const exit = every(held, "10m");
    await harness.clock.sleeping(20 * minute);
    expect(harness.clock.requested).not.toContain(15_000);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("is waited on while Marfa stays down, and stops at once when told to", async () => {
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.sleeping(10 * minute);
    harness.server.refuseNext(
      "GET /connectors/connector-1/state",
      503,
      "unavailable",
    );
    await harness.clock.wake(10 * minute);
    await harness.clock.sleeping(15_000);
    harness.stop();
    expect(await exit).toBe(0);
  });
});
