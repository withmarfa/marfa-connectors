import { expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const values = (maximum: string | undefined) => ({
  READWISE_ACCOUNT: "sample",
  READWISE_ACCESS_TOKEN: "fixture",
  READWISE_API_URL: undefined,
  READWISE_READER_API_URL: undefined,
  READWISE_READER_INCLUDE_FEED: undefined,
  READWISE_READER_INBOUND_ONLY: undefined,
  READWISE_READER_PROPAGATE_PURGE: undefined,
  READWISE_CONTENT_MAX_BYTES: maximum,
});

it.each([
  [undefined, 268435456],
  ["1", 1],
  ["0001", 1],
  ["143307926", 143307926],
  ["1073741824", 1073741824],
] as const)("uses the configured resource byte limit %s", (input, expected) => {
  expect(parseConfig(values(input))).toMatchObject({
    contentMaxBytes: expected,
  });
});
it.each([
  "",
  "0",
  "-1",
  "1.5",
  "1e6",
  "NaN",
  "Infinity",
  " 256",
  "1073741825",
  "9007199254740992",
])("rejects invalid resource byte limit %s", (input) => {
  expect(() => parseConfig(values(input))).toThrow(
    "READWISE_CONTENT_MAX_BYTES",
  );
});
