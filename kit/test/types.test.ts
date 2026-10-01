import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineConnector,
  type Change,
  type Entry,
  type TypeDefinition,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType, testFields, testType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { "test.entry": "write", "test.note": "write" },
  };
});
afterEach(async () => {
  await harness.close();
});

const noteType: TypeDefinition = {
  id: "test.note",
  label: "Note",
  description: "A note from the test vendor.",
  fields: { title: { type: "string", required: true } },
};

interface Held {
  entries: Entry[];
  notes: Entry[];
  archived: string[];
  changes: Change[];
  carries?: string[];
}

function twoTypes(held: Held) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [
      { type: linkedType, fields: testFields },
      { type: noteType, fields: ["title"] },
    ],
    env: { TEST_TOKEN: "secret" },
    carries: () => held.carries ?? ["test.entry"],
    async run(context) {
      await context.upsert(testType.id, held.entries);
      await context.upsert(noteType.id, held.notes);
      await context.archive(testType.id, held.archived);
    },
    onChange(change) {
      held.changes.push(change);
      return Promise.resolve(undefined);
    },
  });
}

function once(held: Held): Promise<number> {
  return start(twoTypes(held), harness.runtime(["--once"]));
}

const entry = {
  source_id: "a:1",
  properties: { title: "One", vendor_id: "v1" },
};
const note = { source_id: "n:1", properties: { title: "A note" } };

describe("a connector of several types", () => {
  it("writes each type's entries under its own type, and reads the log for all of them", async () => {
    const held: Held = {
      entries: [entry],
      notes: [note],
      archived: [],
      changes: [],
      carries: ["test.entry"],
    };
    expect(await once(held)).toBe(0);
    expect(
      harness.server.rows.map((row) => [row.type, row.source_id]).sort(),
    ).toEqual([
      ["test.entry", "a:1"],
      ["test.note", "n:1"],
    ]);
    expect(
      harness.server.requestsTo("GET", "/events")[0]?.query.get("type"),
    ).toBe("test.entry,test.note");
    expect([...harness.server.types.keys()].sort()).toEqual([
      "test.entry",
      "test.note",
    ]);

    harness.server.edit(harness.server.row("a:1").id, { title: "Edited" });
    harness.server.edit(harness.server.row("n:1").id, { title: "Edited" });
    held.entries = [];
    held.notes = [];
    expect(await once(held)).toBe(0);
    expect(held.changes.map((change) => change.item.type)).toEqual([
      "test.entry",
    ]);
    expect(harness.server.row("n:1").properties["title"]).toBe("A note");
  });

  it("archives by the named type's link, and not another type's row", async () => {
    const held: Held = {
      entries: [entry],
      notes: [{ source_id: "v1", properties: { title: "Same key" } }],
      archived: [],
      changes: [],
    };
    await once(held);
    held.archived = ["v1"];
    await once(held);
    expect(harness.server.row("a:1").state).toBe("archived");
    expect(harness.server.row("v1").state).toBe("active");
  });

  it("carries back only the types it names, and mirrors the rest", async () => {
    const held: Held = {
      entries: [entry],
      notes: [],
      archived: [],
      changes: [],
      carries: [],
    };
    await once(held);
    const row = harness.server.row("a:1");
    harness.server.edit(row.id, { title: "Edited" });
    held.entries = [];
    await once(held);
    expect(held.changes).toEqual([]);
    expect(harness.server.row("a:1").properties["title"]).toBe("One");
  });

  it("refuses an upsert of a type it does not declare", async () => {
    const connector = twoTypes({
      entries: [],
      notes: [],
      archived: [],
      changes: [],
    });
    const other = defineConnector({
      ...connector,
      async run(context) {
        await context.upsert("test.other", [note]);
      },
    });
    expect(await start(other, harness.runtime(["--once"]))).toBe(1);
    expect(harness.lastRun().error).toContain(
      "the connector declares no type test.other",
    );
  });

  it("refuses a key that may not write every type it declares", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write", "test.note": "read" },
    };
    const held: Held = { entries: [], notes: [], archived: [], changes: [] };
    expect(await once(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      "may not write type test.note, which the connector writes",
    );
    expect(harness.server.types.size).toBe(0);
  });

  it("takes a key reaching every type it declares, and refuses one reaching another", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write", "test.note": "write" },
    };
    const held: Held = { entries: [], notes: [], archived: [], changes: [] };
    expect(await once(held)).toBe(0);
    harness.server.grants = {
      type_permissions: {
        "test.entry": "write",
        "test.note": "write",
        "test.other": "read",
      },
    };
    expect(await once(held)).toBe(1);
    expect(harness.lastRun().error).toContain("type test.other=read");
  });
});

describe("the definition", () => {
  it("is refused at start where a type carried back names no link", async () => {
    const carried = defineConnector({
      ...twoTypes({ entries: [], notes: [], archived: [], changes: [] }),
      carries: () => ["test.entry", "test.note"],
    });
    expect(await start(carried, harness.runtime(["--once"]))).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "test.note is carried back, so its type needs a link_field",
    );
    expect(harness.server.requests).toEqual([]);
  });

  it("is refused at start where a link or read-only field is not among its fields, or a type repeats", async () => {
    const base = twoTypes({
      entries: [],
      notes: [],
      archived: [],
      changes: [],
    });
    const outside = defineConnector({
      ...base,
      types: [{ type: linkedType, fields: ["title"] }],
    });
    expect(await start(outside, harness.runtime(["--once"]))).toBe(2);
    expect(harness.lines.join("\n")).toContain("vendor_id is not");
    const twice = defineConnector({
      ...base,
      types: [
        { type: testType, fields: testFields },
        { type: testType, fields: testFields },
      ],
    });
    expect(await start(twice, harness.runtime(["--once"]))).toBe(2);
    expect(harness.lines.join("\n")).toContain("each type once");
    expect(harness.server.requests).toEqual([]);
  });
});
