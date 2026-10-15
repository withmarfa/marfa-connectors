import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defineConnector,
  type Change,
  type WatchContext,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Refused, Unreachable } from "../src/rows.js";
import { Harness, linkedType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

function fixture() {
  let seed = true;
  let send: (
    change: Change,
    context: WatchContext<Record<string, never>>,
  ) => void | Promise<void> = () => undefined;
  let preflight: (purges: readonly Change[]) => void | Promise<void> = () =>
    undefined;
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    async run(context) {
      if (seed) {
        await context.upsert(linkedType.id, [
          {
            source_id: "one",
            properties: { title: "Original", vendor_id: "vendor-one" },
          },
        ]);
        seed = false;
      }
    },
    async preflight(inventory) {
      await preflight(inventory.purges);
    },
    async onChange(change, context) {
      await send(change, context);
      return undefined;
    },
  });
  return {
    once: () => start(connector, harness.runtime(["--once"])),
    send: (next: typeof send) => {
      send = next;
    },
    preflight: (next: typeof preflight) => {
      preflight = next;
    },
  };
}

it("keeps the exact request and captured change across a failed write and newer local edit", async () => {
  const f = fixture();
  expect(await f.once()).toBe(0);
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "Sent" });
  let sends = 0;
  f.send(async (change, context) => {
    const intent =
      context.outbound.get(change.item.id) ??
      (await context.outbound.save(change, {
        request: {
          method: "POST",
          body: { title: change.item.properties["title"] as string },
        },
        baseline: { title: "Original" },
      }));
    expect(intent.request).toEqual({ method: "POST", body: { title: "Sent" } });
    expect(change.item.properties["title"]).toBe("Sent");
    sends += 1;
    if (sends === 1) throw new Unreachable("lost response");
    await context.outbound.acknowledge(change.item.id, intent.token);
  });
  await f.once();
  expect(sends).toBe(1);
  harness.server.edit(row.id, { title: "Newer" });
  expect(await f.once()).toBe(0);
  expect(sends).toBe(2);
  expect(harness.server.row("one").properties["title"]).toBe("Newer");
  f.send((change) => {
    expect(change.item.properties["title"]).toBe("Newer");
    sends += 1;
  });
  expect(await f.once()).toBe(0);
  expect(sends).toBe(3);
});

