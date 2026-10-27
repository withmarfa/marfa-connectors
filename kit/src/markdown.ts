import { Parser } from "htmlparser2";
import { Marked, type Tokens } from "marked";
import TurndownService from "turndown";
import {
  highlightedCodeBlock,
  strikethrough,
  taskListItems,
} from "@joplin/turndown-plugin-gfm";

/** An item's body is Markdown. A connector that receives HTML for a field
 *  a type names as its body converts it here before it writes, and one that
 *  sends a body to a vendor that takes HTML converts it back. */

export interface MarkdownOptions {
  /** Turns a link or picture address into the one to write, or `undefined`
   *  to leave it out. The default keeps an absolute `http` or `https`
   *  address. A `mailto:` link is kept without asking. */
  resolve?: (reference: string) => string | undefined;
}

/** What one conversion takes. Converting builds a document tree in memory,
 *  and some of what it does grows faster than the input, so input past any
 *  of these is refused before it is converted. A real post is far inside
 *  them: the value a body is written to holds 100,000 characters, which
 *  HTML of this length converts to with room to spare. */
export const maxHtmlLength = 600_000;
/** Elements, counting those a page closes for itself. */
export const maxHtmlElements = 25_000;
/** How deep elements nest, counted as a browser builds the tree: elements
 *  that close themselves, such as a paragraph, and a close tag that closes
 *  nothing, do not count. */
export const maxHtmlDepth = 200;

/** Why a conversion was refused. */
export type Reason =
  "length" | "elements" | "depth" | "complexity" | "unreadable";

export class NotConvertible extends Error {
  override name = "NotConvertible";
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(`not convertible: ${reason}`);
    this.reason = reason;
  }
}

/** The longest Markdown `markdownToHtml` takes: what a body holds. */
export const maxMarkdownLength = 100_000;
/** What one paragraph of Markdown may cost to convert, as its length times
 *  the emphasis marks in it. The converter pairs each mark with a later one
 *  by looking ahead, so a paragraph of many marks costs about this many
 *  steps, at most 13 ns each; a real paragraph is far inside it. */
export const maxEmphasisWork = 10_000_000;

/** Elements whose tag alone makes text HTML. An unclosed inline element,
 *  such as the `<b` in `a<b and c>d`, is no evidence: only a close tag, a
 *  tag with no content or a block element is. */
const elements = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo big blockquote " +
    "body br button canvas caption center cite code col colgroup data dd del " +
    "details dfn dir div dl dt em embed fieldset figcaption figure font footer " +
    "form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins " +
    "kbd label legend li link main map mark math menu meta meter nav noscript " +
    "object ol optgroup option output p param picture pre progress q rp rt " +
    "ruby s samp script section select small source span strike strong style " +
    "sub summary sup svg table tbody td template textarea tfoot th thead time " +
    "title tr track tt u ul var video wbr xmp"
  ).split(" "),
);

/** Elements that are HTML on their own, as they are the structure of a page
 *  and not a stray word. */
const blocks = new Set(
  (
    "address article aside blockquote body caption center dd details dir div " +
    "dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head " +
    "header hgroup html li main menu nav ol p pre section summary table " +
    "tbody td tfoot th thead tr ul"
  ).split(" "),
);

/** The part of a parsed element the rules read; the package types its nodes
 *  from the browser's DOM, which this runtime does not have. */
interface Dom {
  nodeName: string;
  parentNode: Dom | null;
  nextSibling: unknown;
  previousElementSibling: Dom | null;
  nextElementSibling: Dom | null;
  firstElementChild: Dom | null;
  getAttribute(name: string): string | null;
}

interface Scan {
  /** Whether it holds an HTML element. */
  html: boolean;
  /** The reason it cannot be converted, or `undefined` where it can. */
  refused: "length" | "elements" | "depth" | undefined;
}

const chunk = 32_768;

/**
 * Reads the text with an HTML tokenizer, so that what counts as markup, and
 * how deep it nests, is decided as a browser would decide it: a paragraph
 * that is never closed ends where the next begins, a stray close tag closes
 * nothing, and a `<` that opens no element is text. The tokenizer works a
 * chunk at a time and is stopped as soon as the text is known to be HTML
 * that cannot be converted, so a hostile input costs no more than a small
 * part of its length.
 */
