import { canonicalType } from "./scripted-server.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { Harness, testConnector, testType, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const entry = { source_id: "a:1", properties: { title: "One" } };

const fixer = {
  metadata_permissions: { types: "write" },
  type_permissions: { "test.entry": "write" },
};

const puts = (): number =>
  harness.server.requestsTo("PUT", "/types/test.entry").length;

const served = (): Record<string, unknown> | undefined =>
  harness.server.types.get("test.entry");

const hints = { icon: "rss", color: "orange" };

function carrying(more: Record<string, unknown>) {
  const connector = testConnector(vendor([entry]));
  return {
    ...connector,
    types: [
      { ...connector.types[0], type: { ...testType, ...more } },
    ] as typeof connector.types,
  };
}

describe("a type whose presentation differs from the one the connector carries", () => {
  it("is replaced with the label, description and display hints, in one replace", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      ...testType,
      label: "Feed Entry",
      description: "An old description.",
      display_hints: { icon: "newspaper" },
    });
    const connector = carrying({ display_hints: hints });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(puts()).toBe(1);
    expect(served()).toMatchObject({
      label: testType.label,
      description: testType.description,
      display_hints: hints,
    });
    expect(harness.lines.join("\n")).toContain(
      "changed the label, description, display_hints of the type test.entry",
    );
    expect(harness.lastRun().outcome).toBe("succeeded");

    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(puts()).toBe(1);
  });

  it("is replaced once when fields are missing too, keeping the server's own members", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      ...testType,
      label: "Feed Entry",
      fields: { title: { type: "string", required: true } },
      version: 4,
    });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(puts()).toBe(1);
    const sent = harness.server.requestsTo("PUT", "/types/test.entry")[0]?.body;
    const expected = canonicalType({ ...testType, version: 4 });
    Reflect.deleteProperty(expected, "id");
    expect(sent).toEqual(expected);
  });

  it("keeps the server's display hints where the connector carries none", async () => {
    harness.server.grants = fixer;
    harness.server.store({ ...testType, display_hints: { icon: "star" } });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(puts()).toBe(0);
    expect(served()?.["display_hints"]).toEqual({ icon: "star" });
  });
});

describe("a type whose presentation already agrees", () => {
  it("is not replaced", async () => {
    harness.server.grants = fixer;
    harness.server.store({ ...testType, display_hints: hints });
    const connector = carrying({ display_hints: hints });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(puts()).toBe(0);
  });

  it("is not replaced for display hints it only inherits from its parent", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      display_hints: hints,
    });
    harness.server.store({ ...testType, parent: "test.base" });
    expect(served()?.["display_hints"]).toEqual(hints);
    const connector = carrying({ parent: "test.base" });
    const code = await start(connector, harness.runtime(["--once"]));
    expect(harness.lastRun().error).toBeUndefined();
    expect(code).toBe(0);
    expect(puts()).toBe(0);
  });

  it("is replaced where the connector declares hints the type only inherits", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      display_hints: hints,
    });
    harness.server.store({ ...testType, parent: "test.base" });
    const connector = carrying({ parent: "test.base", display_hints: hints });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(puts()).toBe(1);
  });
});

describe("a presentation the key may not change", () => {
  it("runs on and says so once where the key lacks metadata types=write", async () => {
    harness.server.store({ ...testType, label: "Feed Entry" });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(puts()).toBe(0);
    expect(served()?.["label"]).toBe("Feed Entry");
    expect(harness.lastRun().outcome).toBe("succeeded");
    const said = harness.lines.filter((line) => line.includes("label"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("marfa keys update key-1");
    expect(harness.server.rows).toHaveLength(1);
  });

  it("runs on and says so where the server refuses the replacement", async () => {
    harness.server.grants = fixer;
    harness.server.store({ ...testType, label: "Feed Entry" });
    harness.server.refuseNext(
      "PUT /types/test.entry",
      403,
      "forbidden",
      "Changing label requires schema.write",
    );
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(puts()).toBe(1);
    expect(harness.lastRun().outcome).toBe("succeeded");
    expect(harness.lines.join("\n")).toContain("refused");
    expect(harness.server.rows).toHaveLength(1);
  });
});
