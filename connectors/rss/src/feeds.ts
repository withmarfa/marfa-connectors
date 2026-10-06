import { createHash } from "node:crypto";
import type { Entry } from "@withmarfa/connector";
import { parseFeed } from "feedsmith";
import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { isIP } from "node:net";
import { getFeed, hostOf } from "./fetch.js";

/** Past it a feed is skipped: its entries would be a run's worth of writes. */
export const maxFeedEntries = 5000;

/** Parsing holds an object per element, so their count, more than the
 *  bytes, sets the memory a feed takes; the largest real feeds hold about
 *  200,000. */
export const maxFeedElements = 300_000;

export class TooManyEntries extends Error {
  override name = "TooManyEntries";
}

export class TooManyElements extends Error {
  override name = "TooManyElements";
}

/**
 * A cheap refusal before the parse, which runs bounded in a worker either
 * way: counts each `<` that opens an element or a `<!` declaration, and as
 * entries those whose local name is `item` or `entry` in any case. Comments,
 * CDATA, the doctype, processing instructions, end tags and quoted attribute
 * values are passed over.
 */
function countTags(text: string): void {
  const name = /[^\s/>]*/y;
  const tagEnd = /["'>]/g;
  let elements = 0;
  let entries = 0;
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at)) {
    const skipTo = text.startsWith("<!--", at)
      ? "-->"
      : text.startsWith("<![", at)
        ? "]]>"
        : undefined;
    if (skipTo !== undefined) {
      const end = text.indexOf(skipTo, at + 3);
      if (end === -1) return;
      at = end + skipTo.length;
      continue;
    }
    const next = text[at + 1];
    if (next === "?" || next === "/" || text.startsWith("<!D", at)) {
      at += 1;
      continue;
    }
    elements += 1;
    if (elements > maxFeedElements) throw new TooManyElements();
    name.lastIndex = next === "!" ? at + 2 : at + 1;
    const found = name.exec(text)?.[0] ?? "";
    const local = found.toLowerCase().split(":").pop();
    if (local === "item" || local === "entry") {
      entries += 1;
      if (entries > maxFeedEntries) throw new TooManyEntries();
    }
    tagEnd.lastIndex = name.lastIndex;
    for (;;) {
      const mark = tagEnd.exec(text);
      if (mark === null) return;
      if (mark[0] === ">") {
        at = mark.index + 1;
        break;
      }
      const close = text.indexOf(mark[0], mark.index + 1);
      if (close === -1) return;
      tagEnd.lastIndex = close + 1;
    }
  }
}

export interface Feed {
  /** Its place in RSS_FEEDS, counted from 1, by which a condition names it
   *  where its address may not go. */
  position: number;
  url: string;
  /** What its entries are keyed by: its name in RSS_FEEDS, else its address.
   *  Owned by the configuration, never by what the feed says of itself. */
  key: string;
  /** The key of its address, which its validators belong to. */
  address: string;
}

