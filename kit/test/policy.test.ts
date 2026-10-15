import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defineConnector,
  type Change,
  type Entry,
  type Item,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

function connector(options: {
  entries: Entry[];
  changes: Change[];
  policy?: (
    item: Item | undefined,
    entry?: Entry,
  ) => {
    owned?: boolean;
    fields?: Readonly<Record<string, "mirror" | "sync" | "observe">>;
    firstAgreement?: "preserve";
  };
}) {
  return defineConnector({
    name: "test",
    source: "test",
    env: {},
    types: [
      {
        type: linkedType,
        fields: ["title", "note", "vendor_id"],
        policy: options.policy,
      },
    ],
    async run(context) {
      await context.upsert(linkedType.id, options.entries);
    },
    onChange(change) {
      options.changes.push(change);
      return Promise.resolve(undefined);
    },
  });
}
const entry = (title: string, note = ""): Entry => ({
  source_id: "one",
  properties: { vendor_id: "vendor:one", title, note },
});

it("preserves first-agreement divergence and carries only the local value", async () => {
  harness.server.insert(
    "one",
    { vendor_id: "vendor:one", title: "Local", note: "" },
    linkedType.id,
  );
  const changes: Change[] = [];
  const definition = connector({
    entries: [entry("Vendor")],
    changes,
    policy: () => ({ firstAgreement: "preserve" }),
  });
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("one").properties["title"]).toBe("Local");
  expect(changes).toHaveLength(1);
  expect([...(changes[0]?.changed ?? [])]).toEqual(["title"]);
});

it("observes vendor changes while retaining local divergence without outbound work", async () => {
  const options = {
    entries: [entry("Vendor")],
    changes: [] as Change[],
    policy: () => ({ fields: { title: "observe" as const } }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  options.entries = [entry("New vendor")];
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("one").properties["title"]).toBe("New vendor");
  harness.server.touch("one", { title: "Local" });
  options.entries = [entry("Latest vendor")];
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("one").properties["title"]).toBe("Local");
  expect(options.changes).toEqual([]);
  expect(
    [...harness.server.agreements.values()].every((value) => !value.waiting),
  ).toBe(true);
});

it("does not seed over a local value on an observer's first agreement", async () => {
  harness.server.insert(
    "one",
    { vendor_id: "vendor:one", title: "Local", note: "" },
    linkedType.id,
  );
  const changes: Change[] = [];
  const definition = connector({
    entries: [entry("Vendor")],
    changes,
    policy: () => ({ fields: { title: "observe" } }),
  });
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("one").properties["title"]).toBe("Local");
  expect(changes).toEqual([]);
});

