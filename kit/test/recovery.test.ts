import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../src/main.js";
import {
  causeOf,
  faultOf,
  marfaFetch,
  MarfaAddress,
  MarfaUnreachable,
  Refusal,
} from "../src/marfa.js";
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
    expect(causeOf(new Refusal(404, "item_not_found", "gone"))).toBe("refused");
  });

  it("says registration for a type of the connector's own the server no longer holds, on a whole call or one entry of a bulk write", () => {
    for (const status of [400, undefined]) {
      expect(causeOf(new Refusal(status, "unknown_type", "gone"))).toBe(
        "registration",
      );
    }
  });

  it("does not read the text of an error", () => {
    expect(causeOf(new TypeError("fetch failed"))).toBe("run");
    expect(causeOf(new Error("503 unavailable"))).toBe("run");
    expect(causeOf(new Refusal(400, "validation_error", "401 503"))).toBe(
      "refused",
    );
  });

  it("says address for an address that cannot be used", () => {
    expect(causeOf(new MarfaAddress("fetch failed"))).toBe("address");
  });
});

describe("a call that gets no answer, by what the transport says", () => {
  async function failing(
    message: string,
    cause: { code?: string; message?: string } | undefined,
  ): Promise<unknown> {
    const error = new TypeError(message, {
      cause:
        cause === undefined
          ? undefined
          : Object.assign(new Error(cause.message ?? "x"), cause),
    });
    vi.stubGlobal("fetch", () => Promise.reject(error));
    try {
      return await marfaFetch(1000)("http://marfa.test/").catch(
        (thrown: unknown) => thrown,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("is unreachable for a refused or cut connection and a temporary DNS failure", async () => {
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
    ]) {
      const thrown = await failing("fetch failed", { code });
      expect(thrown).toBeInstanceOf(MarfaUnreachable);
      expect(causeOf(thrown)).toBe("marfa");
    }
  });

  it("is an address that cannot be used for a redirect and a malformed URL", async () => {
    for (const cause of [
      { message: "unexpected redirect" },
      { code: "ERR_INVALID_URL" },
    ]) {
      const thrown = await failing("fetch failed", cause);
      expect(thrown).toBeInstanceOf(MarfaAddress);
      expect(causeOf(thrown)).toBe("address");
    }
  });

  it("is a fault a start refuses and a running connector waits out, for a host not found, a certificate and a TLS error", async () => {
    for (const code of [
      "ENOTFOUND",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "EPROTO",
    ]) {
      const thrown = await failing("fetch failed", { code });
      expect(thrown).toBeInstanceOf(MarfaUnreachable);
      expect(causeOf(thrown)).toBe("marfa");
      expect(faultOf(thrown)).toEqual(expect.any(String));
    }
    const refused = await failing("fetch failed", { code: "ECONNREFUSED" });
    expect(faultOf(refused)).toBeUndefined();
  });
});

describe("an address that cannot be used", () => {
  it("refuses a start at once under --every, naming MARFA_URL, where it was retried for ever", async () => {
    const redirecting = createServer((_request, response) => {
      response.writeHead(302, { Location: "http://elsewhere.invalid/" });
      response.end();
    });
    await new Promise<void>((done) => redirecting.listen(0, "127.0.0.1", done));
    const { port } = redirecting.address() as AddressInfo;
    try {
      const code = await start(
        testConnector(vendor([one])),
        harness.runtime(["--every", "5m"], {
          MARFA_URL: `http://127.0.0.1:${String(port)}`,
        }),
      );
      expect(code).toBe(2);
      expect(said()).toContain("MARFA_URL");
      expect(said()).toContain("redirect");
    } finally {
      redirecting.closeAllConnections();
      await new Promise((done) => redirecting.close(done));
    }
  });

  it("refuses a start where the host is not found or the certificate is refused, under either schedule", async () => {
    for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "EPROTO"]) {
      vi.stubGlobal("fetch", () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error(code), { code }),
          }),
        ),
      );
      try {
        for (const argv of [["--once"], ["--every", "5m"]]) {
          harness.lines.length = 0;
          expect(
            await start(testConnector(vendor([one])), harness.runtime(argv)),
          ).toBe(2);
          expect(said()).toContain("MARFA_URL");
          expect(said()).toContain(code);
        }
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("is waited out by a running connector, with a warning that names MARFA_URL and the cause", async () => {
    const real = fetch;
    let broken = false;
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) =>
      broken
        ? Promise.reject(
            new TypeError("fetch failed", {
              cause: Object.assign(new Error("expired"), {
                code: "CERT_HAS_EXPIRED",
              }),
            }),
          )
        : real(...args),
    );
    try {
      const exit = every(vendor([one]), "10m");
      await harness.clock.sleeping(10 * minute);
      broken = true;
      await harness.clock.wake(minute);
      await until(() => said().includes("CERT_HAS_EXPIRED"));
      expect(said()).toContain("MARFA_URL");
      broken = false;
      harness.stop();
      expect(await exit).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("a type of the connector's the server lost", () => {
  it("is registered again, and the connector goes on writing its rows", async () => {
    const held = vendor([one]);
    const exit = every(held, "15m");
    await harness.clock.sleeping(15 * minute);
    const registered = () => harness.server.requestsTo("POST", "/types").length;
    expect(registered()).toBe(1);
    harness.server.types.delete("test.entry");
    held.entries = [one, { source_id: "a:2", properties: { title: "Two" } }];
    await harness.clock.wake(15 * minute);
    await until(() => registered() === 2);
    await until(() => harness.server.rows.length === 2);
    await until(() => harness.lastRun().outcome === "succeeded");
    expect(said()).toContain("registered again");
    expect(harness.server.runs.map((run) => run.outcome)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(harness.server.runs[1]?.error).toContain("unknown_type");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("deleted while a bulk write is on its way is registered again, not its rows held", async () => {
    const held = vendor([one]);
    const exit = every(held, "15m");
    await harness.clock.sleeping(15 * minute);
    harness.server.beforeAnswer = (request) => {
      if (request.path === "/items/bulk") {
        harness.server.types.delete("test.entry");
        harness.server.beforeAnswer = undefined;
      }
    };
    held.entries = [one, { source_id: "a:2", properties: { title: "Two" } }];
    await harness.clock.wake(15 * minute);
    await until(() => harness.server.rows.length === 2);
    await until(() => harness.lastRun().outcome === "succeeded");
    expect(harness.server.runs[1]?.error).toContain("unknown_type");
    harness.stop();
    expect(await exit).toBe(0);
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

  it("asks once for a run a Marfa that answers still fails, and gives it no more load than the backoff after that", async () => {
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.sleeping(10 * minute);
    for (let times = 0; times < 3; times += 1) {
      harness.server.refuseNext(
        "GET /connectors/connector-1/state",
        503,
        "unavailable",
      );
    }
    await harness.clock.wake(10 * minute);
    await harness.clock.wake(15_000);
    await harness.clock.wake(40 * minute);
    await until(() => harness.server.runs.length === 4);
    // The third failure in a row waits the full eight intervals, and does not ask.
    await harness.clock.sleeping(80 * minute);
    expect(harness.clock.requested.filter((ms) => ms === 15_000)).toHaveLength(
      1,
    );
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("waits at least what Retry-After names on a run's own door before it asks, where a probe would have come sooner", async () => {
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.sleeping(10 * minute);
    harness.server.refuseNext(
      "GET /connectors/connector-1/state",
      429,
      "rate_limited",
      "slow down",
      "120",
    );
    await harness.clock.wake(10 * minute);
    await harness.clock.sleeping(120_000);
    expect(harness.clock.requested).not.toContain(15_000);
    await harness.clock.wake(120_000);
    await until(() => harness.server.runs.length === 3);
    expect(harness.lastRun().outcome).toBe("succeeded");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("spreads its asks, and the first run after an answer, so connectors do not arrive together", async () => {
    harness.random = () => 0.5;
    const held = vendor([one]);
    const exit = every(held, "10m");
    await harness.clock.sleeping(10 * minute);
    harness.server.refuseNext(
      "GET /connectors/connector-1/state",
      503,
      "unavailable",
    );
    await harness.clock.wake(10 * minute);
    await harness.clock.wake(16_500);
    await harness.clock.wake(2500);
    await until(() => harness.server.runs.length === 3);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("is the cause of a run fenced because Marfa did not answer its renewals", async () => {
    const held = vendor([one]);
    let open!: () => void;
    held.gate = new Promise((resolve) => {
      open = resolve;
    });
    const exit = every(held, "10m");
    await until(() => held.runs === 1);
    for (let beat = 1; beat <= 3; beat += 1) {
      harness.server.refuseNext(
        "POST /connectors/connector-1/hold",
        503,
        "unavailable",
      );
      await harness.clock.wake(minute);
      await until(
        () =>
          harness.lines.filter((line) => line.includes("could not be renewed"))
            .length === beat,
      );
    }
    held.gate = undefined;
    open();
    await until(() => harness.server.runs.length === 1);
    expect(harness.lastRun().outcome).toBe("failed");
    await harness.clock.sleeping(15_000);
    expect(harness.clock.requested).not.toContain(20 * minute);
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
