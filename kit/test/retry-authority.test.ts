import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defineConnector,
  type Change,
  type Entry,
  type Item,
  type WatchContext,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Unreachable } from "../src/rows.js";
import { Harness, linkedType } from "./harness.js";
import { ScriptedServer } from "./scripted-server.js";

const otherType = { ...linkedType, id: "test.other" };
let harness: Harness;
beforeEach(async () => {
  harness = new Harness(
    await new ScriptedServer("test", {
      types: [linkedType.id, otherType.id],
    }).start(),
  );
});
afterEach(() => harness.close());

function fixture(journal?: "change" | "remake", ownership = false) {
  let carried = [linkedType.id, otherType.id];
  let first = true;
  let fail = true;
  let primaryTitle = "Original";
  const attempts: string[] = [];
  const healthy: string[] = [];
  let reads = 0;
  const entry = (id: string, title: string): Entry => ({
    source_id: id,
    properties: { title, vendor_id: `vendor-${id}` },
  });
  const send = async (
    change: Change,
    context: WatchContext<Record<string, never>>,
    operation: "change" | "remake",
  ): Promise<Entry | undefined> => {
    if (change.item.type === otherType.id) {
      healthy.push(String(change.item.properties["title"]));
      return entry("two", String(change.item.properties["title"]));
    }
    if (change.kind === "trashed") return;
    const intent =
      journal === operation
        ? (context.outbound.get(change.item.id) ??
          (await context.outbound.save(change, {
            request: {
              operation,
              title: String(change.item.properties["title"]),
            },
            baseline: null,
          })))
        : undefined;
    attempts.push(change.kind);
    if (fail) throw new Unreachable("vendor temporarily absent");
    primaryTitle = String(change.item.properties["title"]);
    const answer = entry("one", primaryTitle);
    if (intent !== undefined)
      await context.outbound.acknowledge(change.item.id, intent.token, answer);
    return answer;
  };
  const connector = defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [
      {
        type: linkedType,
        fields: ["title", "note", "vendor_id"],
        ...(ownership
          ? {
              policy: (item: Item | undefined) => ({
                owned: item?.properties["note"] !== "adopted",
              }),
            }
          : {}),
      },
      { type: otherType, fields: ["title", "vendor_id"] },
    ],
    carries: () => carried,
    async run(context) {
      reads += 1;
      await context.upsert(linkedType.id, [entry("one", primaryTitle)]);
      if (first) await context.upsert(otherType.id, [entry("two", "Healthy")]);
      first = false;
    },
    onChange(change, context) {
      return send(change, context, "change");
    },
    async remake(change, context) {
      await send(change, context, "remake");
      return true;
    },
  });
  return {
    once: () => start(connector, harness.runtime(["--once"])),
    allow: (types: string[]) => {
      carried = types;
    },
    recover: () => {
      fail = false;
    },
    sourceTitle: (title: string) => {
      primaryTitle = title;
    },
    attempts,
    healthy,
    reads: () => reads,
  };
}

it("retains a queued purge while its kind is read only, then retries when enabled", async () => {
  const f = fixture();
  expect(await f.once()).toBe(0);
  harness.server.purge("one");
  expect(await f.once()).toBe(0);
  expect(f.attempts).toEqual(["purged"]);
  const queued = structuredClone(harness.kept()["purges"]);
  f.recover();
  f.allow([]);
  expect(await f.once()).toBe(0);
  expect(f.attempts).toHaveLength(1);
  expect(harness.kept()["purges"]).toEqual(queued);
  f.allow([otherType.id]);
  harness.server.edit(harness.server.row("two").id, { title: "Healthy edit" });
  expect(await f.once()).toBe(0);
  expect(f.attempts).toHaveLength(1);
  expect(f.healthy).toEqual(["Healthy edit"]);
  expect(harness.kept()["purges"]).toEqual(queued);
  f.allow([linkedType.id, otherType.id]);
  expect(await f.once()).toBe(0);
  expect(f.attempts).toEqual(["purged", "purged"]);
  expect(harness.kept()["purges"]).toBeUndefined();
});

