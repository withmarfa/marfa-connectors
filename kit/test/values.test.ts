import { describe, expect, it } from "vitest";
import { cleaned, fingerprint } from "../src/values.js";

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
