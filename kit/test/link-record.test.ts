import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

async function quietRun(held: Vendor): Promise<number> {
  held.changes.length = 0;
  return harness.twoWay(held);
}

/**
 * A create whose vendor object was made, so the connector links the row to
 * `v9`, and whose answer is then lost. `atWrite` is what the instance held
 * for the row as the link's write arrived, which is all a process that died
 * at that moment leaves behind.
 */
async function unanswered(): Promise<{
  held: Vendor;
  row: { id: string };
  atWrite: () => Record<string, unknown> | undefined;
}> {
  const held = vendor([]);
  await harness.twoWay(held);
  const row = harness.server.insert(
    undefined,
    { title: "Theirs", note: "first" },
    "test.entry",
    "person",
  );
  let seen: Record<string, unknown> | undefined;
  harness.server.beforeAnswer = (request) => {
    if (request.method !== "PATCH" || request.path !== `/items/${row.id}`)
      return;
    const body = request.body as { properties?: Record<string, unknown> };
    if (body.properties?.["vendor_id"] === undefined) return;
    const kept = harness.server.agreements.get(row.id)?.record;
    seen = kept === undefined ? undefined : structuredClone(kept);
  };
  held.vendorIdFor = () => "v9";
  held.failAfterLink = { id: row.id, error: new Error("no answer") };
  expect(await quietRun(held)).toBe(1);
  harness.server.beforeAnswer = undefined;
  held.vendorIdFor = undefined;
  expect(harness.server.byId(row.id).properties["vendor_id"]).toBe("v9");
  return { held, row, atWrite: () => seen };
}

/** The process died as the link landed: the instance holds what it held
 *  then. */
function died(
  row: { id: string },
  atWrite: Record<string, unknown> | undefined,
): void {
  const kept = harness.server.agreements.get(row.id);
  if (kept === undefined || atWrite === undefined)
    throw new Error("no agreement was kept before the write");
  kept.record = structuredClone(atWrite);
}

function carried(held: Vendor, kind: string) {
  return held.changes.filter((change) => change.kind === kind);
}

describe("the link setLink is about to write", () => {
  it("is kept on the row's agreement before the write is sent", async () => {
    const { atWrite } = await unanswered();
    expect(atWrite()).toMatchObject({
      attempted: expect.any(String) as string,
      linking: "v9",
    });
    expect(atWrite()?.["link"]).toBeUndefined();
  });

  it("is not kept once the run ends with the row linked", async () => {
    const { row } = await unanswered();
    expect(harness.agreement(row.id)).toMatchObject({ link: "v9" });
    expect(harness.agreement(row.id)?.["linking"]).toBeUndefined();
  });
});

describe("a create that linked the row and then lost its answer", () => {
  it("has its row's trash carry the link it wrote, though the process died before the agreement kept it", async () => {
    const { held, row, atWrite } = await unanswered();
    died(row, atWrite());
    harness.server.trash(row.id);
    await quietRun(held);
    const [trash] = carried(held, "trashed");
    expect(carried(held, "created")).toEqual([]);
    expect(trash?.item.properties["vendor_id"]).toBe("v9");
    expect(trash?.attempted).toBeUndefined();
    expect(trash?.made).toEqual(expect.any(String));
  });

  it("has its row's purge carry the link it wrote", async () => {
    const { held, row, atWrite } = await unanswered();
    died(row, atWrite());
    harness.server.trash(row.id);
    await quietRun(held);
    harness.server.purgeById(row.id);
    await quietRun(held);
    const [purge] = carried(held, "purged");
    expect(purge?.item.properties["vendor_id"]).toBe("v9");
  });

  it("carries a person's edit by the link it wrote", async () => {
    const { held, row, atWrite } = await unanswered();
    died(row, atWrite());
    harness.server.edit(row.id, { note: "edited" });
    await quietRun(held);
    const [update] = carried(held, "updated");
    expect(update?.item.properties["vendor_id"]).toBe("v9");
    expect(update?.changed).toEqual(new Set(["title", "note"]));
    expect(update?.made).toEqual(expect.any(String));
  });

  it("is settled once, however often the run is tried again", async () => {
    const { held, row, atWrite } = await unanswered();
    died(row, atWrite());
    harness.server.trash(row.id);
    await quietRun(held);
    expect(carried(held, "trashed")).toHaveLength(1);
    expect(await quietRun(held)).toBe(0);
    expect(held.changes).toEqual([]);
    expect(harness.agreement(row.id)).toMatchObject({
      link: "v9",
      state: "trashed",
    });
    expect(harness.agreement(row.id)?.["linking"]).toBeUndefined();
  });
});

