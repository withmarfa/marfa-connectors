import { describe, expect, it } from "vitest";
import {
  fitKinds,
  highlightDisplay,
  highlightKinds,
  highlightType,
  isDate,
  isDatetime,
  mapHighlight,
  mapReaderHighlight,
  mapReaderSource,
  mapSource,
  readwisePassageLimit,
  shortened,
  sourceKinds,
  sourceType,
  urlValue,
} from "../src/index.js";

const picture =
  "![](https://readwise-assets.s3.amazonaws.com/media/picture.png)";
function reader(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: "hi",
    category: "highlight",
    parent_id: "doc",
    content,
    notes: "",
    tags: null,
    ...extra,
  };
}

describe("highlight title and body", () => {
  it("names a highlight by the first paragraph of its passage as plain text", () => {
    expect(
      highlightDisplay("# 9:06 PM\n\nJesse asks", undefined, "Doc"),
    ).toEqual({
      title: "9:06 PM",
      body: "# 9:06 PM\n\nJesse asks",
    });
    expect(
      highlightDisplay(
        "**Bold** and [a link](https://example.com) &amp; `code`\nsecond line",
        undefined,
        undefined,
      ).title,
    ).toBe("Bold and a link & code second line");
    expect(
      highlightDisplay("- first item\n- second", undefined, undefined).title,
    ).toBe("first item second");
  });
  it("joins a paragraph Reader broke around a link or a soft wrap", () => {
    expect(
      highlightDisplay(
        "It may be a\nfeature request\n that never ships.\n \t\nNext paragraph",
        undefined,
        undefined,
      ).title,
    ).toBe("It may be a feature request that never ships.");
    expect(
      highlightDisplay("First\r\n\r\nSecond", undefined, undefined).title,
    ).toBe("First");
    expect(
      highlightDisplay("Line one<br>line two", undefined, undefined).title,
    ).toBe("Line one line two");
    expect(
      highlightDisplay(
        "We recently introduced\nMarfa, a store\nfor one person.",
        undefined,
        undefined,
      ).title,
    ).toBe("We recently introduced Marfa, a store for one person.");
  });
  it("takes the title from the export passage, and Reader's when the export has no words", () => {
    expect(
      highlightDisplay("Plain words", "*Export* words", undefined).title,
    ).toBe("Export words");
    expect(
      highlightDisplay("", `${picture}\n\n*Export*\nwords`, undefined).title,
    ).toBe("Export words");
    expect(highlightDisplay("Plain words", picture, undefined).title).toBe(
      "Plain words",
    );
    expect(highlightDisplay("Plain words", "  ", undefined).title).toBe(
      "Plain words",
    );
  });
  // Passages from a real Reader library.
  it("joins a passage Reader broke around its links", () => {
    expect(
      highlightDisplay(
        "We recently introduced\n   \n    claimable sandboxes\n   \n   , which let you start using Stripe directly",
        "We recently introduced [claimable sandboxes](https://docs.stripe.com/sandboxes/claimable-sandboxes) , which let you start using Stripe directly from your AI coding tools",
        undefined,
      ).title,
    ).toBe(
      "We recently introduced claimable sandboxes, which let you start using Stripe…",
    );
  });
  it("keeps a lead line the export sets apart as its own paragraph", () => {
    expect(
      highlightDisplay(
        "Feature Specification\nThe ability for a PM to gather requirements",
        "Feature Specification\n\n> The ability for a PM to gather requirements",
        undefined,
      ).title,
    ).toBe("Feature Specification");
  });
  it("separates blocks Reader glued together with no space", () => {
    expect(
      highlightDisplay(
        "Principles for agent-scale source controlWith agentic coding, many common assumptions",
        "Principles for agent-scale source control\n\nWith agentic coding, many common assumptions",
        undefined,
      ).title,
    ).toBe("Principles for agent-scale source control");
  });
  it("ends the title at a heading in either passage", () => {
    expect(
      highlightDisplay(
        "# 9:06:16 PM - May 27, 2025\n\nJesse is asking me how I feel",
        "# 9:06:16 PM - May 27, 2025 Jesse is asking me how I feel",
        undefined,
      ).title,
    ).toBe("9:06:16 PM - May 27, 2025");
    expect(
      highlightDisplay("Lead in\n## Section\nBody text", undefined, undefined)
        .title,
    ).toBe("Lead in");
    expect(
      highlightDisplay("## Section\nBody text", undefined, undefined).title,
    ).toBe("Section");
  });
  it("leaves list and quotation markers out of the title", () => {
    expect(
      highlightDisplay(
        "When somebody decides to build an AI data center",
        "•   When somebody decides to build an AI data center",
        undefined,
      ).title,
    ).toBe("When somebody decides to build an AI data center");
    for (const marked of [
      "\\- Item",
      "\\* Item",
      "\\+ Item",
      "1\\. Item",
      "\\> Item",
    ])
      expect(highlightDisplay("", marked, undefined).title, marked).toBe(
        "Item",
      );
    expect(highlightDisplay("Plain words", "•", undefined).title).toBe(
      "Plain words",
    );
    expect(highlightDisplay("•", undefined, "Doc").title).toBe(
      "Highlight from Doc",
    );
  });
  it("closes up the space before punctuation", () => {
    expect(
      highlightDisplay(
        "Recent Works by Wang Yidong\n   \n   , Schoeni Art Gallery",
        "*Recent Works by Wang Yidong* , Schoeni Art Gallery ( Hong Kong ) ; 1993 !",
        undefined,
      ).title,
    ).toBe(
      "Recent Works by Wang Yidong, Schoeni Art Gallery ( Hong Kong); 1993!",
    );
    expect(
      highlightDisplay(
        "If backlinks were steaks, .edu and .gov domains would be",
        undefined,
        undefined,
      ).title,
    ).toBe("If backlinks were steaks, .edu and .gov domains would be");
  });
  it("leaves a heading's permalink out of the title", () => {
    expect(
      highlightDisplay(
        "The best part is it doesn’t use more AI #\nMost of the proposed solutions",
        "The best part is it doesn’t use more AI [#](https://simonwillison.net/2025/Apr/11/camel/#the-best-part)\n\nMost of the proposed solutions",
        undefined,
      ).title,
    ).toBe("The best part is it doesn’t use more AI");
    expect(
      highlightDisplay(
        "[#hashtag](https://example.com) words",
        undefined,
        undefined,
      ).title,
    ).toBe("#hashtag words");
  });
  it("cuts a long title at a word boundary to 80 characters with an ellipsis", () => {
    const line =
      "Compared with bleeding-edge models released just months ago, it feels incremental. And more.";
    const title = shortened(line);
    expect(title).toBe(
      "Compared with bleeding-edge models released just months ago, it feels…",
    );
    expect(title.length).toBeLessThanOrEqual(80);
    expect(shortened("a, b; ".repeat(20))).not.toMatch(/[,;] ?…$/);
    expect(shortened("x".repeat(200))).toHaveLength(80);
    expect(shortened("short title")).toBe("short title");
    const emoji = shortened("👩‍👩‍👧 ".repeat(60));
    expect(emoji.endsWith("👩‍👩‍👧…")).toBe(true);
  });
  it("names a picture-only passage after its document", () => {
    const mapped = mapReaderHighlight("one", reader(""), {
      properties: { readwise_text: picture, reader_managed: true },
      documentTitle: "  A  long\nread ",
    });
    expect(mapped.entry.properties).toMatchObject({
      title: "Picture from A long read",
      body: picture,
      text: "",
    });
    expect(
      mapReaderHighlight("one", reader(""), {
        properties: { readwise_text: picture, reader_managed: true },
      }).entry.properties["title"],
    ).toBe("Picture");
    expect(
      mapReaderHighlight("one", reader(""), {
        properties: { readwise_text: `${picture}\n\n${"long ".repeat(40)}` },
        documentTitle: "Doc",
      }).entry.properties["title"],
    ).toBe(
      "long long long long long long long long long long long long long long long…",
    );
    expect(highlightDisplay("", undefined, undefined).title).toBe("Highlight");
  });
  it("keeps a picture title a fuller caller set while the passage is unchanged", () => {
    const first = mapReaderHighlight("one", reader(""), {
      properties: { readwise_text: picture, reader_managed: true },
      documentTitle: "Doc",
    }).entry.properties;
    const kept = mapReaderHighlight("one", reader(""), { properties: first });
    expect(kept.entry.properties["title"]).toBe("Picture from Doc");
    const changed = mapReaderHighlight("one", reader(""), {
      properties: { ...first, readwise_text: `${picture} ` },
    });
    expect(changed.entry.properties["title"]).toBe("Picture");
  });
  it("shows the export Markdown whole, and Reader's passage when Readwise cut the export", () => {
    const markdown = 'Joan Didion: *"I write"*';
    expect(
      mapReaderHighlight("one", reader('Joan Didion: "I write"'), {
        properties: { readwise_text: markdown, reader_managed: true },
      }).entry.properties,
    ).toMatchObject({ title: 'Joan Didion: "I write"', body: markdown });
    const whole = `${"word ".repeat(1_300)}end`;
    const cut = whole.slice(0, readwisePassageLimit);
    expect(
      mapReaderHighlight("one", reader(whole), {
        properties: { readwise_text: cut, reader_managed: true },
      }).entry.properties["body"],
    ).toBe(whole);
  });
  it("writes the same title from both connectors' mappings", () => {
    const text = "**Strategy** is a coherent response\nto a challenge";
    const exported = mapHighlight(
      "one",
      7,
      { id: 42, text, note: "n" },
      "Book",
    );
    const read = mapReaderHighlight(
      "one",
      reader("Strategy is a coherent response\nto a challenge"),
      {
        properties: { readwise_text: text, reader_managed: true },
        documentTitle: "Book",
      },
    );
    expect(exported.properties["title"]).toBe(
      "Strategy is a coherent response to a challenge",
    );
    expect(read.entry.properties["title"]).toBe(exported.properties["title"]);
    expect(read.entry.properties["body"]).toBe(exported.properties["body"]);
    expect(exported.properties["note"]).toBe("n");
    const pictured = mapHighlight("one", 7, { id: 43, text: picture }, "Book");
    expect(pictured.properties).toMatchObject({
      title: "Picture from Book",
      body: picture,
      text: picture,
    });
  });
  it("keeps the whole passage beside a placeholder body when it exceeds a property", () => {
    const passage = `Opening line\n\n${"x".repeat(100_001)}`;
    const mapped = mapReaderHighlight("one", reader(passage));
    expect(mapped.entry.properties).toMatchObject({
      title: "Opening line",
      text: "Complete text is preserved in the attached text file.",
      body: "Complete passage is preserved in the attached text file.",
    });
    expect(mapped.textFiles.map(({ field, text }) => [field, text])).toEqual([
      ["text", passage],
    ]);
  });
  it("declares title and body as the highlight's display fields", () => {
    expect(highlightType.display_hints).toEqual({
      title_field: "title",
      body_field: "body",
    });
    expect(highlightType.fields["title"]?.type).toBe("string");
    expect(highlightType.fields["body"]?.type).toBe("string");
  });
});

