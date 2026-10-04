import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { narrowedCondition } from "../src/own-types.js";
import {
  Harness,
  linkedType,
  testConnector,
  testFields,
  testType,
  vendor,
  type Vendor,
} from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const minute = 60_000;

const entry = {
  source_id: "a:1",
  properties: { title: "One", note: "From the vendor" },
};

const fixer = {
  metadata_permissions: { types: "write" },
  type_permissions: { "test.entry": "write" },
};

/** The type as an older connector registered it, before it gained `note`
 *  and `link`. */
function older(more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...testType,
    fields: {
      title: { type: "string", required: true },
      vendor_id: { type: "string" },
    },
    ...more,
  };
}

const replacing = (request: { method: string; path: string }): boolean =>
  request.method === "PUT" && request.path === "/types/test.entry";

const puts = (): number =>
  harness.server.requestsTo("PUT", "/types/test.entry").length;

describe("a key with metadata types=write", () => {
  it("is accepted beside its own types, and schema.write or anything else wider refused", async () => {
    harness.server.grants = fixer;
    expect(await harness.once(vendor([entry]))).toBe(0);
    harness.server.grants = { ...fixer, permissions: ["schema.write"] };
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lastRun().error).toContain("is refused: schema.write");
    harness.server.grants = {
      ...fixer,
      permissions: ["schema.write", "items.purge"],
    };
    expect(await harness.once(vendor([entry]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    const named = error.slice(error.indexOf("is refused:"));
    expect(named).toContain("items.purge");
    expect(named).toContain("schema.write");
    expect(puts()).toBe(0);
  });

  it("adds the optional fields the server lacks, keeping the server's own fields, version, policies and roles", async () => {
    harness.server.grants = fixer;
    harness.server.types.set(
      "test.entry",
      older({
        fields: {
          title: { type: "string", required: true },
          vendor_id: { type: "string" },
          extra: { type: "string", description: "An operator's own field" },
        },
        version: 4,
        version_policy: { max_versions: 10 },
        roles: ["container"],
        merge_policy: {
          default: "last_writer_wins",
          fields: { title: "keep_both_copies" },
        },
      }),
    );
    expect(await harness.once(vendor([entry]))).toBe(0);

    const sent = harness.server.requestsTo("PUT", "/types/test.entry");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      label: testType.label,
      description: testType.description,
      fields: {
        ...testType.fields,
        extra: { type: "string", description: "An operator's own field" },
      },
      version: 4,
      version_policy: { max_versions: 10 },
      roles: ["container"],
      merge_policy: {
        default: "last_writer_wins",
        fields: { title: "keep_both_copies" },
      },
    });
    expect(harness.lines.join("\n")).toContain(
      "added link, note to the type test.entry",
    );
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
    expect(harness.lastRun().outcome).toBe("succeeded");

    harness.lines.length = 0;
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(puts()).toBe(1);
  });

  const child = (
    fields: string[],
    type: Record<string, unknown>,
    held: Vendor = vendor([entry]),
  ) => {
    const connector = testConnector(held);
    return {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields,
          type: { ...testType, parent: "test.base", ...type },
        },
      ],
    };
  };

  const everything = ["title", "note", "link", "vendor_id"];

  /** The type as an older connector registered it under a parent: its own
   *  fields, and the own members the server compares a replacement with. */
  function underParent(own: Record<string, unknown>): void {
    harness.server.store(
      older({
        parent: "test.base",
        fields: {
          title: { type: "string", required: true },
          vendor_id: { type: "string" },
        },
        ...own,
      }),
    );
  }

  it("sends neither the parent's fields nor its merge policy, only the type's own", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      merge_policy: {
        default: "keep_both_copies",
        fields: { origin: "last_writer_wins" },
      },
    });
    underParent({
      merge_policy: { fields: { title: "last_writer_wins" } },
    });
    expect(
      await start(child(everything, {}), harness.runtime(["--once"])),
    ).toBe(0);
    const body = harness.server.requestsTo("PUT", "/types/test.entry")[0]
      ?.body as Record<string, unknown>;
    expect(Object.keys(body["fields"] as object).sort()).toEqual([
      "link",
      "note",
      "title",
      "vendor_id",
    ]);
    expect(body["merge_policy"]).toEqual({
      fields: { title: "last_writer_wins" },
    });
    expect(body["parent"]).toBe("test.base");
    expect(harness.lastRun().summary ?? "").not.toContain("types update");
  });

  it("sends only the roles and version policy the type holds itself, not those it inherits", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      roles: ["container"],
      version_policy: { max_versions: 10, min_interval_seconds: 60 },
    });
    underParent({
      roles: ["task"],
      version_policy: { min_interval_seconds: 5, retention_days: 30 },
    });
    expect(
      await start(child(everything, {}), harness.runtime(["--once"])),
    ).toBe(0);
    const body = harness.server.requestsTo("PUT", "/types/test.entry")[0]
      ?.body as Record<string, unknown>;
    expect(body["roles"]).toEqual(["task"]);
    expect(body["version_policy"]).toEqual({
      min_interval_seconds: 5,
      retention_days: 30,
    });
    expect(puts()).toBe(1);
    expect(harness.lastRun().summary ?? "").not.toContain("types update");
  });

  it("sends no roles or version policy where the type adds nothing to its parent's", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      roles: ["container"],
      version_policy: { max_versions: 10 },
    });
    underParent({});
    expect(
      await start(child(everything, {}), harness.runtime(["--once"])),
    ).toBe(0);
    const body = harness.server.requestsTo("PUT", "/types/test.entry")[0]
      ?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("roles");
    expect(body).not.toHaveProperty("version_policy");
    expect(puts()).toBe(1);
  });

  it("adds a field to a type it registered under a parent with members of its own", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      roles: ["container"],
      version_policy: { max_versions: 10 },
      merge_policy: { default: "keep_both_copies" },
    });
    const own = {
      roles: ["task"],
      version_policy: { min_interval_seconds: 5 },
      merge_policy: { fields: { title: "last_writer_wins" } },
    };
    const first = child(
      ["title", "vendor_id"],
      {
        ...own,
        fields: {
          title: { type: "string" as const, required: true },
          vendor_id: { type: "string" as const },
        },
      },
      vendor([{ source_id: "a:1", properties: { title: "One" } }]),
    );
    expect(await start(first, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.requestsTo("POST", "/types")).toHaveLength(1);
    expect(puts()).toBe(0);

    expect(
      await start(child(everything, own), harness.runtime(["--once"])),
    ).toBe(0);
    expect(puts()).toBe(1);
    expect(
      Object.keys(harness.server.types.get("test.entry")?.["fields"] as object),
    ).toContain("note");
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
    expect(harness.lastRun().summary ?? "").not.toContain("types update");
  });

  it("starts without the field, naming what the server refused, where the type holds a member of its own that the subset leaves out", async () => {
    harness.server.grants = fixer;
    harness.server.store({
      id: "test.base",
      fields: { origin: { type: "string" } },
      roles: ["container"],
    });
    // The type lists its parent's role again, which the replacement leaves to
    // the parent.
    underParent({ roles: ["container", "task"] });
    expect(
      await start(child(everything, {}), harness.runtime(["--once"])),
    ).toBe(0);
    expect(puts()).toBe(1);
    const summary = harness.lastRun().summary ?? "";
    expect(summary).toContain("marfa types update test.entry --file");
    expect(summary).toContain("roles");
    expect(summary).toContain("link, note");
    expect(harness.server.rows[0]?.properties["note"]).toBeUndefined();
    expect(harness.lastRun().outcome).toBe("succeeded");
  });

  it("reads the type back, and stops without trying again where it still differs", async () => {
    harness.server.grants = fixer;
    harness.server.types.set("test.entry", older());
    let put = false;
    harness.server.beforeAnswer = (request) => {
      if (replacing(request)) put = true;
      // Another version of the connector replaces the type in between.
      if (
        put &&
        request.method === "GET" &&
        request.path === "/types/test.entry"
      ) {
        harness.server.types.set("test.entry", older());
      }
    };
    expect(await harness.once(vendor([entry]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain('field "note" is missing');
    expect(error).toContain("after it was brought up to date");
    expect(puts()).toBe(1);
    expect(harness.server.rows).toEqual([]);
  });

  it("starts once the server answers again, when the read after the replacement got no answer", async () => {
    harness.server.grants = fixer;
    harness.server.types.set("test.entry", older());
    let put = false;
    harness.server.beforeAnswer = (request) => {
      if (replacing(request)) {
        put = true;
        harness.server.refuseNext("GET /types/test.entry", 503, "unavailable");
      }
      if (put) harness.server.beforeAnswer = undefined;
    };
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.wake(minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(1);
    expect(puts()).toBe(1);
    harness.stop();
    expect(await exit).toBe(0);
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
  });

  it("registers the type again when it is deleted before the replacement lands", async () => {
    harness.server.grants = fixer;
    harness.server.types.set("test.entry", older());
    harness.server.beforeAnswer = (request) => {
      if (replacing(request)) harness.server.types.delete("test.entry");
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.requestsTo("POST", "/types")).toHaveLength(1);
    expect(harness.server.types.get("test.entry")).toEqual(testType);
  });

  it("stops with the server's reason when the replacement is refused", async () => {
    for (const [status, code, message] of [
      [403, "forbidden", "Changing roles requires something else"],
      [403, "type_not_permitted", "The key may not write test.entry"],
      [400, "invalid_schema", "The schema is refused"],
      [409, "link_taken", "Two rows hold one value"],
    ] as const) {
      harness.server.grants = fixer;
      harness.server.types.set("test.entry", older());
      harness.server.refuseNext("PUT /types/test.entry", status, code, message);
      expect(await harness.once(vendor([entry]))).toBe(1);
      const error = harness.lastRun().error ?? "";
      expect(error).toContain("could not be brought up to date");
      expect(error).toContain(message);
      expect(harness.server.rows).toEqual([]);
    }
  });

  describe("where the server refuses the change", () => {
    /** A row that holds `note`, which the type then loses, as when an
     *  operator removed the field: its name is one the key may not add. */
    async function heldNote(): Promise<void> {
      harness.server.grants = fixer;
      expect(await harness.once(vendor([entry]))).toBe(0);
      expect(harness.server.rows[0]?.properties["note"]).toBe(
        "From the vendor",
      );
      harness.server.types.set("test.entry", older());
      harness.server.grants = fixer;
    }

    it("starts without the fields, keeps what rows hold, and names what the server refused and the operator's command", async () => {
      await heldNote();
      const changed = {
        source_id: "a:1",
        properties: { title: "One again", note: "Changed at the vendor" },
      };
      expect(await harness.once(vendor([changed]))).toBe(0);
      expect(puts()).toBe(1);
      const row = harness.server.rows[0];
      expect(row?.properties["title"]).toBe("One again");
      expect(row?.properties["note"]).toBe("From the vendor");
      const run = harness.lastRun();
      expect(run.outcome).toBe("succeeded");
      expect(run.summary).toContain("marfa types update test.entry --file");
      expect(run.summary).toContain("fields.note");
      expect(run.summary).not.toContain("--metadata-permission");
      const condition = (
        harness.kept()["conditions"] as Record<string, string>
      )["type-fields:test.entry"];
      expect(condition).toContain("fields.note");
      expect(condition?.slice(0, 120)).toContain("marfa types update");
      expect(
        harness.server.types.get("test.entry")?.["fields"],
      ).not.toHaveProperty("note");
    });

    it("asks again before each scheduled run, and lifts the narrowing once an operator replaces the type", async () => {
      await heldNote();
      const held = vendor([entry]);
      const exit = start(
        testConnector(held),
        harness.runtime(["--every", "15m"]),
      );
      await harness.clock.sleeping(15 * minute);
      expect(held.runs).toBe(1);
      expect(puts()).toBe(1);
      expect(harness.lastRun().summary).toContain("marfa types update");

      await harness.clock.wake(15 * minute);
      await harness.clock.sleeping(15 * minute);
      expect(held.runs).toBe(2);
      expect(puts()).toBe(2);

      harness.server.types.set("test.entry", testType);
      await harness.clock.wake(15 * minute);
      await harness.clock.sleeping(15 * minute);
      expect(held.runs).toBe(3);
      expect(puts()).toBe(2);
      expect(harness.lastRun().summary).not.toContain("types update");
      harness.stop();
      expect(await exit).toBe(0);
    });

    it("still stops where the field the server refused is one the connector cannot write without", async () => {
      harness.server.grants = fixer;
      const connector = testConnector(
        vendor([
          {
            source_id: "a:1",
            properties: { title: "One", vendor_id: "a:1" },
          },
        ]),
      );
      const linked = {
        ...connector,
        types: [
          { ...connector.types[0], fields: testFields, type: linkedType },
        ],
      };
      expect(await start(linked, harness.runtime(["--once"]))).toBe(0);
      expect(harness.server.rows[0]?.properties["vendor_id"]).toBe("a:1");
      harness.server.types.set("test.entry", {
        ...linkedType,
        fields: { title: { type: "string", required: true } },
      });
      expect(await start(linked, harness.runtime(["--once"]))).toBe(1);
      const error = harness.lastRun().error ?? "";
      expect(error).toContain("vendor_id");
      expect(error).toContain("fields.vendor_id");
      expect(error).toContain("marfa types update test.entry --file");
      expect(error).not.toContain("--metadata-permission");
    });

    it("stops where the server refuses for a scope other than schema.write", async () => {
      harness.server.grants = fixer;
      harness.server.types.set("test.entry", older());
      harness.server.refuseNext(
        "PUT /types/test.entry",
        403,
        "forbidden",
        "Missing items.purge",
        undefined,
        { required_scope: "items.purge", changes: ["fields.note"] },
      );
      expect(await harness.once(vendor([entry]))).toBe(1);
      const error = harness.lastRun().error ?? "";
      expect(error).toContain("could not be brought up to date");
      expect(error).toContain("Missing items.purge");
      expect(harness.server.rows).toEqual([]);
    });

    it("starts without the fields where the server refuses with a scope and names no change", async () => {
      harness.server.grants = fixer;
      harness.server.types.set("test.entry", older());
      harness.server.beforeAnswer = (request) => {
        // The key lost types=write between the check and the replacement.
        if (replacing(request)) harness.server.grants = {};
      };
      expect(await harness.once(vendor([entry]))).toBe(0);
      expect(harness.lastRun().summary).toContain(
        "marfa keys update key-1 --metadata-permission types=write",
      );
    });
  });

  it("still stops, naming the operator's command, on every difference but a missing optional field", async () => {
    const connector = (held: Vendor) => testConnector(held);
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "a changed link",
        { ...testType, link_field: "vendor_id" },
        "link_field",
      ],
      ["a changed parent", { ...testType, parent: "test.base" }, "parent"],
      [
        "a field made required",
        {
          ...testType,
          fields: {
            ...testType.fields,
            note: { type: "string", required: true },
          },
        },
        '"note" is required on the server',
      ],
      [
        "a field required here",
        {
          ...testType,
          fields: { ...testType.fields, title: { type: "string" } },
        },
        '"title" is required here',
      ],
      [
        "a changed shape",
        {
          ...testType,
          fields: { ...testType.fields, note: { type: "integer" } },
        },
        '"note" has type',
      ],
      [
        "a required field the connector does not know",
        {
          ...testType,
          fields: {
            ...testType.fields,
            extra: { type: "string", required: true },
          },
        },
        '"extra" is required on the server',
      ],
      [
        "a required field the server lacks",
        older({
          fields: {
            note: { type: "string" },
            link: { type: "url" },
            vendor_id: { type: "string" },
          },
        }),
        '"title" is required here and missing on the server',
      ],
    ];
    for (const [, served, named] of cases) {
      harness.server.grants = fixer;
      harness.server.types.set("test.entry", served);
      expect(
        await start(connector(vendor([entry])), harness.runtime(["--once"])),
      ).toBe(1);
      const error = harness.lastRun().error ?? "";
      expect(error).toContain(named);
      expect(error).toContain("marfa types update test.entry --file");
      expect(harness.server.types.get("test.entry")).toBe(served);
    }
    expect(puts()).toBe(0);
    expect(harness.server.rows).toEqual([]);
  });

  it("still stops on a connection type that differs", async () => {
    harness.server.grants = {
      ...fixer,
      edge_permissions: { "test.blocks": "write" },
    };
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    held.connections = [
      {
        id: "test.blocks",
        cardinality: "many-to-many",
        source_type_constraints: ["test.entry"],
        target_type_constraints: ["test.entry"],
      },
    ];
    harness.server.edgeTypes.set("test.blocks", {
      id: "test.blocks",
      cardinality: "one-to-one",
      source_type_constraints: ["test.entry"],
      target_type_constraints: ["test.entry"],
      cascade_on_delete: "orphan",
      property_schema: {},
      written_at: "source",
    });
    expect(await harness.once(held)).toBe(1);
    expect(harness.lastRun().error).toContain(
      "the connection type test.blocks on the server differs",
    );
    expect(harness.server.rows).toEqual([]);
  });
});

