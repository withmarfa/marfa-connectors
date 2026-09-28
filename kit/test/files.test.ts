import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineConnector,
  type Entry,
  type TypeDefinition,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType, testFields } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
  harness.server.grants = {
    type_permissions: { "test.entry": "write", "test.file": "write" },
    edge_permissions: { "attached-to": "write" },
  };
});
afterEach(async () => {
  await harness.close();
});

const fileType: TypeDefinition = {
  id: "test.file",
  label: "File",
  description: "An attachment from the test vendor.",
  parent: "core.file",
  fields: { asset_id: { type: "string" } },
};

interface Held {
  entries: Entry[];
  files: Entry[];
  loads: number;
}

function withFiles(
  held: Held,
  fields = ["asset_id", "title", "blob_ref", "mime_type"],
) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [
      { type: linkedType, fields: testFields },
      { type: fileType, fields },
    ],
    connections: [
      {
        id: "attached-to",
        cardinality: "many-to-many",
        source_type_constraints: ["test.file"],
        target_type_constraints: ["test.entry"],
      },
    ],
    env: {},
    async run(context) {
      await context.upsert("test.entry", held.entries);
      await context.upsert("test.file", held.files);
    },
  });
}

function once(held: Held, fields?: string[]): Promise<number> {
  return start(withFiles(held, fields), harness.runtime(["--once"]));
}

const issue: Entry = {
  source_id: "a:1",
  properties: { title: "One", vendor_id: "v1" },
};

function file(held: Held, key: string, text: string): Entry {
  return {
    source_id: "f:1",
    properties: { asset_id: "f1", title: "notes.txt" },
    file: {
      key,
      load: () => {
        held.loads += 1;
        return Promise.resolve({
          bytes: new TextEncoder().encode(text),
          mime_type: "text/plain",
        });
      },
    },
    connections: { "attached-to": [{ type: "test.entry", id: "v1" }] },
  };
}

function hashOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

describe("a file", () => {
  it("is uploaded once, attached to its item, and loaded again only when the vendor's key changes", async () => {
    const held: Held = { entries: [issue], files: [], loads: 0 };
    held.files = [file(held, "etag-1", "hello")];
    expect(await once(held)).toBe(0);
    const row = harness.server.row("f:1");
    expect(row.properties).toMatchObject({
      blob_ref: hashOf("hello"),
      mime_type: "text/plain",
    });
    expect(harness.server.targetsOf(row.id, "attached-to")).toEqual([
      harness.server.row("a:1").id,
    ]);
    expect([held.loads, harness.server.uploads]).toEqual([1, 1]);

    expect(await once(held)).toBe(0);
    expect([held.loads, harness.server.uploads]).toEqual([1, 1]);
    expect(harness.lastRun().summary).toContain("unchanged 2");

    held.files = [file(held, "etag-2", "hello again")];
    expect(await once(held)).toBe(0);
    expect([held.loads, harness.server.uploads]).toEqual([2, 2]);
    expect(harness.server.row("f:1").properties["blob_ref"]).toBe(
      hashOf("hello again"),
    );
  });

  it("the vendor would not give waits with a condition, and lands once it does", async () => {
    const held: Held = { entries: [issue], files: [], loads: 0 };
    const failing = file(held, "etag-1", "hello");
    held.files = [
      {
        ...failing,
        file: {
          key: "etag-1",
          load: () => Promise.reject(new Error("404 from the vendor")),
        },
      },
    ];
    expect(await once(held)).toBe(0);
    expect(harness.server.rows.map((row) => row.source_id)).toEqual(["a:1"]);
    expect(harness.lastRun().summary).toContain(
      "the file for f:1 could not be fetched from the vendor, so its row waits: 404 from the vendor",
    );
    held.files = [failing];
    expect(await once(held)).toBe(0);
    expect(harness.server.row("f:1").properties["blob_ref"]).toBe(
      hashOf("hello"),
    );
  });

  it("is refused on a kind that does not list where its bytes are written", async () => {
    const held: Held = { entries: [issue], files: [], loads: 0 };
    held.files = [file(held, "etag-1", "hello")];
    expect(await once(held, ["asset_id", "title"])).toBe(0);
    expect(held.loads).toBe(0);
    expect(harness.lastRun().summary).toContain(
      "the entry f:1 carries a file, and its type's fields do not list blob_ref and mime_type",
    );
  });
});

describe("attached-to", () => {
  it("is the instance's own, never registered, and refused to a key that may not write it", async () => {
    const held: Held = { entries: [issue], files: [], loads: 0 };
    held.files = [file(held, "etag-1", "hello")];
    expect(await once(held)).toBe(0);
    expect(harness.server.requestsTo("POST", "/edge-types")).toEqual([]);

    harness.server.grants = {
      type_permissions: { "test.entry": "write", "test.file": "write" },
    };
    expect(await once(held)).toBe(1);
    expect(harness.lastRun().error).toContain("may not write edge attached-to");
  });
});
