import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector, type TypeDefinition } from "../src/define.js";
import { start } from "../src/main.js";
import { readOnlyTypesOf } from "../src/read-only-types.js";
import type { Spec } from "../src/rows.js";
import { Harness, testType, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

function sent(): Record<string, unknown>[] {
  return harness.server
    .requestsTo("POST", "/connectors")
    .map((request) => request.body as Record<string, unknown>);
}

function typed(id: string): TypeDefinition {
  return { ...testType, id, link_field: "vendor_id" };
}

function two(carried: () => string[]) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [
      { type: typed("test.mirrored"), fields: ["title", "vendor_id"] },
      { type: typed("test.carried"), fields: ["title", "vendor_id"] },
    ],
    env: {},
    carries: carried,
    run: () => Promise.resolve(),
    onChange: () => Promise.resolve(undefined),
  });
}

describe("read_only_types on registration", () => {
  it("names the types a connector that carries nothing back writes", async () => {
    await harness.once(vendor());
    expect(sent()[0]?.["read_only_types"]).toEqual(["test.entry"]);
  });

  it("leaves the field out for a connector that carries every type back", async () => {
    await harness.twoWay(vendor());
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).not.toHaveProperty("read_only_types");
  });

  it("names only the types left out of what it carries", async () => {
    await start(
      two(() => ["test.carried"]),
      harness.runtime(["--once"]),
    );
    expect(sent()[0]?.["read_only_types"]).toEqual(["test.mirrored"]);
  });

  it("is replaced by a registration that follows a change of configuration", async () => {
    await start(
      two(() => ["test.carried"]),
      harness.runtime(["--once"]),
    );
    expect(harness.server.readOnlyTypes).toEqual(["test.mirrored"]);
    await start(
      two(() => []),
      harness.runtime(["--once"]),
    );
    expect(harness.server.readOnlyTypes).toEqual([
      "test.mirrored",
      "test.carried",
    ]);
    await start(
      two(() => ["test.mirrored", "test.carried"]),
      harness.runtime(["--once"]),
    );
    expect(harness.server.readOnlyTypes).toEqual([]);
    expect(harness.server.registrations).toBe(3);
  });
});

describe("readOnlyTypesOf", () => {
  it("holds each type once and none for no types", () => {
    const spec = (type: string, twoWay: boolean): Spec =>
      ({ type, twoWay }) as Spec;
    expect(
      readOnlyTypesOf([spec("a", false), spec("a", false), spec("b", true)]),
    ).toEqual(["a"]);
    expect(readOnlyTypesOf([])).toEqual([]);
  });
});
