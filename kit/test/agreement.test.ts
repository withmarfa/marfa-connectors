import { describe, expect, it } from "vitest";
import {
  carried,
  changedInMarfa,
  mark,
  merge,
  noteWaiting,
  sideOf,
  type Agreement,
} from "../src/agreement.js";

const fields = ["title", "body", "labels"] as const;
const never = (): boolean => false;
const always = (): boolean => true;

/** Both sides agreed on these values. */
function agreed(values: Record<string, unknown>): Agreement {
  return {
    vendor: sideOf(fields, values),
    marfa: sideOf(fields, values),
    state: "active",
    changedAt: "2026-09-28T10:00:00.000Z",
  };
}

const base = { title: "One", body: "Plain", labels: ["a"] };

function row(
  properties: Record<string, unknown>,
  updated = "2026-09-28T10:05:00.000Z",
) {
  return { properties, occurred_at: undefined, updated_at: updated };
}

describe("merge", () => {
  it("keeps a change made in Marfa to a field the vendor did not change, and writes the vendor's change to another", () => {
    const merged = merge({
      fields,
      readOnly: never,
      agreement: agreed(base),
      row: row({ ...base, title: "One, from Marfa" }),
      entry: {
        source_id: "a:1",
        properties: { ...base, labels: ["a", "b"] },
        changed_at: "2026-09-28T10:10:00.000Z",
      },
    });
    expect(merged.properties).toEqual({
      title: "One, from Marfa",
      body: "Plain",
      labels: ["a", "b"],
    });
    expect(merged.write).toBe(true);
    expect(merged.lost).toEqual([]);
    expect(merged.kept).toEqual([]);
    // The title still waits to be carried, from when it was first seen.
    expect(merged.agreement.waiting).toEqual({
      title: "2026-09-28T10:05:00.000Z",
    });
    expect(changedInMarfa(merged.agreement, fields, merged.properties)).toEqual(
      ["title"],
    );
  });

  it("gives a field both sides changed to the later change, and a tie to Marfa", () => {
    const later = merge({
      fields,
      readOnly: never,
      agreement: {
        ...agreed(base),
        waiting: { title: "2026-09-28T10:05:00.000Z" },
      },
      row: row({ ...base, title: "Marfa's" }, "2026-09-28T10:20:00.000Z"),
      entry: {
        source_id: "a:1",
        properties: { ...base, title: "Vendor's" },
        changed_at: "2026-09-28T10:07:00.000Z",
      },
    });
    // The first sighting is the person's time, not the row's later one.
    expect(later.properties["title"]).toBe("Vendor's");
    expect(later.lost).toEqual(["title"]);
    expect(later.agreement.waiting).toBeUndefined();

    const tie = merge({
      fields,
      readOnly: never,
      agreement: agreed(base),
      row: row({ ...base, title: "Marfa's" }, "2026-09-28T10:07:00.000Z"),
      entry: {
        source_id: "a:1",
        properties: { ...base, title: "Vendor's" },
        changed_at: "2026-09-28T10:07:00.000Z",
      },
    });
    expect(tie.properties["title"]).toBe("Marfa's");
    expect(tie.kept).toEqual(["title"]);
    expect(tie.write).toBe(false);
  });

  it("agrees silently where both sides changed a field to the same value", () => {
    const merged = merge({
      fields,
      readOnly: never,
      agreement: agreed(base),
      row: row({ ...base, title: "Same" }),
      entry: {
        source_id: "a:1",
        properties: { ...base, title: "Same" },
        changed_at: "2026-09-28T10:10:00.000Z",
      },
    });
    expect(merged.lost).toEqual([]);
    expect(merged.kept).toEqual([]);
    expect(merged.write).toBe(false);
    expect(changedInMarfa(merged.agreement, fields, merged.properties)).toEqual(
      [],
    );
  });

  it("puts a read-only field back from the vendor, and names it", () => {
    const merged = merge({
      fields,
      readOnly: always,
      agreement: agreed(base),
      row: row(
        { ...base, body: "Edited in Marfa" },
        "2026-09-28T11:00:00.000Z",
      ),
      entry: {
        source_id: "a:1",
        properties: base,
        changed_at: "2026-09-28T10:00:00.000Z",
      },
    });
    expect(merged.properties["body"]).toBe("Plain");
    expect(merged.putBack).toEqual(["body"]);
    expect(merged.write).toBe(true);
    expect(merged.agreement.waiting).toBeUndefined();
  });

  it("leaves two sides that rightly differ as they are, and carries nothing", () => {
    // The vendor trimmed what was carried: the two halves differ on purpose.
    const agreement: Agreement = {
      vendor: sideOf(fields, { ...base, title: "Trimmed" }),
      marfa: sideOf(fields, { ...base, title: "Trimmed " }),
      state: "active",
    };
    const merged = merge({
      fields,
      readOnly: never,
      agreement,
      row: row({ ...base, title: "Trimmed " }),
      entry: {
        source_id: "a:1",
        properties: { ...base, title: "Trimmed" },
        changed_at: "2026-09-28T10:10:00.000Z",
      },
    });
    expect(merged.write).toBe(false);
    expect(changedInMarfa(merged.agreement, fields, merged.properties)).toEqual(
      [],
    );
  });

  it("clears a field the vendor cleared, and keeps a field the vendor does not hold", () => {
    const merged = merge({
      fields,
      readOnly: never,
      agreement: agreed(base),
      row: row({ ...base, notes: "Marfa's own" }),
      entry: {
        source_id: "a:1",
        properties: { title: "One", labels: ["a"] },
        changed_at: "2026-09-28T10:10:00.000Z",
      },
    });
    expect(merged.properties).toEqual({
      title: "One",
      labels: ["a"],
      notes: "Marfa's own",
    });
  });

  it("seeds a row with nothing agreed from the vendor, and carries nothing", () => {
    const merged = merge({
      fields,
      readOnly: never,
      agreement: undefined,
      row: row({ ...base, title: "Marfa's", notes: "kept" }),
      entry: {
        source_id: "a:1",
        properties: base,
        changed_at: "2026-09-28T10:10:00.000Z",
      },
    });
    expect(merged.properties).toEqual({ ...base, notes: "kept" });
    expect(merged.seeded).toEqual(["title"]);
    expect(changedInMarfa(merged.agreement, fields, merged.properties)).toEqual(
      [],
    );
  });

  it("keeps waiting marks that are not fields through a merge", () => {
    const merged = merge({
      fields,
      readOnly: never,
      agreement: {
        ...agreed(base),
        waiting: { "@state": "2026-09-28T10:01:00.000Z" },
      },
      row: row(base),
      entry: { source_id: "a:1", properties: base },
    });
    expect(merged.agreement.waiting).toEqual({
      "@state": "2026-09-28T10:01:00.000Z",
    });
  });

  it("writes the row's own time only where the vendor moved it", () => {
    const first = merge({
      fields,
      readOnly: never,
      agreement: undefined,
      row: row(base),
      entry: {
        source_id: "a:1",
        properties: base,
        occurred_at: "2026-09-01T00:00:00Z",
      },
    });
    expect(first.occurredAt).toBe("2026-09-01T00:00:00.000Z");
    const again = merge({
      fields,
      readOnly: never,
      agreement: first.agreement,
      row: { ...row(base), occurred_at: "2026-08-01T00:00:00.000Z" },
      entry: {
        source_id: "a:1",
        properties: base,
        occurred_at: "2026-09-01T00:00:00.000Z",
      },
    });
    // The vendor did not move it: Marfa's own time stands.
    expect(again.occurredAt).toBeUndefined();
    expect(again.write).toBe(false);
  });
});

