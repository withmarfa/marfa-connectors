import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Harness,
  secretToken,
  signed,
  vendor,
  type Vendor,
} from "./harness.js";

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

function outcomes(): (string | null)[] {
  return harness.server.deliveries.map((delivery) => delivery.outcome);
}

/** The looks between scheduled runs, told from a run's listing by their limit. */
function looks() {
  return harness.server
    .requestsTo("GET", "/connectors/connector-1/deliveries")
    .filter((request) => request.query.get("limit") === "1");
}

describe("deliveries a scheduled run takes", () => {
  it("reads everything, and marks the verified deliveries processed once the run's writes land", async () => {
    const first = signed({ ids: ["a:1"] });
    const second = signed({ ids: ["a:2"] });
    harness.server.deliver(first.body, first.headers);
    harness.server.deliver(second.body, second.headers);
    const held = vendor([one]);

    expect(await harness.inbound(held)).toBe(0);
    expect(held.hints).toEqual([undefined]);
    expect(outcomes()).toEqual(["processed", "processed"]);
    expect(harness.lastRun().summary).toContain(
      "deliveries processed 2, rejected 0, duplicate 0",
    );
  });

  it("marks a delivery that fails its signature rejected at once, and says why", async () => {
    const forged = signed({ ids: ["a:1"] }, "not the token");
    harness.server.deliver(forged.body, forged.headers);
    harness.server.deliver('{"ids":["a:1"]}');
    const held = vendor([one]);
    held.fail = new Error("the vendor answered 502");

    expect(await harness.inbound(held)).toBe(1);
    expect(outcomes()).toEqual(["rejected", "rejected"]);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.summary).toContain("rejected 2");
    expect(run.summary).toContain("2 deliveries failed the signature check");
  });

  it("marks a repeat of a processed delivery a duplicate, and a repeat of a forged one it verifies as fresh", async () => {
    const real = signed({ ids: ["a:1"] });
    const forged = signed({ ids: ["a:1"] }, "not the token");
    const processed = harness.server.deliver(real.body, real.headers);
    processed.handled_at = "2026-09-25T00:00:00.000Z";
    processed.outcome = "processed";
    const shown = harness.server.deliver(forged.body, forged.headers);
    harness.server.deliver(real.body, real.headers, processed.id);
    harness.server.deliver(real.body, real.headers, shown.id);
    const held = vendor([one]);

    expect(await harness.inbound(held)).toBe(0);
    expect(outcomes()).toEqual([
      "processed",
      "rejected",
      "duplicate",
      "processed",
    ]);
    expect(harness.lastRun().summary).toContain(
      "deliveries processed 1, rejected 1, duplicate 1",
    );
  });

  it("leaves the deliveries of a run that fails waiting, and the next run takes them", async () => {
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    const held = vendor([one]);
    held.fail = new Error("the vendor answered 502");

    expect(await harness.inbound(held)).toBe(1);
    expect(outcomes()).toEqual([null]);
    expect(harness.lastRun().summary).toContain("deliveries processed 0");

    held.fail = undefined;
    expect(await harness.inbound(held)).toBe(0);
    expect(outcomes()).toEqual(["processed"]);
  });

  it("says how to make an endpoint when none is live", async () => {
    harness.server.endpoints = [
      { id: "endpoint-1", retired_at: "2026-09-25T00:00:00.000Z" },
    ];
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(harness.lastRun().summary).toContain(
      "no webhook endpoint is live, so nothing reaches this connector but its schedule; make one with `marfa connectors endpoints create connector-1`",
    );
  });

  it("reads the vendor whole when the deliveries and endpoints cannot be read, and says so", async () => {
    harness.server.refuseNext(
      "GET /connectors/connector-1/deliveries",
      404,
      "not_found",
    );
    harness.server.refuseNext(
      "GET /connectors/connector-1/endpoints",
      404,
      "not_found",
    );
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    const held = vendor([one]);

    expect(await harness.inbound(held)).toBe(0);
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(harness.server.row("a:1").properties["title"]).toBe("One");
    expect(run.summary).toContain(
      "the waiting deliveries could not be read, so this run read the vendor whole without them",
    );
    expect(run.summary).toContain(
      "the webhook endpoints could not be read, so whether one is live is not known",
    );
    expect(outcomes()).toEqual([null]);
  });

  it("takes at most 500 deliveries a run, listing and marking 200 to a request", async () => {
    for (let at = 0; at < 501; at += 1) {
      const said = signed({ ids: [`a:${String(at)}`] });
      harness.server.deliver(said.body, said.headers);
    }
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(
      outcomes().filter((outcome) => outcome === "processed"),
    ).toHaveLength(500);
    expect(outcomes().at(-1)).toBeNull();
    expect(
      harness.server
        .requestsTo("GET", "/connectors/connector-1/deliveries")
        .map((request) => request.query.get("limit")),
    ).toEqual(["200", "200", "100"]);
    expect(
      harness.server
        .requestsTo("POST", "/connectors/connector-1/deliveries/handled")
        .map((request) => (request.body as { ids: string[] }).ids.length),
    ).toEqual([200, 200, 100]);
    expect(harness.lastRun().summary).toContain("deliveries processed 500");

    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(outcomes().every((outcome) => outcome === "processed")).toBe(true);
  });

  it("marks a repeat of a delivery verified earlier in the same collection a duplicate", async () => {
    const real = signed({ ids: ["a:1"] });
    const first = harness.server.deliver(real.body, real.headers);
    harness.server.deliver(real.body, real.headers, first.id);
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(outcomes()).toEqual(["processed", "duplicate"]);
  });

  it("takes a repeat of a delivery rejected in an earlier run as fresh", async () => {
    const real = signed({ ids: ["a:1"] });
    const forged = signed({ ids: ["a:1"] }, "not the token");
    const first = harness.server.deliver(forged.body, forged.headers);
    first.handled_at = "2026-09-25T00:00:00.000Z";
    first.outcome = "rejected";
    harness.server.deliver(real.body, real.headers, first.id);
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(outcomes()).toEqual(["rejected", "processed"]);
  });

  it("marks rejected deliveries 200 to a request", async () => {
    for (let at = 0; at < 201; at += 1) {
      const forged = signed({ ids: [`a:${String(at)}`] }, "not the token");
      harness.server.deliver(forged.body, forged.headers);
    }
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(
      harness.server
        .requestsTo("POST", "/connectors/connector-1/deliveries/handled")
        .map((request) => (request.body as { ids: string[] }).ids.length),
    ).toEqual([200, 1]);
  });

  it("raises no rejected condition when nothing was rejected", async () => {
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(outcomes()).toEqual(["processed"]);
    expect(harness.lastRun().summary).not.toContain("signature check");
  });

  it("takes the rest when one body cannot be fetched, leaving that one waiting, and does not look before the schedule", async () => {
    const first = signed({ ids: ["a:1"] });
    const second = signed({ ids: ["a:2"] });
    harness.server.deliver(first.body, first.headers);
    harness.server.deliver(second.body, second.headers);
    harness.server.beforeAnswer = (request) => {
      if (
        request.path === "/connectors/connector-1/deliveries/delivery-1/body"
      ) {
        harness.server.refuseNext(
          "GET /connectors/connector-1/deliveries/delivery-1/body",
          500,
          "internal",
        );
      }
    };
    const exit = harness.inbound(vendor([one]), ["--every", "15m"]);
    await harness.clock.sleeping(15 * minute);
    expect(outcomes()).toEqual([null, "processed"]);
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toContain(
      "1 delivery's body could not be fetched, so it waits for a later run",
    );
    expect(looks()).toHaveLength(0);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("fails a run stopped while it fetches bodies, rather than reading on without them", async () => {
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    harness.server.beforeAnswer = (request) => {
      if (request.path.endsWith("/body")) harness.stop();
    };
    expect(await harness.inbound(vendor([one]))).toBe(0);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.summary).not.toContain("could not be");
    expect(outcomes()).toEqual([null]);
  });

  it("leaves the deliveries of a run stopped part-way waiting, though its connector returned", async () => {
    const held = vendor([one]);
    expect(await harness.inbound(held)).toBe(0);
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    let release: () => void = () => undefined;
    held.gate = new Promise((resolve) => {
      release = () => {
        resolve();
      };
    });
    // The row is unchanged, so the run writes nothing the stop could cut.
    const exit = harness.inbound(held);
    await until(() => held.runs === 2);
    harness.stop();
    release();
    expect(await exit).toBe(0);
    // The witness: the connector returned and the run succeeded.
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(outcomes()).toEqual([null]);
  });

  it("counts the deliveries marked before a mark failed", async () => {
    for (let at = 0; at < 201; at += 1) {
      const said = signed({ ids: [`a:${String(at)}`] });
      harness.server.deliver(said.body, said.headers);
    }
    let marks = 0;
    harness.server.beforeAnswer = (request) => {
      if (request.path !== "/connectors/connector-1/deliveries/handled") return;
      marks += 1;
      if (marks === 2) {
        harness.server.refuseNext(
          "POST /connectors/connector-1/deliveries/handled",
          500,
          "internal",
        );
      }
    };
    expect(await harness.inbound(vendor([one]))).toBe(0);
    expect(harness.lastRun().summary).toContain("deliveries processed 200,");
    expect(outcomes().filter((outcome) => outcome === null)).toHaveLength(1);
  });

  it("asks nothing about deliveries for a connector that reads none", async () => {
    harness.server.deliver('{"ids":["a:1"]}');
    expect(await harness.once(vendor([one]))).toBe(0);
    expect(
      harness.server.requests.some((request) =>
        /\/(deliveries|endpoints)/.test(request.path),
      ),
    ).toBe(false);
    expect(harness.lastRun().summary).not.toContain("deliveries");
    expect(outcomes()).toEqual([null]);
  });
});

