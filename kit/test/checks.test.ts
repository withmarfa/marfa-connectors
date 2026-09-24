import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TypeDefinition } from "../src/define.js";
import { start } from "../src/main.js";
import { typeDifferences } from "../src/type-check.js";
import { Harness, testConnector, testType, vendor } from "./harness.js";

describe("the type check", () => {
  const served = {
    id: "test.entry",
    fields: {
      title: { type: "string", required: true },
      note: { type: "string" },
      link: { type: "url" },
    },
  };

  it("folds any format that is a field type of its own, as the server does", () => {
    const withFormat = (link: object): TypeDefinition => ({
      ...testType,
      fields: {
        ...testType.fields,
        link: link as TypeDefinition["fields"][string],
      },
    });
    expect(
      typeDifferences(withFormat({ type: "string", format: "url" }), served),
    ).toEqual([]);
    expect(
      typeDifferences(withFormat({ type: "url", format: "url" }), served),
    ).toEqual([]);
    expect(
      typeDifferences(
        withFormat({ type: "array", items_type: "string", format: "url" }),
        {
          ...served,
          fields: {
            ...served.fields,
            link: { type: "url", items_type: "string" },
          },
        },
      ),
    ).toEqual([]);
    expect(
      typeDifferences(withFormat({ type: "string", format: "bcp47" }), served),
    ).toEqual([
      'field "link" has type "string" here and "url" on the server',
      'field "link" has format "bcp47" here and nothing on the server',
    ]);
  });

  it("takes an absent searchable as searchable", () => {
    const searchable = (value: boolean): TypeDefinition => ({
      ...testType,
      fields: {
        ...testType.fields,
        note: { type: "string", searchable: value },
      },
    });
    expect(typeDifferences(searchable(true), served)).toEqual([]);
    expect(typeDifferences(searchable(false), served)).toEqual([
      'field "note" has searchable false here and true on the server',
    ]);
  });

  it("compares the parent", () => {
    expect(typeDifferences(testType, served)).toEqual([]);
    expect(
      typeDifferences(testType, { ...served, parent: "test.base" }),
    ).toEqual(['parent is nothing here and "test.base" on the server']);
  });
});

describe("MARFA_URL", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await Harness.create();
  });
  afterEach(async () => {
    await harness.close();
  });

  it("is refused with credentials, a query or a fragment, without showing what it holds", async () => {
    const withCredentials = harness.server.url.replace(
      "http://",
      "http://someone:hunter2-pass@",
    );
    for (const url of [
      withCredentials,
      `${harness.server.url}/?x=1`,
      `${harness.server.url}/#x`,
    ]) {
      expect(
        await start(
          testConnector(vendor()),
          harness.runtime(["--every", "1m"], { MARFA_URL: url }),
        ),
      ).toBe(2);
    }
    expect(harness.lines.join("\n")).not.toContain("hunter2-pass");
    expect(harness.server.requests).toEqual([]);
  });
});

describe("conditions past what one summary holds", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await Harness.create();
  });
  afterEach(async () => {
    await harness.close();
  });

  it("are each reported on some run, none marked reported before it is", async () => {
    const held = vendor([{ source_id: "a:1", properties: { title: "One" } }]);
    held.conditions = Array.from(
      { length: 40 },
      (_, index): [string, string] => [
        `c${String(index)}`,
        `condition ${String(index).padStart(2, "0")} ${"is a lasting problem ".repeat(3)}`,
      ],
    );
    const seen = new Set<string>();
    for (let run = 0; run < 6; run += 1) {
      await harness.once(held);
      const summary = harness.lastRun().summary ?? "";
      expect(summary.length).toBeLessThanOrEqual(2000);
      for (const match of summary.matchAll(/condition (\d\d)/g)) {
        expect(seen.has(match[1] ?? "")).toBe(false);
        seen.add(match[1] ?? "");
      }
    }
    expect(seen.size).toBe(40);
    expect(harness.server.runs[0]?.summary).toMatch(
      /more conditions wait for a later report$/,
    );
  });
});