function hashed(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

// A port names another server and stays. Only the host is lowercased: a path is
// case-sensitive.
export function canonicalFeedUrl(feedUrl: string): string {
  const url = new URL(feedUrl.trim());
  const host = url.host.replace(/^www\./, "");
  return `${host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

export function feedKey(feedUrl: string, name?: string): string {
  return name === undefined
    ? hashed(`feed-url:${canonicalFeedUrl(feedUrl)}`)
    : hashed(`feed-name:${name}`);
}

function isAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Each entry is an address, or `name=address`: a feed named keeps its
 * entries when its address moves or a token in it rotates. Two spellings of
 * one unnamed address are one feed, read once.
 */
export function feedList(value: string): Feed[] {
  const parts = value.split(/\s+/).filter((part) => part !== "");
  const read = parts.map((part, at) => {
    const named = /^https?:\/\//i.test(part)
      ? undefined
      : /^([^=]+)=(.*)$/.exec(part);
    const url = named?.[2] ?? part;
    return { position: at + 1, name: named?.[1], url };
  });
  const bad = read.filter((feed) => !isAddress(feed.url));
  if (bad.length > 0) {
    throw new Error(
      bad.length === 1
        ? "RSS_FEEDS holds an entry that is not an http or https address"
        : `RSS_FEEDS holds ${String(bad.length)} entries that are not http or https addresses`,
    );
  }
  const byKey = new Map<string, Feed>();
  const byName = new Map<string, { position: number; address: string }>();
  for (const { position, name, url } of read) {
    const address = feedKey(url);
    if (name !== undefined) {
      const other = byName.get(name);
      if (other !== undefined && other.address !== address) {
        throw new Error(
          `RSS_FEEDS gives entries ${String(other.position)} and ${String(position)} one name`,
        );
      }
      byName.set(name, { position, address });
    }
    const key = feedKey(url, name);
    if (!byKey.has(key)) byKey.set(key, { position, url, key, address });
  }
  return [...byKey.values()];
}

// Never the path or query: a private feed carries its token in either.
export function feedName(feed: Feed): string {
  return `feed ${String(feed.position)} in RSS_FEEDS (${new URL(feed.url).origin})`;
}

export interface Validators {
  etag?: string;
  last_modified?: string;
}

export type Fetched =
  | {
      status: 200;
      bytes: Uint8Array;
      contentType: string | null;
      validators: Validators;
      url: string;
    }
  | { status: number };

/** A validator is echoed back verbatim; past this a server is not using it
 *  as one, and it is not kept. */
const maxValidatorLength = 1024;

function sniffed(bytes: Uint8Array): string | undefined {
  const [a, b, c, d] = bytes;
  if (a === 0xef && b === 0xbb && c === 0xbf) return "utf-8";
  if (a === 0xfe && b === 0xff) return "utf-16be";
  if (a === 0xff && b === 0xfe) return "utf-16le";
  if (a === 0x3c && b === 0x00 && c === 0x3f && d === 0x00) return "utf-16le";
  if (a === 0x00 && b === 0x3c && c === 0x00 && d === 0x3f) return "utf-16be";
  return undefined;
}

// Precedence per XML's media types (RFC 7303): byte order mark, Content-Type
// charset, XML declaration, then UTF-8.
export function decodeFeed(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const header = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  const declared = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/.exec(
    new TextDecoder("latin1").decode(bytes.subarray(0, 1024)),
  )?.[1];
  // A declaration read from single-byte text cannot be true of UTF-16 or
  // UTF-32, whatever it says; generators write one out of habit.
  const declaration =
    declared !== undefined && /^utf-?(16|32)/i.test(declared)
      ? undefined
      : declared;
  for (const label of [sniffed(bytes), header, declaration]) {
    if (label === undefined) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Not an encoding this platform knows; the next source may name one.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Hosts the owner allows to resolve to this machine or a private network,
 * separated by whitespace, each read as a URL reads its host: lowercased,
 * an international name in its ASCII form, an IPv6 address in brackets or
 * bare.
 */
export function privateHosts(value: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (value ?? "")
    .split(/\s+/)
    .filter((part) => part !== "")) {
    const url = URL.parse(`http://${isIP(entry) === 6 ? `[${entry}]` : entry}`);
    if (
      url?.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error(
        "RSS_PRIVATE_HOSTS holds an entry that is not a host name",
      );
    }
    hosts.add(hostOf(url));
  }
  return hosts;
}

