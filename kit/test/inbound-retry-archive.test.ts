import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@withmarfa/client";
import { start } from "../src/main.js";
import {
  Harness,
  linkedType,
  testConnector,
  testType,
  testFields,
  vendor,
} from "./harness.js";
import type { PendingInbound } from "../src/define.js";

let harness: Harness;
const retry = { mode: "replay" as const, context: "a".repeat(64) };
const bad = {
  source_id: "bad",
  properties: { title: "Bad", vendor_id: "vendor-bad" },
};
const held = () => harness.kept()["inbound"] as PendingInbound[] | undefined;
let linked = false;
async function run(
  read: NonNullable<Parameters<typeof testConnector>[0]["read"]>,
) {
  const source = vendor();
  source.read = read;
  const connector = testConnector(source);
  return start(
    linked
      ? { ...connector, types: [{ fields: testFields, type: linkedType }] }
      : connector,
    harness.runtime(["--once"]),
  );
}
const key = () => (linked ? "vendor-bad" : "bad");
async function park(existing = false) {
  if (existing)
    expect(
      await run(async (ctx) => {
        await ctx.upsert(testType.id, [bad]);
      }),
    ).toBe(0);
  if (existing)
    harness.server.refuseNext(
      `PATCH /items/${harness.server.row("bad").id}`,
      400,
      "invalid_properties",
    );
  else
    harness.server.entryRefusals.set("bad", {
      status: 400,
      code: "invalid_properties",
      message: "Bad title",
    });
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry });
      await scope.upsert(testType.id, [
        { ...bad, properties: { ...bad.properties, title: "Changed" } },
      ]);
      await scope.state.checkpoint("page", 1);
    }),
  ).toBe(0);
  expect(held()).toHaveLength(1);
}
async function archive(checkpoint = true, scopeName = "A", options = retry) {
  return run(async (ctx) => {
    const scope = ctx.forScope(scopeName, { retry: options });
    await scope.archive(testType.id, [key()]);
    if (checkpoint) await scope.state.checkpoint("page", 2);
  });
}
beforeEach(async () => {
  harness = await Harness.create();
  linked = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

it.each([false, true])(
  "settles refused creates after fresh absence, linked=%s",
  async (withLink) => {
    linked = withLink;
    await park();
    expect(await archive()).toBe(0);
    expect(held()).toBeUndefined();
    expect(harness.kept()["state"]).toEqual({ page: 2 });
  },
);
it.each([false, true])(
  "settles rejected updates after an acknowledged archive, linked=%s",
  async (withLink) => {
    linked = withLink;
    await park(true);
    expect(await archive()).toBe(0);
    expect(harness.server.row("bad").state).toBe("archived");
    expect(held()).toBeUndefined();
  },
);
it("keeps settlement speculative without a checkpoint, then settles an already archived row", async () => {
  await park(true);
  expect(await archive(false)).toBe(0);
  expect(harness.server.row("bad").state).toBe("archived");
  expect(held()).toHaveLength(1);
  expect(await archive()).toBe(0);
  expect(held()).toBeUndefined();
});
it("cannot settle another scope's pending record", async () => {
  await park();
  await archive(true, "B");
  expect(held()).toHaveLength(1);
  expect(await archive()).toBe(0);
  expect(held()).toBeUndefined();
});
it.each(["trashed", "restored"])(
  "retains retry intent for a manually %s row",
  async (state) => {
    await park(true);
    if (state === "trashed") harness.server.trash(harness.server.row("bad").id);
    else {
      expect(await archive(false)).toBe(0);
      harness.server.restore(harness.server.row("bad").id);
    }
    expect(await archive()).toBe(0);
    expect(held()).toHaveLength(1);
    expect(harness.server.row("bad").state).toBe(
      state === "trashed" ? "trashed" : "active",
    );
  },
);
it.each(["lookup", "transition"])(
  "retains retry intent after a refused %s",
  async (operation) => {
    await park(true);
    harness.server.refuseNext(
      operation === "lookup"
        ? "POST /items/lookup"
        : `POST /items/${harness.server.row("bad").id}/transition`,
      403,
      "forbidden",
    );
    await archive();
    expect(held()).toHaveLength(1);
    expect(harness.kept()["state"]).toEqual({ page: 1 });
  },
);
it("retains retry intent when checkpoint is refused and settles on restart", async () => {
  await park();
  harness.server.refuseNext(
    "PUT /connectors/connector-1/state",
    400,
    "validation_error",
  );
  expect(await archive()).toBe(1);
  expect(held()).toHaveLength(1);
  expect(await archive()).toBe(0);
  expect(held()).toBeUndefined();
});
it("refreshes a cached absent lookup before settling deletion", async () => {
  await park();
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry });
      await scope.known(testType.id, ["bad"]);
      harness.server.entryRefusals.delete("bad");
      const client = createClient({
        baseUrl: harness.server.url,
        credential: harness.server.key,
      });
      const created = await client.POST("/items", {
        body: { type: testType.id, source: "test", ...bad },
      });
      expect(created.response.ok).toBe(true);
      await scope.archive(testType.id, ["bad"]);
      await scope.state.checkpoint("page", 2);
    }),
  ).toBe(0);
  expect(harness.server.row("bad").state).toBe("archived");
});

