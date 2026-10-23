import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defineConnector,
  type Change,
  type WatchContext,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Unreachable } from "../src/rows.js";
import { Harness, linkedType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

type Context = WatchContext<Record<string, never>>;

/** A vendor that names what a create makes after the row it was for, as a
 *  vendor taking a client-chosen id does, so a lost create can be found. */
function fixture() {
  const vendor = new Map<string, string>();
  const calls: string[] = [];
  const preflights: { purges: Change[]; trashes: Change[] }[] = [];
  // How many creates lose their answer, and whether before the vendor.
  let losing = 1;
  let before = false;
  let loseDelete = false;
  let loseAcknowledgment = false;
  let seen: Change[] = [];
  const create = async (change: Change, context: Context) => {
    const id = change.item.id;
    const intent =
      context.outbound.get(id) ??
      (await context.outbound.save(change, {
        request: { create: `made-${id}` },
        baseline: null,
      }));
    const made = (intent.request as { create: string }).create;
    const lose = losing > 0;
    if (lose) losing -= 1;
    if (lose && before) throw new Unreachable(`${id} got no answer`);
    calls.push(`create ${made}`);
    vendor.set(made, change.item.properties["title"] as string);
    if (lose) throw new Unreachable(`${id} got no answer`);
    await context.setLink(change.item, made);
    await context.outbound.acknowledge(id, intent.token);
  };
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    async run() {
      // The vendor is not read: these tests are about carrying.
    },
    preflight(inventory) {
      preflights.push({
        purges: [...inventory.purges],
        trashes: [...inventory.trashes],
      });
      return Promise.resolve();
    },
    async onChange(change, context) {
      seen.push(change);
      const pending = context.outbound.get(change.item.id);
      if (change.kind === "created") {
        await create(change, context);
        return undefined;
      }
      if (
        (change.kind === "trashed" || change.kind === "purged") &&
        pending?.change.kind === "created"
      ) {
        // Whether the create landed is the vendor's to say.
        const made = (pending.request as { create: string }).create;
        if (loseDelete) {
          loseDelete = false;
          throw new Unreachable(`the vendor did not answer for ${made}`);
        }
        if (vendor.has(made)) {
          calls.push(`delete ${made}`);
          vendor.delete(made);
        }
        if (loseAcknowledgment) {
          loseAcknowledgment = false;
          harness.server.loseStateAnswer = true;
        }
        await context.outbound.acknowledge(change.item.id, pending.token);
        return undefined;
      }
      calls.push(
        `${change.kind} ${String(change.item.properties["vendor_id"])}`,
      );
      return undefined;
    },
  });
  return {
    vendor,
    calls,
    preflights,
    seen: () => {
      const all = seen;
      seen = [];
      return all;
    },
    once: () => start(connector, harness.runtime(["--once"])),
    loseCreates: (count: number, beforeSending = false) => {
      losing = count;
      before = beforeSending;
    },
    loseDelete: () => {
      loseDelete = true;
    },
    loseAcknowledgment: () => {
      loseAcknowledgment = true;
    },
  };
}

/** A row made by hand, whose create's answer the first run loses. */
async function uncertain(f: ReturnType<typeof fixture>) {
  expect(await f.once()).toBe(0);
  const row = harness.server.insert("manual", { title: "Plan" }, linkedType.id);
  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["created"]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  return row;
}

it("hands a trash the pending create it overtakes, and settles both", async () => {
  const f = fixture();
  const row = await uncertain(f);
  expect(f.vendor.has(`made-${row.id}`)).toBe(true);
  harness.server.trash(row.id);

  expect(await f.once()).toBe(0);
  const [trash, ...rest] = f.seen();
  expect(rest).toEqual([]);
  expect(trash?.kind).toBe("trashed");
  expect(trash?.attempted).toBeDefined();
  expect(trash?.item.state).toBe("trashed");
  expect(f.calls).toEqual([`create made-${row.id}`, `delete made-${row.id}`]);
  expect(f.vendor.size).toBe(0);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(harness.server.byId(row.id).state).toBe("trashed");
  expect(harness.agreement(row.id)?.["state"]).toBe("trashed");
  expect(harness.lastRun().outcome).toBe("succeeded");
  expect(harness.lastRun().summary).toContain("pushed 1");

  expect(await f.once()).toBe(0);
  expect(f.seen()).toEqual([]);
  expect(f.calls).toHaveLength(2);
});

it("settles a trash over a pending create that never reached the vendor", async () => {
  const f = fixture();
  f.loseCreates(0);
  expect(await f.once()).toBe(0);
  f.loseCreates(1, true);
  const row = harness.server.insert("manual", { title: "Plan" }, linkedType.id);
  expect(await f.once()).toBe(0);
  expect(f.calls).toEqual([]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  f.seen();
  harness.server.trash(row.id);

  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["trashed"]);
  expect(f.calls).toEqual([]);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(await f.once()).toBe(0);
  expect(f.seen()).toEqual([]);
});

