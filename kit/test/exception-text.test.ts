import { describe, expect, it } from "vitest";
import { withoutBodies } from "../src/exception-text.js";

describe("withoutBodies", () => {
  it.each([
    [
      'the vendor refused {"title":"private"} today',
      "the vendor refused [removed] today",
    ],
    ['got [1, 2, {"a": "}"}] back', "got [removed] back"],
    ['escaped {"a": "quote \\" } here"} then', "escaped [removed] then"],
    ['nested {"a": {"b": [1, 2]}} end', "nested [removed] end"],
    ['cut off {"title": "priv', "cut off [removed]"],
    ['[{"a":1}] and {"b":2}', "[removed] and [removed]"],
  ])("removes a JSON body: %s", (text, expected) => {
    expect(withoutBodies(text)).toBe(expected);
  });

  it.each([
    "the vendor answered 503",
    "failed with [redacted] and [ERR_STREAM_PREMATURE_CLOSE]",
    "no body here: [ok] and [a b]",
  ])("keeps ordinary text: %s", (text) => {
    expect(withoutBodies(text)).toBe(text);
  });
});