function scan(text: string): Scan {
  let html = false as boolean;
  let refused = undefined as Scan["refused"];
  let depth = 0;
  let count = 0;
  const parser: Parser = new Parser(
    {
      onopentag(name) {
        count += 1;
        depth += 1;
        if (blocks.has(name)) html = true;
        if (count > maxHtmlElements) refused = "elements";
        else if (depth > maxHtmlDepth) refused = "depth";
        else if (html && text.length > maxHtmlLength) refused = "length";
        if (refused !== undefined) parser.pause();
      },
      onclosetag(name, implied) {
        depth -= 1;
        if (elements.has(name) && (!implied || voids.has(name))) html = true;
      },
    },
    { decodeEntities: false },
  );
  for (let at = 0; at < text.length && refused === undefined; at += chunk) {
    parser.write(text.slice(at, at + chunk));
  }
  if (refused === undefined) {
    parser.end();
    if (html && text.length > maxHtmlLength) refused = "length";
  }
  return { html: html || refused !== undefined, refused };
}

const voids = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);

/** Whether the text holds an HTML element. Text without one is plain text,
 *  whatever else it holds, such as `<https://example.org>`, `a < b` or
 *  `a<b and c>d`. */
export function isHtml(text: string): boolean {
  return scan(text).html;
}

/** Hosts and paths that serve a counting pixel, which is no picture. */
const trackers: readonly RegExp[] = [
  /^([a-z0-9-]+\.)*feedburner\.com\/~(ff|r)\//i,
  /^([a-z0-9-]+\.)*feedsportal\.com\//i,
  /^([a-z0-9-]+\.)*feedblitz\.com\//i,
  /^([a-z0-9-]+\.)*feedpress\.(it|me)\/.*\/(i|pixel)/i,
  /^(pixel|stats)\.wp\.com\//i,
  /^stats\.wordpress\.com\//i,
  /^medium\.com\/_\/stat/i,
  /^([a-z0-9-]+\.)*google-analytics\.com\//i,
  /^([a-z0-9-]+\.)*doubleclick\.net\//i,
  /^([a-z0-9-]+\.)*scorecardresearch\.com\//i,
  /^([a-z0-9-]+\.)*quantserve\.com\//i,
  /^([a-z0-9-]+\.)*list-manage\.com\/track\//i,
];

function isTracker(address: string): boolean {
  const url = URL.parse(address);
  if (url === null) return false;
  const where = `${url.host}${url.pathname}`;
  return trackers.some((tracker) => tracker.test(where));
}

function isPixel(width: string | null, height: string | null): boolean {
  return [width, height].some((size) => {
    const pixels = /^\s*(\d+)\s*(?:px)?\s*$/i.exec(size ?? "");
    return pixels?.[1] !== undefined && Number(pixels[1]) <= 1;
  });
}

function absolute(reference: string): string | undefined {
  const url = URL.parse(reference.trim());
  return url !== null && (url.protocol === "http:" || url.protocol === "https:")
    ? url.href
    : undefined;
}

// Spaces, brackets and angle brackets would end the destination early.
function destination(address: string): string {
  return address.replace(/[\s()<>]/g, (one) =>
    one === "(" ? "%28" : one === ")" ? "%29" : encodeURIComponent(one),
  );
}

function label(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[[\]\\]/g, "\\$&");
}

// A table is laid out from marks the cell and row rules leave in the
// converted text, in one pass, so that no rule asks the parsed tree for a
// sibling by position, which costs more the longer the table is. A
// document's own use of these characters is removed before converting.
const cellStart = "\uE000";
const cellEnd = "\uE001";
const rowEnd = "\uE002";
const headingMark = "\uE003";
const captionStart = "\uE004";
const captionEnd = "\uE005";
const marks = /[\uE000-\uE005]/g;
const cells = /\uE000(.)([^\uE001]*)\uE001/gs;
const captions = /\uE004([^\uE005]*)\uE005/g;
const borders: Partial<Record<string, string>> = {
  l: ":---",
  r: "---:",
  c: ":---:",
};

function alignOf(cell: Dom): string {
  const named = (cell.getAttribute("align") ?? "").trim().toLowerCase();
  const styled = /text-align\s*:\s*(left|right|center)/i.exec(
    cell.getAttribute("style") ?? "",
  )?.[1];
  const word = named === "" ? (styled ?? "").toLowerCase() : named;
  return word === "left" || word === "right" || word === "center"
    ? word.charAt(0)
    : "-";
}

