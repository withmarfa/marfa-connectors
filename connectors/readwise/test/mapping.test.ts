import { describe, expect, it } from "vitest";
import { parsePage } from "@withmarfa/readwise";
import { identity, mapHighlight, mapSource } from "@withmarfa/readwise";
import {
  sourceType,
  highlightType,
  sourceFields,
  highlightFields,
} from "@withmarfa/readwise";

const highlight = {
  id: 42,
  text: "  passage 漢字\n",
  note: null,
  location: 23,
  location_type: "time_offset",
  is_deleted: false,
  tags: [{ name: " Reading " }, "Reading", "日本語"],
  highlighted_at: "2026-10-14T12:30:00Z",
  external_id: "reader-highlight",
};
const source = {
  user_book_id: 42,
  title: " ",
  readable_title: "Readable title",
  category: "podcasts",
  source: "reader",
  external_id: "reader-document",
  document_note: "annotation",
  summary: "summary",
  source_url: "https://example.com/source",
  highlights: [highlight],
};
const page = (results: unknown[] = [source]) => ({
  count: 1,
  nextPageCursor: null,
  results,
});

describe("Readwise mapping", () => {
  it("separates accounts and independent ID sequences", () => {
    expect(
      new Set([
        identity("one", "source", 42),
        identity("one", "highlight", 42),
        identity("two", "source", 42),
      ]).size,
    ).toBe(3);
    expect(identity("one", "source", 42)).toBe("one:source:42");
    expect(() => identity(" ", "source", 42)).toThrow();
    expect(() => identity("one:source", "source", 42)).toThrow();
    expect(() =>
      identity("one", "source", Number.MAX_SAFE_INTEGER + 1),
    ).toThrow();
  });
  it("inherits core types and declares every mapped property", () => {
    expect(sourceType.parent).toBe("core.media");
    expect(highlightType.parent).toBe("core.highlight");
    const parsed = first(parsePage(page()).results);
    expect(
      Object.keys(mapSource("one", parsed).properties).every((key) =>
        sourceFields.includes(key),
      ),
    ).toBe(true);
    expect(
      Object.keys(
        mapHighlight("one", parsed.user_book_id, first(parsed.highlights))
          .properties,
      ).every((key) => highlightFields.includes(key)),
    ).toBe(true);
  });
  it("maps source notes, summary and Reader identifiers without inventing a change time", () => {
    const entry = mapSource("one", first(parsePage(page()).results));
    expect(entry.properties).toMatchObject({
      title: "Readable title",
      notes: "annotation",
      description: "summary",
      external_id: "reader-document",
      url: "https://example.com/source",
      readwise_source: "reader",
    });
    expect(entry.changed_at).toBeUndefined();
    expect(
      mapSource(
        "one",
        first(parsePage(page([{ user_book_id: 7, highlights: [] }])).results),
      ).properties["title"],
    ).toBe("Readwise source 7");
  });
  it("keeps passages, annotations, locations, tags and the source relationship", () => {
    const parsed = first(parsePage(page()).results);
    const entry = mapHighlight("one", 42, first(parsed.highlights));
    expect(entry.properties).toMatchObject({
      text: highlight.text,
      tags: ["Reading", "日本語"],
      locator_type: "time",
      start_location: "23",
      external_id: "reader-highlight",
      readwise_source_id: "42",
    });
    expect(entry.properties["note"]).toBeUndefined();
    expect(entry.occurred_at).toBe(highlight.highlighted_at);
    expect(entry.connections).toEqual({
      references: [{ type: "readwise.source", id: "one:source:42" }],
    });
    const long = "字\n".repeat(10000);
    expect(
      mapHighlight("one", 42, {
        ...first(parsed.highlights),
        text: long,
        note: long,
      }).properties,
    ).toMatchObject({ text: long, note: long });
  });
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "retains unknown locator %s without mapping inherited properties",
    (location_type) => {
      const parsed = first(
        parsePage(
          page([{ ...source, highlights: [{ ...highlight, location_type }] }]),
        ).results,
      );
      const entry = mapHighlight("one", 42, first(parsed.highlights));
      expect(entry.properties["location_type"]).toBe(location_type);
      expect(entry.properties["locator_type"]).toBeUndefined();
    },
  );
  it("retains vendor values without claiming unsupported core enums or invalid URLs/dates", () => {
    const parsed = first(
      parsePage(
        page([
          {
            ...source,
            source_url: "bad URL",
            highlights: [
              {
                ...highlight,
                color: "red",
                location_type: "kindle",
                highlighted_at: "not a date",
              },
            ],
          },
        ]),
      ).results,
    );
    const entry = mapHighlight("one", 42, first(parsed.highlights));
    expect(entry.properties).toMatchObject({
      readwise_color: "red",
      location_type: "kindle",
      location: 23,
      highlighted_at: "not a date",
    });
    expect(entry.properties["color"]).toBeUndefined();
    expect(entry.properties["locator_type"]).toBeUndefined();
    expect(entry.occurred_at).toBeUndefined();
    expect(mapSource("one", parsed).properties["url"]).toBeUndefined();
    expect(mapSource("one", parsed).properties["source_url"]).toBe("bad URL");
  });
});

describe("Readwise export validation", () => {
  it("accepts empty accounts and a count of highlights rather than sources", () => {
    expect(
      parsePage({ count: 509, nextPageCursor: null, results: [source] }).count,
    ).toBe(509);
    expect(
      parsePage({ count: 0, nextPageCursor: null, results: [] }).results,
    ).toEqual([]);
  });
  it("normalizes the live API's safe numeric page cursor without losing precision", () => {
    expect(
      parsePage({ count: 509, nextPageCursor: 61520441, results: [source] })
        .nextPageCursor,
    ).toBe("61520441");
    expect(() =>
      parsePage({
        count: 1,
        nextPageCursor: Number.MAX_SAFE_INTEGER + 1,
        results: [source],
      }),
    ).toThrow("nextPageCursor");
  });
  it.each([
    {},
    { results: [] },
    { count: 0, results: [], nextPageCursor: 1.5 },
    page([null]),
    page([{ ...source, user_book_id: 1.5 }]),
    page([{ ...source, highlights: [{ id: 4 }] }]),
    page([{ ...source, highlights: [{ ...highlight, book_id: 99 }] }]),
    page([{ ...source, highlights: [{ ...highlight, is_deleted: "false" }] }]),
    page([{ ...source, highlights: [{ ...highlight, tags: [null] }] }]),
  ])("rejects malformed export data %#", (value) => {
    expect(() => parsePage(value)).toThrow(/Readwise/);
  });
  it("accepts explicit tombstones without content but never maps them to empty passages", () => {
    const parsed = parsePage(
      page([
        {
          user_book_id: 42,
          is_deleted: true,
          highlights: [{ id: 3, is_deleted: true }],
        },
      ]),
    );
    expect(first(parsed.results).is_deleted).toBe(true);
    expect(() =>
      mapHighlight("one", 42, first(first(parsed.results).highlights)),
    ).toThrow();
    expect(() => mapSource("one", first(parsed.results))).toThrow();
  });
});

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected a fixture row");
  return value;
}