describe("between scheduled runs", () => {
  it("starts a run for a waiting delivery that reads only what it named", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    expect(held.hints).toEqual([undefined]);

    const said = signed({ ids: ["a:1", "a:7"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    expect(held.hints?.[1]).toEqual(new Set(["a:1", "a:7"]));
    expect(outcomes()).toEqual(["processed"]);

    // Nothing waits, so the next look starts nothing.
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(2);

    harness.stop();
    expect(await exit).toBe(0);
  });

  it("hands a run everything where a delivery asks for it", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const said = signed({ everything: true });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    expect(held.hints).toEqual([undefined, undefined]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("waits for the schedule after a run for deliveries fails, rather than trying at every look", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    held.fail = new Error("the vendor answered 502");
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(15 * minute - 10_000);
    expect(outcomes()).toEqual([null]);

    held.fail = undefined;
    await harness.clock.wake(15 * minute - 10_000);
    await until(() => held.runs === 3);
    await harness.clock.sleeping(10_000);
    expect(outcomes()).toEqual(["processed"]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("rejects a delivery whose verify throws, reads everything for one whose hints throw, and repeats neither error", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const text = "secret-body is not JSON";
    // The witness: the parse error quotes the body's start.
    expect((): unknown => JSON.parse(text)).toThrow(/secret-bod/);
    harness.server.deliver(text, [
      [
        "X-Signature",
        createHmac("sha256", secretToken).update(text).digest("hex"),
      ],
    ]);
    const loud = signed({ ids: ["a:1"] });
    harness.server.deliver(loud.body, [...loud.headers, ["X-Throw", "1"]]);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);

    expect(held.hints).toEqual([undefined, undefined]);
    expect(outcomes()).toEqual(["processed", "rejected"]);
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toContain(
      "1 verified delivery could not be read for what changed",
    );
    expect(run.summary).toContain("rejected 1");
    const said = [
      ...harness.lines,
      ...harness.server.runs.map((reported) => JSON.stringify(reported)),
    ].join("\n");
    expect(said).not.toContain("secret-bod");
    expect(said).not.toContain("cannot read");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("marks what a run took processed though a write was held, and does not run again at the next look", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    harness.server.entryRefusals.set("a:2", {
      status: 400,
      code: "invalid_properties",
      message: "title is over its length cap",
    });
    held.entries = [one, { source_id: "a:2", properties: { title: "Two" } }];
    const said = signed({ ids: ["a:2"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    expect(outcomes()).toEqual(["processed"]);
    expect(harness.lastRun().summary).toContain("the state is held");

    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    expect(held.runs).toBe(2);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("waits for the schedule when what a run took could not be marked", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    harness.server.refuseNext(
      "POST /connectors/connector-1/deliveries/handled",
      500,
      "internal",
    );
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(15 * minute - 10_000);
    expect(outcomes()).toEqual([null]);
    expect(
      harness.lines.some((line) =>
        line.includes("could not be marked processed"),
      ),
    ).toBe(true);

    await harness.clock.wake(15 * minute - 10_000);
    await until(() => held.runs === 3);
    await harness.clock.sleeping(10_000);
    expect(outcomes()).toEqual(["processed"]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("clears no condition in a run for deliveries, so the next scheduled run does not report it again", async () => {
    harness.server.endpoints = [
      { id: "endpoint-1", retired_at: "2026-09-25T00:00:00.000Z" },
    ];
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const missing = "no webhook endpoint is live";
    expect(harness.lastRun().summary).toContain(missing);

    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    harness.clock.advance(15 * minute);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 3);
    await harness.clock.sleeping(10_000);

    expect(
      harness.server.runs.map((run) => run.summary?.includes(missing)),
    ).toEqual([true, false, false]);
    expect(harness.lines.some((line) => line.includes("cleared:"))).toBe(false);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("warns once while waiting deliveries cannot be read, and says when they can", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    for (let at = 0; at < 2; at += 1) {
      harness.server.refuseNext(
        "GET /connectors/connector-1/deliveries",
        503,
        "unavailable",
      );
    }
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    await harness.clock.wake(10_000);
    await harness.clock.sleeping(10_000);
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);

    const lines = (text: string): number =>
      harness.lines.filter((line) => line.includes(text)).length;
    expect(lines("waiting deliveries could not be read")).toBe(1);
    expect(lines("waiting deliveries can be read again")).toBe(1);
    expect(outcomes()).toEqual(["processed"]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("looks as often as --deliveries-every says", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, [
      "--every",
      "15m",
      "--deliveries-every",
      "30s",
    ]);
    await harness.clock.sleeping(30_000);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("refuses --deliveries-every without --every", async () => {
    expect(
      await harness.inbound(vendor([one]), [
        "--once",
        "--deliveries-every",
        "30s",
      ]),
    ).toBe(2);
  });

  it("refuses a flag it does not know after --every", async () => {
    expect(
      await harness.inbound(vendor([one]), [
        "--every",
        "15m",
        "--deliver-every",
        "30s",
      ]),
    ).toBe(2);
  });

  it("does not read the endpoints in a run for deliveries", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    // The witness: the scheduled run read them once.
    expect(
      harness.server.requestsTo("GET", "/connectors/connector-1/endpoints"),
    ).toHaveLength(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("reports a run for deliveries whose listing fails as failed, and waits for the schedule", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    let refused = false;
    harness.server.beforeAnswer = (request) => {
      if (
        !refused &&
        request.path === "/connectors/connector-1/deliveries" &&
        request.query.get("limit") === "200"
      ) {
        refused = true;
        harness.server.refuseNext(
          "GET /connectors/connector-1/deliveries",
          500,
          "internal",
        );
      }
    };
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => harness.server.runs.length === 2);
    expect(harness.lastRun().outcome).toBe("failed");
    await harness.clock.sleeping(15 * minute - 10_000);
    expect(held.runs).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("does not look after a scheduled run whose marks failed", async () => {
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    harness.server.refuseNext(
      "POST /connectors/connector-1/deliveries/handled",
      500,
      "internal",
    );
    const exit = harness.inbound(vendor([one]), ["--every", "15m"]);
    await harness.clock.sleeping(15 * minute);
    expect(looks()).toHaveLength(0);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("sleeps only what is left before the schedule, and runs on it without one more look", async () => {
    const held = vendor([one]);
    const exit = harness.inbound(held, [
      "--every",
      "16m",
      "--deliveries-every",
      "7m",
    ]);
    await harness.clock.wake(7 * minute);
    await harness.clock.wake(7 * minute);
    await harness.clock.sleeping(2 * minute);
    const said = signed({ ids: ["a:1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(2 * minute);
    await until(() => held.runs === 2);
    expect(held.hints?.[1]).toBeUndefined();
    expect(looks()).toHaveLength(2);
    await harness.clock.sleeping(7 * minute);
    harness.stop();
    expect(await exit).toBe(0);
  });
});

describe("a two-way connector's run for deliveries", () => {
  const linked = {
    source_id: "a:1",
    properties: { title: "One", note: "first", vendor_id: "v1" },
  };

  async function watched(): Promise<unknown> {
    return ((await harness.stateFile()) as { watch: { cursor?: string } }).watch
      .cursor;
  }

  /** Two scheduled runs, so the second reads the first's writes as its own. */
  async function settledTwoWay(
    held: Vendor,
  ): Promise<{ exit: Promise<number> }> {
    const exit = harness.inboundTwoWay(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    harness.clock.advance(15 * minute);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 2);
    await harness.clock.sleeping(10_000);
    return { exit };
  }

  async function delivered(held: Vendor, runs: number): Promise<void> {
    const said = signed({ ids: ["v1"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => held.runs === runs);
    await harness.clock.sleeping(10_000);
  }

  it("reads the vendor whole and carries what changed in Marfa, moving the cursor", async () => {
    const held = vendor([linked]);
    const { exit } = await settledTwoWay(held);
    const cursor = await watched();
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { ...linked.properties, title: "Edited" });
    held.changes.length = 0;

    await delivered(held, 3);
    expect(held.hints).toEqual([undefined, undefined, undefined]);
    expect(
      held.changes.map((change) => change.item.properties["title"]),
    ).toEqual(["Edited"]);
    expect(await watched()).not.toBe(cursor);
    expect(outcomes()).toEqual(["processed"]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("carries back an archive made in Marfa beside the vendor's change to the same row", async () => {
    const held = vendor([linked]);
    const { exit } = await settledTwoWay(held);
    harness.server.transition(harness.server.row("a:1").id, "archived");
    held.entries = [
      {
        ...linked,
        properties: { ...linked.properties, title: "By the vendor" },
      },
    ];
    held.changes.length = 0;

    await delivered(held, 3);
    expect(harness.server.row("a:1").properties["title"]).toBe("By the vendor");
    expect(held.changes.map((change) => change.kind)).toEqual(["archived"]);

    harness.clock.advance(15 * minute);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 4);
    await harness.clock.sleeping(10_000);
    expect(held.changes.map((change) => change.kind)).toEqual(["archived"]);
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("carries a person's edit that beat the vendor's mid-write, and the vendor's older entry never writes over it", async () => {
    const held = vendor([linked]);
    const { exit } = await settledTwoWay(held);
    const row = harness.server.row("a:1");
    const earlier = new Date(
      Date.parse(row.updated_at) - 120_000,
    ).toISOString();
    harness.server.afterList = () => {
      harness.server.edit(row.id, { note: "by a person, since the read" });
      harness.server.afterList = undefined;
    };
    held.entries = [
      {
        ...linked,
        properties: { ...linked.properties, title: "By the vendor" },
        changed_at: earlier,
      },
    ];
    held.changes.length = 0;

    await delivered(held, 3);
    expect(
      held.changes.map((change) => change.item.properties["note"]),
    ).toEqual(["by a person, since the read"]);

    // The vendor now holds what was carried to it.
    held.entries = [
      {
        ...linked,
        properties: {
          ...linked.properties,
          note: "by a person, since the read",
        },
      },
    ];
    harness.clock.advance(15 * minute);
    await harness.clock.wake(10_000);
    await until(() => held.runs === 4);
    await harness.clock.sleeping(10_000);
    expect(harness.server.row("a:1").properties["note"]).toBe(
      "by a person, since the read",
    );
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("carries a create first, so the vendor's webhook for what it made links the row rather than making a twin", async () => {
    const held = vendor([]);
    const exit = harness.inboundTwoWay(held, ["--every", "15m"]);
    await harness.clock.sleeping(10_000);
    const theirs = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    held.vendorIdFor = (change) =>
      change.item.id === theirs.id ? "v-theirs" : undefined;
    // The vendor made its copy and the link's write failed, so the next run
    // offers the create again.
    harness.server.refuseNext(`PATCH /items/${theirs.id}`, 503, "unavailable");
    harness.clock.advance(15 * minute);
    await harness.clock.wake(10_000);
    await until(() => harness.server.runs.length === 2);
    expect(harness.lastRun().outcome).toBe("failed");
    await harness.clock.sleeping(10_000);

    held.entries = [
      {
        source_id: "v-theirs",
        properties: { title: "Theirs", vendor_id: "v-theirs" },
        changed_at: "2026-09-24T00:00:00.000Z",
      },
    ];
    const said = signed({ ids: ["v-theirs"] });
    harness.server.deliver(said.body, said.headers);
    await harness.clock.wake(10_000);
    await until(() => harness.server.runs.length === 3);
    await harness.clock.sleeping(10_000);
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(
      harness.server.rows
        .filter((row) => row.properties["vendor_id"] === "v-theirs")
        .map((row) => row.id),
    ).toEqual([theirs.id]);
    harness.stop();
    expect(await exit).toBe(0);
  });
});