describe("carried", () => {
  it("records what was carried on Marfa's side, and the vendor's answer on its own", () => {
    const agreement = { ...agreed(base), waiting: { title: "t" } };
    const next = carried({
      fields,
      agreement,
      properties: { ...base, title: "Sent " },
      state: "active",
      changed: ["title"],
      answered: {
        source_id: "a:1",
        properties: { ...base, title: "Sent" },
        changed_at: "2026-09-28T12:00:00.000Z",
      },
    });
    expect(next.marfa["title"]).toBe(mark("Sent "));
    expect(next.vendor["title"]).toBe(mark("Sent"));
    expect(next.waiting).toBeUndefined();
    expect(next.changedAt).toBe("2026-09-28T12:00:00.000Z");
    // The vendor's echo of its own answer is no change on either side.
    const echo = merge({
      fields,
      readOnly: never,
      agreement: next,
      row: row({ ...base, title: "Sent " }),
      entry: {
        source_id: "a:1",
        properties: { ...base, title: "Sent" },
        changed_at: "2026-09-28T12:00:00.000Z",
      },
    });
    expect(echo.write).toBe(false);
    expect(changedInMarfa(echo.agreement, fields, echo.properties)).toEqual([]);
  });

  it("takes the carried values as the vendor's where it answered nothing", () => {
    const next = carried({
      fields,
      agreement: agreed(base),
      properties: { ...base, body: undefined },
      state: "active",
      changed: ["body"],
      answered: undefined,
    });
    expect(next.vendor["body"]).toBeUndefined();
    expect(next.marfa["body"]).toBeUndefined();
    expect(next.vendor["title"]).toBe(mark("One"));
  });
});

describe("noteWaiting", () => {
  it("keeps the first sighting of a field and lets go of one back where it was agreed", () => {
    const agreement = { ...agreed(base), waiting: { title: "first" } };
    expect(
      noteWaiting(agreement, fields, { ...base, title: "x", body: "y" }, "now"),
    ).toEqual({ title: "first", body: "now" });
    expect(noteWaiting(agreement, fields, base, "now")).toBeUndefined();
  });
});
