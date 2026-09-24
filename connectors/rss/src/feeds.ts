import { createHash } from "node:crypto";
import type { Entry } from "@withmarfa/connector";
import { decodeHTML } from "entities";
import { parseFeed } from "feedsmith";

const fetchTimeoutMs = 60_000;

/** The addresses in `RSS_FEEDS`, one per line or separated by commas or spaces. */
export function feedList(value: string): string[] {
  const feeds = [
    ...new Set(value.split(/[\s,]+/).filter((part) => part !== "")),
  ];
  const bad = feeds.filter((feed) => {
    try {
      const url = new URL(feed);
      return url.protocol !== "http:" && url.protocol !== "https:";
    } catch {
      return true;
    }
  });
  if (bad.length > 0) {
    throw new Error(
      `RSS_FEEDS holds ${String(bad.length)} entries that are not http or https addresses`,
    );
  }
  return feeds;
}

/** A feed as a log line or a report names it: its host and path, never its query. */
export function feedName(feedUrl: string): string {
  const url = new URL(feedUrl);
  return `${url.host}${url.pathname}`;
}

/** The address without its credentials or fragment, as each row's `feed_url`. */
function withoutCredentials(address: string): URL {
  const url = new URL(address);
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

/**
 * The address as its host, path and query, so its scheme, credentials and
 * fragment fall away, with `www.` and trailing slashes removed: two
 * spellings of one feed are one feed, and a changed password is not a new
 * one. A port names another server and stays. Only the host is lowercased,
 * since a path is case-sensitive and two feeds differing in case are two
 * feeds.
 */
export function canonicalFeedUrl(feedUrl: string): string {
  const url = new URL(feedUrl.trim());
  const host = url.host.replace(/^www\./, "");
  return `${host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/**
 * The feed's part of every entry's `source_id`. An Atom feed's own `<id>`
 * names it wherever it moves; an RSS 2.0 feed has none, so its address does.
 * Hashed, because an Atom id is an IRI whose colons would make
 * `<feed>:<entry>` read two ways, and the two arms are prefixed apart so an
 * id and an address never hash alike.
 */
export function feedKey(
  feedUrl: string,
  declaredId: string | undefined,
): string {
  const declared = declaredId?.trim();
  const input =
    declared !== undefined && declared !== ""
      ? `feed-id:${declared}`
      : `feed-url:${canonicalFeedUrl(feedUrl)}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export interface Validators {
  etag?: string;
  last_modified?: string;
}

export type Fetched =
  | { status: 304 }
  | { status: 200; text: string; validators: Validators }
  | { status: number };

/**
 * A feed's bytes as text, in the encoding XML's media types give it: a byte
 * order mark first, then the Content-Type's charset, then the XML
 * declaration's, then UTF-8. A name the platform does not know gives way
 * to the next.
 */
export function decodeFeed(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const bom =
    bytes[0] === 0xfe && bytes[1] === 0xff
      ? "utf-16be"
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : undefined;
  const header = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  const declaration = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/.exec(
    new TextDecoder("latin1").decode(bytes.subarray(0, 1024)),
  )?.[1];
  for (const label of [bom, header, declaration]) {
    if (label === undefined) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Not an encoding this platform knows; the next source may name one.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function fetchFeed(
  feedUrl: string,
  validators: Validators | undefined,
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
  const response = await fetch(feedUrl, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
  });
  if (response.status === 304) return { status: 304 };
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status };
  }
  const etag = response.headers.get("ETag") ?? undefined;
  const lastModified = response.headers.get("Last-Modified") ?? undefined;
  return {
    status: 200,
    text: decodeFeed(
      new Uint8Array(await response.arrayBuffer()),
      response.headers.get("Content-Type"),
    ),
    validators: {
      ...(etag !== undefined && { etag }),
      ...(lastModified !== undefined && { last_modified: lastModified }),
    },
  };
}

function isoOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * The base a feed's or an entry's links resolve against: its own
 * `xml:base`, itself resolved against its parent's, else its parent's. The
 * parser reads no `xml:base` on a link itself.
 */
function baseOf(parent: string, declared: string | undefined): string {
  const base = declared?.trim();
  if (base === undefined || base === "") return parent;
  try {
    return new URL(base, parent).href;
  } catch {
    return parent;
  }
}

/**
 * A link resolved against its base, when it is an http or https address,
 * and without credentials, which a row never carries.
 */
function linkOf(value: string | undefined, base: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** A BCP 47 tag, as feeds often spell one with an underscore. */
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

/** Elements that break a line, whose tags read as a space. */
const blockTags =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi;

/**
 * Markup as the text a reader sees: scripts, styles and comments dropped,
 * a block's tags read as a space and any other tag as nothing, entities
 * decoded, and whitespace run together.
 */
function plainOf(markup: string | undefined): string | undefined {
  if (markup === undefined) return undefined;
  const stripped = markup
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(blockTags, " ")
    .replace(/<[^>]*>/g, "");
  return textOf(decodeHTML(stripped).replace(/\s+/g, " "));
}

/** An Atom text construct as plain text, whichever of its three types it is. */
function atomTextOf(
  text: { value?: string; type?: string } | undefined,
): string | undefined {
  return text?.type === "html" || text?.type === "xhtml"
    ? plainOf(text.value)
    : textOf(text?.value);
}

export interface Read {
  entries: Entry[];
  /** Entries with neither an id nor a link, which nothing can key. */
  unkeyed: number;
}

/** Reads an Atom or RSS 2.0 document into entries, or throws if it is neither. */
export function readFeed(feedUrl: string, text: string): Read {
  const parsed = parseFeed(text);
  const feedAddress = withoutCredentials(feedUrl).href;
  let unkeyed = 0;
  const entries: Entry[] = [];
  const keep = (
    entryId: string | undefined,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
    key: string,
  ): void => {
    const id = textOf(entryId);
    if (id === undefined) {
      unkeyed += 1;
      return;
    }
    entries.push({
      source_id: `${key}:${id}`,
      properties: { ...properties, entry_id: id, feed_url: feedAddress },
      occurred_at: occurredAt,
    });
  };

  if (parsed.format === "atom") {
    const feed = parsed.feed;
    const key = feedKey(feedUrl, feed.id);
    const feedBase = baseOf(feedUrl, feed.xml?.base);
    const alternate = (
      links: { href?: string; rel?: string }[] | undefined,
    ): string | undefined =>
      links?.find((link) => link.rel === undefined || link.rel === "alternate")
        ?.href;
    const siteUrl = linkOf(alternate(feed.links), feedBase);
    const language = languageOf(feed.xml?.lang);
    for (const entry of feed.entries ?? []) {
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
          author: textOf(entry.authors?.[0]?.name ?? feed.authors?.[0]?.name),
          published_at: published,
          image_url: linkOf(image, entryBase),
          language,
          source_url: siteUrl,
          source_title: atomTextOf(feed.title),
        },
        published ?? isoOf(entry.updated),
        key,
      );
    }
    return { entries, unkeyed };
  }
  if (parsed.format === "rss") {
    const feed = parsed.feed;
    const key = feedKey(feedUrl, undefined);
    const channelBase = baseOf(feedUrl, feed.xml?.base);
    const siteUrl = linkOf(feed.link, channelBase);
    const language = languageOf(feed.language);
    for (const item of feed.items ?? []) {
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
          source_title: textOf(feed.title),
        },
        published ?? isoOf(item.dc?.dates?.[0]),
        key,
      );
    }
    return { entries, unkeyed };
  }
  throw new Error(
    `a ${parsed.format} feed, where this connector reads Atom and RSS 2.0`,
  );
}
