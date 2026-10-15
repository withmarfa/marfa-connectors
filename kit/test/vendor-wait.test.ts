import { afterEach, beforeEach, expect, it } from "vitest";
import type { Entry } from "../src/define.js";
import { Harness, testType, vendor } from "./harness.js";

function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

it("continues the same inbound page with its cache after a vendor 429", async () => {
  const held = vendor();
  const requests: string[] = [];
  let limited = true;
  const retryAt = new Date(harness.clock.now().getTime() + 1000).toISOString();
  const read = (part: string) => {
    requests.push(part);
    if (part === "second" && limited) {
      limited = false;
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    return Response.json({ source_id: part, properties: { title: part } });
  };
  held.read = async (context) => {
    const scope = context.forScope("page");
    expect(await scope.state.checkpoint("previous", "complete")).toEqual({
      committed: true,
    });
    context.state.set("draft", "retained");
    const cache: Entry[] = [];
    for (const part of ["first", "second"]) {
      let response = read(part);
      if (response.status === 429) {
        const delay = response.headers.get("retry-after");
        if (delay === null) throw new Error("missing retry deadline");
        await context.waitUntil(
          new Date(
            harness.clock.now().getTime() + Number(delay) * 1000,
          ).toISOString(),
        );
        response = read(part);
      }
      cache.push((await response.json()) as Entry);
    }
    expect(context.state.get("draft")).toBe("retained");
    expect(scope.state.get("previous")).toBe("complete");
    await scope.upsert(testType.id, cache);
    expect(await scope.state.checkpoint("page", "complete")).toEqual({
      committed: true,
    });
  };
  const running = harness.once(held);
  await Promise.race([
    harness.clock.sleeping(1000),
    running.then(() => {
      throw new Error("inbound run ended before waiting for the vendor");
    }),
  ]);
  expect(harness.kept()["outboundRetryAt"]).toBe(retryAt);
  expect(harness.kept()["state"]).toEqual({ previous: "complete" });
  await harness.clock.wake(1000);
  expect(await running).toBe(0);
  expect(held.runs).toBe(1);
  expect(requests).toEqual(["first", "second", "second"]);
  expect(harness.server.row("first").properties["title"]).toBe("first");
  expect(harness.server.row("second").properties["title"]).toBe("second");
  expect(harness.kept()["state"]).toEqual({
    previous: "complete",
    draft: "retained",
    page: "complete",
  });
  expect(harness.kept()["outboundRetryAt"]).toBeUndefined();
});

it("keeps a cancelled inbound wait across restart until its deadline", async () => {
  const held = vendor();
  const retryAt = new Date(harness.clock.now().getTime() + 1000).toISOString();
  let resumed = 0;
  held.read = async (context) => {
    await context.forScope("page").waitUntil(retryAt);
    resumed++;
  };
  const running = harness.once(held);
  await Promise.race([
    harness.clock.sleeping(1000),
    running.then(() => {
      throw new Error("inbound run ended before waiting for the vendor");
    }),
  ]);
  harness.stop();
  await running;
  expect(resumed).toBe(0);
  expect(harness.kept()["outboundRetryAt"]).toBe(retryAt);
  expect(await harness.once(held)).toBe(1);
  expect(held.runs).toBe(1);
  expect(resumed).toBe(0);
  harness.clock.advance(1000);
  expect(await harness.once(held)).toBe(0);
  expect(held.runs).toBe(2);
  expect(resumed).toBe(1);
  expect(harness.kept()["outboundRetryAt"]).toBeUndefined();
});

it.each(["deadline", "clear"])(
  "does not resume inbound requests after losing the %s acknowledgment",
  async (stage) => {
    const held = vendor();
    const retryAt = new Date(
      harness.clock.now().getTime() + 1000,
    ).toISOString();
    let resumed = 0;
    held.read = async (context) => {
      if (stage === "deadline") harness.server.loseStateAnswer = true;
      await context.waitUntil(retryAt);
      resumed++;
    };
    const running = harness.once(held);
    if (stage === "clear") {
      await Promise.race([
        harness.clock.sleeping(1000),
        running.then(() => {
          throw new Error("inbound run ended before waiting for the vendor");
        }),
      ]);
      harness.server.loseStateAnswer = true;
      await harness.clock.wake(1000);
    }
    expect(await running).toBe(1);
    expect(resumed).toBe(0);
    expect(harness.kept()["outboundRetryAt"]).toBe(
      stage === "deadline" ? retryAt : undefined,
    );
  },
);

it.each(["root", "scoped"] as const)(
  "keeps the longest concurrent %s deadline when the process stops",
  async (kind) => {
    const held = vendor();
    const first = new Date(harness.clock.now().getTime() + 1000).toISOString();
    const last = new Date(harness.clock.now().getTime() + 62_000).toISOString();
    let resumed = 0;
    held.read = async (context) => {
      const other = kind === "root" ? context : context.forScope("other");
      await Promise.all([context.waitUntil(first), other.waitUntil(last)]);
      resumed++;
    };
    const running = harness.once(held);
    await Promise.race([
      harness.clock.sleeping(1000),
      harness.clock.sleeping(62_000),
      running.then(() => {
        throw new Error("inbound run ended before waiting for the vendor");
      }),
    ]);
    const kept = harness.kept()["outboundRetryAt"];
    harness.stop();
    await running;
    expect(kept).toBe(last);
    expect(harness.kept()["outboundRetryAt"]).toBe(last);
    expect(resumed).toBe(0);
    harness.clock.advance(1000);
    expect(await harness.once(held)).toBe(1);
    expect(held.runs).toBe(1);
    harness.clock.advance(61_000);
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(2);
    expect(resumed).toBe(1);
  },
);

it.each(["root", "scoped"] as const)(
  "keeps a concurrent %s extension received during the clearing acknowledgment",
  async (kind) => {
    const held = vendor();
    const first = new Date(harness.clock.now().getTime() + 1000).toISOString();
    const last = new Date(harness.clock.now().getTime() + 62_000).toISOString();
    const clearing = gate();
    const releaseClear = gate();
    const extend = gate();
    const registered = gate();
    let firstResumed = 0;
    held.read = async (context) => {
      const other = kind === "root" ? context : context.forScope("other");
      await Promise.all([
        context.waitUntil(first).then(() => {
          firstResumed++;
        }),
        extend.promise.then(() => {
          const waiting = other.waitUntil(last);
          registered.resolve();
          return waiting;
        }),
      ]);
    };
    const running = harness.once(held);
    await harness.clock.sleeping(1000);
    harness.server.beforeAnswer = async (request) => {
      if (request.method !== "PUT" || !request.path.endsWith("/state")) return;
      harness.server.beforeAnswer = undefined;
      clearing.resolve();
      await releaseClear.promise;
    };
    await harness.clock.wake(1000);
    await clearing.promise;
    extend.resolve();
    await registered.promise;
    releaseClear.resolve();
    await Promise.race([
      harness.clock.sleeping(61_000),
      running.then(() => {
        throw new Error("inbound run ended before honoring the extension");
      }),
    ]);
    const kept = harness.kept()["outboundRetryAt"];
    harness.stop();
    await running;
    expect(firstResumed).toBe(0);
    expect(kept).toBe(last);
    expect(harness.kept()["outboundRetryAt"]).toBe(last);
  },
);