export async function fetchFeed(
  feed: Feed,
  validators: Validators | undefined,
  allowed: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<Fetched> {
  const headers: Record<string, string> = {
    Accept:
      "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  };
  if (validators?.etag !== undefined)
    headers["If-None-Match"] = validators.etag;
  if (validators?.last_modified !== undefined) {
    headers["If-Modified-Since"] = validators.last_modified;
  }
  const answer = await getFeed(feed.url, headers, allowed, signal);
  if (answer.bytes === undefined) return { status: answer.status };
  const header = (name: string): string | undefined => {
    const value = answer.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const kept = (name: string): string | undefined => {
    const value = header(name);
    return value !== undefined && value.length <= maxValidatorLength
      ? value
      : undefined;
  };
  const etag = kept("etag");
  const lastModified = kept("last-modified");
  return {
    status: 200,
    bytes: answer.bytes,
    contentType: header("content-type") ?? null,
    validators: {
      ...(etag !== undefined && { etag }),
      ...(lastModified !== undefined && { last_modified: lastModified }),
    },
    url: answer.url,
  };
}

function isoOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

interface Base {
  href: string;
  // From the fetch address, which may carry a private feed's token, not a
  // declared `xml:base`.
  fromAddress: boolean;
}

// Asked of the resolver: `https:item` is absolute alone and relative against a
// base of the same scheme.
function keepsPath(reference: string, base: string): boolean {
  const origin = new URL(base);
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  try {
    return new URL(reference, base).href !== new URL(reference, origin).href;
  } catch {
    return true;
  }
}

// The parser reads no `xml:base` on an Atom link itself.
function baseOf(parent: Base, declared: string | undefined): Base {
  const base = declared?.trim();
  if (base === undefined || base === "") return parent;
  try {
    return {
      href: new URL(base, parent.href).href,
      fromAddress: parent.fromAddress && keepsPath(base, parent.href),
    };
  } catch {
    return parent;
  }
}

// A link relative to the fetch path is not written: it would carry that path.
function linkOf(value: string | undefined, base: Base): string | undefined {
  const reference = value?.trim();
  if (reference === undefined || reference === "") return undefined;
  if (base.fromAddress && keepsPath(reference, base.href)) return undefined;
  try {
    const url = new URL(reference, base.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function languageOf(value: string | undefined): string | undefined {
  const tag = value?.trim().replace(/_/g, "-");
  return tag !== undefined && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)
    ? tag
    : undefined;
}

function textOf(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

const blockElements = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

type Markup = ReturnType<typeof parseDocument>["children"];

// Walked with a stack of its own, so nesting as deep as a feed can write it
// cannot overflow the call stack.
function readText(nodes: Markup): string {
  let text = "";
  const work: (Markup[number] | string)[] = [...nodes].reverse();
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    if (typeof next === "string") {
      text += next;
    } else if (next.type === ElementType.Text) {
      text += next.data;
    } else if (next.type === ElementType.CDATA) {
      text += DomUtils.textContent(next);
    } else if (next.type === ElementType.Tag) {
      if (blockElements.has(next.name)) {
        text += " ";
        work.push(" ");
      }
      for (let at = next.children.length - 1; at >= 0; at -= 1) {
        const child = next.children[at];
        if (child !== undefined) work.push(child);
      }
    }
  }
  return text;
}

type Picture = ReturnType<typeof DomUtils.getElementsByTagName>[number];

interface Reading {
  plain: string | undefined;
  /** Whether it holds an element, so is HTML and not text. */
  marked: boolean;
  /** Whether it shows nothing: no text, and no element but tracking pixels
   *  and wrappers that hold nothing. */
  empty: boolean;
  pictures: Picture[];
}

// Elements that show nothing of their own.
const wrappers = new Set(["br", "div", "p", "span", "wbr"]);

function readingOf(markup: string | undefined): Reading | undefined {
  if (markup === undefined) return undefined;
  const { children } = parseDocument(markup, { recognizeCDATA: true });
  const plain = textOf(readText(children).replace(/\s+/g, " "));
  const pictures = DomUtils.getElementsByTagName("img", children);
  return {
    plain,
    marked: DomUtils.findOne(() => true, children) !== null,
    empty:
      plain === undefined &&
      DomUtils.findAll(
        (element) =>
          !wrappers.has(element.name) &&
          !(element.name === "img" && isTiny(element)),
        children,
      ).length === 0,
    pictures,
  };
}

function plainOf(markup: string | undefined): string | undefined {
  return readingOf(markup)?.plain;
}

function atomTextOf(
  text: { value?: string; type?: string } | undefined,
): string | undefined {
  return text?.type === "html" || text?.type === "xhtml"
    ? plainOf(text.value)
    : textOf(text?.value);
}

// A width or height of 0 or 1 pixel is a tracking pixel, not a picture.
function isTiny(picture: Picture): boolean {
  return (["width", "height"] as const).some((name) => {
    const size = /^\s*(\d+)\s*(?:px)?\s*$/i.exec(picture.attribs[name] ?? "");
    return size?.[1] !== undefined && Number(size[1]) <= 1;
  });
}

interface Counted {
  url: string;
  /** What the picture says of itself: its title, else its alt. */
  caption: string | undefined;
}

// The first picture whose address is an http or https link once resolved
// against the entry's base, so a data: URI or a link relative to the fetch
// path is passed over, and which does not declare itself a pixel.
function countedPicture(
  reading: Reading | undefined,
  base: Base,
): Counted | undefined {
  for (const picture of reading?.pictures ?? []) {
    if (isTiny(picture)) continue;
    const url = linkOf(picture.attribs["src"], base);
    if (url === undefined) continue;
    const said = (name: string): string | undefined =>
      textOf(picture.attribs[name]?.replace(/\s+/g, " "));
    return { url, caption: said("title") ?? said("alt") };
  }
  return undefined;
}

interface Summary {
  /** What the feed's summary or description says, in HTML or plain text. */
  value: string | undefined;
  /** Whether the value may hold markup: an Atom summary of type `text` may
   *  not, and an RSS description may. */
  html: boolean;
}

interface Written {
  description: string | undefined;
  body: string | undefined;
  image_url: string | undefined;
}

/**
 * A feed's content is its content element where it has one, else its
 * summary where that holds markup. The description is the summary as plain
 * text, or for a summary that is only a picture, that picture's caption.
 */
function contentOf(
  summary: Summary,
  content: string | undefined,
  enclosure: string | undefined,
  base: Base,
  contentIsHtml = true,
): Written {
  const reading = summary.html ? readingOf(summary.value) : undefined;
  const picture = countedPicture(reading, base);
  const body = textOf(content);
  const enclosed = linkOf(enclosure, base);
  const found =
    enclosed === undefined
      ? ((contentIsHtml ? countedPicture(readingOf(body), base) : undefined) ??
        picture)
      : undefined;
  return {
    description: summary.html
      ? (reading?.plain ?? picture?.caption)
      : textOf(summary.value),
    body:
      body ??
      (reading?.marked === true && !reading.empty
        ? textOf(summary.value)
        : undefined),
    image_url: enclosed ?? found?.url,
  };
}

/** Marfa's default cap on a string property: a longer one is refused, and
 *  the entry with it. */
export const maxFieldLength = 100_000;

export interface Read {
  entries: Entry[];
  unkeyed: number;
  /** Values longer than Marfa takes, left out of their entries. */
  dropped: number;
  /** A hash of the id an Atom feed declares for itself, which identifies
   *  nothing here and is compared only to say two feeds claim one id. */
  declared: string | undefined;
}

export const entryFields = [
  "url",
  "title",
  "description",
  "body",
  "author",
  "published_at",
  "image_url",
  "source_url",
  "source_title",
  "language",
  "entry_id",
  "feed_origin",
  "feed_hash",
] as const;

/** The `xml:base` on an RSS 2.0 `<channel>`, which feedsmith does not read,
 *  taken from that start tag alone rather than a second parse of the feed. */
function channelBaseOf(text: string): string | undefined {
  const start = /<channel\b[^>]*>/.exec(text)?.[0];
  if (start === undefined) return undefined;
  const channel = DomUtils.findOne(
    (element) => element.name === "channel",
    parseDocument(start, { xmlMode: true }).children,
  );
  return channel?.attribs["xml:base"];
}

export function readFeed(
  feed: Pick<Feed, "url" | "key">,
  text: string,
  documentUrl: string = feed.url,
): Read {
  countTags(text);
  const parsed = parseFeed(text);
  const { key } = feed;
  const named = {
    feed_origin: new URL(feed.url).origin,
    feed_hash: key,
  };
  const documentBase: Base = { href: documentUrl, fromAddress: true };
  let unkeyed = 0;
  let dropped = 0;
  const entries: Entry[] = [];
  const keep = (
    entryId: string | undefined,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
  ): void => {
    const id = textOf(entryId);
    if (id === undefined || id.length > maxFieldLength) {
      unkeyed += 1;
      return;
    }
    const kept = Object.fromEntries(
      Object.entries(properties).filter(([, value]) => {
        const long = typeof value === "string" && value.length > maxFieldLength;
        if (long) dropped += 1;
        return !long;
      }),
    );
    entries.push({
      source_id: `${key}:${id}`,
      properties: { ...kept, entry_id: id, ...named },
      occurred_at: occurredAt,
    });
  };

  if (parsed.format === "atom") {
    const atom = parsed.feed;
    const declared = atom.id?.trim();
    const feedBase = baseOf(documentBase, atom.xml?.base);
    const alternate = (
      links: { href?: string; rel?: string }[] | undefined,
    ): string | undefined =>
      links?.find((link) => link.rel === undefined || link.rel === "alternate")
        ?.href;
    const siteUrl = linkOf(alternate(atom.links), feedBase);
    const language = languageOf(atom.xml?.lang);
    for (const entry of atom.entries ?? []) {
      const entryBase = baseOf(feedBase, entry.xml?.base);
      const url = linkOf(alternate(entry.links), entryBase);
      const image = entry.links?.find(
        (link) =>
          link.rel === "enclosure" && link.type?.startsWith("image/") === true,
      )?.href;
      const published = isoOf(entry.published);
      const written = contentOf(
        {
          value: entry.summary?.value,
          html:
            entry.summary?.type === "html" || entry.summary?.type === "xhtml",
        },
        entry.content?.value,
        image,
        entryBase,
        entry.content?.type === "html" || entry.content?.type === "xhtml",
      );
      keep(
        entry.id ?? url,
        {
          url,
          title: atomTextOf(entry.title),
          ...written,
          author: textOf(entry.authors?.[0]?.name ?? atom.authors?.[0]?.name),
          published_at: published,
          language,
          source_url: siteUrl,
          source_title: atomTextOf(atom.title),
        },
        published ?? isoOf(entry.updated),
      );
    }
    return {
      entries,
      unkeyed,
      dropped,
      declared:
        declared === undefined || declared === ""
          ? undefined
          : hashed(`feed-id:${declared}`),
    };
  }
  if (parsed.format === "rss") {
    const rss = parsed.feed;
    const channelBase = baseOf(
      baseOf(documentBase, rss.xml?.base),
      channelBaseOf(text),
    );
    const siteUrl = linkOf(rss.link, channelBase);
    const language = languageOf(rss.language);
    for (const item of rss.items ?? []) {
      const itemBase = baseOf(channelBase, item.xml?.base);
      const url = linkOf(item.link, itemBase);
      const image = item.enclosures?.find(
        (enclosure) => enclosure.type?.startsWith("image/") === true,
      )?.url;
      const published = isoOf(item.pubDate);
      // RSS 2.0 lets a description carry entity-encoded HTML, and feeds do.
      const written = contentOf(
        { value: item.description, html: true },
        item.content?.encoded,
        image,
        itemBase,
      );
      keep(
        item.guid?.value ?? url,
        {
          url,
          title: textOf(item.title),
          ...written,
          author: textOf(item.authors?.[0]?.name ?? item.dc?.creators?.[0]),
          published_at: published,
          language,
          source_url: siteUrl,
          source_title: textOf(rss.title),
        },
        published ?? isoOf(item.dc?.dates?.[0]),
      );
    }
    return { entries, unkeyed, dropped, declared: undefined };
  }
  throw new Error(
    `a ${parsed.format} feed, where this connector reads Atom and RSS 2.0`,
  );
}
