import { afterEach, beforeEach, expect, it } from "vitest";
import type { Entry } from "../src/define.js";
import { Harness, testType, vendor } from "./harness.js";

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
