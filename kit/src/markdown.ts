import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

/** An item's body is Markdown. A connector that receives HTML for a field
 *  a type names as its body converts it here before it writes. */

export interface MarkdownOptions {
  /** Turns a link or picture address into the one to write, or `undefined`
   *  to leave it out. The default keeps an absolute `http` or `https`
   *  address. A `mailto:` link is kept without asking. */
  resolve?: (reference: string) => string | undefined;
}

/** HTML nested deeper than this is refused: converting it takes time that
 *  grows with the square of the depth, and overflows the stack past a few
 *  thousand levels. Real pages nest a few dozen. */
export const maxHtmlDepth = 200;

export class NotConvertible extends Error {
  override name = "NotConvertible";
}

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

const voids = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);

/** The part of a parsed element the rules read; the package types its nodes
 *  from the browser's DOM, which this runtime does not have. */
interface Dom {
  nodeName: string;
  parentNode: Dom | null;
  nextSibling: unknown;
  getAttribute(name: string): string | null;
  children: ArrayLike<unknown>;
}

const tag = /(\/?)([a-z][a-z0-9]*)/iy;

interface Scan {
  /** Whether it holds an HTML element. */
  html: boolean;
  /** How deep its elements nest, at the deepest, counting each one that
   *  opens and is not closed or void. */
  depth: number;
}

// One pass, linear in the text: no pattern here backtracks over a run of
// `<` that never closes.
function scan(text: string): Scan {
  const last = text.lastIndexOf(">");
  let html = false;
  let depth = 0;
  let deepest = 0;
  for (
    let at = text.indexOf("<");
    at !== -1 && at < last;
    at = text.indexOf("<", at + 1)
  ) {
    tag.lastIndex = at + 1;
    const found = tag.exec(text);
    if (found === null) continue;
    const name = (found[2] ?? "").toLowerCase();
    const after = text[tag.lastIndex];
    if (
      !elements.has(name) ||
      !(after === ">" || after === "/" || (after ?? "x").trim() === "")
    ) {
      continue;
    }
    html = true;
    if (found[1] === "/") {
      depth = Math.max(0, depth - 1);
    } else if (!voids.has(name)) {
      const end = text.indexOf(">", tag.lastIndex);
      if (end === -1 || text[end - 1] !== "/") depth += 1;
      deepest = Math.max(deepest, depth);
    }
  }
  return { html, depth: deepest };
}

/** Whether the text holds an HTML element. Text without one is plain text,
 *  whatever else it holds, such as `<https://example.org>` or `a < b`. */
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
  // Added before the table and task list rules, which then take their items.
  service.addRule("listItem", {
    filter: "li",
    replacement(content, item: unknown) {
      const node = item as Dom;
      const parent = node.parentNode;
      let prefix = "- ";
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? "1");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${String((Number.isFinite(start) ? start : 1) + index)}. `;
      }
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      return `${prefix}${body}${node.nextSibling && !body.endsWith("\n") ? "\n" : ""}`;
    },
  });
  service.use(gfm);
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
// becomes an empty one. A fenced block is code and keeps every line.
function tidy(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) fenced = !fenced;
      return !fenced && line.trim() === "" ? "" : line;
    })
    .join("\n")
    .replace(/\n{3,}/g, (run, at: number, whole: string) =>
      whole.slice(0, at).split("```").length % 2 === 1 ? "\n\n" : run,
    );
}

/**
 * Converts HTML to Markdown for a field a type names as its body: headings,
 * emphasis, links, lists, quotes, code and tables stay; a script, style,
 * frame, form control, counting pixel or one-pixel picture goes, with
 * anything that would run. Text without an HTML element passes through
 * unchanged, so a plain-text value is never escaped. The result is trimmed.
 *
 * Throws `NotConvertible` for HTML nested deeper than `maxHtmlDepth`, or
 * that the converter cannot read; the caller leaves the value out.
 */
export function htmlToMarkdown(
  text: string,
  { resolve = absolute }: MarkdownOptions = {},
): string {
  const found = scan(text);
  if (!found.html) return text;
  if (found.depth > maxHtmlDepth) throw new NotConvertible();
  try {
    return tidy(serviceFor(resolve).turndown(text)).trim();
  } catch {
    throw new NotConvertible();
  }
}