it("does not call the vendor when durable intent storage is refused", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Send" });
  let sent = false;
  f.send(async (change, context) => {
    harness.server.refuseNext(
      "PUT /connectors/connector-1/state",
      503,
      "internal_error",
    );
    await context.outbound.save(change, {
      request: { title: "Send" },
      baseline: null,
    });
    sent = true;
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(false);
});

it("keeps a saved intent after losing its save acknowledgment, without sending HTTP", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Send" });
  let sent = 0;
  f.send(async (change, context) => {
    harness.server.loseStateAnswer = true;
    await context.outbound.save(change, {
      request: { title: "Send" },
      baseline: null,
    });
    sent += 1;
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(0);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  f.send(async (change, context) => {
    const intent = context.outbound.get(change.item.id);
    expect(intent?.request).toEqual({ title: "Send" });
    sent += 1;
    if (intent === undefined) throw new Error("missing intent");
    await context.outbound.acknowledge(change.item.id, intent.token);
  });
  expect(await f.once()).toBe(0);
  expect(sent).toBe(1);
});

it("recovers a lost acknowledgment without repeating HTTP", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Send" });
  let sent = 0;
  f.send(async (change, context) => {
    const intent = await context.outbound.save(change, {
      request: { title: "Send" },
      baseline: null,
    });
    sent += 1;
    harness.server.loseStateAnswer = true;
    await context.outbound.acknowledge(change.item.id, intent.token);
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(1);
  expect(await f.once()).toBe(0);
  expect(sent).toBe(1);
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("retains pending purge intent independently of the removed agreement", async () => {
  const f = fixture();
  await f.once();
  harness.server.purge("one");
  let sent = 0;
  f.send(async (change, context) => {
    const intent =
      context.outbound.get(change.item.id) ??
      (await context.outbound.save(change, {
        request: { delete: "vendor-one" },
        baseline: { exists: true },
      }));
    sent += 1;
    if (sent === 1) throw new Unreachable("lost delete response");
    await context.outbound.acknowledge(change.item.id, intent.token);
  });
  await f.once();
  expect(sent).toBe(1);
  expect(harness.server.agreements.size).toBe(0);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  expect(await f.once()).toBe(0);
  expect(sent).toBe(2);
});

it("blocks outbound calls when the watch inventory is incomplete", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Send" });
  harness.server.incompleteAfter = 0;
  let sent = false;
  let preflight = false;
  f.send(() => {
    sent = true;
  });
  f.preflight(() => {
    preflight = true;
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(false);
  expect(preflight).toBe(false);
});

it("preflights every purge before carrying any update", async () => {
  const f = fixture();
  await f.once();
  harness.server.insert("two", { title: "Two" }, linkedType.id);
  harness.server.purge("one");
  let sent = false;
  f.send(() => {
    sent = true;
  });
  f.preflight((purges) => {
    expect(purges).toHaveLength(1);
    expect(purges[0]?.item.source_id).toBe("one");
    throw new Error("batch blocked");
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(false);
});

it("keeps a create's confirmed link after a lost acknowledgment and leaves newer edits pending", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.insert(
    "manual",
    { title: "Create" },
    linkedType.id,
  );
  let sent = 0;
  f.send(async (change, context) => {
    const intent = await context.outbound.save(change, {
      request: { create: "Create" },
      baseline: null,
    });
    sent += 1;
    await context.setLink(change.item, "created-id");
    harness.server.edit(row.id, { title: "Newer" });
    harness.server.loseStateAnswer = true;
    await context.outbound.acknowledge(change.item.id, intent.token);
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(1);
  expect(await f.once()).toBe(0);
  expect(sent).toBe(1);
  expect(harness.server.row("manual").properties).toMatchObject({
    title: "Newer",
    vendor_id: "created-id",
  });
  f.send((change) => {
    expect(change.kind).toBe("updated");
    expect(change.item.properties["title"]).toBe("Newer");
    sent += 1;
  });
  expect(await f.once()).toBe(0);
  expect(sent).toBe(2);
});

it("includes not-due purge retries and cascaded purges in preflight", async () => {
  const f = fixture();
  await f.once();
  harness.server.purge("one");
  f.send(() => {
    throw new Refused("try later");
  });
  await f.once();
  const child = harness.server.insert(
    "child",
    { title: "Child", vendor_id: "child-id" },
    linkedType.id,
  );
  harness.server.cascadeTrash(child.id, "parent");
  harness.server.purge("child");
  const inventory: string[][] = [];
  f.preflight((purges) => {
    inventory.push(purges.map((p) => p.item.source_id ?? "").sort());
  });
  f.send(() => {
    throw new Error("not due, never send");
  });
  expect(await f.once()).toBe(0);
  expect(inventory).toEqual([["child", "one"]]);
});

it("refuses oversized intents before HTTP and cannot replace a pending request", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Send" });
  let sent = 0;
  f.send(async (change, context) => {
    await context.outbound.save(change, {
      request: "x".repeat(512 * 1024),
      baseline: null,
    });
    sent += 1;
  });
  expect(await f.once()).toBe(1);
  expect(sent).toBe(0);
  f.send(async (change, context) => {
    const request = { title: "Original request" };
    const saved = await context.outbound.save(change, {
      request,
      baseline: null,
    });
    request.title = "Modified";
    (saved.request as { title: string }).title = "Modified again";
    expect(context.outbound.get(change.item.id)?.request).toEqual({
      title: "Original request",
    });
    await expect(
      context.outbound.save(change, {
        request: { title: "Other" },
        baseline: null,
      }),
    ).rejects.toThrow("cannot be replaced");
    await context.outbound.acknowledge(change.item.id, saved.token);
  });
  expect(await f.once()).toBe(0);
});