it("recomputes observer policy when adoption races an inbound write", async () => {
  const options = {
    entries: [entry("Before")],
    changes: [] as Change[],
    policy: (item: Item | undefined) => ({
      fields: {
        title:
          item?.properties["note"] === "managed"
            ? ("observe" as const)
            : ("mirror" as const),
      },
    }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  const id = harness.server.row("one").id;
  let raced = false;
  harness.server.beforeAnswer = (request) => {
    if (
      !raced &&
      request.method === "PATCH" &&
      request.path === `/items/${id}`
    ) {
      raced = true;
      harness.server.touch("one", { title: "Local", note: "managed" });
    }
  };
  options.entries = [entry("Stale export", "managed")];
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(raced).toBe(true);
  expect(harness.server.row("one").properties["title"]).toBe("Local");
  expect(options.changes).toEqual([]);
});

it("does not carry or put back rows outside its ownership", async () => {
  const options = {
    entries: [entry("Before")],
    changes: [] as Change[],
    policy: (item: Item | undefined) => ({
      owned: item?.properties["note"] !== "other",
    }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  harness.server.touch("one", { title: "Local", note: "other" });
  options.entries = [];
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("one").properties["title"]).toBe("Local");
  expect(options.changes).toEqual([]);
});

it("rechecks ownership and field policy when a mirrored put-back races adoption", async () => {
  const options = {
    entries: [entry("Before")],
    changes: [] as Change[],
    policy: (item: Item | undefined) => ({
      fields: {
        title:
          item?.properties["note"] === "managed"
            ? ("observe" as const)
            : ("mirror" as const),
      },
    }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  harness.server.touch("one", { title: "Local" });
  const id = harness.server.row("one").id;
  let raced = false;
  harness.server.beforeAnswer = (request) => {
    if (
      !raced &&
      request.method === "PATCH" &&
      request.path === `/items/${id}`
    ) {
      raced = true;
      harness.server.touch("one", { title: "New local", note: "managed" });
    }
  };
  options.entries = [];
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(raced).toBe(true);
  expect(harness.server.row("one").properties["title"]).toBe("New local");
  expect(
    options.changes.flatMap((change) => [...change.changed]),
  ).not.toContain("title");
});

it("reads ownership again before carrying a cached watch change", async () => {
  const options = {
    entries: [entry("Before")],
    changes: [] as Change[],
    policy: (item: Item | undefined) => ({
      owned: item?.properties["note"] !== "other",
    }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  harness.server.touch("one", { title: "Local" });
  options.entries = [];
  const moved = {
    ...definition,
    run() {
      harness.server.touch("one", { note: "other" });
      return Promise.resolve(undefined);
    },
  };
  expect(await start(moved, harness.runtime(["--once"]))).toBe(0);
  expect(options.changes).toEqual([]);
});

it.each(["created", "trashed", "purged"])(
  "does not carry an unowned %s row",
  async (operation) => {
    const options = {
      entries: [entry("Before", "other")],
      changes: [] as Change[],
      policy: () => ({ owned: true }),
    };
    const definition = connector(options);
    expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
    options.entries = [];
    if (operation === "created")
      harness.server.insert(
        "manual",
        { title: "Manual", note: "other" },
        linkedType.id,
      );
    else if (operation === "trashed")
      harness.server.trash(harness.server.row("one").id);
    else harness.server.purge("one");
    const unowned = {
      ...definition,
      types: definition.types.map((kind) => ({
        ...kind,
        policy: (item: Item | undefined) => ({
          owned: item?.properties["note"] !== "other",
        }),
      })),
    };
    expect(await start(unowned, harness.runtime(["--once"]))).toBe(0);
    expect(options.changes).toEqual([]);
  },
);

it("refuses a stale inbound write when only the ownership marker changed", async () => {
  const options = {
    entries: [entry("Before")],
    changes: [] as Change[],
    policy: (item: Item | undefined) => ({
      owned: item?.properties["note"] !== "other",
    }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  const id = harness.server.row("one").id;
  let raced = false;
  harness.server.beforeAnswer = (request) => {
    if (
      !raced &&
      request.method === "PATCH" &&
      request.path === `/items/${id}`
    ) {
      raced = true;
      harness.server.touch("one", { note: "other" });
    }
  };
  options.entries = [entry("Stale title")];
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(raced).toBe(true);
  expect(harness.server.row("one").properties["title"]).toBe("Before");
});

it("keeps a refused exact write pending on a server without the precondition", async () => {
  const options = {
    entries: [entry("Before")],
    changes: [] as Change[],
    policy: () => ({ owned: true }),
  };
  const definition = connector(options);
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  const id = harness.server.row("one").id;
  harness.server.refuseNext(
    `PATCH /items/${id}`,
    400,
    "validation_error",
    "version_match is not declared",
  );
  options.entries = [entry("After")];
  await start(definition, harness.runtime(["--once"]));
  expect(harness.server.row("one").properties["title"]).toBe("Before");
  expect(await start(definition, harness.runtime(["--once"]))).toBe(0);
  expect(harness.server.row("one").properties["title"]).toBe("After");
});
