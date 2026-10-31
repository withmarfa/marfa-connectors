import { describe, expect, it } from "vitest";
import { removed } from "../src/recurrence.js";

describe("removed", () => {
  it("reads a line of many empty parameters in linear time", () => {
    const line = `EXDATE${";".repeat(64)}`;
    const result = removed([line], "Europe/London");
    expect(result.instants.size + result.days.size).toBe(0);
  });

  it("reads a zoned line as its instant", () => {
    const result = removed(
      ["EXDATE;TZID=Europe/London:20261203T090000"],
      "UTC",
    );
    expect([...result.instants]).toEqual([Date.UTC(2026, 11, 3, 9)]);
  });
});