function isHeading(row: Dom): boolean {
  const section = row.parentNode;
  if (section === null || row.previousElementSibling !== null) return false;
  if (section.nodeName === "THEAD") return true;
  const first =
    section.nodeName === "TABLE" ||
    (section.nodeName === "TBODY" &&
      (section.previousElementSibling === null ||
        section.previousElementSibling.nodeName === "THEAD"));
  if (!first) return false;
  let any = false;
  for (
    let cell = row.firstElementChild;
    cell !== null;
    cell = cell.nextElementSibling
  ) {
    if (cell.nodeName !== "TH") return false;
    any = true;
  }
  return any;
}

function tables(service: TurndownService): void {
  service.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node: unknown) =>
      `${cellStart}${alignOf(node as Dom)}${content}${cellEnd}`,
  });
  service.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node: unknown) =>
      `${isHeading(node as Dom) ? headingMark : ""}${content}${rowEnd}`,
  });
  service.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  service.addRule("tableCaption", {
    filter: "caption",
    replacement: (content) => `${captionStart}${content}${captionEnd}`,
  });
  service.addRule("tableColumns", {
    filter: ["colgroup", "col"],
    replacement: () => "",
  });
  service.addRule("table", {
    filter: "table",
    replacement(content) {
      const above: string[] = [];
      const body = content.replace(captions, (_, caption: string) => {
        above.push(caption.trim());
        return "";
      });
      const rows = body
        .split(rowEnd)
        .map((row) => ({
          heading: row.includes(headingMark),
          loose: row.replace(cells, "").replace(marks, "").trim(),
          cells: [...row.matchAll(cells)].map((one) => ({
            align: one[1] ?? "-",
            text: (one[2] ?? "").trim(),
          })),
        }))
        .filter((row) => row.loose !== "" || row.cells.length > 0);
      const texts = rows.flatMap((row) => [
        row.loose,
        ...row.cells.map((one) => one.text),
      ]);
      const single = rows.length === 1 && (rows[0]?.cells.length ?? 0) <= 1;
      const stacked = texts.some((one) => one.includes("\n"));
      if (single || stacked || rows.every((row) => row.cells.length === 0)) {
        return `\n\n${[...above, ...texts].filter((one) => one !== "").join("\n\n")}\n\n`;
      }
      const width = Math.max(...rows.map((row) => row.cells.length));
      const aligns = Array.from({ length: width }, (_, at) => {
        for (const row of rows) {
          const one = row.cells[at]?.align;
          if (one !== undefined && one !== "-") return one;
        }
        return "-";
      });
      const line = (row: string[]): string =>
        `| ${row.map((one) => one.padEnd(3)).join(" | ")} |`;
      const escape = (one: string): string => one.replace(/\|+/g, "\\|");
      const first = rows[0];
      const headed = first?.heading === true;
      const fill = (row: { cells: { text: string }[] }): string[] =>
        Array.from({ length: width }, (_, at) =>
          escape(row.cells[at]?.text ?? ""),
        );
      const out = [
        line(headed ? fill(first) : Array.from({ length: width }, () => "")),
        line(aligns.map((one) => borders[one] ?? "---")),
        ...rows.slice(headed ? 1 : 0).map((row) => line(fill(row))),
      ];
      const loose = rows.map((row) => row.loose).filter((one) => one !== "");
      return `\n\n${[...above, ...loose].join("\n\n")}${above.length + loose.length > 0 ? "\n\n" : ""}${out.join("\n")}\n\n`;
    },
  });
}