it("hands a purge the pending create it overtakes, and settles both", async () => {
  const f = fixture();
  const row = await uncertain(f);
  harness.server.trash(row.id);
  harness.server.purgeById(row.id);

  expect(await f.once()).toBe(0);
  const [purge, ...rest] = f.seen();
  expect(rest).toEqual([]);
  expect(purge?.kind).toBe("purged");
  expect(purge?.item.id).toBe(row.id);
  expect(purge?.attempted).toBeDefined();
  expect(purge?.item.properties["vendor_id"]).toBeUndefined();
  expect(f.calls).toEqual([`create made-${row.id}`, `delete made-${row.id}`]);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(harness.kept()["purges"]).toBeUndefined();

  expect(await f.once()).toBe(0);
  expect(f.seen()).toEqual([]);
  expect(f.calls).toHaveLength(2);
});

it("keeps the purge and its pending create until the vendor answers", async () => {
  const f = fixture();
  const row = await uncertain(f);
  harness.server.trash(row.id);
  harness.server.purgeById(row.id);
  f.loseDelete();

  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["purged"]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  expect(harness.kept()["purges"]).toHaveLength(1);
  expect(harness.problems()[`unreachable:${row.id}`]).toContain(
    "did not answer",
  );

  // The log has moved past the purge; the kit remembers it.
  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["purged"]);
  expect(f.calls).toEqual([`create made-${row.id}`, `delete made-${row.id}`]);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(harness.kept()["purges"]).toBeUndefined();
});

it("replays the create for a row restored before the next run", async () => {
  const f = fixture();
  const row = await uncertain(f);
  harness.server.trash(row.id);
  harness.server.restore(row.id);

  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["created"]);
  expect(f.calls).toEqual([`create made-${row.id}`, `create made-${row.id}`]);
  expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
    `made-${row.id}`,
  );
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(await f.once()).toBe(0);
  expect(f.seen()).toEqual([]);
});

it("replays the create for a row restored while its trash waited", async () => {
  const f = fixture();
  const row = await uncertain(f);
  harness.server.trash(row.id);
  f.loseDelete();
  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["trashed"]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  harness.server.restore(row.id);

  expect(await f.once()).toBe(0);
  expect(f.seen().map((change) => change.kind)).toEqual(["created"]);
  expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
    `made-${row.id}`,
  );
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("asks for the create again, as attempted, when the row is restored after its trash settled", async () => {
  const f = fixture();
  const row = await uncertain(f);
  harness.server.trash(row.id);
  expect(await f.once()).toBe(0);
  f.seen();
  harness.server.restore(row.id);

  expect(await f.once()).toBe(0);
  const [create, ...rest] = f.seen();
  expect(rest).toEqual([]);
  expect(create?.kind).toBe("created");
  expect(create?.attempted).toBeDefined();
  expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
    `made-${row.id}`,
  );
});

it("settles a superseding trash whose acknowledgment was lost without asking the vendor again", async () => {
  const f = fixture();
  const row = await uncertain(f);
  harness.server.trash(row.id);
  f.loseAcknowledgment();
  expect(await f.once()).toBe(1);
  expect(f.calls).toEqual([`create made-${row.id}`, `delete made-${row.id}`]);
  f.seen();

  expect(await f.once()).toBe(0);
  expect(f.seen()).toEqual([]);
  expect(f.calls).toHaveLength(2);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(harness.agreement(row.id)?.["state"]).toBe("trashed");
});