it("does not confuse a linked identity with a source ID", async () => {
  linked = true;
  await park();
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry });
      await scope.archive(testType.id, ["bad"]);
      await scope.state.checkpoint("page", 2);
    }),
  ).toBe(0);
  expect(held()).toHaveLength(1);
});
it("cannot settle a retry under another mode", async () => {
  await park();
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry: { ...retry, mode: "refetch" } });
      await scope.archive(testType.id, ["bad"]);
      await scope.state.checkpoint("page", 2);
    }),
  ).toBe(0);
  expect(held()).toHaveLength(1);
  expect(harness.kept()["state"]).toEqual({ page: 1 });
});
it("does not roll back an applied settlement after a lost checkpoint response", async () => {
  await park();
  const before = harness.server.requestsTo(
    "PUT",
    "/connectors/connector-1/state",
  ).length;
  harness.server.loseStateAnswer = true;
  expect(await archive()).toBe(1);
  expect(held()).toBeUndefined();
  expect(harness.kept()["state"]).toEqual({ page: 2 });
  expect(
    harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
  ).toHaveLength(before + 1);
  expect(await archive()).toBe(0);
  expect(held()).toBeUndefined();
});
it.each([false, true])(
  "keeps a retry when a row changes type before archive, linked=%s",
  async (withLink) => {
    linked = withLink;
    await park(true);
    harness.server.row("bad").type = "other.type";
    expect(await archive()).toBe(0);
    expect(held()).toHaveLength(1);
    expect(harness.server.row("bad").state).toBe("active");
  },
);
it.each(["lookup", "transition"])(
  "retains retries after an uncertain %s failure",
  async (operation) => {
    await park(true);
    harness.server.refuseNext(
      operation === "lookup"
        ? "POST /items/lookup"
        : `POST /items/${harness.server.row("bad").id}/transition`,
      503,
      "service_unavailable",
    );
    expect(await archive()).toBe(1);
    expect(held()).toHaveLength(1);
    expect(harness.kept()["state"]).toEqual({ page: 1 });
    expect(await archive()).toBe(0);
    expect(held()).toBeUndefined();
  },
);

it("keeps retry intent after an archive commits but its response is lost", async () => {
  await park(true);
  const originalFetch = globalThis.fetch;
  const path = `/items/${harness.server.row("bad").id}/transition`;
  const intercepted = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, options) => {
      const response = await originalFetch(input, options);
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === path)
        throw new Error("archive response lost");
      return response;
    });
  expect(await archive()).toBe(1);
  expect(harness.server.row("bad").state).toBe("archived");
  expect(held()).toHaveLength(1);
  intercepted.mockRestore();
  expect(await archive()).toBe(0);
  expect(held()).toBeUndefined();
});
it("settles a refusal followed by explicit deletion in the same scope before checkpoint", async () => {
  harness.server.entryRefusals.set("bad", {
    status: 400,
    code: "invalid_properties",
    message: "bad",
  });
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry });
      await scope.upsert(testType.id, [bad]);
      await scope.archive(testType.id, ["bad"]);
      await scope.state.checkpoint("page", 1);
    }),
  ).toBe(0);
  expect(held()).toBeUndefined();
  expect(harness.kept()["state"]).toEqual({ page: 1 });
});

it("retains absent retries with no refused-insert evidence", async () => {
  await park();
  const state = harness.server.states.get("test");
  const records = state?.["inbound"] as PendingInbound[];
  const record = records[0];
  if (record === undefined) throw new Error("missing pending record");
  delete record.refusedInsert;
  expect(await archive()).toBe(0);
  expect(held()).toHaveLength(1);
});
it("does not treat a singleton size refusal as evidence of a refused insert", async () => {
  harness.server.bodyCap = 5000;
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry: { ...retry, mode: "refetch" } });
      await scope.upsert(testType.id, [
        { ...bad, properties: { title: "x".repeat(6000) } },
      ]);
      await scope.state.checkpoint("page", 1);
    }),
  ).toBe(0);
  expect(held()?.[0]?.code).toBe("request_too_large");
  expect(held()?.[0]?.refusedInsert).toBeUndefined();
  expect(
    await run(async (ctx) => {
      const scope = ctx.forScope("A", { retry: { ...retry, mode: "refetch" } });
      await scope.archive(testType.id, ["bad"]);
      await scope.state.checkpoint("page", 2);
    }),
  ).toBe(0);
  expect(held()).toHaveLength(1);
});