describe("a key without metadata types=write", () => {
  it("names every metadata entry the key keeps in the command that grants it, since an update replaces the map", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      edge_permissions: { "test.blocks": "write" },
      metadata_permissions: { edge_types: "write" },
    };
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    held.connections = [
      {
        id: "test.blocks",
        cardinality: "many-to-many",
        source_type_constraints: ["test.entry"],
        target_type_constraints: ["test.entry"],
      },
    ];
    expect(await harness.once(held)).toBe(0);
    expect(harness.lastRun().summary).toContain(
      "marfa keys update key-1 --metadata-permission edge_types=write --metadata-permission types=write`",
    );
  });

  it("starts without the fields the server lacks, keeps what rows hold, and names the fix", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");

    harness.server.types.set("test.entry", older());
    const changed = {
      source_id: "a:1",
      properties: { title: "One again", note: "Changed at the vendor" },
    };
    expect(await harness.once(vendor([changed]))).toBe(0);
    expect(puts()).toBe(0);
    const row = harness.server.rows[0];
    expect(row?.properties["title"]).toBe("One again");
    expect(row?.properties["note"]).toBe("From the vendor");
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toContain("link, note");
    expect(run.summary).toContain(
      "marfa keys update key-1 --metadata-permission types=write",
    );
    expect(
      (harness.kept()["conditions"] as Record<string, string>)[
        "type-fields:test.entry"
      ],
    ).toBeDefined();
  });

  it("still stops where the server lacks the link field or a file field", async () => {
    harness.server.types.set("test.entry", {
      ...linkedType,
      fields: { title: { type: "string", required: true } },
    });
    const connector = testConnector(vendor([entry]));
    const linked = {
      ...connector,
      types: [{ ...connector.types[0], fields: testFields, type: linkedType }],
    };
    expect(await start(linked, harness.runtime(["--once"]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("vendor_id");
    expect(error).toContain(
      "marfa keys update key-1 --metadata-permission types=write",
    );

    const filed = {
      ...connector,
      types: [
        {
          ...connector.types[0],
          fields: [
            "title",
            "note",
            "link",
            "vendor_id",
            "blob_ref",
            "mime_type",
          ],
          type: {
            ...testType,
            fields: {
              ...testType.fields,
              blob_ref: { type: "string" as const },
              mime_type: { type: "string" as const },
            },
          },
        },
      ],
    };
    harness.server.types.set("test.entry", testType);
    expect(await start(filed, harness.runtime(["--once"]))).toBe(1);
    expect(harness.lastRun().error).toContain("blob_ref, mime_type");
    expect(harness.server.rows).toEqual([]);
  });

  it("lifts the narrowing under --every once the key may add the fields, without a restart", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(1);
    expect(harness.server.rows[0]?.properties["note"]).toBeUndefined();
    expect(harness.lastRun().summary).toContain(
      "--metadata-permission types=write",
    );

    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(2);
    expect(puts()).toBe(0);
    expect(harness.lastRun().summary).toContain(
      "--metadata-permission types=write",
    );

    harness.server.grants = fixer;
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(3);
    expect(puts()).toBe(1);
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
    expect(harness.lastRun().summary).not.toContain("types=write");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("tells the connector the fields it writes, which change when the narrowing lifts", async () => {
    harness.server.types.set("test.entry", older());
    const seen: string[][] = [];
    const held = vendor([entry]);
    held.read = (context) => {
      seen.push([...context.written("test.entry")]);
      expect(() => context.written("test.other")).toThrow(
        "the connector declares no type test.other",
      );
      expect([...context.forScope("s").written("test.entry")]).toEqual(
        seen.at(-1),
      );
      return Promise.resolve();
    };
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.grants = fixer;
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    harness.stop();
    expect(await exit).toBe(0);
    expect(seen).toEqual([["title", "vendor_id", "toString"], testFields]);
  });

  it("lifts the narrowing under --every once an operator fixes the type", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.types.set("test.entry", testType);
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(2);
    expect(harness.server.rows[0]?.properties["note"]).toBe("From the vendor");
    expect(harness.lastRun().summary).not.toContain("types=write");
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("stops under --every when the key was widened since the run before", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.grants = {
      ...fixer,
      permissions: ["items.purge"],
    };
    await harness.clock.wake(15 * minute);
    expect(await exit).toBe(1);
    expect(held.runs).toBe(1);
    expect(harness.lastRun().error).toContain("items.purge");
    expect(puts()).toBe(0);
  });

  it("goes on without the fields when the check before a scheduled run gets no answer", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.refuseNext("GET /keys/current", 503, "unavailable");
    await harness.clock.wake(15 * minute);
    await harness.clock.sleeping(15 * minute);
    expect(held.runs).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "could not be checked again, so it goes on without the fields it lacked",
    );
    expect(harness.lastRun().summary).toContain(
      "--metadata-permission types=write",
    );
    harness.stop();
    expect(await exit).toBe(0);
  });

  it("stops under --every when the check before a scheduled run finds a difference it may not put right", async () => {
    harness.server.types.set("test.entry", older());
    const held = vendor([entry]);
    const exit = start(
      testConnector(held),
      harness.runtime(["--every", "15m"]),
    );
    await harness.clock.sleeping(15 * minute);
    harness.server.types.set("test.entry", older({ link_field: "vendor_id" }));
    await harness.clock.wake(15 * minute);
    expect(await exit).toBe(1);
    expect(held.runs).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("link_field");
    expect(harness.lastRun().error).toContain(
      "marfa types update test.entry --file",
    );
  });
});

