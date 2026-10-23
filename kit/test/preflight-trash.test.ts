import { afterEach, beforeEach, expect, it } from "vitest";
import { defineConnector, type Change, type Item } from "../src/define.js";
import { start } from "../src/main.js";
import { Refused, Unreachable } from "../src/rows.js";
import { Harness, linkedType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(() => harness.close());

interface Seen {
  purges: string[];
  trashes: string[];
}

const names = (changes: readonly Change[]): string[] =>
  changes.map((change) => change.item.source_id ?? change.item.id).sort();

function fixture(options: { policy?: boolean; limit?: number } = {}) {
  let seed = true;
  let limit = options.limit ?? 2;
  const seen: Seen[] = [];
  const changes: Change[] = [];
  let reads = 0;
  let during: (() => void) | undefined;
  let refuse = false;
  let journal = false;
  let lose = false;
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [
      {
        type: linkedType,
        fields: ["title", "note", "vendor_id"],
        ...(options.policy === true && {
          policy: (item: Item | undefined) => ({
            owned: item?.properties["note"] !== "adopted",
          }),
        }),
      },
    ],
    async run(context) {
      reads += 1;
      if (!seed) return;
      await context.upsert(
        linkedType.id,
        ["one", "two", "three"].map((name) => ({
          source_id: name,
          properties: { title: name, vendor_id: `vendor-${name}` },
        })),
      );
      seed = false;
    },
    preflight(inventory) {
      seen.push({
        purges: names(inventory.purges),
        trashes: names(inventory.trashes),
      });
      for (const trash of inventory.trashes) {
        expect(trash.kind).toBe("trashed");
        expect(trash.item.state).toBe("trashed");
        expect(trash.changed.size).toBe(0);
      }
      during?.();
      if (inventory.trashes.length + inventory.purges.length > limit)
        return Promise.reject(new Error("too many deletions held"));
      return Promise.resolve();
    },
    async onChange(change, context) {
      changes.push(change);
      if (change.kind !== "trashed") return undefined;
      const intent = journal
        ? (context.outbound.get(change.item.id) ??
          (await context.outbound.save(change, {
            request: { delete: change.item.id },
            baseline: null,
          })))
        : undefined;
      if (refuse) throw new Refused("not yours");
      if (intent === undefined) return undefined;
      if (lose) throw new Unreachable("lost delete response");
      await context.outbound.acknowledge(change.item.id, intent.token);
      return undefined;
    },
  });
  const unhandled = { ...connector };
  Reflect.deleteProperty(unhandled, "onChange");
  return {
    seen,
    changes,
    reads: () => reads,
    once: () => start(connector, harness.runtime(["--once"])),
    // The same connector with its write handler gone.
    unhandled: () => start(unhandled, harness.runtime(["--once"])),
    limit: (next: number) => {
      limit = next;
    },
    during: (next: (() => void) | undefined) => {
      during = next;
    },
    refuse: (next: boolean) => {
      refuse = next;
    },
    journal: (next: { lose: boolean }) => {
      journal = true;
      lose = next.lose;
    },
  };
}

const trash = (name: string): void => {
  harness.server.trash(harness.server.row(name).id);
};

it("holds many trashes, carries none of them and reads nothing, then carries them once allowed", async () => {
  const f = fixture();
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  for (const name of ["one", "two", "three"]) trash(name);
  const reads = f.reads();
  expect(await f.once()).toBe(1);
  expect(f.seen.at(-1)).toEqual({
    purges: [],
    trashes: ["one", "three", "two"],
  });
  expect(f.changes).toEqual([]);
  expect(f.reads()).toBe(reads);
  expect(harness.lines.join("\n")).toContain("too many deletions held");
  // Held again on the next run: the trashes still wait.
  expect(await f.once()).toBe(1);
  expect(f.seen.at(-1)?.trashes).toEqual(["one", "three", "two"]);
  expect(f.changes).toEqual([]);
  f.limit(10);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.changes.map((change) => change.kind)).toEqual([
    "trashed",
    "trashed",
    "trashed",
  ]);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(f.changes).toHaveLength(3);
});

it("lets a few trashes pass, each as onChange then sees it", async () => {
  const f = fixture();
  await f.once();
  trash("one");
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)).toEqual({ purges: [], trashes: ["one"] });
  expect(f.changes.map((change) => change.kind)).toEqual(["trashed"]);
  expect(f.changes[0]?.item.properties["vendor_id"]).toBe("vendor-one");
});

it("leaves a cascaded trash out of the person's trashes", async () => {
  const f = fixture({ limit: 1 });
  await f.once();
  trash("one");
  harness.server.cascadeTrash(harness.server.row("two").id, "parent");
  harness.server.cascadeTrash(harness.server.row("three").id, "parent");
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)).toEqual({ purges: [], trashes: ["one"] });
  expect(names(f.changes)).toEqual(["one"]);
});

