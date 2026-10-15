import { describe, expect, it } from "vitest";
import type { Item } from "@withmarfa/connector";
import { readerPolicy } from "../src/policy.js";
const item = (properties: Record<string, unknown>) =>
  ({ type: "readwise.source", properties }) as unknown as Item;
describe("Reader ownership", () => {
  it("leaves unmanaged export rows and other accounts alone", () => {
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({ account: "sample", readwise_id: "1" }),
      ),
    ).toEqual({ owned: false });
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({
          account: "other",
          reader_managed: true,
          reader_id: "one",
          canonical_key: "other:reader-document:one",
        }),
      ),
    ).toEqual({ owned: false });
  });
  it("requires a verified canonical identity or explicit create intent", () => {
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({ account: "sample", reader_managed: true }),
      ),
    ).toEqual({ owned: false });
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({ account: "sample", reader_create: true }),
      ),
    ).toMatchObject({ owned: true, firstAgreement: "hold" });
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({
          account: "sample",
          reader_managed: true,
          reader_id: "one",
          canonical_key: "sample:reader-document:one",
        }),
      ),
    ).toMatchObject({ owned: true });
  });
  it("adopts verified Reader entries without changing another account's row", () => {
    const entry = {
      source_id: "sample:source:1",
      properties: {
        account: "sample",
        reader_managed: true,
        reader_id: "one",
        canonical_key: "sample:reader-document:one",
      },
    };
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({ account: "sample" }),
        entry,
      ),
    ).toMatchObject({ owned: true, firstAgreement: "hold" });
    expect(
      readerPolicy(
        "readwise.source",
        "sample",
        item({ account: "other" }),
        entry,
      ),
    ).toEqual({ owned: false });
  });
});
