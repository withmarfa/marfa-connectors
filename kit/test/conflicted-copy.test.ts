import { afterEach, beforeEach, expect, it } from "vitest";
import type { Entry } from "../src/define.js";
import { Harness, vendor, type Vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const original: Entry = {
  source_id: "one",
  properties: { title: "Plan", note: "Mine", vendor_id: "vendor-one" },
};

// A vendor that names what a create made after the row, as a create answers.
function held(): Vendor {
  const held = vendor([original]);
  held.vendorIdFor = (change) =>
    change.kind === "created" ? `made-${change.item.id}` : undefined;
  return held;
}

function created(held: Vendor): string[] {
  return held.changes
    .filter((change) => change.kind === "created")
    .map((change) => change.item.id);
}

function copyConditions(): [string, string][] {
  return Object.entries(harness.problems()).filter(([key]) =>
    key.startsWith("conflicted-copy:"),
  );
}

it("creates a row made in Marfa at the vendor, which a conflicted copy is not", async () => {
  const vendorHeld = held();
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  const row = harness.server.insert(
    "mine",
    { title: "Made in Marfa" },
    "test.entry",
  );

  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(created(vendorHeld)).toEqual([row.id]);
  expect(copyConditions()).toEqual([]);
});

it("leaves a conflicted copy in Marfa and raises a condition naming it and its original", async () => {
  const vendorHeld = held();
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  const row = harness.server.row("one");
  const copy = harness.server.conflictedCopy(row.id, { note: "Theirs" });
  const before = harness.server.requests.length;

  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(vendorHeld.changes).toEqual([]);
  const raised = copyConditions();
  expect(raised.map(([key]) => key)).toEqual([`conflicted-copy:${copy.id}`]);
  expect(raised[0]?.[1]).toContain(
    `${copy.id} is a conflicted copy of ${row.id}`,
  );

  const writes = harness.server.requests
    .slice(before)
    .filter(
      (request) =>
        request.path.startsWith("/items") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
        !request.path.startsWith("/items/lookup"),
    );
  expect(writes).toEqual([]);
  const kept = harness.server.byId(copy.id);
  expect(kept.state).toBe("active");
  expect(kept.properties["note"]).toBe("Theirs");
  expect(harness.server.tags.get(copy.id)).toContain("conflicted-copy");
  expect(harness.server.linkOf(kept)).toBeUndefined();

  // Standing: it is raised again, not cleared, while the copy waits.
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(vendorHeld.changes).toEqual([]);
  expect(copyConditions()).toHaveLength(1);
  expect(harness.lastRun().outcome).toBe("succeeded");
});

it("leaves a conflicted copy the connector meets first in a read of every row", async () => {
  const vendorHeld = held();
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  const row = harness.server.row("one");
  const copy = harness.server.conflictedCopy(row.id, { note: "Theirs" });
  // The server cannot answer from the cursor, so the next run reads every row.
  harness.server.tooOld = true;

  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(harness.lastRun().summary).toContain(
    "every row of the connector's types was compared with what was last agreed",
  );
  expect(created(vendorHeld)).toEqual([]);
  expect(copyConditions().map(([key]) => key)).toEqual([
    `conflicted-copy:${copy.id}`,
  ]);
});

it("still carries an edit to the original beside its copy", async () => {
  const vendorHeld = held();
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  const row = harness.server.row("one");
  harness.server.conflictedCopy(row.id, { note: "Theirs" }, { title: "Won" });

  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(vendorHeld.changes.map((change) => change.kind)).toEqual(["updated"]);
  expect(vendorHeld.changes[0]?.item.id).toBe(row.id);
});

it("clears the condition and sends nothing when the copy is put in the bin", async () => {
  const vendorHeld = held();
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  const copy = harness.server.conflictedCopy(harness.server.row("one").id, {
    note: "Theirs",
  });
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(copyConditions()).toHaveLength(1);

  harness.server.trash(copy.id);
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(vendorHeld.changes).toEqual([]);
  expect(copyConditions()).toEqual([]);
});

it("creates the copy at the vendor once a person removes its tag", async () => {
  const vendorHeld = held();
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  const copy = harness.server.conflictedCopy(harness.server.row("one").id, {
    note: "Theirs",
  });
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(created(vendorHeld)).toEqual([]);

  harness.server.tags.set(copy.id, []);
  expect(await harness.twoWay(vendorHeld)).toBe(0);
  expect(created(vendorHeld)).toEqual([copy.id]);
  expect(copyConditions()).toEqual([]);
});
