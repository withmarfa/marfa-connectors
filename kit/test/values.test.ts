import { describe, expect, it } from "vitest";
import { cleaned, fingerprint, same } from "../src/values.js";

describe("same", () => {
  it("takes a key holding null as a key the object does not have", () => {
    // A person's client can write null onto a row; the vendor's entry
    // leaves the key out. The witness: a value that differs is a change.
    expect(same({ title: "One", completed_at: null }, { title: "One" })).toBe(
      true,
    );
    expect(same({ title: "One" }, { title: "One", completed_at: null })).toBe(
      true,
    );
    expect(same({ title: "One", note: null }, { title: "One", note: "" })).toBe(
      false,
    );
    expect(same(null, undefined)).toBe(true);
    expect(same(null, "")).toBe(false);
  });

  it("compares as JSON, whatever order the keys arrive in", () => {
    expect(same({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(
      true,
    );
    expect(same({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 3 }], a: 1 })).toBe(
      false,
    );
    expect(same([1, 2], [2, 1])).toBe(false);
  });
});

describe("fingerprint", () => {
  it("names a value's content, keys in any order and a null as an absent key", () => {
    expect(fingerprint({ a: 1, b: { c: [1, 2] } })).toBe(
      fingerprint({ b: { c: [1, 2] }, a: 1 }),
    );
    expect(fingerprint({ a: 1, b: null })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });
});

describe("cleaned", () => {
  it("leaves out what a write clears: an absent or null key", () => {
    expect(cleaned({ a: 1, b: null, c: undefined })).toEqual({ a: 1 });
  });
});