function serviceFor(resolve: (reference: string) => string | undefined) {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
    linkStyle: "inlined",
  });
  // Markdown reads `&amp;` as an `&`, so text that spells an entity out keeps
  // its first character as it is.
  const escaping = service.escape.bind(service);
  service.escape = (text) =>
    escaping(text).replace(/&(?=#?[a-z0-9]+;)/gi, "\\&");
  service.remove([
    "script",
    "style",
    "iframe",
    "noscript",
    "object",
    "embed",
    "template",
    "head",
    "svg",
    "canvas",
    "audio",
    "video",
    "link",
    "meta",
    "button",
    "input",
    "select",
    "textarea",
  ]);
  // Added before the task list rule, which then takes its items.
  const positions = new WeakMap<Dom, Map<Dom, number>>();
  const position = (parent: Dom, item: Dom): number => {
    let held = positions.get(parent);
    if (held === undefined) {
      held = new Map();
      let at = 0;
      for (
        let child = parent.firstElementChild;
        child !== null;
        child = child.nextElementSibling
      ) {
        held.set(child, at);
        at += 1;
      }
      positions.set(parent, held);
    }
    return held.get(item) ?? 0;
  };
  service.addRule("listItem", {
    filter: "li",
    replacement(content, item: unknown) {
      const node = item as Dom;
      const parent = node.parentNode;
      let prefix = "- ";
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? "1");
        prefix = `${String((Number.isFinite(start) ? start : 1) + position(parent, node))}. `;
      }
      // Markdown writes a task's box as text, which the escaping would
      // otherwise turn into `\[ \]`.
      const body = content
        .replace(/^\n+/, "")
        .replace(/^\\\[([ xX])\\\] /, "[$1] ")
        .replace(/\n+$/, "\n")
        .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      return `${prefix}${body}${node.nextSibling && !body.endsWith("\n") ? "\n" : ""}`;
    },
  });
  service.use([highlightedCodeBlock, strikethrough, tables, taskListItems]);
  service.addRule("link", {
    filter: (node: unknown) =>
      (node as Dom).nodeName === "A" &&
      (node as Dom).getAttribute("href") !== null,
    replacement(content, node: unknown) {
      const href = (node as Dom).getAttribute("href") ?? "";
      const target = /^\s*mailto:/i.test(href) ? href.trim() : resolve(href);
      return target === undefined || content.trim() === ""
        ? content
        : `[${content.trim()}](${destination(target)})`;
    },
  });
  service.addRule("picture", {
    filter: "img",
    replacement(_content, node: unknown) {
      const picture = node as Dom;
      if (
        isPixel(picture.getAttribute("width"), picture.getAttribute("height"))
      )
        return "";
      const src = picture.getAttribute("src");
      const target = src === null ? undefined : resolve(src);
      if (
        target === undefined ||
        isTracker(target.replace(/^https?:\/\//i, "https://"))
      )
        return "";
      return `![${label(picture.getAttribute("alt") ?? "")}](${destination(target)})`;
    },
  });
  return service;
}

// A line of only spaces, left where a dropped element sat between blocks,
// becomes an empty one, and a run of empty lines becomes one. A fenced block
// is code and keeps every line.
function tidy(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  let blank = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced || line.startsWith("```")) {
      out.push(line);
      blank = false;
    } else if (line.trim() === "") {
      // A hard break before a blank line breaks nothing.
      const last = out.length - 1;
      if (!blank && last >= 0 && out[last] !== "") {
        out[last] = (out[last] ?? "").replace(/ {2,}$/, "");
      }
      if (!blank) out.push("");
      blank = true;
    } else {
      out.push(line);
      blank = false;
    }
  }
  return out.join("\n");
}

/**
 * Converts HTML to Markdown for a field a type names as its body: headings,
 * emphasis, links, lists, quotes, code and tables stay; a script, style,
 * frame, form control, counting pixel or one-pixel picture goes, with
 * anything that would run. A table that holds blocks, nests another or has
 * one cell is written as text. Text without an HTML element passes through
 * unchanged, so a plain-text value is never escaped. The result is trimmed.
 *
 * Throws `NotConvertible` for HTML past `maxHtmlLength`, `maxHtmlElements`
 * or `maxHtmlDepth`, before any of it is converted, or that the converter
 * cannot read; the caller leaves the value out. Its `reason` says which.
 */
export function htmlToMarkdown(
  text: string,
  { resolve = absolute }: MarkdownOptions = {},
): string {
  const found = scan(text);
  if (found.refused !== undefined) throw new NotConvertible(found.refused);
  if (!found.html) return text;
  try {
    return tidy(serviceFor(resolve).turndown(text.replace(marks, "")))
      .replace(marks, "")
      .trim();
  } catch {
    throw new NotConvertible("unreadable");
  }
}

const entities: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (one) =>
    one === "&"
      ? "&amp;"
      : one === "<"
        ? "&lt;"
        : one === ">"
          ? "&gt;"
          : one === '"'
            ? "&quot;"
            : "&#39;",
  );
}

function safe(reference: string): string | undefined {
  const url = URL.parse(reference.trim());
  return url !== null && /^(https?|mailto):$/.test(url.protocol)
    ? url.protocol === "mailto:"
      ? reference.trim()
      : url.href
    : undefined;
}

/** The HTML a vendor that takes a little of it shows: bold, italic, links,
 *  lists and line breaks. What Markdown has beyond that is written as text,
 *  and HTML typed into the Markdown stays text, never markup. */