describe("a create whose link never landed", () => {
  const lost = async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Theirs" },
      "test.entry",
      "person",
    );
    harness.server.refuseWhere(
      "PATCH /items/" + row.id,
      (request) =>
        (request.body as { properties?: Record<string, unknown> }).properties?.[
          "vendor_id"
        ] !== undefined,
      422,
      "validation_failed",
    );
    held.vendorIdFor = () => "v9";
    await quietRun(held);
    harness.server.stopRefusing();
    held.vendorIdFor = undefined;
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBeUndefined();
    return { held, row };
  };

  it("is not taken for a link the row holds, so its trash carries none", async () => {
    const { held, row } = await lost();
    harness.server.trash(row.id);
    await quietRun(held);
    const [trash] = carried(held, "trashed");
    expect(trash?.item.properties["vendor_id"]).toBeUndefined();
    expect(trash?.attempted).toEqual(expect.any(String));
  });

  it("is made again by the next run, which links the row", async () => {
    const { held, row } = await lost();
    held.vendorIdFor = () => "v9";
    await quietRun(held);
    const [created] = carried(held, "created");
    expect(created?.attempted).toEqual(expect.any(String));
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe("v9");
    expect(harness.agreement(row.id)).toMatchObject({ link: "v9" });
  });
});

describe("a link a person typed after an unanswered create", () => {
  const typed = async () => {
    const held = vendor([]);
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Theirs", note: "first" },
      "test.entry",
      "person",
    );
    held.pushFail = { id: row.id, error: new Error("lost the answer") };
    expect(await quietRun(held)).toBe(1);
    harness.server.edit(row.id, { vendor_id: "typed" });
    return { held, row };
  };

  it("is not carried as an update, and the run says so", async () => {
    const { held, row } = await typed();
    await quietRun(held);
    expect(carried(held, "updated")).toEqual([]);
    expect(
      held.changes.filter(
        (change) => change.item.properties["vendor_id"] === "typed",
      ),
    ).toEqual([]);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe("typed");
    const said = Object.values(harness.problems()).join("\n");
    expect(said).toContain("unknown");
    expect(said).toContain("leaves it alone");
    expect(said).not.toContain("typed");
  });

  it("is not carried by the trash or the purge that follow", async () => {
    const { held, row } = await typed();
    await quietRun(held);
    harness.server.trash(row.id);
    await quietRun(held);
    expect(
      held.changes.filter(
        (change) => change.item.properties["vendor_id"] === "typed",
      ),
    ).toEqual([]);
    harness.server.purgeById(row.id);
    await quietRun(held);
    expect(
      held.changes.filter(
        (change) => change.item.properties["vendor_id"] === "typed",
      ),
    ).toEqual([]);
    expect(harness.server.tombstones.size).toBeGreaterThan(0);
  });

  it("is kept on the row, never overwritten", async () => {
    const { held, row } = await typed();
    held.vendorIdFor = () => "v9";
    await quietRun(held);
    await quietRun(held);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe("typed");
  });
});

describe("a link a person typed over the one the connector wrote", () => {
  it("is not carried as an update or a trash, though the connector did write one", async () => {
    const { held, row, atWrite } = await unanswered();
    died(row, atWrite());
    harness.server.edit(row.id, { vendor_id: "typed" });
    await quietRun(held);
    expect(
      held.changes.filter(
        (change) => change.item.properties["vendor_id"] === "typed",
      ),
    ).toEqual([]);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe("typed");
    expect(Object.values(harness.problems()).join("\n")).toContain(
      "was typed over",
    );
    harness.server.trash(row.id);
    await quietRun(held);
    expect(
      held.changes.filter(
        (change) => change.item.properties["vendor_id"] === "typed",
      ),
    ).toEqual([]);
  });
});

describe("a link a person typed while a create waits in the journal", () => {
  it("is never overwritten when the replayed create writes its link", async () => {
    const held = vendor([]);
    held.journaled = true;
    await harness.twoWay(held);
    const row = harness.server.insert(
      undefined,
      { title: "Theirs", note: "first" },
      "test.entry",
      "person",
    );
    held.pushFail = { id: row.id, error: new Error("lost the answer") };
    expect(await quietRun(held)).toBe(1);
    harness.server.edit(row.id, { vendor_id: "typed" });
    held.vendorIdFor = () => "v9";
    await quietRun(held);
    expect(harness.server.byId(row.id).properties["vendor_id"]).toBe("typed");
    expect(harness.agreement(row.id)?.["link"]).not.toBe("v9");
  });
});