it("counts a row trashed and then purged once, as a purge", async () => {
  const f = fixture({ limit: 0 });
  await f.once();
  trash("one");
  trash("two");
  expect(await f.once()).toBe(1);
  expect(f.seen.at(-1)).toEqual({ purges: [], trashes: ["one", "two"] });
  harness.server.purge("one");
  trash("three");
  harness.server.purge("three");
  expect(await f.once()).toBe(1);
  expect(f.seen.at(-1)).toEqual({ purges: ["one", "three"], trashes: ["two"] });
  expect(f.changes).toEqual([]);
});

it("carries nothing for a trash restored before it was carried", async () => {
  const f = fixture({ limit: 0 });
  await f.once();
  trash("one");
  trash("two");
  expect(await f.once()).toBe(1);
  harness.server.restore(harness.server.row("one").id);
  harness.server.restore(harness.server.row("two").id);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)).toEqual({ purges: [], trashes: [] });
  expect(f.changes).toEqual([]);
});

it("leaves out a refused trash that still stands", async () => {
  const f = fixture({ limit: 1 });
  await f.once();
  trash("one");
  f.refuse(true);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual(["one"]);
  expect(f.changes).toHaveLength(1);
  f.refuse(false);
  trash("two");
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual(["two"]);
  expect(names(f.changes)).toEqual(["one", "two"]);
});

it("carries no trash that preflight did not see", async () => {
  const f = fixture({ policy: true });
  await f.once();
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "edited" });
  f.during(() => {
    if (row.state !== "trashed") harness.server.trash(row.id);
  });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(f.changes.map((change) => change.kind)).not.toContain("trashed");
  f.during(undefined);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual(["one"]);
  expect(f.changes.map((change) => change.kind)).toContain("trashed");
});

it("counts a journaled trash and holds its replay with the batch", async () => {
  const f = fixture({ limit: 1 });
  await f.once();
  trash("one");
  f.journal({ lose: true });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.changes).toHaveLength(1);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  trash("two");
  expect(await f.once()).toBe(1);
  expect(f.seen.at(-1)?.trashes).toEqual(["one", "two"]);
  expect(f.changes).toHaveLength(1);
  f.journal({ lose: false });
  f.limit(2);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(names(f.changes)).toEqual(["one", "one", "two"]);
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("leaves out a journaled trash the vendor refused while the refusal stands", async () => {
  const f = fixture({ limit: 1 });
  await f.once();
  trash("one");
  f.journal({ lose: false });
  f.refuse(true);
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual(["one"]);
  expect(f.changes).toHaveLength(1);
  expect(harness.kept()["outbound"]).toHaveLength(1);
  for (let run = 0; run < 3; run += 1) {
    expect(await f.once(), harness.lines.join("\n")).toBe(0);
    expect(f.seen.at(-1)?.trashes).toEqual([]);
  }
  expect(f.changes).toHaveLength(1);
});

// The record a run journaled, as the instance keeps it.
const journaled = (): Record<string, unknown> => {
  const records = harness.kept()["outbound"] as Record<string, unknown>[];
  const [record] = records;
  if (record === undefined || records.length !== 1)
    throw new Error("expected one journaled write");
  return record;
};

it("leaves out a journaled trash the vendor already answered", async () => {
  const f = fixture({ limit: 1 });
  await f.once();
  trash("one");
  f.journal({ lose: true });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  // Answered, with only Marfa's agreement left to keep.
  journaled()["acknowledged"] = true;
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(f.changes).toHaveLength(1);
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("leaves out a journaled trash whose row is no longer the connector's", async () => {
  const f = fixture({ limit: 1, policy: true });
  await f.once();
  const row = harness.server.row("one");
  trash("one");
  f.journal({ lose: true });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  harness.server.edit(row.id, { note: "adopted" });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(f.changes).toHaveLength(1);
  expect(journaled()["acknowledged"]).toBe(false);
  // Given back while preflight runs: not sent, since preflight left it out.
  f.during(() => {
    harness.server.edit(row.id, { note: "" });
  });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(f.changes).toHaveLength(1);
  f.during(undefined);
  f.journal({ lose: false });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual(["one"]);
  expect(names(f.changes)).toEqual(["one", "one"]);
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("leaves out a journaled trash whose write handler is gone", async () => {
  const f = fixture({ limit: 1 });
  await f.once();
  trash("one");
  f.journal({ lose: true });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(await f.unhandled(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(f.changes).toHaveLength(1);
  expect(journaled()["acknowledged"]).toBe(false);
});

it("looks up no waiting row one at a time unless it is trashed", async () => {
  const f = fixture({ policy: true });
  await f.once();
  for (const name of ["one", "two", "three"])
    harness.server.edit(harness.server.row(name).id, { title: "edited" });
  const lookups = (): number[] =>
    harness.server
      .requestsTo("POST", "/items/lookup")
      .map((request) => (request.body as { ids?: unknown[] }).ids?.length ?? 0);
  const before = lookups().length;
  let asked: number[] = [];
  f.during(() => {
    asked = lookups().slice(before);
  });
  expect(await f.once(), harness.lines.join("\n")).toBe(0);
  expect(f.seen.at(-1)?.trashes).toEqual([]);
  expect(asked.filter((ids) => ids === 1)).toEqual([]);
  expect(f.changes.map((change) => change.kind)).toEqual([
    "updated",
    "updated",
    "updated",
  ]);
});
