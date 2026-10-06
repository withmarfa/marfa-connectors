import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TypeDefinition } from "../src/define.js";
import { start } from "../src/main.js";
import { typeDifferences } from "../src/type-check.js";
import { Harness, testConnector, testType, vendor } from "./harness.js";

describe("the type check", () => {
  const none = { missing: [], other: [] };
  const served = {
    id: "test.entry",
    fields: {
      title: { type: "string", required: true },
      note: { type: "string" },
      link: { type: "url" },
      vendor_id: { type: "string" },
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
    ).toEqual(none);
    expect(
      typeDifferences(withFormat({ type: "url", format: "url" }), served),
    ).toEqual(none);
    expect(
      typeDifferences(
        withFormat({ type: "array", items_type: "string", format: "url" }),
        {
          ...served,
          fields: {
            ...served.fields,
            link: { type: "array", items_type: "url" },
          },
        },
      ),
    ).toEqual(none);
    expect(
      typeDifferences(withFormat({ type: "string", format: "bcp47" }), served)
        .other,
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
    expect(typeDifferences(searchable(true), served)).toEqual(none);
    expect(typeDifferences(searchable(false), served).other).toEqual([
      'field "note" has searchable false here and true on the server',
    ]);
  });

  it("compares the parent", () => {
    expect(typeDifferences(testType, served)).toEqual(none);
    expect(
      typeDifferences(testType, { ...served, parent: "test.base" }).other,
    ).toEqual(['parent is nothing here and "test.base" on the server']);
  });

  it("keeps an optional field the server holds and the connector does not declare, and refuses a required one", () => {
    const extra = (field: object) => ({
      ...served,
      fields: { ...served.fields, extra: field },
    });
    expect(typeDifferences(testType, extra({ type: "string" }))).toEqual(none);
    expect(
      typeDifferences(testType, extra({ type: "string", required: true })),
    ).toEqual({
      missing: [],
      other: ['field "extra" is required on the server and not here'],
    });
  });

  it("tells an optional field the server lacks apart from every other difference", () => {
    const { title, vendor_id } = served.fields;
    expect(
      typeDifferences(testType, { ...served, fields: { title, vendor_id } }),
    ).toEqual({
      missing: ["link", "note"],
      other: [],
    });
    const { note, link } = served.fields;
    expect(
      typeDifferences(testType, {
        ...served,
        fields: { note, link, vendor_id },
      }),
    ).toEqual({
      missing: [],
      other: ['field "title" is required here and missing on the server'],
    });
  });
});

describe("MARFA_API_URL", () => {
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
          harness.runtime(["--every", "1m"], { MARFA_API_URL: url }),
        ),
      ).toBe(2);
    }
    const said = harness.lines.join("\n");
    expect(said).toContain(
      "MARFA_API_URL is not an http or https address without credentials",
    );
    expect(said).not.toContain("hunter2-pass");
    expect(harness.server.requests).toEqual([]);
    expect(
      await start(testConnector(vendor()), harness.runtime(["--once"])),
    ).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
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

  it("are each reported in turn when more stand than a report holds, the rest counted and named in the log", async () => {
    const held = vendor([{ source_id: "a:1", properties: { title: "One" } }]);
    held.conditions = Array.from(
      { length: 40 },
      (_, index): [string, string] => [
        `c${String(index)}`,
        `condition ${String(index).padStart(2, "0")} ${"is a lasting problem ".repeat(3)}`,
      ],
    );
    const seen = new Set<string>();
    for (let run = 0; run < 2; run += 1) {
      await harness.once(held);
      const summary = harness.lastRun().summary ?? "";
      expect(summary.length).toBeLessThanOrEqual(2000);
      const shown = [...summary.matchAll(/condition (\d\d)/g)];
      for (const match of shown) seen.add(match[1] ?? "");
      expect(summary).toMatch(
        new RegExp(
          `${String(40 - shown.length)} more conditions are in the connector's log$`,
        ),
      );
    }
    expect(seen.size).toBe(40);
    const warned = harness.lines.filter((line) =>
      line.includes("is a lasting problem"),
    );
    expect(warned).toHaveLength(80);
  });
});
