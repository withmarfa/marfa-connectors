import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineConnector,
  type RunContext,
  type TypeDefinition,
} from "../src/define.js";
import { start } from "../src/main.js";
import { rowId, type TableReport, type TableRow } from "../src/tables.js";
import { Harness, testFields, testType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const tabled: TypeDefinition = {
  ...testType,
  tables: {
    checks: {
      label: "Checks",
      columns: {
        name: { type: "string", required: true, max_length: 12 },
        state: { type: "enum", enum_values: ["passed", "failed"] },
        runs: { type: "integer" },
      },
      order: "name",
    },
  },
};

const entry = { source_id: "a:1", properties: { title: "One" } };

const fixer = {
  metadata_permissions: { types: "write" },
  type_permissions: { "test.entry": "write" },
};

type Work = (
  context: RunContext<Record<string, never>>,
  itemId: string,
) => Promise<void>;

function connectorDoing(work: Work, type: TypeDefinition = tabled) {
  return defineConnector({
    name: "test",
    description: "A connector that writes table rows.",
    source: "test",
    types: [{ type, fields: testFields }],
    env: {},
    async run(context) {
      await context.upsert(type.id, [entry]);
      await work(context, "a:1");
    },
  });
}

function runOnce(work: Work, type?: TypeDefinition): Promise<number> {
  return start(connectorDoing(work, type), harness.runtime(["--once"]));
}

const rows = (...names: string[]): TableRow[] =>
  names.map((name) => ({ key: name, values: { name, state: "passed" } }));

function itemId(): string {
  const [id] = harness.server.rows.map((row) => row.id);
  if (id === undefined) throw new Error("no item was written");
  return id;
}

function held(): Map<string, Record<string, unknown>> {
  const table = harness.server.tableRows.get(itemId())?.get("checks");
  return new Map(
    [...(table ?? [])].map(([id, row]) => [id, row.values] as const),
  );
}

const batches = (): number =>
  harness.server.requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/rows"),
  ).length;

describe("a type that declares tables", () => {
  it("is registered with them", async () => {
    harness.server.grants = fixer;
    expect(await runOnce(() => Promise.resolve())).toBe(0);
    expect(harness.server.types.get("test.entry")?.["tables"]).toHaveProperty(
      "checks",
    );
  });

  it("gains a table its stored definition lacks, when the key may write types", async () => {
    harness.server.grants = fixer;
    harness.server.types.set("test.entry", { ...testType });
    expect(await runOnce(() => Promise.resolve())).toBe(0);
    expect(harness.server.requestsTo("PUT", "/types/test.entry")).toHaveLength(
      1,
    );
    expect(harness.server.types.get("test.entry")?.["tables"]).toHaveProperty(
      "checks",
    );
  });

  it("replaces the type to land a changed table or column label and description", async () => {
    harness.server.grants = fixer;
    harness.server.types.set("test.entry", {
      ...testType,
      tables: tabled.tables,
    });
    const relabelled: TypeDefinition = {
      ...testType,
      tables: {
        checks: {
          label: "Check runs",
          description: "What ran on the head commit.",
          columns: {
            ...tabled.tables?.["checks"]?.columns,
            name: {
              type: "string",
              required: true,
              max_length: 12,
              label: "Check name",
            },
          },
          order: "name",
        },
      },
    };
    expect(await runOnce(() => Promise.resolve(), relabelled)).toBe(0);
    expect(harness.server.requestsTo("PUT", "/types/test.entry")).toHaveLength(
      1,
    );
    const stored = harness.server.types.get("test.entry")?.["tables"] as
      | Record<
          string,
          {
            label?: string;
            description?: string;
            columns: Record<string, { label?: string }>;
          }
        >
      | undefined;
    expect(stored?.["checks"]).toMatchObject({
      label: "Check runs",
      description: "What ran on the head commit.",
    });
    expect(stored?.["checks"]?.columns["name"]?.label).toBe("Check name");
    expect(await runOnce(() => Promise.resolve(), relabelled)).toBe(0);
    expect(harness.server.requestsTo("PUT", "/types/test.entry")).toHaveLength(
      1,
    );
  });

  it("leaves a key that may not write types to skip the table, and says so", async () => {
    harness.server.types.set("test.entry", { ...testType });
    let report: TableReport | undefined;
    await runOnce(async (context, key) => {
      report = await context.tables.put("test.entry", key, "checks", rows("a"));
    });
    expect(report?.skipped).toBe("narrowed");
    expect(batches()).toBe(0);
  });
});