it("keeps a pending create waiting while another row's trash holds its row", async () => {
  const f = fixture();
  const row = await uncertain(f);
  const root = harness.server.insert("root", { title: "Root" }, linkedType.id);
  harness.server.cascadeTrash(row.id, root.id);

  expect(await f.once()).toBe(0);
  expect(f.seen().filter((change) => change.item.id === row.id)).toEqual([]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  expect(harness.problems()[`outbound-pending:${row.id}`]).toContain(
    "another row's trash",
  );
});

it("offers the superseding trash and purge to preflight", async () => {
  const f = fixture();
  expect(await f.once()).toBe(0);
  f.loseCreates(2);
  const one = harness.server.insert("one", { title: "One" }, linkedType.id);
  const two = harness.server.insert("two", { title: "Two" }, linkedType.id);
  expect(await f.once()).toBe(0);
  f.seen();
  expect(harness.kept()["outbound"]).toHaveLength(2);
  harness.server.trash(one.id);
  harness.server.trash(two.id);
  harness.server.purgeById(two.id);
  f.preflights.length = 0;

  expect(await f.once()).toBe(0);
  const [inventory] = f.preflights;
  expect(inventory?.trashes.map((change) => change.item.id)).toEqual([one.id]);
  expect(inventory?.trashes[0]?.attempted).toBeDefined();
  expect(
    inventory?.purges.filter((change) => change.item.id === two.id),
  ).toHaveLength(1);
  expect(
    inventory?.purges.find((change) => change.item.id === two.id)?.attempted,
  ).toBeDefined();
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("hands a purge after another row's trash the pending create it overtakes", async () => {
  const f = fixture();
  const row = await uncertain(f);
  const root = harness.server.insert("root", { title: "Root" }, linkedType.id);
  harness.server.cascadeTrash(row.id, root.id);
  harness.server.purgeById(row.id);

  expect(await f.once()).toBe(0);
  expect(
    f
      .seen()
      .filter((change) => change.item.id === row.id)
      .map((c) => c.kind),
  ).toEqual(["purged"]);
  expect(f.calls).toContain(`delete made-${row.id}`);
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("hands a trash the pending remake it overtakes", async () => {
  const vendor = new Set(["vendor-one"]);
  const calls: string[] = [];
  let seed = true;
  let lose = true;
  const kinds: string[] = [];
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    async run(context) {
      if (!seed) return;
      seed = false;
      await context.upsert(linkedType.id, [
        {
          source_id: "one",
          properties: { title: "One", vendor_id: "vendor-one" },
        },
      ]);
    },
    async remake(change, context) {
      kinds.push(`remake:${change.kind}`);
      const intent =
        context.outbound.get(change.item.id) ??
        (await context.outbound.save(change, {
          request: { remake: "remade-one" },
          baseline: null,
        }));
      calls.push("remake remade-one");
      vendor.add("remade-one");
      if (lose) {
        lose = false;
        throw new Unreachable("the remake got no answer");
      }
      await context.setLink(change.item, "remade-one");
      await context.outbound.acknowledge(change.item.id, intent.token);
      return true;
    },
    async onChange(change, context) {
      kinds.push(change.kind);
      const pending = context.outbound.get(change.item.id);
      if (change.kind === "trashed" && pending !== undefined) {
        expect(pending.change.kind).toBe("restored");
        expect(change.attempted).toBeDefined();
        const made = (pending.request as { remake: string }).remake;
        if (vendor.delete(made)) calls.push(`delete ${made}`);
        await context.outbound.acknowledge(change.item.id, pending.token);
        return undefined;
      }
      if (change.kind === "trashed") {
        const link = change.item.properties["vendor_id"] as string;
        if (vendor.delete(link)) calls.push(`delete ${link}`);
      }
      return undefined;
    },
  });
  const once = () => start(connector, harness.runtime(["--once"]));
  expect(await once()).toBe(0);
  const row = harness.server.row("one");
  harness.server.trash(row.id);
  expect(await once()).toBe(0);
  harness.server.restore(row.id);
  expect(await once()).toBe(0);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  harness.server.trash(row.id);

  expect(await once()).toBe(0);
  expect(kinds).toEqual(["trashed", "remake:restored", "trashed"]);
  expect(calls).toEqual([
    "delete vendor-one",
    "remake remade-one",
    "delete remade-one",
  ]);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(harness.agreement(row.id)?.["state"]).toBe("trashed");
  expect(await once()).toBe(0);
  expect(kinds).toHaveLength(3);
});

it("keeps the pending create, without failing the run, when onChange leaves it unsettled", async () => {
  let lost = true;
  const kinds: string[] = [];
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [{ type: linkedType, fields: ["title", "vendor_id"] }],
    async run() {
      // Nothing to read.
    },
    async onChange(change, context) {
      kinds.push(change.kind);
      // Carries no trash, as a vendor without a bin would.
      if (change.kind !== "created") return undefined;
      const intent =
        context.outbound.get(change.item.id) ??
        (await context.outbound.save(change, {
          request: { create: change.item.id },
          baseline: null,
        }));
      if (lost) {
        lost = false;
        throw new Unreachable("the create got no answer");
      }
      await context.setLink(change.item, `made-${change.item.id}`);
      await context.outbound.acknowledge(change.item.id, intent.token);
      return undefined;
    },
  });
  const once = () => start(connector, harness.runtime(["--once"]));
  expect(await once()).toBe(0);
  const row = harness.server.insert("manual", { title: "Plan" }, linkedType.id);
  expect(await once()).toBe(0);
  harness.server.trash(row.id);

  expect(await once()).toBe(0);
  expect(kinds).toEqual(["created", "trashed"]);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  expect(harness.problems()[`outbound-pending:${row.id}`]).toContain(
    "did not acknowledge it under the trash",
  );

  // Its restore lets the create finish.
  harness.server.restore(row.id);
  expect(await once()).toBe(0);
  expect(kinds).toEqual(["created", "trashed", "created"]);
  expect(harness.kept()["outbound"]).toBeUndefined();
  expect(harness.server.byId(row.id).properties["vendor_id"]).toBe(
    `made-${row.id}`,
  );
});