describe("a refused entry while a type is narrowed", () => {
  const bad = {
    source_id: "bad",
    properties: { title: "Bad", note: "From the vendor" },
  };
  const retry = { mode: "replay" as const, context: "a".repeat(64) };

  async function runTwice(): Promise<number[]> {
    harness.server.entryRefusals.set("bad", {
      status: 400,
      code: "invalid_properties",
      message: "Bad title",
    });
    const held = vendor();
    held.read = async (context) => {
      const scope = context.forScope("A", { retry });
      await scope.upsert("test.entry", [bad]);
      await scope.state.checkpoint("page", 1);
    };
    const posts = (): number =>
      harness.server.requestsTo("POST", "/items/bulk").length;
    const counts: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      expect(await harness.once(held)).toBe(0);
      counts.push(posts());
    }
    return counts;
  }

  it("is held for the day against a current type", async () => {
    const [first = 0, second = 0] = await runTwice();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("is held for the day while the type lacks a field the connector omits", async () => {
    harness.server.types.set("test.entry", older());
    const [first = 0, second = 0] = await runTwice();
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});

describe("the fix in a narrowed type's condition", () => {
  const fields = Array.from(
    { length: 80 },
    (_, index) => `field_${String(index)}`,
  );

  it("comes before the fields, so the cap on a condition never cuts it", () => {
    const text = narrowedCondition("test.entry", fields, {
      kind: "grant",
      key: "key-1",
      command:
        "marfa keys update key-1 --metadata-permission edge_types=write --metadata-permission types=write",
    });
    expect(text.length).toBeGreaterThan(500);
    expect(text.slice(0, 500)).toContain(
      "marfa keys update key-1 --metadata-permission edge_types=write --metadata-permission types=write",
    );
  });

  it("names the operator's command before the fields and the server's changes", () => {
    const text = narrowedCondition("test.entry", fields, {
      kind: "refused",
      changes: fields.map((name) => `fields.${name}`),
    });
    expect(text.length).toBeGreaterThan(500);
    expect(text.slice(0, 500)).toContain(
      "marfa types update test.entry --file <definition>",
    );
  });
});
