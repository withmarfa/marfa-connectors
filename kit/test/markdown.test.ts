import { describe, expect, it } from "vitest";
import {
  htmlToMarkdown,
  isHtml,
  markdownToHtml,
  maxHtmlDepth,
  maxHtmlElements,
  maxHtmlLength,
  NotConvertible,
} from "../src/markdown.js";

function within<T>(milliseconds: number, run: () => T): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    expect(performance.now() - started).toBeLessThan(milliseconds);
  }
}

describe("htmlToMarkdown", () => {
  it("passes plain text through unchanged, without escaping it", () => {
    for (const text of [
      "Plain text with * stars, _under_ and # hash.",
      "a < b and c > d",
      "if a<b and c>d",
      "x<i>y and 2<3>1",
      "Use the <b> tag for bold",
      "</b> stray close and <notatag> and <a",
      "See <https://example.org/x> and 1 <2> 3",
      "Tom &amp; Jerry",
      "  spaced\n\nlines  ",
    ]) {
      expect(isHtml(text)).toBe(false);
      expect(htmlToMarkdown(text)).toBe(text);
    }
  });

  it("converts the structure a post carries", () => {
    const out = htmlToMarkdown(
      '<h2>Title</h2><p>Some <strong>bold</strong>, <em>em</em> and <a href="https://example.org/a?b=(1)">a link</a>.</p>' +
        "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol><li>first</li><li>second</li></ol>" +
        "<blockquote><p>quoted</p></blockquote><pre><code>let a = 1;\nlet b = 2;</code></pre><p>Use <code>x</code>.</p>" +
        "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>" +
        '<p><img src="https://example.org/p.png" alt="A [pic]"></p>',
    );
    expect(out).toBe(
      [
        "## Title",
        "",
        "Some **bold**, *em* and [a link](https://example.org/a?b=%281%29).",
        "",
        "- one",
        "- two\n  - nested",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "```\nlet a = 1;\nlet b = 2;\n```",
        "",
        "Use `x`.",
        "",
        "| a   | b   |",
        "| --- | --- |",
        "| 1   | 2   |",
        "",
        "![A \\[pic\\]](https://example.org/p.png)",
      ].join("\n"),
    );
  });

  it("drops what would run or does not show", () => {
    const out = htmlToMarkdown(
      '<p>Keep</p><script>alert(1)</script><style>p{color:red}</style><iframe src="https://x.test/e"></iframe>' +
        '<noscript><img src="https://x.test/n.png"></noscript><button>Go</button><video src="a.mp4">fallback</video>' +
        '<svg><title>t</title><text>s</text></svg><a href="javascript:alert(1)">click</a>',
    );
    expect(out).toBe("Keep\n\nclick");
  });

  it("drops one-pixel and known tracking pictures, and keeps others", () => {
    const out = htmlToMarkdown(
      "<p>Text</p>" +
        '<img src="https://x.test/a.gif" width="1" height="1">' +
        '<img src="https://x.test/b.gif" height="1px">' +
        '<img src="https://feeds.feedburner.com/~r/blog/~4/abc">' +
        '<img src="https://pixel.wp.com/b.gif?v=wpcom">' +
        '<img src="https://medium.com/_/stat?event=post.clientViewed">' +
        '<img src="https://x.test/real.jpg" width="640" height="480" alt="Real">',
    );
    expect(out).toBe("Text\n\n![Real](https://x.test/real.jpg)");
  });

  it("leaves out a link or picture that does not resolve, and keeps its text", () => {
    const out = htmlToMarkdown(
      '<p><a href="/rel">relative</a> <a href="mailto:a@example.org">mail</a> <img src="data:image/png;base64,AAAA" alt="d"></p>',
    );
    expect(out).toBe("relative [mail](mailto:a@example.org)");
  });

  it("asks the caller to resolve a reference", () => {
    const out = htmlToMarkdown(
      '<p><a href="/rel">relative</a> <img src="img/x.png" alt="x"></p>',
      { resolve: (ref) => new URL(ref, "https://example.org/blog/").href },
    );
    expect(out).toBe(
      "[relative](https://example.org/rel) ![x](https://example.org/blog/img/x.png)",
    );
  });

  it("keeps a table with no header row readable", () => {
    const out = htmlToMarkdown(
      "<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>",
    );
    expect(out).not.toMatch(/<\/?(table|tr|td)/);
    expect(out).toContain("1");
    expect(out).toContain("4");
  });

  it("refuses HTML nested past the limit, quickly", () => {
    const deep = "<div>".repeat(maxHtmlDepth + 1) + "x";
    const started = Date.now();
    expect(() => htmlToMarkdown(deep)).toThrow(NotConvertible);
    expect(() =>
      htmlToMarkdown("<div>".repeat(200_000) + "x" + "</div>".repeat(200_000)),
    ).toThrow(NotConvertible);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(htmlToMarkdown("<div>".repeat(maxHtmlDepth) + "x")).toBe("x");
  });

  it("keeps the blank and spaced lines of a code block, and tidies the rest", () => {
    expect(
      htmlToMarkdown(
        '<p>A</p><img src="https://x.test/a.gif" width="1">  <img src="https://x.test/b.gif" width="1"><pre><code>one\n\n\n  two   </code></pre>',
      ),
    ).toBe("A\n\n```\none\n\n\n  two   \n```");
  });

  it("scans a run of unclosed angle brackets in linear time", () => {
    const started = Date.now();
    expect(isHtml("<a ".repeat(300_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads valid HTML whose elements close themselves: paragraphs, items, cells and terms", () => {
    expect(htmlToMarkdown("<p>para ".repeat(250))).toBe(
      Array.from({ length: 250 }, () => "para").join("\n\n"),
    );
    expect(htmlToMarkdown("<ul>" + "<li>item ".repeat(500) + "</ul>")).toBe(
      Array.from({ length: 500 }, () => "- item").join("\n"),
    );
    expect(
      htmlToMarkdown("<table>" + "<tr><td>a<td>b".repeat(300) + "</table>"),
    ).toContain("| a   | b   |");
    expect(isHtml("<p>one")).toBe(true);
    expect(isHtml("<br>")).toBe(true);
    expect(isHtml("one <b>two</b>")).toBe(true);
  });

  it("counts depth as a browser would: a close tag that closes nothing does not lower it", () => {
    within(500, () => {
      expect(() => htmlToMarkdown("<div></b>".repeat(1200))).toThrow(
        NotConvertible,
      );
      expect(() => htmlToMarkdown("<div></span></p>".repeat(1200))).toThrow(
        NotConvertible,
      );
    });
  });

  describe("limits", () => {
    it("refuses HTML over the length limit before converting it, and passes long plain text through", () => {
      const article = "<p>Some <b>bold</b> words and a long run of text.</p>\n";
      const big = article.repeat(Math.ceil(3_600_000 / article.length));
      within(1000, () => {
        expect(() => htmlToMarkdown(big)).toThrow(NotConvertible);
      });
      const plain = "plain words ".repeat(Math.ceil(3_600_000 / 12));
      within(1000, () => {
        expect(htmlToMarkdown(plain)).toBe(plain);
      });
      expect(maxHtmlLength).toBeLessThan(big.length);
      const fits = article.repeat(Math.floor(maxHtmlLength / article.length));
      expect(htmlToMarkdown(fits).length).toBeGreaterThan(1000);
    });

    it("refuses HTML with more elements than the limit, quickly", () => {
      within(1000, () => {
        expect(() =>
          htmlToMarkdown("<span>a</span>".repeat(maxHtmlElements + 1)),
        ).toThrow(NotConvertible);
        expect(() =>
          htmlToMarkdown(
            "<table>" +
              "<tr><td>a</td><td>b</td></tr>".repeat(12_000) +
              "</table>",
          ),
        ).toThrow(NotConvertible);
      });
      expect(
        htmlToMarkdown("<span>a</span>".repeat(maxHtmlElements - 10)).length,
      ).toBe(maxHtmlElements - 10);
    });

    it("converts the largest inputs it takes in time that grows with their size", () => {
      const rows = Math.floor((maxHtmlElements - 1) / 3);
      const table = `<table>${"<tr><td>cell</td><td>two</td></tr>".repeat(rows)}</table>`;
      const out = within(1500, () => htmlToMarkdown(table));
      expect(out.split("\n")).toHaveLength(rows + 2);
      within(1500, () => {
        htmlToMarkdown(
          "<ol>" + "<li>item</li>".repeat(maxHtmlElements - 2) + "</ol>",
        );
        htmlToMarkdown("<p>x</p>\n\n\n\n".repeat(10_000));
        htmlToMarkdown(
          `${"<p>a</p><hr>".repeat(8000)}<pre>${"x\n".repeat(50_000)}</pre>`,
        );
      });
    });
  });

  describe("tables", () => {
    it("writes a header row, alignment and escaped bars", () => {
      expect(
        htmlToMarkdown(
          '<table><thead><tr><th align="left">a</th><th align="right">b</th><th align="center">c</th></tr></thead>' +
            "<tbody><tr><td>1|x</td><td>2</td><td>3</td></tr></tbody></table>",
        ),
      ).toBe(
        [
          "| a   | b   | c   |",
          "| :--- | ---: | :---: |",
          "| 1\\|x | 2   | 3   |",
        ].join("\n"),
      );
    });

    it("pads short rows and adds an empty header to a table with none", () => {
      const out = htmlToMarkdown(
        "<table><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td></tr></table>",
      );
      expect(out.split("\n")).toEqual([
        "|     |     |     |",
        "| --- | --- | --- |",
        "| 1   | 2   | 3   |",
        "| 4   |     |     |",
      ]);
    });

    it("lays out a table of blocks, a single cell or a nested table as text, never as HTML", () => {
      const layout = htmlToMarkdown(
        "<table><tr><td><table><tr><td>in</td><td>two</td></tr></table></td><td><ul><li>a</li></ul><p>p</p></td></tr></table>" +
          '<table><tr><td onclick="x()">solo</td></tr></table><table><tr><td><h2>H</h2></td><td>y</td></tr></table>',
      );
      expect(layout).not.toMatch(/<\/?(table|tr|td|div|ul|li)/);
      for (const word of ["in", "two", "a", "p", "solo", "H", "y"]) {
        expect(layout).toContain(word);
      }
    });

    it("keeps a document's own private-use characters from reaching the table layout", () => {
      expect(
        htmlToMarkdown(
          "<table><tr><td>\uE000a\uE001</td><td>b</td></tr></table>",
        ),
      ).toBe("|     |     |\n| --- | --- |\n| a   | b   |");
    });
  });
});

describe("markdownToHtml", () => {
  const roundTrip = (markdown: string): string =>
    htmlToMarkdown(markdownToHtml(markdown));

  it("writes the plain-text subset Google Calendar shows", () => {
    expect(
      markdownToHtml(
        "one **bold** and *em* and [a link](https://example.org/a)",
      ),
    ).toBe(
      'one <b>bold</b> and <i>em</i> and <a href="https://example.org/a">a link</a>',
    );
    expect(markdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToHtml("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(markdownToHtml("first\n\nsecond\nthird")).toBe(
      "first<br><br>second<br>third",
    );
    expect(markdownToHtml("## Agenda\n\ntext")).toBe(
      "<b>Agenda</b><br><br>text",
    );
  });

  it("sends text with no formatting as it is, entities and all", () => {
    expect(markdownToHtml("Tom & Jerry < 3")).toBe("Tom & Jerry < 3");
    expect(markdownToHtml("5 \\* 3")).toBe("5 * 3");
  });

  it("escapes HTML a person typed, so it stays text", () => {
    expect(markdownToHtml("Use the <br> tag\n**bold**")).toBe(
      "Use the &lt;br&gt; tag<br><b>bold</b>",
    );
    expect(markdownToHtml("<script>x()</script> **a**")).not.toContain(
      "<script",
    );
    expect(markdownToHtml("[x](javascript:alert(1)) **a**")).not.toContain(
      "javascript:",
    );
    expect(
      markdownToHtml('**a** ![p](https://example.org/p.png "t")'),
    ).not.toContain("<img");
  });

  it("round trips an ordinary agenda to a fixed point", () => {
    const agenda = [
      "## Agenda",
      "",
      "1. Welcome and **apologies**",
      "2. Review of the [budget](https://example.org/budget?a=1&b=2)",
      "   - revenue",
      "   - costs",
      "3. Any other business",
      "",
      "Dial in: https://example.org/call",
      "Notes by *Alex* & Sam, 5 < 6.",
      "",
      "Use the <br> tag",
      "**bold**",
    ].join("\n");
    const once = roundTrip(agenda);
    expect(roundTrip(once)).toBe(once);
    expect(once).toContain("Use the <br> tag");
    expect(once).toContain("**bold**");
    expect(once).toContain("[budget](https://example.org/budget?a=1&b=2)");
    expect(once).toContain("Notes by *Alex* & Sam, 5 < 6.");
    expect(once).not.toContain("&amp;");
  });

  it("reads back what it wrote for the HTML Google's own editor leaves, so a description never changes by being sent", () => {
    const once = htmlToMarkdown(
      'Agenda<br><br><b>Items</b><br><ul><li>one</li><li>two <a href="https://example.org/x">link</a></li></ul>Thanks &amp; bye',
    );
    expect(once).toBe(
      "Agenda\n\n**Items**\n\n- one\n- two [link](https://example.org/x)\n\nThanks & bye",
    );
    for (const google of [
      "Agenda<br><b>Hiring</b><ul><li>roles</li></ul>",
      "Line one<br>Line two<br><br><i>Para</i> two",
      '<b>Join</b>: <a href="https://meet.example.org/abc">https://meet.example.org/abc</a><br>Dial-in: +44 20 7946 0000',
      "<ol><li>Welcome</li><li>Budget<ul><li>revenue</li><li>costs</li></ul></li></ol>AOB",
      "<p>First paragraph</p><p>Second <b>bold</b> one</p>",
      "Plain agenda with no markup at all",
      "Tom &amp;amp; Jerry<br>5 &lt; 6",
    ]) {
      const read = htmlToMarkdown(google);
      expect([google, roundTrip(read)]).toEqual([google, read]);
    }
  });

  it("round trips text a person typed with markup characters", () => {
    for (const text of [
      "Costs 5 * 3 = 15, see _notes_ # 1 and a_b.",
      "1. one\n2. two",
      "a\\*b\\*c and `code` and a | b",
      "> quoted line\n\nafter",
      "<b>not bold</b> but **bold**",
      "- [x] done\n- [ ] todo",
      "```\ncode <b>\n```\n\ntext",
      "1. a\n\n   para\n2. b",
      "<br>",
    ]) {
      const once = roundTrip(text);
      expect(roundTrip(once)).toBe(once);
    }
  });

  it("refuses Markdown over the length limit", () => {
    expect(() => markdownToHtml("a".repeat(maxHtmlLength + 1))).toThrow(
      NotConvertible,
    );
  });
});
