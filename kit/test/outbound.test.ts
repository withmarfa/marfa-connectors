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
    types: [{ type: linkedType, fields: ["title", "note", "vendor_id"] }],
    async run(context) {
      if (seed) {
        await context.upsert(linkedType.id, [
          {
            source_id: "one",
            properties: {
              title: "Original",
              note: "Old note",
              vendor_id: "vendor-one",
            },
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
it.each([false, true])(
  "adopts unsent readback fields and preserves newer local edits after acknowledgment loss=%s",
  async (lost) => {
    let seed = true;
    let sends = 0;
    const connector = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [{ type: linkedType, fields: ["title", "note", "vendor_id"] }],
      async run(context) {
        if (seed) {
          await context.upsert(linkedType.id, [
            {
              source_id: "one",
              properties: {
                title: "Original",
                note: "Old note",
                vendor_id: "vendor-one",
              },
            },
          ]);
          seed = false;
        }
      },
      async onChange(change, context) {
        sends++;
        const intent = await context.outbound.save(change, {
          request: { title: "Sent" },
          baseline: null,
        });
        harness.server.edit(change.item.id, { title: "Newer local title" });
        harness.server.loseStateAnswer = lost;
        await context.outbound.acknowledge(change.item.id, intent.token, {
          source_id: "one",
          properties: {
            title: "Sent",
            note: "Fresh vendor note",
            vendor_id: "vendor-one",
          },
        });
      },
    });
    const once = () => start(connector, harness.runtime(["--once"]));
    await once();
    harness.server.edit(harness.server.row("one").id, { title: "Sent" });
    await once();
    if (lost) await once();
    expect(sends).toBe(1);
    expect(harness.server.row("one").properties).toMatchObject({
      title: "Newer local title",
      note: "Fresh vendor note",
    });
  },
);
it("does not replace a newer unsent local field with recovered readback", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "Sent" });
  f.send(async (change, context) => {
    const intent = await context.outbound.save(change, {
      request: { title: "Sent" },
      baseline: null,
    });
    harness.server.edit(row.id, { note: "Newer local note" });
    harness.server.loseStateAnswer = true;
    await context.outbound.acknowledge(row.id, intent.token, {
      source_id: "one",
      properties: {
        title: "Sent",
        note: "Fresh vendor note",
        vendor_id: "vendor-one",
      },
    });
  });
  await f.once();
  await f.once();
  expect(harness.server.row("one").properties["note"]).toBe("Newer local note");
});
it("honors a journaled purge refusal cooldown while keeping it in preflight", async () => {
  const f = fixture();
  await f.once();
  harness.server.purge("one");
  let calls = 0;
  f.send(async (change, context) => {
    await context.outbound.save(change, {
      request: { delete: "vendor-one" },
      baseline: null,
    });
    calls++;
    throw new Refused("try later");
  });
  await f.once();
  const inventory: string[][] = [];
  f.preflight((purges) => {
    inventory.push(purges.map((p) => p.item.id));
  });
  await f.once();
  expect(calls).toBe(1);
  expect(inventory[0]).toHaveLength(1);
});
it.each([false, true])(
  "keeps a vendor retry deadline across processes with a pending intent=%s",
  async (journal) => {
    const f = fixture();
    await f.once();
    harness.server.edit(harness.server.row("one").id, { title: "Sent" });
    let calls = 0;
    let checks = 0;
    f.preflight(() => {
      checks++;
    });
    const retryAt = new Date(
      harness.clock.now().getTime() + 60000,
    ).toISOString();
    f.send(async (change, context) => {
      const intent = journal
        ? (context.outbound.get(change.item.id) ??
          (await context.outbound.save(change, {
            request: { title: "Sent" },
            baseline: null,
          })))
        : undefined;
      calls++;
      if (calls === 1) throw new Unreachable("rate limited", { retryAt });
      if (intent)
        await context.outbound.acknowledge(change.item.id, intent.token);
    });
    await f.once();
    expect(harness.kept()["outboundRetryAt"]).toBe(retryAt);
    await f.once();
    expect(calls).toBe(1);
    expect(checks).toBe(1);
    harness.clock.advance(60000);
    expect(await f.once()).toBe(0);
    expect(calls).toBe(2);
  },
);
it("keeps a preflight rate limit without ever reaching a mutation", async () => {
  const f = fixture();
  await f.once();
  let calls = 0;
  const retryAt = new Date(harness.clock.now().getTime() + 60000).toISOString();
  f.preflight(() => {
    calls++;
    throw new Unreachable("rate limited", { retryAt });
  });
  await f.once();
  await f.once();
  expect(calls).toBe(1);
  expect(harness.kept()["outboundRetryAt"]).toBe(retryAt);
});
it("uses the durable purge answer when the callback returns no entry", async () => {
  const f = fixture();
  await f.once();
  harness.server.purge("one");
  const changedAt = "2026-10-15T12:00:00.000Z";
  f.send(async (change, context) => {
    const intent = await context.outbound.save(change, {
      request: { delete: "vendor-one" },
      baseline: null,
    });
    await context.outbound.acknowledge(change.item.id, intent.token, {
      source_id: "one",
      properties: {},
      changed_at: changedAt,
    });
  });
  expect(await f.once()).toBe(0);
  expect(
    harness.server.tombstones.get(`${linkedType.id}\u0000link:vendor-one`)
      ?.settled_at,
  ).toBe(changedAt);
});
it("does not replay a definitively refused immutable update", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Refused" });
  let calls = 0;
  f.send(async (change, context) => {
    await context.outbound.save(change, {
      request: { title: "Refused" },
      baseline: null,
    });
    calls++;
    throw new Refused("unsupported value");
  });
  await f.once();
  await f.once();
  expect(calls).toBe(1);
  expect(harness.kept()["outbound"]).toHaveLength(1);
});
