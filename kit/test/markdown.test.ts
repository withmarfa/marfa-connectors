import { describe, expect, it } from "vitest";
import {
  htmlToMarkdown,
  isHtml,
  maxHtmlDepth,
  NotConvertible,
} from "../src/markdown.js";

describe("htmlToMarkdown", () => {
  it("passes plain text through unchanged, without escaping it", () => {
    for (const text of [
      "Plain text with * stars, _under_ and # hash.",
      "a < b and c > d",
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
});