describe("field kinds", () => {
  it("declares every date, time and address field with its kind", () => {
    const formats = (fields: typeof sourceType.fields) =>
      Object.fromEntries(
        Object.entries(fields)
          .filter(([, field]) => field.format !== undefined)
          .map(([name, field]) => [name, field.format]),
      );
    expect(formats(sourceType.fields)).toMatchObject({
      source_url: "url",
      cover_image_url: "url",
      unique_url: "url",
      readwise_url: "url",
      reader_url: "url",
      reader_source_url: "url",
      reader_image_url: "url",
      reader_created_at: "datetime",
      reader_updated_at: "datetime",
      reader_first_opened_at: "datetime",
      reader_last_opened_at: "datetime",
      reader_saved_at: "datetime",
      reader_last_moved_at: "datetime",
      reader_published_date: "date",
    });
    expect(formats(highlightType.fields)).toMatchObject({
      url: "url",
      readwise_url: "url",
      highlighted_at: "datetime",
      readwise_created_at: "datetime",
      readwise_updated_at: "datetime",
      reader_published_date: "date",
    });
    for (const fields of [sourceType.fields, highlightType.fields])
      for (const [name, field] of Object.entries(fields))
        if (/_(at|url)$/.test(name)) expect(field.format, name).toBeDefined();
  });
  it("judges values as the server does", () => {
    expect(isDatetime("2025-08-18T14:18:02.485953+00:00")).toBe(true);
    expect(isDatetime("2025-08-18")).toBe(true);
    expect(isDatetime("2025-08-18T14:18Z")).toBe(true);
    expect(isDatetime("2025-08-18T14:18:02")).toBe(false);
    expect(isDatetime("2025-08-18t14:18:02z")).toBe(false);
    expect(isDatetime("2025-02-30T00:00:00Z")).toBe(false);
    expect(isDatetime("2025-08-18T24:00:00Z")).toBe(false);
    expect(isDate("2024-02-29")).toBe(true);
    expect(isDate("2025-02-29")).toBe(false);
    expect(isDate("2025-08-18T00:00:00Z")).toBe(false);
    expect(urlValue(" https://exa\tmple.com/a\n ")).toBe(
      "https://example.com/a",
    );
    expect(urlValue("private://read/01k2")).toBe("private://read/01k2");
    expect(urlValue("mailto:reader-forwarded-email/abc")).toBe(
      "mailto:reader-forwarded-email/abc",
    );
    expect(urlValue("")).toBeUndefined();
    expect(urlValue("not a url")).toBeUndefined();
  });
  it("leaves a blank value out and keeps a refused one under original_values", () => {
    const values: Record<string, unknown> = {
      reader_image_url: "",
      reader_url: " https://read.readwise.io/read/x ",
      reader_published_date: "2025-13-01",
      reader_saved_at: "2025-08-18T14:18:02.114000+00:00",
      original_values: { reader_url: "stale", readwise_url: "kept" },
    };
    fitKinds(values, sourceKinds);
    expect(values).toEqual({
      reader_url: "https://read.readwise.io/read/x",
      reader_saved_at: "2025-08-18T14:18:02.114000+00:00",
      original_values: {
        reader_published_date: "2025-13-01",
        readwise_url: "kept",
      },
    });
    const clean: Record<string, unknown> = { highlighted_at: "2025-08-18" };
    fitKinds(clean, highlightKinds);
    expect(clean).toEqual({ highlighted_at: "2025-08-18" });
  });
  it("writes a Reader row whose values a kind refuses", () => {
    const source = mapReaderSource("one", {
      id: "doc",
      category: "article",
      title: "Doc",
      image_url: "",
      published_date: "2025-08-18",
      saved_at: "yesterday",
      url: "https://read.readwise.io/read/doc",
    });
    expect(source.entry.properties).toMatchObject({
      reader_published_date: "2025-08-18",
      reader_url: "https://read.readwise.io/read/doc",
      original_values: { reader_saved_at: "yesterday" },
    });
    expect(source.entry.properties).not.toHaveProperty("reader_image_url");
    expect(source.entry.properties).not.toHaveProperty("reader_saved_at");
    const repaired = mapReaderSource(
      "one",
      { id: "doc", category: "article", saved_at: "2025-08-18T14:18:02Z" },
      { properties: source.entry.properties },
    );
    expect(repaired.entry.properties).not.toHaveProperty("original_values");
    expect(repaired.entry.properties["reader_saved_at"]).toBe(
      "2025-08-18T14:18:02Z",
    );
  });
  it("writes an export row whose values a kind refuses", () => {
    const source = mapSource("one", {
      user_book_id: 7,
      title: "Book",
      highlights: [],
      source_url: "",
      readwise_url: "https://readwise.io/bookreview/7",
      cover_image_url: "cover.png",
    });
    expect(source.properties).toMatchObject({
      readwise_url: "https://readwise.io/bookreview/7",
      original_values: { cover_image_url: "cover.png" },
    });
    expect(source.properties).not.toHaveProperty("source_url");
    const highlight = mapHighlight("one", 7, {
      id: 42,
      text: "Passage",
      highlighted_at: "2025-08-18 14:18",
    });
    expect(highlight.properties).toMatchObject({
      original_values: { highlighted_at: "2025-08-18 14:18" },
    });
    expect(highlight.occurred_at).toBeUndefined();
  });
});