it.each(["change", "remake"] as const)(
  "retains a pending %s and newer local values while its kind is read only without blocking another kind",
  async (operation) => {
    const f = fixture(operation);
    expect(await f.once()).toBe(0);
    const row = harness.server.row("one");
    if (operation === "remake") {
      harness.server.trash(row.id);
      expect(await f.once()).toBe(0);
      harness.server.restore(row.id);
    }
    harness.server.edit(row.id, { title: "Captured" });
    expect(await f.once()).toBe(0);
    expect(f.attempts).toHaveLength(1);
    const intent = structuredClone(harness.kept()["outbound"]);
    expect(
      intent,
      `${f.attempts.join(", ")}\n${harness.lines.join("\n")}`,
    ).toHaveLength(1);
    harness.server.edit(row.id, { title: "Newer local value" });
    harness.server.edit(harness.server.row("two").id, {
      title: "Healthy edit",
    });
    f.allow([otherType.id]);
    const before = f.reads();
    expect(await f.once()).toBe(0);
    expect(f.reads()).toBe(before + 1);
    expect(f.attempts).toHaveLength(1);
    expect(f.healthy).toEqual(["Healthy edit"]);
    expect(harness.kept()["outbound"]).toEqual(intent);
    expect(harness.server.row("one").properties["title"]).toBe(
      "Newer local value",
    );
    f.allow([linkedType.id, otherType.id]);
    f.recover();
    expect(await f.once()).toBe(0);
    expect(f.attempts).toHaveLength(2);
    expect(harness.kept()["outbound"]).toBeUndefined();
    expect(harness.server.row("one").properties["title"]).toBe(
      "Newer local value",
    );
  },
);

it("retains a pending write after its row is adopted, then rechecks current ownership before replay", async () => {
  const f = fixture("change", true);
  await f.once();
  const row = harness.server.row("one");
  harness.server.edit(row.id, { title: "Captured" });
  await f.once();
  const intent = structuredClone(harness.kept()["outbound"]);
  harness.server.edit(row.id, { title: "Newer", note: "adopted" });
  harness.server.edit(harness.server.row("two").id, { title: "Healthy edit" });
  f.recover();
  expect(await f.once()).toBe(0);
  expect(f.attempts).toHaveLength(1);
  expect(f.healthy).toEqual(["Healthy edit"]);
  expect(harness.kept()["outbound"]).toEqual(intent);
  expect(harness.server.row("one").properties["title"]).toBe("Newer");
  harness.server.edit(row.id, { note: "owned" });
  expect(await f.once()).toBe(0);
  expect(f.attempts).toHaveLength(2);
  expect(harness.kept()["outbound"]).toBeUndefined();
});

it("keeps a missing pending target and its purge without recreating or writing it", async () => {
  const f = fixture("change");
  await f.once();
  harness.server.edit(harness.server.row("one").id, { title: "Captured" });
  await f.once();
  const intent = structuredClone(harness.kept()["outbound"]);
  harness.server.purge("one");
  harness.server.edit(harness.server.row("two").id, { title: "Healthy edit" });
  f.recover();
  expect(await f.once()).toBe(0);
  expect(f.attempts).toHaveLength(1);
  expect(f.healthy).toEqual(["Healthy edit"]);
  expect(harness.kept()["outbound"]).toEqual(intent);
  expect(harness.kept()["purges"]).toHaveLength(1);
  expect(
    harness.server.rows.filter((row) => row.type === linkedType.id),
  ).toEqual([]);
});

it("withholds a kind's inbound rows when an uncertain create has no vendor identity", async () => {
  const f = fixture("change");
  await f.once();
  const manual = harness.server.insert(
    "manual",
    { title: "Create" },
    linkedType.id,
  );
  await f.once();
  const intent = structuredClone(harness.kept()["outbound"]);
  expect(intent).toHaveLength(1);
  harness.server.edit(manual.id, { title: "Newer local value" });
  harness.server.edit(harness.server.row("two").id, { title: "Healthy edit" });
  f.sourceTitle("Remote value");
  f.allow([otherType.id]);
  expect(await f.once()).toBe(0);
  expect(f.attempts).toHaveLength(1);
  expect(f.healthy).toEqual(["Healthy edit"]);
  expect(harness.kept()["outbound"]).toEqual(intent);
  expect(harness.server.row("manual").properties["title"]).toBe(
    "Newer local value",
  );
  expect(harness.server.row("one").properties["title"]).toBe("Original");
});
