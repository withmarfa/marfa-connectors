import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defineConnector,
  type Change,
  type Entry,
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
it.each([false, true])(
  "releases a definitively refused intent for a fresh corrected change; lost retirement acknowledgment=%s",
  async (lost) => {
    const f = fixture();
    await f.once();
    const row = harness.server.row("one");
    harness.server.edit(row.id, { title: "Bad" });
    const sent: string[] = [];
    f.send(async (change, context) => {
      const intent = await context.outbound.save(change, {
        request: { title: change.item.properties["title"] as string },
        baseline: null,
      });
      sent.push(change.item.properties["title"] as string);
      if (sent.length === 1) throw new Refused("unsupported value");
      await context.outbound.acknowledge(change.item.id, intent.token);
    });
    await f.once();
    await f.once();
    expect(sent).toEqual(["Bad"]);
    harness.server.edit(row.id, { vendor_id: "untrusted-link" });
    await f.once();
    expect(sent).toEqual(["Bad"]);
    expect(harness.kept()["outbound"]).toHaveLength(1);
    harness.server.edit(row.id, { title: "Good" });
    if (lost)
      harness.server.beforeAnswer = (request) => {
        const body = request.body as { state?: { outbound?: unknown } };
        if (
          request.method === "PUT" &&
          request.path.endsWith("/state") &&
          body.state !== undefined &&
          body.state.outbound === undefined
        ) {
          harness.server.loseStateAnswer = true;
          harness.server.beforeAnswer = undefined;
        }
      };
    if (lost) {
      expect(await f.once()).toBe(1);
      expect(sent).toEqual(["Bad"]);
    }
    expect(await f.once()).toBe(0);
    expect(sent).toEqual(["Bad", "Good"]);
    expect(harness.kept()["outbound"]).toBeUndefined();
  },
);
it("releases a refused intent when its carried edit is reverted", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "Bad" });
  let calls = 0;
  f.send(async (change, context) => {
    await context.outbound.save(change, {
      request: { title: "Bad" },
      baseline: null,
    });
    calls++;
    throw new Refused("unsupported value");
  });
  await f.once();
  harness.server.edit(row.id, { title: "Original" });
  await f.once();
  await f.once();
  expect(calls).toBe(1);
  expect(harness.kept()["outbound"]).toBeUndefined();
});
it("does not replay rejected work when reverted retirement storage fails", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "Bad" });
  const sent: string[] = [];
  f.send(async (change, context) => {
    const intent =
      context.outbound.get(change.item.id) ??
      (await context.outbound.save(change, {
        request: { title: "Bad" },
        baseline: null,
      }));
    expect(intent.request).toEqual({ title: "Bad" });
    sent.push(change.item.properties["title"] as string);
    throw new Refused("unsupported value");
  });
  await f.once();
  harness.server.edit(row.id, { title: "Original" });
  harness.server.beforeAnswer = (request) => {
    const body = request.body as { state?: { outbound?: unknown } };
    if (
      request.method === "PUT" &&
      request.path.endsWith("/state") &&
      body.state !== undefined &&
      body.state.outbound === undefined
    ) {
      harness.server.refuseNext(
        "PUT /connectors/connector-1/state",
        503,
        "internal_error",
      );
      harness.server.beforeAnswer = undefined;
    }
  };
  expect(await f.once()).toBe(1);
  await f.once();
  expect(sent).toEqual(["Bad"]);
  expect(harness.server.row("one").properties["title"]).toBe("Original");
  expect(harness.kept()["outbound"]).toBeUndefined();
});
it("keeps an uncertain intent across repeated newer local changes", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "Sent" });
  const requests: string[] = [];
  f.send(async (change, context) => {
    const intent =
      context.outbound.get(change.item.id) ??
      (await context.outbound.save(change, {
        request: { title: change.item.properties["title"] as string },
        baseline: null,
      }));
    expect(intent.request).toEqual({ title: "Sent" });
    requests.push(change.item.properties["title"] as string);
    throw new Unreachable("lost response");
  });
  await f.once();
  harness.server.edit(row.id, { title: "Newer" });
  await f.once();
  harness.server.edit(row.id, { title: "Newest" });
  await f.once();
  expect(requests).toEqual(["Sent", "Sent", "Sent"]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  expect(harness.server.row("one").properties["title"]).toBe("Newest");
});
it("keeps uncertain requests visible to scoped and unscoped inbound readers", async () => {
  const pending: number[] = [];
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    run(context) {
      pending.push(context.pendingOutbound().length);
      expect(context.forScope("reader").pendingOutbound()).toEqual(
        context.pendingOutbound(),
      );
      return Promise.resolve();
    },
    async onChange(change, context) {
      await context.outbound.save(change, {
        request: { title: "Sent" },
        baseline: null,
      });
      throw new Unreachable("lost response");
    },
  });
  const once = () => start(connector, harness.runtime(["--once"]));
  await once();
  harness.server.insert("manual", { title: "Sent" }, linkedType.id);
  await once();
  expect(pending).toEqual([0, 1]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
});
it.each([
  { refused: false, newer: false },
  { refused: false, newer: true },
  { refused: true, newer: false },
  { refused: true, newer: true },
])(
  "merges vendor changes before a local correction; refused=$refused newer=$newer",
  async ({ refused, newer }) => {
    let remote: Entry = {
      source_id: "one",
      properties: { title: "Original", vendor_id: "vendor-one" },
    };
    const sent: string[] = [];
    const connector = defineConnector({
      name: "test",
      source: "test",
      env: {},
      types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
      async run(context) {
        const scope = context.forScope("reader");
        expect(scope.pendingOutbound()).toEqual(context.pendingOutbound());
        if (scope.pendingOutbound().length === 0)
          await scope.upsert(linkedType.id, [remote]);
      },
      async onChange(change, context) {
        const title = change.item.properties["title"] as string;
        const intent = await context.outbound.save(change, {
          request: { title },
          baseline: null,
        });
        sent.push(title);
        if (title === "Bad") throw new Refused("unsupported value");
        remote = { ...remote, properties: { ...remote.properties, title } };
        await context.outbound.acknowledge(change.item.id, intent.token);
        return undefined;
      },
    });
    const once = () => start(connector, harness.runtime(["--once"]));
    expect(await once()).toBe(0);
    const row = harness.server.row("one");
    if (refused) {
      harness.server.edit(row.id, { title: "Bad" });
      expect(await once()).toBe(0);
    }
    const edited = harness.server.edit(row.id, { title: "Good" });
    if (newer)
      remote = {
        ...remote,
        properties: { ...remote.properties, title: "Newer remote" },
        changed_at: new Date(
          Date.parse(edited.updated_at) + 60_000,
        ).toISOString(),
      };
    expect(await once()).toBe(0);
    expect(remote.properties["title"]).toBe(newer ? "Newer remote" : "Good");
    expect(harness.server.row("one").properties["title"]).toBe(
      newer ? "Newer remote" : "Good",
    );
    expect(sent).toEqual([
      ...(refused ? ["Bad"] : []),
      ...(newer ? [] : ["Good"]),
    ]);
    expect(harness.kept()["outbound"]).toBeUndefined();
  },
);
it("keeps a confirmed create link when its later refused step is corrected", async () => {
  const f = fixture();
  await f.once();
  const row = harness.server.insert("manual", { title: "Bad" }, linkedType.id);
  let creates = 0;
  const patches: string[] = [];
  f.send(async (change, context) => {
    let intent = await context.outbound.save(change, {
      request: { phase: change.kind === "created" ? "create" : "patch" },
      baseline: null,
    });
    if (change.kind === "created") {
      creates++;
      await context.setLink(change.item, "created-id");
      intent = await context.outbound.advance(change.item.id, intent.token, {
        request: { phase: "patch" },
        baseline: { created: "created-id" },
      });
    }
    patches.push(change.item.properties["title"] as string);
    if (patches.length === 1) throw new Refused("unsupported title");
    expect(change.item.properties["vendor_id"]).toBe("created-id");
    await context.outbound.acknowledge(change.item.id, intent.token);
  });
  await f.once();
  await f.once();
  expect(creates).toBe(1);
  expect(patches).toEqual(["Bad"]);
  harness.server.edit(row.id, { title: "Good" });
  expect(await f.once()).toBe(0);
  expect(creates).toBe(1);
  expect(patches).toEqual(["Bad", "Good"]);
  expect(harness.server.row("manual").properties["vendor_id"]).toBe(
    "created-id",
  );
});
it("merges a newer vendor edit after a confirmed create's later step was refused", async () => {
  let remote: Entry | undefined;
  let creates = 0;
  const sent: string[] = [];
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    async run(context) {
      if (remote !== undefined) await context.upsert(linkedType.id, [remote]);
    },
    async onChange(change, context) {
      let intent = await context.outbound.save(change, {
        request: { phase: change.kind === "created" ? "create" : "patch" },
        baseline: null,
      });
      if (change.kind === "created") {
        creates++;
        await context.setLink(change.item, "created-id");
        remote = {
          source_id: "manual",
          properties: { title: "Original", vendor_id: "created-id" },
        };
        intent = await context.outbound.advance(change.item.id, intent.token, {
          request: { phase: "patch" },
          baseline: { created: "created-id" },
        });
      }
      sent.push(change.item.properties["title"] as string);
      if (change.item.properties["title"] === "Bad")
        throw new Refused("unsupported title");
      await context.outbound.acknowledge(change.item.id, intent.token);
      return undefined;
    },
  });
  const once = () => start(connector, harness.runtime(["--once"]));
  expect(await once()).toBe(0);
  const row = harness.server.insert("manual", { title: "Bad" }, linkedType.id);
  await once();
  const edited = harness.server.edit(row.id, { title: "Good" });
  remote = {
    source_id: "manual",
    properties: { title: "Newer remote", vendor_id: "created-id" },
    changed_at: new Date(Date.parse(edited.updated_at) + 60_000).toISOString(),
  };
  expect(await once()).toBe(0);
  expect(creates).toBe(1);
  expect(sent).toEqual(["Bad"]);
  expect(harness.server.row("manual").properties).toMatchObject({
    title: "Newer remote",
    vendor_id: "created-id",
  });
  expect(harness.kept()["outbound"]).toBeUndefined();
});
it("durably consumes known-no-apply evidence before retrying, including a lost reset acknowledgment", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Sent" });
  let calls = 0;
  const retryAt = new Date(harness.clock.now().getTime() + 60000).toISOString();
  f.send(async (change, context) => {
    const pending =
      context.outbound.get(change.item.id) ??
      (await context.outbound.save(change, {
        request: { create: "Sent" },
        baseline: null,
      }));
    if (calls === 0) {
      calls++;
      throw new Unreachable("rate limited", {
        retryAt,
        requestNotApplied: true,
      });
    }
    if (pending.requestNotApplied !== true)
      throw new Refused("uncertain create needs readback");
    harness.server.loseStateAnswer = true;
    await context.outbound.prepareRetry(change.item.id, pending.token);
    calls++;
  });
  await f.once();
  expect(
    (harness.kept()["outbound"] as { requestNotApplied?: true }[])[0]
      ?.requestNotApplied,
  ).toBe(true);
  harness.clock.advance(60000);
  await f.once();
  expect(calls).toBe(1);
  expect(
    (harness.kept()["outbound"] as { requestNotApplied?: true }[])[0]
      ?.requestNotApplied,
  ).toBeUndefined();
  await f.once();
  expect(calls).toBe(1);
});
it("retries the same request after durable known-no-apply evidence is consumed", async () => {
  const f = fixture();
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Sent" });
  let calls = 0;
  const retryAt = new Date(harness.clock.now().getTime() + 60000).toISOString();
  f.send(async (change, context) => {
    const pending =
      context.outbound.get(change.item.id) ??
      (await context.outbound.save(change, {
        request: { create: "Sent" },
        baseline: null,
      }));
    if (calls === 0) {
      calls++;
      throw new Unreachable("rate limited", {
        retryAt,
        requestNotApplied: true,
      });
    }
    expect(pending.requestNotApplied).toBe(true);
    await context.outbound.prepareRetry(change.item.id, pending.token);
    expect(
      context.outbound.get(change.item.id)?.requestNotApplied,
    ).toBeUndefined();
    expect(context.outbound.get(change.item.id)?.request).toEqual({
      create: "Sent",
    });
    calls++;
    await context.outbound.acknowledge(change.item.id, pending.token);
  });
  await f.once();
  harness.clock.advance(60000);
  expect(await f.once()).toBe(0);
  expect(calls).toBe(2);
});
it.each([false, true])(
  "advances a proved step without changing the captured edit; replacement ACK lost=%s",
  async (lost) => {
    const f = fixture();
    await f.once();
    const row = harness.server.row("one");
    harness.server.edit(row.id, { title: "Captured" });
    let patches = 0;
    let steps = 0;
    f.send(async (change, context) => {
      let intent =
        context.outbound.get(change.item.id) ??
        (await context.outbound.save(change, {
          request: { phase: "save", url: "https://example.com/item" },
          baseline: null,
        }));
      if ((intent.request as { phase: string }).phase === "save") {
        steps++;
        harness.server.edit(row.id, { title: "Newer" });
        harness.server.loseStateAnswer = lost;
        intent = await context.outbound.advance(change.item.id, intent.token, {
          request: {
            phase: "patch",
            title: change.item.properties["title"] as string,
          },
          baseline: { title: "Readback" },
        });
      }
      expect(intent.change.item.properties["title"]).toBe("Captured");
      expect(intent.request).toEqual({ phase: "patch", title: "Captured" });
      expect(intent.baseline).toEqual({ title: "Readback" });
      patches++;
      await context.outbound.acknowledge(change.item.id, intent.token);
    });
    await f.once();
    if (lost) {
      expect(patches).toBe(0);
      await f.once();
    }
    expect(steps).toBe(1);
    expect(patches).toBe(1);
    expect(harness.server.row("one").properties["title"]).toBe("Newer");
  },
);
