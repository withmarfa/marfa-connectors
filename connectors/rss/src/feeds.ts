import { createHash } from "node:crypto";
import type { Entry } from "@withmarfa/connector";
import { parseFeed } from "feedsmith";
import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { getFeed } from "./fetch.js";

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

/** Counted in the text before it is parsed, so a feed past either cap costs
 *  no parse; a tag inside CDATA counts too, which errs toward refusing. */
function countTags(text: string): void {
  const tag = /<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/g;
  let elements = 0;
  let entries = 0;
  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    elements += 1;
    if (elements > maxFeedElements) throw new TooManyElements();
    const name = match[1];
    if (name === "item" || name === "entry") {
      entries += 1;
      if (entries > maxFeedEntries) throw new TooManyEntries();
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
      text: string;
      validators: Validators;
      url: string;
    }
  | { status: number };

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

/** Hosts the owner allows to resolve to this machine or a private network,
 *  separated by whitespace. */
export function privateHosts(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/\s+/)
      .filter((host) => host !== "")
      .map((host) => host.toLowerCase().replace(/^\[|\]$/g, "")),
  );
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
  const etag = header("etag");
  const lastModified = header("last-modified");
  return {
    status: 200,
    text: decodeFeed(answer.bytes, header("content-type") ?? null),
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

function readText(nodes: Markup): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === ElementType.Text) {
      text += node.data;
    } else if (node.type === ElementType.CDATA) {
      text += DomUtils.textContent(node);
    } else if (node.type === ElementType.Tag) {
      const inner = readText(node.children);
      text += blockElements.has(node.name) ? ` ${inner} ` : inner;
    }
  }
  return text;
}

function plainOf(markup: string | undefined): string | undefined {
  if (markup === undefined) return undefined;
  const document = parseDocument(markup, { recognizeCDATA: true });
  return textOf(readText(document.children).replace(/\s+/g, " "));
}

function atomTextOf(
  text: { value?: string; type?: string } | undefined,
): string | undefined {
  return text?.type === "html" || text?.type === "xhtml"
    ? plainOf(text.value)
    : textOf(text?.value);
}

export interface Read {
  entries: Entry[];
  unkeyed: number;
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
  const entries: Entry[] = [];
  const keep = (
    entryId: string | undefined,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
  ): void => {
    const id = textOf(entryId);
    if (id === undefined) {
      unkeyed += 1;
      return;
    }
    entries.push({
      source_id: `${key}:${id}`,
      properties: { ...properties, entry_id: id, ...named },
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
      keep(
        entry.id ?? url,
        {
          url,
          title: atomTextOf(entry.title),
          description: atomTextOf(entry.summary),
          body: textOf(entry.content?.value),
          author: textOf(entry.authors?.[0]?.name ?? atom.authors?.[0]?.name),
          published_at: published,
          image_url: linkOf(image, entryBase),
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
      keep(
        item.guid?.value ?? url,
        {
          url,
          title: textOf(item.title),
          // RSS 2.0 lets a description carry entity-encoded HTML, and
          // feeds do.
          description: plainOf(item.description),
          body: textOf(item.content?.encoded),
          author: textOf(item.authors?.[0]?.name ?? item.dc?.creators?.[0]),
          published_at: published,
          image_url: linkOf(image, itemBase),
          language,
          source_url: siteUrl,
          source_title: textOf(rss.title),
        },
        published ?? isoOf(item.dc?.dates?.[0]),
      );
    }
    return { entries, unkeyed, declared: undefined };
  }
  throw new Error(
    `a ${parsed.format} feed, where this connector reads Atom and RSS 2.0`,
  );
}