const writer = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html: ({ text }) => escaped(text),
    space: () => "",
    paragraph({ tokens }) {
      return `${this.parser.parseInline(tokens).replace(/\s+$/, "")}<br><br>`;
    },
    heading({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b><br><br>`;
    },
    strong({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>`;
    },
    em({ tokens }) {
      return `<i>${this.parser.parseInline(tokens)}</i>`;
    },
    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`;
    },
    codespan: ({ text }) => `<code>${escaped(text)}</code>`,
    code: ({ text }) => `<pre><code>${escaped(text)}</code></pre>`,
    checkbox: ({ checked }) => (checked ? "[x] " : "[ ] "),
    br: () => "<br>",
    hr: () => "<hr>",
    blockquote({ tokens }) {
      return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
    },
    table({ header, rows }) {
      const line = (cells: Tokens.TableCell[]): string =>
        cells.map((cell) => this.parser.parseInline(cell.tokens)).join(" | ");
      return `${[header, ...rows].map(line).join("<br>")}<br><br>`;
    },
    list({ ordered, start, items }) {
      const body = items.map((item) => this.listitem(item)).join("");
      return ordered
        ? `<ol${start === "" || start === 1 ? "" : ` start="${String(start)}"`}>${body}</ol>`
        : `<ul>${body}</ul>`;
    },
    listitem(item) {
      const body = this.parser.parse(item.tokens).replace(/(<br>)+$/, "");
      return `<li>${body}</li>`;
    },
    link({ href, tokens }) {
      const target = safe(href);
      const text = this.parser.parseInline(tokens);
      return target === undefined
        ? text
        : `<a href="${escaped(target)}">${text}</a>`;
    },
    image({ href, text }) {
      const target = safe(href);
      return target === undefined
        ? escaped(text)
        : `<a href="${escaped(target)}">${escaped(text === "" ? target : text)}</a>`;
    },
  },
});

/** The most work one paragraph costs the converter: its length times its
 *  emphasis marks, not counting a list's bullet. A list item starts a
 *  paragraph of its own, even where a paragraph is above it. */
function emphasisWork(markdown: string): number {
  let most = 0;
  for (const paragraph of markdown.split(
    /\n[ \t]*\n|\n(?=[ \t]*(?:[*+-]|1[.)])[ \t]+\S)/,
  )) {
    const marks = paragraph.replace(/^[ \t]*[*_+-][ \t]/gm, "").match(/[*_]/g);
    most = Math.max(most, (marks?.length ?? 0) * paragraph.length);
  }
  return most;
}

/**
 * Converts a body's Markdown to the HTML a vendor that takes a little of it
 * shows: bold, italic, links, lists and line breaks, with a line break kept
 * as one. HTML typed into the Markdown is text, a link keeps only an
 * `http`, `https` or `mailto` address, a picture is its link and a table is
 * a line of text for each row. Text that is the same as plain text, with
 * nothing to show, is returned as it is, so that a vendor that treats HTML
 * and plain text differently gets the text it was given. Any other text
 * that shows as plain text, such as one whose escapes the plain form would
 * lose, or one that would itself read as HTML, is wrapped to say it is not.
 *
 * Throws `NotConvertible` for text past `maxMarkdownLength`, one that nests
 * deeper than the converter reads, or a paragraph past `maxEmphasisWork`.
 */
export function markdownToHtml(markdown: string): string {
  if (markdown.length > maxMarkdownLength) throw new NotConvertible("length");
  if (emphasisWork(markdown) > maxEmphasisWork) {
    throw new NotConvertible("complexity");
  }
  let html: string;
  try {
    html = (writer.parse(markdown) as string)
      .replace(/>\n+(?=<)/g, ">")
      .replace(
        /(<br>)+(?=<(?:ul|ol|blockquote|pre|hr|table)\b|<\/blockquote>)/g,
        "",
      )
      .replace(/\n+$/, "")
      .replace(/^(<br>)+|(<br>)+$/g, "");
  } catch (error) {
    throw new NotConvertible(
      error instanceof RangeError ? "depth" : "unreadable",
    );
  }
  if (isHtml(html)) return html;
  const plain = html.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (one) => entities[one] ?? one,
  );
  return plain === markdown && !/<[a-z/!]/i.test(plain)
    ? plain
    : `<span>${html}</span>`;
}