describe("writing rows", () => {
  beforeEach(() => {
    harness.server.grants = fixer;
  });

  it("puts rows to the item's table, patches one and deletes one", async () => {
    const reports: TableReport[] = [];
    expect(
      await runOnce(async (context, key) => {
        reports.push(
          await context.tables.put("test.entry", key, "checks", rows("a", "b")),
          await context.tables.patch("test.entry", key, "checks", [
            { key: "a", values: { state: "failed" } },
          ]),
          await context.tables.remove("test.entry", key, "checks", ["b", "z"]),
        );
      }),
    ).toBe(0);
    expect(
      reports.map((r) => [r.created, r.patched, r.deleted, r.absent]),
    ).toEqual([
      [2, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 1],
    ]);
    expect([...held().values()]).toEqual([{ name: "a", state: "failed" }]);
    expect([...held().keys()]).toEqual([rowId(itemId(), "checks", "a")]);
  });

  it("writes no duplicate rows when the run is sent again", async () => {
    const work: Work = async (context, key) => {
      await context.tables.put("test.entry", key, "checks", rows("a", "b"));
    };
    expect(await runOnce(work)).toBe(0);
    expect(await runOnce(work)).toBe(0);
    expect(held().size).toBe(2);
  });

  it("writes a value that returns to an earlier state, since a key is never made from the content", async () => {
    const as =
      (state: "passed" | "failed"): Work =>
      async (context, key) => {
        await context.tables.put("test.entry", key, "checks", [
          { key: "a", values: { name: "a", state } },
        ]);
      };
    for (const state of ["passed", "failed", "passed"] as const) {
      expect(await runOnce(as(state))).toBe(0);
      expect([...held().values()]).toEqual([{ name: "a", state }]);
    }
    const keys = harness.server.requests
      .filter((request) => request.path.endsWith("/rows"))
      .map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("sends each page of a call under a key of its own", async () => {
    await runOnce(async (context, key) => {
      await context.tables.put(
        "test.entry",
        key,
        "checks",
        rows(...Array.from({ length: 501 }, (_, index) => `r${String(index)}`)),
      );
    });
    const keys = harness.server.requests
      .filter((request) => request.path.endsWith("/rows"))
      .map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("reports a refused row, keeps the rest, and raises a condition", async () => {
    let report: TableReport | undefined;
    expect(
      await runOnce(async (context, key) => {
        report = await context.tables.put("test.entry", key, "checks", [
          ...rows("a"),
          { key: "long", values: { name: "x".repeat(40) } },
          { key: "bad", values: { name: "b", state: "unknown" } },
          ...rows("c"),
        ]);
      }),
    ).toBe(0);
    expect(report?.created).toBe(2);
    expect(report?.refused.map((r) => [r.key, r.column])).toEqual([
      ["long", "name"],
      ["bad", "state"],
    ]);
    expect(report?.refused[0]?.reason).toContain("12");
    expect([...held().values()].map((values) => values["name"]).sort()).toEqual(
      ["a", "c"],
    );
    expect(Object.keys(harness.problems())).toContain(
      "table-rows:test.entry:checks",
    );
  });

  it("deletes a row the vendor removed, and writes nothing for rows unchanged", async () => {
    const reports: TableReport[] = [];
    await runOnce(async (context, key) => {
      reports.push(
        await context.tables.replace(
          "test.entry",
          key,
          "checks",
          rows("a", "b"),
        ),
        await context.tables.replace(
          "test.entry",
          key,
          "checks",
          rows("a", "b"),
        ),
        await context.tables.replace("test.entry", key, "checks", rows("a")),
      );
    });
    expect(reports.map((r) => [r.created, r.unchanged, r.deleted])).toEqual([
      [2, 0, 0],
      [0, 2, 0],
      [0, 1, 1],
    ]);
    expect([...held().values()].map((values) => values["name"])).toEqual(["a"]);
    expect(batches()).toBe(2);
  });

  it("reads the rows back", async () => {
    let read: readonly unknown[] | undefined;
    await runOnce(async (context, key) => {
      await context.tables.put("test.entry", key, "checks", rows("a"));
      read = await context.tables.read("test.entry", key, "checks");
    });
    expect(read).toHaveLength(1);
  });

  it("skips an item that is not there, and one in the bin", async () => {
    const reports: (TableReport | undefined)[] = [];
    await runOnce(async (context, key) => {
      reports.push(
        await context.tables.put("test.entry", "nothing", "checks", rows("a")),
      );
      harness.server.trash(itemId());
      reports.push(
        await context.tables.put("test.entry", key, "checks", rows("a")),
      );
    });
    expect(reports.map((r) => r?.skipped)).toEqual(["missing", "bin"]);
  });

  it("halves a page the server finds too large", async () => {
    harness.server.bodyCap = 3000;
    const many = Array.from({ length: 40 }, (_, at) => ({
      key: `row-${String(at)}`,
      values: { name: `n${String(at)}` },
    }));
    await runOnce(async (context, key) => {
      await context.tables.put("test.entry", key, "checks", many);
    });
    expect(held().size).toBe(40);
    expect(batches()).toBeGreaterThan(1);
  });

  it("refuses a table the type does not declare", async () => {
    expect(
      await runOnce(async (context, key) => {
        await context.tables.put("test.entry", key, "nothing", rows("a"));
      }),
    ).toBe(1);
  });
});
