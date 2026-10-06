import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  canonicalFeedUrl,
  decodeFeed,
  feedKey,
  feedList,
  privateHosts,
  maxFeedElements,
  maxFeedEntries,
  maxFieldLength,
  readFeed,
  TooManyElements,
  TooManyEntries,
} from "../src/feeds.js";
import { getFeed, isPrivate, maxFeedBytes, TooLarge } from "../src/fetch.js";

/** Few elements, each with thousands of attributes: under every count, and
 *  far over what any real feed takes to parse. */
function heavyFeed(bytes: number): string {
  const attributes = Array.from(
    { length: 4000 },
    (_, at) => `a${String(at)}="v"`,
  ).join(" ");
  const item = `<item><title ${attributes}>t</title><guid>g</guid></item>`;
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${item.repeat(Math.floor(bytes / item.length))}</channel></rss>`;
}

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");
const at = (url: string, name?: string) => ({ url, key: feedKey(url, name) });

/** Zeros, gzipped: a few hundred KiB on the wire for every 256 MiB inside. */
async function gzipBomb(bytes: number): Promise<Buffer> {
  const gzip = createGzip({ level: 9 });
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((ended) => gzip.on("end", ended));
  const zeros = Buffer.alloc(16 * 1024 * 1024);
  for (let written = 0; written < bytes; written += zeros.byteLength) {
    if (!gzip.write(zeros)) {
      await new Promise((drained) => gzip.once("drain", drained));
    }
  }
  gzip.end();
  await done;
  return Buffer.concat(chunks);
}

function manyItems(count: number): string {
  const items = Array.from(
    { length: count },
    (_, at) =>
      `<item><title>${String(at)}</title><guid>${String(at)}</guid></item>`,
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Many</title>${items}</channel></rss>`;
}

describe("a feed's identity", () => {
  it("keeps a path's case and drops the scheme, www and a trailing slash", () => {
    expect(canonicalFeedUrl("https://WWW.Example.COM/Feed/")).toBe(
      "example.com/Feed",
    );
    expect(canonicalFeedUrl("http://example.com/Feed")).toBe(
      "example.com/Feed",
    );
    expect(canonicalFeedUrl("https://example.com/feed")).not.toBe(
      canonicalFeedUrl("https://example.com/Feed"),
    );
  });

  it("keys a feed apart from its address's credentials and fragment, and keeps a port", () => {
    expect(
      canonicalFeedUrl("https://reader:pass@www.example.org:443/rss.xml#top"),
    ).toBe("example.org/rss.xml");
    expect(feedKey("https://reader:pass@example.org/rss.xml")).toBe(
      feedKey("https://reader:rotated@example.org/rss.xml"),
    );
    expect(canonicalFeedUrl("https://example.org:8443/rss.xml")).toBe(
      "example.org:8443/rss.xml",
    );
    expect(canonicalFeedUrl("https://example.org/rss.xml?page=2")).toBe(
      "example.org/rss.xml?page=2",
    );
  });

  it("keys a feed by its name in the list, else its address, and never by an id it declares", () => {
    const named = feedKey("https://example.org/rss.xml?token=a", "news");
    expect(named).toMatch(/^[0-9a-f]{32}$/);
    expect(named).toBe(
      feedKey("https://elsewhere.example.net/feed?token=b", "news"),
    );
    expect(named).not.toBe(feedKey("https://example.org/rss.xml?token=a"));
    const document = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><id>tag:example.com,2026:feed</id>
        <entry><title>Twin</title><id>tag:example.com,2026:entry:1</id></entry></feed>`;
    const first = readFeed(
      at("https://example.com/atom.xml"),
      fixture("atom.xml"),
    );
    const second = readFeed(at("https://twin.example.net/atom.xml"), document);
    expect(second.declared).toBe(first.declared);
    expect(second.entries[0]?.source_id).not.toBe(first.entries[0]?.source_id);
    expect(
      second.entries[0]?.source_id.startsWith(
        feedKey("https://twin.example.net/atom.xml"),
      ),
    ).toBe(true);
  });

  it("keys two feeds' bare guid of 1 apart", () => {
    const one = readFeed(at("https://example.org/rss.xml"), fixture("rss.xml"));
    const other = readFeed(
      at("https://example.net/rss.xml"),
      fixture("rss.xml"),
    );
    expect(one.entries[0]?.source_id).toMatch(/^[0-9a-f]{32}:1$/);
    expect(one.entries[0]?.source_id).not.toBe(other.entries[0]?.source_id);
  });
});

describe("reading a feed", () => {
  it("reads an Atom feed's entries under bookmark names", () => {
    const { entries, unkeyed } = readFeed(
      at("https://example.com/atom.xml"),
      fixture("atom.xml"),
    );
    expect(unkeyed).toBe(0);
    const key = feedKey("https://example.com/atom.xml");
    expect(entries).toEqual([
      {
        source_id: `${key}:tag:example.com,2026:entry:1`,
        properties: {
          url: "https://example.com/posts/1",
          title: "First entry",
          description: "The first summary.",
          body: "<p>The first body.</p>",
          author: "A. Writer",
          published_at: "2026-09-18T09:00:00.000Z",
          image_url: undefined,
          language: "en",
          source_url: "https://example.com/",
          source_title: "Example Atom Feed",
          entry_id: "tag:example.com,2026:entry:1",
          feed_origin: "https://example.com",
          feed_hash: feedKey("https://example.com/atom.xml"),
        },
        occurred_at: "2026-09-18T09:00:00.000Z",
      },
      {
        source_id: `${key}:tag:example.com,2026:entry:2`,
        properties: {
          url: "https://example.com/posts/2",
          title: "Second entry",
          description: "The second summary.",
          body: undefined,
          author: "A. Writer",
          published_at: undefined,
          image_url: "https://example.com/2.png",
          language: "en",
          source_url: "https://example.com/",
          source_title: "Example Atom Feed",
          entry_id: "tag:example.com,2026:entry:2",
          feed_origin: "https://example.com",
          feed_hash: feedKey("https://example.com/atom.xml"),
        },
        occurred_at: "2026-09-19T09:00:00.000Z",
      },
    ]);
  });

  it("reads an RSS 2.0 feed, keying an entry without a guid by its link and leaving out one with neither", () => {
    const { entries, unkeyed } = readFeed(
      at("https://example.org/rss.xml"),
      fixture("rss.xml"),
    );
    expect(unkeyed).toBe(1);
    expect(entries.map((entry) => entry.properties["entry_id"])).toEqual([
      "1",
      "https://example.org/beta",
    ]);
    expect(entries[0]?.properties).toMatchObject({
      title: "Alpha",
      description: "Alpha summary.",
      body: "<p>Alpha body.</p>",
      author: "B. Writer",
      language: "en-GB",
      source_url: "https://example.org/",
      source_title: "Example RSS Feed",
      published_at: "2026-09-16T08:00:00.000Z",
    });
    expect(entries[1]?.properties["image_url"]).toBe(
      "https://example.org/beta.jpg",
    );
    expect(entries[1]?.occurred_at).toBe("2026-09-17T07:00:00.000Z");
  });

  it("keeps no credentials of the address it was given, in any link it resolves", () => {
    const rss = readFeed(
      at("https://reader:pass@example.org/feed.xml#top"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>/</link>
        <item><title>A</title><link>/posts/a</link><guid>a</guid></item>
      </channel></rss>`,
    );
    expect(rss.entries[0]?.properties).toMatchObject({
      url: "https://example.org/posts/a",
      source_url: "https://example.org/",
      feed_origin: "https://example.org",
      feed_hash: feedKey("https://example.org/feed.xml"),
    });
    const atom = readFeed(
      at("https://reader:pass@example.com/atom.xml"),
      fixture("atom.xml"),
    );
    expect(atom.entries[1]?.properties["url"]).toBe(
      "https://example.com/posts/2",
    );
    expect(JSON.stringify([rss.entries, atom.entries])).not.toMatch(
      /reader|pass/,
    );
  });

  it("writes no credentials a feed's own links carry", () => {
    const { entries } = readFeed(
      at("https://example.org/feed.xml"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://site:key@example.org/</link>
        <item><title>A</title><link>https://viewer:secret@example.org/a</link><guid>a</guid></item>
      </channel></rss>`,
    );
    expect(entries[0]?.properties).toMatchObject({
      url: "https://example.org/a",
      source_url: "https://example.org/",
    });
    expect(JSON.stringify(entries)).not.toMatch(/viewer|secret|site:key/);
  });

  it("reads Atom's html and xhtml text as plain text, and its text as it is", () => {
    const { entries } = readFeed(
      at("https://example.com/atom.xml"),
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title type="html">Site &amp;amp; Co</title>
        <id>tag:example.com,2026:feed</id>
        <updated>2026-09-20T10:00:00Z</updated>
        <entry>
          <title type="html">&lt;em&gt;Hello&lt;/em&gt; &amp;amp; world</title>
          <id>tag:example.com,2026:entry:1</id>
          <updated>2026-09-20T10:00:00Z</updated>
          <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>A <b>bold</b> summary.</p><p>Two.</p></div></summary>
        </entry>
        <entry>
          <title>Less &lt;than&gt; plain</title>
          <id>tag:example.com,2026:entry:2</id>
          <updated>2026-09-20T10:00:00Z</updated>
        </entry>
      </feed>`,
    );
    expect(entries.map((entry) => entry.properties["title"])).toEqual([
      "Hello & world",
      "Less <than> plain",
    ]);
    expect(entries[0]?.properties["description"]).toBe("A bold summary. Two.");
    expect(entries[0]?.properties["source_title"]).toBe("Site & Co");
  });

  it("reads an RSS 2.0 title, and the channel's, as plain text: entities decoded, markup removed, whitespace collapsed", () => {
    const { entries } = readFeed(
      at("https://example.org/rss.xml"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Site &lt;i&gt;News&lt;/i&gt; &amp;amp; Co</title><link>https://example.org/</link>
        <item><title>Undated &lt;b&gt;bold&lt;/b&gt;</title><guid>a</guid></item>
        <item><title><![CDATA[Fish &amp; <i>chips</i>]]></title><guid>b</guid></item>
        <item><title>Don&amp;#8217;t   split
          this</title><guid>c</guid></item>
        <item><title>   </title><guid>d</guid></item>
      </channel></rss>`,
    );
    expect(entries.map((entry) => entry.properties["title"])).toEqual([
      "Undated bold",
      "Fish & chips",
      "Don\u2019t split this",
      undefined,
    ]);
    expect(entries[0]?.properties["source_title"]).toBe("Site News & Co");
  });

  it("reads an RSS 2.0 description's entity-encoded HTML as plain text", () => {
    const { entries } = readFeed(
      at("https://example.org/rss.xml"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://example.org/</link>
        <item><title>A</title><guid>a</guid>
          <description>&lt;p&gt;Fish &amp;amp; &lt;a href="/c"&gt;chips&lt;/a&gt;&lt;/p&gt;&lt;p&gt;Peas.&lt;/p&gt;</description>
        </item>
      </channel></rss>`,
    );
    expect(entries[0]?.properties["description"]).toBe("Fish & chips Peas.");
  });

  it("resolves links against xml:base, the feed's and an entry's", () => {
    const { entries } = readFeed(
      at("https://example.com/atom.xml"),
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/blog/2026/">
        <title>T</title>
        <id>tag:example.com,2026:feed</id>
        <updated>2026-09-20T10:00:00Z</updated>
        <link href="./"/>
        <entry>
          <title>One</title>
          <id>tag:example.com,2026:entry:1</id>
          <updated>2026-09-20T10:00:00Z</updated>
          <link href="post-1"/>
        </entry>
        <entry xml:base="../../archive/">
          <title>Two</title>
          <id>tag:example.com,2026:entry:2</id>
          <updated>2026-09-20T10:00:00Z</updated>
          <link href="post-2"/>
        </entry>
      </feed>`,
    );
    expect(entries.map((entry) => entry.properties["url"])).toEqual([
      "https://example.com/blog/2026/post-1",
      "https://example.com/archive/post-2",
    ]);
    expect(entries[0]?.properties["source_url"]).toBe(
      "https://example.com/blog/2026/",
    );
  });

  it("keys an entry whose id is blank by its link", () => {
    const rss = readFeed(
      at("https://example.org/rss.xml"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://example.org/</link>
        <item><title>A</title><link>https://example.org/a</link><guid> </guid></item>
      </channel></rss>`,
    );
    const atom = readFeed(
      at("https://example.com/atom.xml"),
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>T</title><id>tag:example.com,2026:feed</id><updated>2026-09-20T10:00:00Z</updated>
        <entry><title>A</title><id></id><updated>2026-09-20T10:00:00Z</updated><link href="https://example.com/a"/></entry>
      </feed>`,
    );
    expect([rss.unkeyed, atom.unkeyed]).toEqual([0, 0]);
    expect(
      [...rss.entries, ...atom.entries].map(
        (entry) => entry.properties["entry_id"],
      ),
    ).toEqual(["https://example.org/a", "https://example.com/a"]);
  });

  it("reads the charset a feed's bytes are in", () => {
    const latin = Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><t>Résumé</t>',
      "latin1",
    );
    expect(decodeFeed(latin, "application/xml")).toContain("Résumé");
    expect(decodeFeed(latin, "text/xml; charset=ISO-8859-1")).toContain(
      "Résumé",
    );
    expect(decodeFeed(latin, "text/xml; charset=no-such-charset")).toContain(
      "Résumé",
    );
    const utf8 = Buffer.from("<?xml version='1.0'?><t>Résumé</t>", "utf8");
    expect(decodeFeed(utf8, null)).toContain("Résumé");
    const utf16 = Buffer.from("﻿<?xml version='1.0'?><t>Résumé</t>", "utf16le");
    expect(decodeFeed(utf16, "application/xml; charset=utf-8")).toContain(
      "Résumé",
    );
    const latinDeclaredUtf8 = Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?><t>Résumé</t>',
      "latin1",
    );
    expect(
      decodeFeed(latinDeclaredUtf8, "text/xml; charset=ISO-8859-1"),
    ).toContain("Résumé");
    const markedUtf8 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<?xml version='1.0'?><t>Résumé</t>", "utf8"),
    ]);
    expect(decodeFeed(markedUtf8, "text/xml; charset=ISO-8859-1")).toContain(
      "Résumé",
    );
    const unmarked16 = Buffer.from(
      "<?xml version='1.0'?><t>Résumé</t>",
      "utf16le",
    );
    expect(decodeFeed(unmarked16, null)).toContain("Résumé");
  });

  it("reads a UTF-8 feed whose declaration names UTF-16 out of habit", () => {
    const text = decodeFeed(
      Buffer.from(
        '<?xml version="1.0" encoding="utf-16"?><rss version="2.0"><channel><title>T</title><link>https://example.org/</link><item><title>Résumé</title><guid>r</guid></item></channel></rss>',
        "utf8",
      ),
      "application/rss+xml",
    );
    expect(
      readFeed(at("https://example.org/rss.xml"), text).entries.map(
        (entry) => entry.properties["title"],
      ),
    ).toEqual(["Résumé"]);
  });

  it("refuses what is not a feed it reads", () => {
    expect(() =>
      readFeed(
        at("https://example.org/x"),
        "<html><body>not a feed</body></html>",
      ),
    ).toThrow();
  });

  it("reads a list of feeds, and refuses an entry that is not an address", () => {
    expect(
      feedList(
        "https://a.example.com/1\nhttps://b.example.com/2  https://a.example.com/1",
      ),
    ).toEqual([
      {
        position: 1,
        url: "https://a.example.com/1",
        key: feedKey("https://a.example.com/1"),
        address: feedKey("https://a.example.com/1"),
      },
      {
        position: 2,
        url: "https://b.example.com/2",
        key: feedKey("https://b.example.com/2"),
        address: feedKey("https://b.example.com/2"),
      },
    ]);
    expect(() =>
      feedList("https://a.example.com/1 ftp://b.example.com/2"),
    ).toThrow("an entry that is not an http or https address");
    expect(() =>
      feedList("ftp://a.example.com/1 mailto:b news=ftp://c"),
    ).toThrow("3 entries that are not");
  });

  it("reads a name given as name=address, which keys the feed, and refuses one name for two addresses", () => {
    const [named, plain] = feedList(
      "news=https://a.example.com/feed?token=t1 https://b.example.com/q?x=1",
    );
    expect(named).toEqual({
      position: 1,
      url: "https://a.example.com/feed?token=t1",
      key: feedKey("https://a.example.com/feed?token=t1", "news"),
      address: feedKey("https://a.example.com/feed?token=t1"),
    });
    expect(plain?.url).toBe("https://b.example.com/q?x=1");
    expect(plain?.key).toBe(feedKey("https://b.example.com/q?x=1"));
    expect(() =>
      feedList("news=https://a.example.com/1 news=https://a.example.com/2"),
    ).toThrow("RSS_FEEDS gives entries 1 and 2 one name");
    expect(
      feedList(
        "news=https://a.example.com/1 news=https://www.a.example.com/1/",
      ),
    ).toHaveLength(1);
  });

  it("keeps a comma in an address, separating entries by whitespace alone", () => {
    expect(
      feedList(
        "https://a.example.com/feed?tags=a,b\thttps://b.example.com/2",
      ).map((feed) => feed.url),
    ).toEqual([
      "https://a.example.com/feed?tags=a,b",
      "https://b.example.com/2",
    ]);
  });

  it("reads RSS_PRIVATE_HOSTS as a URL reads a host, and refuses what is not one", () => {
    expect([
      ...privateHosts(" LOCALHOST.  bücher.example\n[::1] fd00::1 10.0.0.2 "),
    ]).toEqual([
      "localhost",
      "xn--bcher-kva.example",
      "::1",
      "fd00::1",
      "10.0.0.2",
    ]);
    expect(privateHosts(undefined).size).toBe(0);
    for (const bad of [
      "http://nas.example",
      "nas.example:8080",
      "nas.example/feed",
      "nas.example#top",
    ]) {
      expect(() => privateHosts(bad)).toThrow(
        "RSS_PRIVATE_HOSTS holds an entry that is not a host name",
      );
    }
  });

  it("lists a feed once however it is spelled, keeping the first spelling", () => {
    expect(
      feedList(
        "https://a.example.com/feed https://a.example.com/feed/ http://www.a.example.com/feed https://a.example.com/feed?page=2",
      ).map((feed) => [feed.position, feed.url]),
    ).toEqual([
      [1, "https://a.example.com/feed"],
      [4, "https://a.example.com/feed?page=2"],
    ]);
  });

  it("keeps a feed's query and path out of the rows, where a token rides, and writes no link relative to that path", () => {
    const address =
      "https://example.org/private/p4th-t0ken/feed.xml?token=s3cr3t-token";
    const rss = readFeed(
      at(address),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>./</link>
        <item><title>A</title><link>#frag</link><guid>a</guid></item>
        <item><title>B</title><link>item/2</link><guid>b</guid>
          <enclosure url="img.png" type="image/png" length="1"/></item>
        <item><title>C</title><link>/posts/c</link><guid>c</guid></item>
        <item><title>D</title><link>item/4</link></item>
      </channel></rss>`,
    );
    const atom = readFeed(
      at(address),
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>T</title><id>tag:example.org,2026:feed</id><updated>2026-09-20T10:00:00Z</updated>
        <link href="./"/>
        <entry><title>E</title><id>tag:example.org,2026:e</id><updated>2026-09-20T10:00:00Z</updated><link href="e1"/></entry>
      </feed>`,
    );
    const entries = [...rss.entries, ...atom.entries];
    expect(JSON.stringify(entries)).not.toMatch(/s3cr3t|p4th-t0ken|private/);
    expect(entries.map((entry) => entry.properties["url"])).toEqual([
      undefined,
      undefined,
      "https://example.org/posts/c",
      undefined,
    ]);
    expect(rss.entries[1]?.properties["image_url"]).toBeUndefined();
    expect(rss.entries[0]?.properties["source_url"]).toBeUndefined();
    expect(rss.unkeyed).toBe(1);
    expect(rss.entries[0]?.properties).toMatchObject({
      feed_origin: "https://example.org",
      feed_hash: feedKey(address),
    });
  });

  it("reads markup as text, and a < that opens no tag as text", () => {
    const description = (html: string): unknown =>
      readFeed(
        at("https://example.org/rss.xml"),
        `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://example.org/</link>
          <item><title>A</title><guid>a</guid><description>${html}</description></item>
        </channel></rss>`,
      ).entries[0]?.properties["description"];
    expect(description("1 &lt; 2 and 3 &gt; 2")).toBe("1 < 2 and 3 > 2");
    expect(
      description("&lt;![CDATA[x &lt; y and y &gt; z]]&gt; and more"),
    ).toBe("x < y and y > z and more");
    expect(description('&lt;img alt="a &gt; b" src="x.png"&gt;Caption')).toBe(
      "Caption",
    );
    expect(
      description("&lt;script&gt;var t = 'hidden';&lt;/script&gt;Shown"),
    ).toBe("Shown");
    expect(
      description("&lt;style&gt;p { color: red }&lt;/style&gt;Shown"),
    ).toBe("Shown");
    expect(description("&lt;!-- a &gt; b, hidden --&gt;Shown")).toBe("Shown");
  });

  it("resolves an RSS 2.0 feed's links against its rss, channel and item xml:base", () => {
    const { entries } = readFeed(
      at("https://example.org/rss.xml"),
      `<?xml version="1.0"?><rss version="2.0" xml:base="https://a.example.org/root/">
        <channel xml:base="chan/"><title>T</title><link>site</link>
          <item><title>A</title><guid>a</guid><link>p</link>
            <enclosure url="img.jpg" type="image/jpeg" length="1"/></item>
          <item xml:base="/items/"><title>B</title><guid>b</guid><link>q</link></item>
        </channel></rss>`,
    );
    expect(entries.map((entry) => entry.properties["url"])).toEqual([
      "https://a.example.org/root/chan/p",
      "https://a.example.org/items/q",
    ]);
    expect(entries[0]?.properties["source_url"]).toBe(
      "https://a.example.org/root/chan/site",
    );
    expect(entries[0]?.properties["image_url"]).toBe(
      "https://a.example.org/root/chan/img.jpg",
    );
  });

  it("writes no link that resolves against the feed's path, however it is spelled", () => {
    const address = "https://example.org/private/p4th-t0ken/feed.xml";
    const rss = readFeed(
      at(address),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https:./</link>
        <item><title>A</title><link>https:item/2</link><guid>a</guid></item>
        <item><title>B</title><link>HTTPS:item/3</link><guid>b</guid></item>
        <item><title>C</title><link>https://example.org/c</link><guid>c</guid>
          <enclosure url="https:img.png" type="image/png" length="1"/></item>
      </channel></rss>`,
    );
    const based = readFeed(
      at(address),
      `<?xml version="1.0"?><rss version="2.0"><channel xml:base="./"><title>T</title><link>https://example.org/</link>
        <item><title>D</title><link>item/5</link><guid>d</guid></item>
      </channel></rss>`,
    );
    const atom = readFeed(
      at(address),
      `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:base="https:sub/">
        <title>T</title><id>tag:example.org,2026:feed</id><updated>2026-09-20T10:00:00Z</updated>
        <entry><title>E</title><id>tag:example.org,2026:e</id><updated>2026-09-20T10:00:00Z</updated><link href="e1"/></entry>
      </feed>`,
    );
    const entries = [...rss.entries, ...based.entries, ...atom.entries];
    expect(JSON.stringify(entries)).not.toMatch(/p4th-t0ken|private/);
    expect(entries.map((entry) => entry.properties["url"])).toEqual([
      undefined,
      undefined,
      "https://example.org/c",
      undefined,
      undefined,
    ]);
    expect(rss.entries[2]?.properties["image_url"]).toBeUndefined();
    expect(rss.entries[0]?.properties["source_url"]).toBeUndefined();
    expect(based.entries[0]?.properties["source_url"]).toBe(
      "https://example.org/",
    );
  });

  it("resolves links against the origin a redirect took the fetch to, and never against its path", () => {
    const { entries } = readFeed(
      at("https://example.org/old/feed"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>/</link>
        <item><title>A</title><guid>a</guid><link>/posts/a</link></item>
        <item><title>B</title><guid>b</guid><link>post-b</link></item>
      </channel></rss>`,
      "https://cdn.example.net/new/blog/feed",
    );
    expect(entries[0]?.properties).toMatchObject({
      url: "https://cdn.example.net/posts/a",
      source_url: "https://cdn.example.net/",
      feed_origin: "https://example.org",
      feed_hash: feedKey("https://example.org/old/feed"),
    });
    expect(entries[1]?.properties["url"]).toBeUndefined();
  });
});

describe("an entry's content and image", () => {
  const rss = (items: string, channel = ""): string =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title><link>https://example.org/</link>${channel}${items}</channel></rss>`;
  const atom = (entries: string, feed = ""): string =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"${feed}><title>T</title><id>tag:example.com,2026:feed</id>${entries}</feed>`;
  const only = (document: string) =>
    readFeed(at("https://example.org/rss.xml"), document).entries[0]
      ?.properties;

  it("keeps the markup of a summary that is a feed's only content as the body, and its plain text as the description", () => {
    const description = `&lt;p&gt;Fish &amp;amp; &lt;a href="/c"&gt;chips&lt;/a&gt;&lt;/p&gt;&lt;p&gt;Peas.&lt;/p&gt;`;
    expect(
      only(
        rss(
          `<item><guid>a</guid><description>${description}</description></item>`,
        ),
      ),
    ).toMatchObject({
      body: `<p>Fish &amp; <a href="/c">chips</a></p><p>Peas.</p>`,
      description: "Fish & chips Peas.",
    });
    const summary = readFeed(
      at("https://example.com/atom.xml"),
      atom(
        `<entry><id>a</id><title>A</title><summary type="html">&lt;p&gt;One &lt;b&gt;bold&lt;/b&gt;.&lt;/p&gt;</summary></entry>
         <entry><id>b</id><title>B</title><summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Two <i>italic</i>.</p></div></summary></entry>`,
      ),
    ).entries;
    expect(summary.map((entry) => entry.properties["body"])).toEqual([
      "<p>One <b>bold</b>.</p>",
      "<p>Two <i>italic</i>.</p>",
    ]);
    expect(summary.map((entry) => entry.properties["description"])).toEqual([
      "One bold.",
      "Two italic.",
    ]);
  });

  it("keeps the content as the body and the summary as the description where a feed has both, and no body for a summary without markup", () => {
    expect(
      only(
        rss(
          `<item><guid>a</guid><description>&lt;p&gt;Short.&lt;/p&gt;</description><content:encoded><![CDATA[<p>Long.</p>]]></content:encoded></item>`,
        ),
      ),
    ).toMatchObject({ body: "<p>Long.</p>", description: "Short." });
    const plain = readFeed(
      at("https://example.org/rss.xml"),
      rss(
        `<item><guid>a</guid><description>Fish &amp;amp; chips &amp;lt;3</description></item>`,
      ),
    ).entries[0]?.properties;
    expect(plain).toMatchObject({ description: "Fish & chips <3" });
    expect(plain).not.toHaveProperty("body", expect.anything());
    const text = readFeed(
      at("https://example.com/atom.xml"),
      atom(
        `<entry><id>a</id><title>A</title><summary>Less &lt;than&gt; plain</summary></entry>`,
      ),
    ).entries[0]?.properties;
    expect(text).toMatchObject({ description: "Less <than> plain" });
    expect(text?.["body"]).toBeUndefined();
  });

  it("keeps a picture-only entry's picture, its caption as the description and its markup as the body", () => {
    const entry = only(
      rss(
        `<item><title>Compiling</title><link>https://example.org/303/</link><guid>https://example.org/303/</guid>
          <description>&lt;img src="https://imgs.example.org/comics/compiling.png" title="Hover caption &amp;amp; joke" alt="Compiling" /&gt;</description></item>`,
      ),
    );
    expect(entry).toMatchObject({
      body: `<img src="https://imgs.example.org/comics/compiling.png" title="Hover caption &amp; joke" alt="Compiling" />`,
      description: "Hover caption & joke",
      image_url: "https://imgs.example.org/comics/compiling.png",
    });
  });

  it("captions a picture-only entry by its alt text where the picture has no title", () => {
    expect(
      only(
        rss(
          `<item><guid>a</guid><description>&lt;img src="https://example.org/a.png" alt="  A  diagram "/&gt;</description></item>`,
        ),
      ),
    ).toMatchObject({ description: "A diagram" });
  });

  it("takes the first picture that counts, passing over pixels, data URIs and other schemes", () => {
    const html = [
      `<img src="https://example.org/track.gif" width="1" height="1">`,
      `<img src="https://example.org/zero.gif" height="0">`,
      `<img src="https://example.org/px.gif" width="1px">`,
      `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`,
      `<img src="ftp://example.org/old.png">`,
      `<img>`,
      `<img src="https://example.org/real.png" width="640" height="480">`,
      `<img src="https://example.org/later.png">`,
    ].join("");
    const entry = only(
      rss(
        `<item><guid>a</guid><description><![CDATA[<p>Text.</p>${html}]]></description></item>`,
      ),
    );
    expect(entry?.["image_url"]).toBe("https://example.org/real.png");
  });

  it("resolves a relative picture against the entry's base, and writes none relative to the feed's path", () => {
    const based = readFeed(
      at("https://example.org/feeds/secret-path/feed.xml?token=secret"),
      atom(
        `<entry xml:base="https://cdn.example.net/posts/"><id>a</id><title>A</title>
          <content type="html">&lt;img src="a/one.png"&gt;</content></entry>
        <entry><id>b</id><title>B</title>
          <content type="html">&lt;img src="//cdn.example.net/two.png"&gt;</content></entry>
        <entry><id>c</id><title>C</title>
          <content type="html">&lt;img src="sub/three.png"&gt;</content></entry>`,
      ),
    ).entries;
    expect(based.map((entry) => entry.properties["image_url"])).toEqual([
      "https://cdn.example.net/posts/a/one.png",
      "https://cdn.example.net/two.png",
      undefined,
    ]);
    expect(JSON.stringify(based)).not.toContain("secret");
  });

  it("takes an enclosure before a picture in the text, and a picture in the content before one in the summary", () => {
    const enclosed = readFeed(
      at("https://example.org/rss.xml"),
      rss(
        `<item><guid>a</guid><description>&lt;img src="https://example.org/summary.png"&gt;</description>
          <enclosure url="https://example.org/cover.jpg" type="image/jpeg" length="1"/></item>
         <item><guid>b</guid><description>&lt;img src="https://example.org/summary.png"&gt;</description>
          <content:encoded><![CDATA[<p><img src="https://example.org/content.png"></p>]]></content:encoded></item>
         <item><guid>c</guid><description>&lt;img src="https://example.org/summary.png"&gt;</description>
          <content:encoded><![CDATA[<p>No picture.</p>]]></content:encoded></item>
         <item><guid>d</guid>
          <content:encoded><![CDATA[<p><img src="https://example.org/body-only.png"></p>]]></content:encoded></item>`,
      ),
    ).entries;
    expect(enclosed.map((entry) => entry.properties["image_url"])).toEqual([
      "https://example.org/cover.jpg",
      "https://example.org/content.png",
      "https://example.org/summary.png",
      "https://example.org/body-only.png",
    ]);
  });

  it("writes nothing for a summary that holds only a tracking pixel", () => {
    const entry = only(
      rss(
        `<item><guid>a</guid><title>A</title><description>&lt;img src="https://example.org/t.gif" width="1" height="1" alt="pixel"&gt;</description></item>`,
      ),
    );
    expect(entry?.["title"]).toBe("A");
    for (const field of ["body", "description", "image_url"]) {
      expect(entry?.[field]).toBeUndefined();
    }
  });

  it("keeps the markup of a summary that shows something even where no picture of it counts", () => {
    const kept = readFeed(
      at("https://example.org/rss.xml"),
      rss(
        [
          `<item><guid>a</guid><description>&lt;iframe src="https://example.org/embed"&gt;&lt;/iframe&gt;</description></item>`,
          `<item><guid>b</guid><description>&lt;video src="https://example.org/clip.mp4"&gt;&lt;/video&gt;</description></item>`,
          `<item><guid>c</guid><description>&lt;img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="&gt;</description></item>`,
          `<item><guid>d</guid><description>&lt;img src="pics/a.png"&gt;</description></item>`,
          `<item><guid>e</guid><description>&lt;p&gt;&lt;br&gt;&lt;/p&gt;&lt;img src="https://example.org/t.gif" width="1" height="1"&gt;</description></item>`,
        ].join(""),
      ),
    ).entries;
    expect(kept.map((entry) => entry.properties["body"] !== undefined)).toEqual(
      [true, true, true, true, false],
    );
  });

  it("reads content nested deeper than the call stack, and a text content that only holds picture-like text", () => {
    const depth = 12_000;
    const nested = `${"<i>".repeat(depth)}deep${"</i>".repeat(depth)}`;
    const deep = only(
      rss(
        `<item><guid>a</guid><description>one</description><content:encoded><![CDATA[${nested}]]></content:encoded></item>`,
      ),
    );
    expect(deep?.["body"]).toBe(nested);
    const described = only(
      rss(
        `<item><guid>b</guid><description><![CDATA[${nested}]]></description></item>`,
      ),
    );
    expect(described?.["description"]).toBe("deep");
    const text = readFeed(
      at("https://example.org/feed.xml"),
      atom(
        `<entry><id>a</id><title>A</title><content type="text">&lt;img src="https://example.org/x.png"&gt;</content></entry>`,
      ),
    ).entries;
    expect(text[0]?.properties["image_url"]).toBeUndefined();
  });

  it("gives an entry with no date no date of its own, leaving the server to date it when it is first stored", () => {
    const { entries } = readFeed(
      at("https://example.org/rss.xml"),
      rss(`<item><guid>a</guid><title>Undated</title></item>`),
    );
    expect(entries[0]?.occurred_at).toBeUndefined();
    expect(entries[0]?.properties["published_at"]).toBeUndefined();
  });
});

describe("RSS 1.0 and JSON Feed", () => {
  const rdf = `<?xml version="1.0" encoding="utf-8"?>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
      <channel rdf:about="https://example.org/feed.rdf">
        <title>Example &lt;b&gt;RDF&lt;/b&gt;</title>
        <link>https://example.org/</link>
        <description>An RSS 1.0 feed.</description>
        <dc:language>en-GB</dc:language>
        <items><rdf:Seq><rdf:li rdf:resource="https://example.org/a"/></rdf:Seq></items>
      </channel>
      <item rdf:about="https://example.org/a#id">
        <title>Fish &amp;amp; chips</title>
        <link>https://example.org/a</link>
        <description>&lt;p&gt;Short.&lt;/p&gt;</description>
        <dc:date>2026-09-18T09:00:00+01:00</dc:date>
        <dc:creator>A. Writer</dc:creator>
        <content:encoded><![CDATA[<p>Long <img src="https://example.org/inline.png" alt="x"/></p>]]></content:encoded>
      </item>
      <item>
        <title>Linked only</title>
        <link>https://example.org/b</link>
        <description>Plain summary.</description>
        <media:thumbnail url="https://example.org/b.jpg" width="120" height="80"/>
      </item>
      <item><title>Nothing to know it by</title></item>
    </rdf:RDF>`;

  it("reads an RSS 1.0 feed into the same fields as the others", () => {
    const read = readFeed(at("https://example.org/feed.rdf"), rdf);
    expect(read.unkeyed).toBe(1);
    expect(read.entries).toHaveLength(2);
    expect(read.entries[0]).toMatchObject({
      occurred_at: "2026-09-18T08:00:00.000Z",
      properties: {
        entry_id: "https://example.org/a#id",
        url: "https://example.org/a",
        title: "Fish & chips",
        description: "Short.",
        body: `<p>Long <img src="https://example.org/inline.png" alt="x"/></p>`,
        author: "A. Writer",
        published_at: "2026-09-18T08:00:00.000Z",
        image_url: "https://example.org/inline.png",
        source_url: "https://example.org/",
        source_title: "Example RDF",
        language: "en-GB",
      },
    });
    expect(read.entries[1]?.properties).toMatchObject({
      entry_id: "https://example.org/b",
      description: "Plain summary.",
      image_url: "https://example.org/b.jpg",
    });
    expect(read.entries[1]?.properties).not.toHaveProperty(
      "body",
      expect.anything(),
    );
    expect(read.entries[1]?.occurred_at).toBeUndefined();
  });

  const json = JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "Example <b>JSON</b>",
    home_page_url: "https://example.org/",
    language: "en",
    authors: [{ name: "Feed Author" }],
    items: [
      {
        id: "1",
        url: "https://example.org/1",
        title: "One &amp; <b>two</b>",
        content_html: `<p>Hello <img src="https://example.org/inline.png"/></p>`,
        summary: "Short.",
        image: "https://example.org/hero.png",
        date_published: "2026-09-18T09:00:00Z",
        authors: [{ name: "Item Author" }],
        language: "fr",
      },
      {
        id: "2",
        content_text: "Plain words",
        date_modified: "2026-09-19T09:00:00Z",
        banner_image: "https://example.org/banner.png",
      },
      { id: "3", summary: "Only a summary" },
      { url: "https://example.org/4", title: "No id" },
      { title: "Nothing to know it by" },
    ],
  });

  it("reads a JSON Feed into the same fields as the others", () => {
    const read = readFeed(at("https://example.org/feed.json"), json);
    expect(read.unkeyed).toBe(1);
    expect(read.entries.map((entry) => entry.properties["entry_id"])).toEqual([
      "1",
      "2",
      "3",
      "https://example.org/4",
    ]);
    expect(read.entries[0]).toMatchObject({
      occurred_at: "2026-09-18T09:00:00.000Z",
      properties: {
        url: "https://example.org/1",
        title: "One & two",
        description: "Short.",
        body: `<p>Hello <img src="https://example.org/inline.png"/></p>`,
        author: "Item Author",
        published_at: "2026-09-18T09:00:00.000Z",
        image_url: "https://example.org/hero.png",
        source_url: "https://example.org/",
        source_title: "Example JSON",
        language: "fr",
      },
    });
    expect(read.entries[1]).toMatchObject({
      occurred_at: "2026-09-19T09:00:00.000Z",
      properties: {
        body: "Plain words",
        image_url: "https://example.org/banner.png",
        author: "Feed Author",
        language: "en",
      },
    });
    expect(read.entries[1]?.properties).not.toHaveProperty(
      "published_at",
      expect.anything(),
    );
    expect(read.entries[2]?.properties).toMatchObject({
      description: "Only a summary",
    });
    expect(read.entries[2]?.properties).not.toHaveProperty(
      "body",
      expect.anything(),
    );
    expect(read.entries[2]?.occurred_at).toBeUndefined();
  });

  it("counts a JSON Feed's entries against the cap, and its markup in strings against none", () => {
    const feed = (items: object[]): string =>
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "T",
        items,
      });
    expect(() =>
      readFeed(
        at("https://example.org/feed.json"),
        feed(
          Array.from({ length: maxFeedEntries + 1 }, (_, id) => ({
            id: String(id),
          })),
        ),
      ),
    ).toThrow(TooManyEntries);
    const read = readFeed(
      at("https://example.org/feed.json"),
      feed([
        { id: "1", content_html: "<i>x</i>".repeat(maxFeedElements) },
        ...Array.from({ length: maxFeedEntries - 1 }, (_, id) => ({
          id: `i${String(id)}`,
        })),
      ]),
    );
    expect(read.entries).toHaveLength(maxFeedEntries);
  });

  it("takes a JSON Feed's content picture where it names no image, and writes no link relative to where it was fetched", () => {
    const read = readFeed(
      at("https://example.org/private/token/feed.json"),
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "T",
        items: [
          {
            id: "1",
            content_html: `<img src="https://example.org/in.png"/>`,
            url: "post",
          },
        ],
      }),
    );
    expect(read.entries[0]?.properties).toMatchObject({
      image_url: "https://example.org/in.png",
    });
    expect(read.entries[0]?.properties).not.toHaveProperty(
      "url",
      expect.anything(),
    );
  });
});

describe("media:thumbnail", () => {
  const rss = (item: string): string =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title><link>https://example.org/</link><item><guid>a</guid>${item}</item></channel></rss>`;
  const image = (document: string): unknown =>
    readFeed(at("https://example.org/feed/rss.xml"), document).entries[0]
      ?.properties["image_url"];
  const thumbnail = `<media:thumbnail url="https://example.org/thumb.jpg" width="100" height="100"/>`;

  it("supplies the image where nothing else does", () => {
    expect(image(rss(thumbnail))).toBe("https://example.org/thumb.jpg");
  });

  it("comes after an enclosure, a content picture and a summary picture", () => {
    expect(
      image(
        rss(
          `${thumbnail}<enclosure url="https://example.org/enc.jpg" type="image/jpeg" length="1"/>`,
        ),
      ),
    ).toBe("https://example.org/enc.jpg");
    expect(
      image(
        rss(
          `${thumbnail}<content:encoded><![CDATA[<img src="https://example.org/content.jpg"/>]]></content:encoded>`,
        ),
      ),
    ).toBe("https://example.org/content.jpg");
    expect(
      image(
        rss(
          `${thumbnail}<description>&lt;img src="https://example.org/summary.jpg"/&gt;</description>`,
        ),
      ),
    ).toBe("https://example.org/summary.jpg");
  });

  it("is the first thumbnail that is usable, in the item, its media group or its media content", () => {
    const unusable = `<media:thumbnail url="https://example.org/pixel.gif" width="1" height="1"/><media:thumbnail url="data:image/gif;base64,R0lG"/><media:thumbnail url="relative.jpg"/>`;
    expect(image(rss(`${unusable}${thumbnail}`))).toBe(
      "https://example.org/thumb.jpg",
    );
    expect(
      image(
        rss(
          `<media:group><media:content url="https://example.org/v.mp4" medium="video">${thumbnail}</media:content></media:group>`,
        ),
      ),
    ).toBe("https://example.org/thumb.jpg");
    expect(image(rss(unusable))).toBeUndefined();
  });

  it("supplies an Atom entry's image too", () => {
    const entry = readFeed(
      at("https://example.com/atom.xml"),
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>T</title><id>f</id><entry><id>a</id><title>A</title>${thumbnail}</entry></feed>`,
    ).entries[0];
    expect(entry?.properties["image_url"]).toBe(
      "https://example.org/thumb.jpg",
    );
  });
});

describe("fetching a feed", () => {
  let server: Server;
  let base: string;
  let answer: (res: import("node:http").ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((_, res) => {
      answer(res);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  it("stops a compressed bomb at the cap, holding memory to a fraction of what it unpacks to", async () => {
    const unpacked = 1024 * 1024 * 1024;
    const bomb = await gzipBomb(unpacked);
    expect(bomb.byteLength).toBeLessThan(maxFeedBytes);
    answer = (res) => {
      res
        .writeHead(200, {
          "Content-Type": "application/xml",
          "Content-Encoding": "gzip",
        })
        .end(bomb);
    };
    const before = process.resourceUsage().maxRSS;
    await expect(
      getFeed(`${base}/bomb.xml`, {}, new Set(), AbortSignal.timeout(30_000)),
    ).rejects.toBeInstanceOf(TooLarge);
    const grewKiB = process.resourceUsage().maxRSS - before;
    expect(grewKiB * 1024).toBeLessThan(unpacked / 8);
  });

  it("stops a plain body past the cap, whether or not it declares its length", async () => {
    const big = Buffer.alloc(maxFeedBytes + 1, 0x20);
    for (const declared of [true, false]) {
      answer = (res) => {
        res.writeHead(200, {
          "Content-Type": "application/xml",
          ...(!declared && { "Transfer-Encoding": "chunked" }),
          ...(declared && { "Content-Length": String(big.byteLength) }),
        });
        res.end(big);
      };
      await expect(
        getFeed(`${base}/big.xml`, {}, new Set(), AbortSignal.timeout(30_000)),
      ).rejects.toBeInstanceOf(TooLarge);
    }
  });

  it("passes over quoted attribute values and counts declarations it does not know, so neither hides entries or elements from the count", () => {
    const rss = (items: string): string =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;
    const read = (text: string) => () =>
      readFeed(at("https://example.org/rss.xml"), text);
    for (const opener of ["<!--", "<![CDATA[", "<!DOCTYPE"]) {
      expect(
        read(
          rss(
            `<title a="${opener}">t</title><x b='${opener}'/>${"<item><title>a</title><guid>a</guid></item>".repeat(maxFeedEntries + 1)}`,
          ),
        ),
      ).toThrow(TooManyEntries);
    }
    expect(read(rss("<!a/>".repeat(maxFeedElements + 1)))).toThrow(
      TooManyElements,
    );
  });

  it("counts every element and every entry the parser would build, whatever their names' case, prefix or alphabet", () => {
    const rss = (items: string): string =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;
    const read = (text: string) => () =>
      readFeed(at("https://example.org/rss.xml"), text);
    expect(read(rss("<é/>".repeat(maxFeedElements)))).toThrow(TooManyElements);
    expect(read(rss("<_:x/>".repeat(maxFeedElements)))).toThrow(
      TooManyElements,
    );
    for (const item of ["ITEM", "Item", "rss:item", "x:ENTRY", "Entry"]) {
      expect(
        read(
          rss(`<${item}><title>a</title></${item}>`.repeat(maxFeedEntries + 1)),
        ),
      ).toThrow(TooManyEntries);
    }
    const upper = readFeed(
      at("https://example.org/rss.xml"),
      rss("<ITEM><TITLE>A</TITLE><GUID>a</GUID></ITEM>"),
    );
    expect(upper.entries).toHaveLength(1);
    expect(
      readFeed(
        at("https://example.org/rss.xml"),
        rss(
          `<!-- <item> --><![CDATA[x]]>${"<item><title>a</title><guid>a</guid></item>".repeat(maxFeedEntries)}`,
        ),
      ).entries,
    ).toHaveLength(maxFeedEntries);
  });

  it("refuses a feed with more entries or elements than the caps before parsing it, counting entries the parser would drop", () => {
    expect(() =>
      readFeed(
        at("https://example.org/rss.xml"),
        manyItems(maxFeedEntries + 1),
      ),
    ).toThrow(TooManyEntries);
    expect(() =>
      readFeed(
        at("https://example.org/rss.xml"),
        `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${"<item></item>".repeat(maxFeedEntries + 1)}</channel></rss>`,
      ),
    ).toThrow(TooManyEntries);
    expect(() =>
      readFeed(
        at("https://example.org/rss.xml"),
        `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>A</title><guid>a</guid>${"<x/>".repeat(maxFeedElements)}</item></channel></rss>`,
      ),
    ).toThrow(TooManyElements);
    expect(
      readFeed(at("https://example.org/rss.xml"), manyItems(maxFeedEntries))
        .entries,
    ).toHaveLength(maxFeedEntries);
  });

  it("takes an address on this machine or a private network for one, however an IPv6 address carries it", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "168.63.129.16",
      "100.100.100.200",
      "::1",
      "fd00:ec2::254",
      "fe80::1",
      "fec0::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:0:a9fe:a9fe",
      "::127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::5db8:d822",
      "2002:7f00:1::",
      "2002:a9fe:a9fe::1",
      "2001:0:5db8:d822:0:0:80ff:fffe",
    ]) {
      expect([address, isPrivate(address)]).toEqual([address, true]);
    }
    for (const address of [
      "93.184.216.34",
      "2606:4700::1111",
      "64:ff9b::5db8:d822",
      "2002:5db8:d822::1",
      "::ffff:93.184.216.34",
      "example.org",
    ]) {
      expect([address, isPrivate(address)]).toEqual([address, false]);
    }
  });

  /** Runs a read in a fresh process, whose high-water marks start clean,
   *  and answers how it ended and how much it grew. */
  async function measured(document: string): Promise<{
    outcome: string;
    rssMiB: number;
    heapMiB: number;
  }> {
    const { stdout } = await run(
      "node",
      [resolve(import.meta.dirname, "fixtures/measure.js"), document],
      { timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout) as {
      outcome: string;
      rssMiB: number;
      heapMiB: number;
    };
  }

  it("reads a feed in a worker whose heap limit, not the feed, bounds the memory it takes", async () => {
    const { outcome, rssMiB } = await measured("heavy");
    expect(outcome).toBe("TooHeavy");
    expect(rssMiB).toBeLessThan(450);
  }, 90_000);

  it("refuses a read whose entries come to more than the cap, which shared feed values multiply, without that copy reaching the connector", async () => {
    const { outcome, rssMiB, heapMiB } = await measured("shared");
    expect(outcome).toBe("TooBig");
    expect(heapMiB).toBeLessThan(64);
    expect(rssMiB).toBeLessThan(450);
  }, 90_000);

  it("gives up on a read that runs past its time limit", async () => {
    const { readBounded, TooSlow } = (await import(
      resolve(import.meta.dirname, "../dist/parse.js")
    )) as typeof import("../src/parse.js");
    await expect(
      readBounded(
        {
          feed: at("https://example.org/rss.xml"),
          bytes: new TextEncoder().encode(fixture("rss.xml")),
          contentType: null,
          documentUrl: "https://example.org/rss.xml",
        },
        AbortSignal.timeout(60_000),
        { timeoutMs: 1 },
      ),
    ).rejects.toBeInstanceOf(TooSlow);
  });

  it("reads nothing once the run is stopped, even when it stopped before the read began", async () => {
    const { readBounded } = (await import(
      resolve(import.meta.dirname, "../dist/parse.js")
    )) as typeof import("../src/parse.js");
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    await expect(
      readBounded(
        {
          feed: at("https://example.org/rss.xml"),
          bytes: new TextEncoder().encode(fixture("rss.xml")),
          contentType: null,
          documentUrl: "https://example.org/rss.xml",
        },
        stopped.signal,
      ),
    ).rejects.toThrow("stopped");
  });

  it("leaves out a field longer than Marfa takes, and keeps the rest of the entry", () => {
    const long = "x".repeat(maxFieldLength + 1);
    const read = readFeed(
      at("https://example.org/rss.xml"),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>${long}</title>
        <item><title>A</title><guid>a</guid><description>${long}</description></item>
        <item><title>B</title><guid>b</guid></item></channel></rss>`,
    );
    expect(read.entries.map((entry) => entry.properties["title"])).toEqual([
      "A",
      "B",
    ]);
    expect(
      read.entries.some(
        (entry) =>
          entry.properties["source_title"] !== undefined ||
          entry.properties["description"] !== undefined,
      ),
    ).toBe(false);
    expect(read.dropped).toBe(3);
  });
});

interface Served {
  body: string | Buffer;
  authorization?: string;
  redirect?: string;
  encoding?: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

describe("the connector, run as a process", () => {
  let marfa: ScriptedServer;
  let feeds: Server;
  let base: string;
  let served: Record<string, Served>;
  let asked: { path: string; headers: IncomingHttpHeaders; answered: number }[];

  beforeEach(async () => {
    marfa = await new ScriptedServer("rss", { types: ["rss.entry"] }).start();
    served = {
      "/atom.xml": { body: fixture("atom.xml"), etag: '"atom-1"' },
      "/rss.xml": {
        body: fixture("rss.xml"),
        lastModified: "Wed, 16 Sep 2026 09:00:00 GMT",
      },
    };
    asked = [];
    feeds = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://feeds.test").pathname;
      const feed = served[path];
      const answer = (
        status: number,
        headers: Record<string, string> = {},
        body: string | Buffer = "",
      ): void => {
        asked.push({ path, headers: req.headers, answered: status });
        res.writeHead(status, headers).end(body);
      };
      if (feed === undefined) {
        answer(404);
        return;
      }
      if (feed.redirect !== undefined) {
        answer(301, { Location: feed.redirect });
        return;
      }
      if (
        feed.authorization !== undefined &&
        req.headers.authorization !== feed.authorization
      ) {
        answer(401);
        return;
      }
      const unchanged =
        (feed.etag !== undefined &&
          req.headers["if-none-match"] === feed.etag) ||
        (feed.lastModified !== undefined &&
          req.headers["if-modified-since"] === feed.lastModified);
      if (unchanged) {
        answer(304);
        return;
      }
      answer(
        200,
        {
          "Content-Type": feed.contentType ?? "application/xml",
          ...(feed.encoding !== undefined && {
            "Content-Encoding": feed.encoding,
          }),
          ...(feed.etag !== undefined && { ETag: feed.etag }),
          ...(feed.lastModified !== undefined && {
            "Last-Modified": feed.lastModified,
          }),
        },
        feed.body,
      );
    });
    await new Promise<void>((done) => feeds.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${String((feeds.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await marfa.stop();
    feeds.closeAllConnections();
    await new Promise((done) => feeds.close(done));
  });

  async function once(
    paths = ["/atom.xml", "/rss.xml"],
    argv = ["--once"],
    feedList = paths.map((path) => `${base}${path}`).join("\n"),
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; output: string }> {
    try {
      const { stderr } = await run("node", [built, ...argv], {
        env: {
          PATH: process.env["PATH"],
          MARFA_API_URL: marfa.url,
          MARFA_API_KEY: marfa.key,
          RSS_FEEDS: feedList,
          ...env,
        },
        timeout: 15_000,
      });
      return { code: 0, output: stderr };
    } catch (error) {
      const failed = error as { code: number | null; stderr: string };
      return { code: failed.code, output: failed.stderr };
    }
  }

  function row(entryId: string) {
    const found = marfa.rows.find(
      (candidate) => candidate.properties["entry_id"] === entryId,
    );
    if (found === undefined) throw new Error(`no row for ${entryId}`);
    return found;
  }

  it("registers rss.entry as a kind of bookmark, and writes both feeds' entries at the feed tier", async () => {
    expect((await once()).code).toBe(0);
    const registered = marfa.types.get("rss.entry");
    expect(registered?.["parent"]).toBe("core.bookmark");
    expect(registered).not.toHaveProperty("compatible_with");
    expect(Object.keys(registered?.["fields"] as object)).toEqual([
      "entry_id",
      "feed_origin",
      "feed_hash",
    ]);
    expect(marfa.rows).toHaveLength(4);
    expect(marfa.rows.every((candidate) => candidate.tier === "feed")).toBe(
      true,
    );
    expect(row("tag:example.com,2026:entry:1").occurred_at).toBe(
      "2026-09-18T09:00:00.000Z",
    );
    expect(marfa.runs.at(-1)?.summary).toMatch(
      /^created 4, updated 0, archived 0, unchanged 0, skipped 0\. an entry in feed 2 in RSS_FEEDS \(http:\/\/127\.0\.0\.1:\d+\) has no id or link to be known by/,
    );
  });

  it("asks again with the validators each feed gave, and writes nothing on a 304", async () => {
    expect((await once()).code).toBe(0);
    expect((await once()).code).toBe(0);
    const second = asked.slice(2);
    expect(
      second.find((request) => request.path === "/atom.xml")?.headers[
        "if-none-match"
      ],
    ).toBe('"atom-1"');
    expect(
      second.find((request) => request.path === "/rss.xml")?.headers[
        "if-modified-since"
      ],
    ).toBe("Wed, 16 Sep 2026 09:00:00 GMT");
    expect(second.map((request) => request.answered)).toEqual([304, 304]);
    expect(marfa.runs.at(-1)?.summary?.split(". ")[0]).toBe(
      "created 0, updated 0, archived 0, unchanged 0, skipped 0",
    );
    expect(marfa.rows.every((candidate) => candidate.version === 1)).toBe(true);
  });

  it("moves exactly the entry that changed, and clears a summary the feed dropped", async () => {
    expect((await once()).code).toBe(0);
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    atom.body = atom.body
      .replace(
        "<title>First entry</title>",
        "<title>First entry, revised</title>",
      )
      .replace("<summary>The second summary.</summary>", "");
    atom.etag = '"atom-2"';
    expect((await once()).code).toBe(0);
    expect(row("tag:example.com,2026:entry:1").properties["title"]).toBe(
      "First entry, revised",
    );
    expect(row("tag:example.com,2026:entry:1").version).toBe(2);
    expect(row("tag:example.com,2026:entry:2").properties).not.toHaveProperty(
      "description",
    );
    expect(row("tag:example.com,2026:entry:2").version).toBe(2);
    expect(row("1").version).toBe(1);
    expect(marfa.runs.at(-1)?.summary?.split(". ")[0]).toBe(
      "created 0, updated 2, archived 0, unchanged 0, skipped 0",
    );
  });

  it("never removes an entry the feed no longer carries", async () => {
    expect((await once()).code).toBe(0);
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    atom.body = atom.body.replace(
      /<entry>\s*<title>Second entry[\s\S]*?<\/entry>/,
      "",
    );
    atom.etag = '"atom-3"';
    expect((await once()).code).toBe(0);
    expect(asked.map((request) => [request.path, request.answered])).toEqual([
      ["/atom.xml", 200],
      ["/rss.xml", 200],
      ["/atom.xml", 200],
      ["/rss.xml", 304],
    ]);
    expect(marfa.runs.at(-1)?.summary?.split(". ")[0]).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0",
    );
    expect(row("tag:example.com,2026:entry:2").state).toBe("active");
    expect(row("tag:example.com,2026:entry:2").version).toBe(1);
  });

  it("reports an entry left out on every run, across a 304 and the feed's next change", async () => {
    expect((await once(["/rss.xml"])).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain(
      "no id or link to be known by",
    );
    expect((await once(["/rss.xml"])).code).toBe(0);
    const rss = served["/rss.xml"];
    if (typeof rss?.body !== "string") throw new Error("no rss fixture");
    rss.body = rss.body.replace(
      "<title>Alpha</title>",
      "<title>Alpha, changed</title>",
    );
    rss.lastModified = "Thu, 17 Sep 2026 09:00:00 GMT";
    expect((await once(["/rss.xml"])).code).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([200, 304, 200]);
    expect(marfa.runs.map((run) => run.summary)).toEqual([
      expect.stringMatching(/^created \d+, .*no id or link to be known by/),
      expect.stringMatching(
        /^created 0, updated 0, archived 0, unchanged 0, skipped 0\. .*no id or link to be known by/,
      ),
      expect.stringMatching(
        /^created 0, updated 1, archived 0, unchanged 1, skipped 0\. .*no id or link to be known by/,
      ),
    ]);
  });

  it("keeps two feeds that declare one id apart, whichever is listed first, and says so", async () => {
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    served["/twin.xml"] = {
      body: atom.body
        .replace("<title>First entry</title>", "<title>Twin</title>")
        .replace("<title>Second entry</title>", "<title>Twin too</title>")
        .replaceAll("https://example.com/", "https://twin.example.net/"),
    };
    for (let run = 0; run < 2; run += 1) {
      expect((await once(["/twin.xml", "/atom.xml"])).code).toBe(0);
    }
    expect(marfa.rows).toHaveLength(4);
    const byFeed = (path: string): unknown[] =>
      marfa.rows
        .filter(
          (candidate) =>
            candidate.properties["feed_hash"] === feedKey(`${base}${path}`),
        )
        .map((candidate) => candidate.properties["title"]);
    expect(byFeed("/atom.xml")).toEqual(["First entry", "Second entry"]);
    expect(byFeed("/twin.xml")).toEqual(["Twin", "Twin too"]);
    expect(marfa.rows.every((candidate) => candidate.version === 1)).toBe(true);
    expect(marfa.runs[0]?.summary).toContain(
      `feed 2 in RSS_FEEDS (${base}) declares the same feed id as feed 1 in RSS_FEEDS (${base}), and each keeps its own entries`,
    );
  });

  it("keeps a token in a feed's query out of the rows and the kept state", async () => {
    expect((await once(["/rss.xml?token=s3cr3t-token"])).code).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([200]);
    expect(marfa.rows).toHaveLength(2);
    expect(JSON.stringify(marfa.rows)).not.toContain("s3cr3t");
    const stored = JSON.stringify(marfa.states.get("rss") ?? {});
    expect(stored).toContain("last_modified");
    expect(stored).not.toContain("s3cr3t");
  });

  it("names a private feed by its place in the list and its origin, and its path reaches no row, log line, condition, report or state", async () => {
    const token = "s3cr3t-path-token";
    served[`/private/${token}/feed.xml`] = { body: fixture("rss.xml") };
    served[`/private/${token}/page.html`] = {
      body: "<html><body>not a feed</body></html>",
    };
    const paths = [
      `/private/${token}/feed.xml`,
      `/private/${token}/gone.xml`,
      `/private/${token}/page.html`,
    ];
    const closed = `http://127.0.0.1:1/private/${token}/feed.xml`;
    const { code, output } = await once(
      paths,
      ["--once"],
      [...paths.map((path) => `${base}${path}`), closed].join("\n"),
    );
    expect(code).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([200, 404, 200]);
    expect(marfa.rows).toHaveLength(2);
    const reported = JSON.stringify(marfa.runs);
    const stored = JSON.stringify([
      marfa.states.get("rss") ?? {},
      ...marfa.agreements.values(),
    ]);
    for (const text of [JSON.stringify(marfa.rows), output, reported, stored]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("/private/");
    }
    const hash = feedKey(`${base}${paths[0] ?? ""}`);
    expect(marfa.rows[0]?.properties).toMatchObject({
      feed_origin: base,
      feed_hash: hash,
    });
    expect(reported).toContain(`an entry in feed 1 in RSS_FEEDS (${base})`);
    expect(reported).toContain(`feed 2 in RSS_FEEDS (${base}) answered 404`);
    expect(reported).toContain(
      `feed 3 in RSS_FEEDS (${base}) is not an Atom, RSS or JSON feed`,
    );
    expect(reported).toContain(
      "feed 4 in RSS_FEEDS (http://127.0.0.1:1) could not be fetched: its server refused the connection (ECONNREFUSED)",
    );
    expect(stored).toContain(`unkeyed:${hash}`);
  });

  it("keeps the feed list out of a failed run's report, as a secret", async () => {
    const address = `${base}/private/s3cr3t-path-token/feed.xml`;
    served["/private/s3cr3t-path-token/feed.xml"] = {
      body: fixture("rss.xml"),
    };
    marfa.refuseNext(
      "POST /items/bulk",
      500,
      "internal",
      `the write failed for ${address}`,
    );
    const { code, output } = await once([], ["--once"], address);
    expect(code).toBe(1);
    const error = marfa.runs.at(-1)?.error ?? "";
    expect(error).toContain("the write failed for [redacted]");
    for (const text of [error, output]) {
      expect(text).not.toContain("s3cr3t-path-token");
    }
  });

  it("refuses a feed list it cannot read at start, under --every as under --once", async () => {
    const bad = `${base}/atom.xml ftp://feeds.example.com/private/f7p-t0ken`;
    for (const argv of [["--once"], ["--every", "1m"]]) {
      const { code, output } = await once([], argv, bad);
      expect(code).toBe(2);
      expect(output).toContain(
        "RSS_FEEDS holds an entry that is not an http or https address",
      );
      expect(output).not.toContain("f7p-t0ken");
    }
    expect(marfa.requests).toEqual([]);
    expect((await once(["/atom.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(2);
  });

  it("follows a redirect, and writes no link relative to the address it reached", async () => {
    served["/old/feed"] = { body: "", redirect: "/new/blog/feed" };
    served["/new/blog/feed"] = {
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>/</link>
        <item><title>A</title><guid>a</guid><link>post-a</link></item>
        <item><title>B</title><guid>b</guid><link>/posts/b</link></item>
      </channel></rss>`,
    };
    expect((await once(["/old/feed"])).code).toBe(0);
    expect(asked.map((request) => [request.path, request.answered])).toEqual([
      ["/old/feed", 301],
      ["/new/blog/feed", 200],
    ]);
    expect(row("a").properties).not.toHaveProperty("url");
    expect(row("b").properties).toMatchObject({
      url: `${base}/posts/b`,
      source_url: `${base}/`,
      feed_origin: base,
      feed_hash: feedKey(`${base}/old/feed`),
    });
    expect(JSON.stringify(marfa.rows)).not.toContain("/new/blog");
  });

  it("fetches a feed whose address carries credentials, sending them as Basic authorization", async () => {
    served["/basic.xml"] = {
      body: fixture("rss.xml"),
      authorization: `Basic ${Buffer.from("reader:p@ss-w0rd").toString("base64")}`,
    };
    const address = `${base.replace("http://", "http://reader:p%40ss-w0rd@")}/basic.xml`;
    const { code, output } = await once([], ["--once"], address);
    expect(code).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([200]);
    expect(marfa.rows).toHaveLength(2);
    const reported = JSON.stringify(marfa.runs);
    for (const text of [JSON.stringify(marfa.rows), output, reported]) {
      expect(text).not.toMatch(/p@ss|p%40ss|reader/);
    }
    expect(marfa.rows[0]?.properties["feed_origin"]).toBe(base);
  });

  it("reads a feed in the charset its server names", async () => {
    served["/latin.xml"] = {
      body: Buffer.from(
        '<?xml version="1.0"?><rss version="2.0"><channel><title>Café</title><link>https://example.org/</link>' +
          "<item><title>Résumé</title><guid>r</guid></item></channel></rss>",
        "latin1",
      ),
      contentType: "application/rss+xml; charset=ISO-8859-1",
    };
    expect((await once(["/latin.xml"])).code).toBe(0);
    expect(row("r").properties).toMatchObject({
      title: "Résumé",
      source_title: "Café",
    });
  });

  it("reads the other feeds when some fail, and names each failing one and why on every run it fails", async () => {
    const list = [
      `${base}/atom.xml`,
      `${base}/gone.xml`,
      "http://127.0.0.1:1/private/feed.xml",
    ].join("\n");
    for (let run = 1; run <= 3; run += 1) {
      const { code, output } = await once([], ["--once"], list);
      expect(code).toBe(0);
      expect(marfa.runs).toHaveLength(run);
      const last = marfa.runs.at(-1);
      expect(last?.outcome).toBe("succeeded");
      for (const text of [last?.summary ?? "", output]) {
        expect(text).toContain(`feed 2 in RSS_FEEDS (${base}) answered 404`);
        expect(text).toContain(
          "feed 3 in RSS_FEEDS (http://127.0.0.1:1) could not be fetched: its server refused the connection (ECONNREFUSED)",
        );
        expect(text).not.toContain("gone.xml");
        expect(text).not.toContain("/private/");
      }
    }
    expect(marfa.rows).toHaveLength(2);
  });

  it("fails a run in which every feed failed, naming each", async () => {
    const list = [`${base}/gone.xml`, "http://127.0.0.1:1/feed.xml"].join("\n");
    const { code, output } = await once([], ["--once"], list);
    expect(code).toBe(1);
    const last = marfa.runs.at(-1);
    expect(last?.outcome).toBe("failed");
    expect(last?.error).toContain(
      "none of the 2 feeds in RSS_FEEDS could be read, so this run read nothing",
    );
    expect(last?.summary).toContain(
      `feed 1 in RSS_FEEDS (${base}) answered 404`,
    );
    expect(last?.summary).toContain(
      "feed 2 in RSS_FEEDS (http://127.0.0.1:1) could not be fetched: its server refused the connection (ECONNREFUSED)",
    );
    expect(output).toContain("run failed");
    expect((await once(["/gone.xml"])).code).toBe(1);
    expect(marfa.runs.at(-1)?.error).toContain(
      "the feed in RSS_FEEDS could not be read, so this run read nothing",
    );
  });

  it("asks a feed whose entries did not land again whole", async () => {
    const entryKey =
      readFeed(at(`${base}/atom.xml`), fixture("atom.xml")).entries[0]
        ?.source_id ?? "";
    marfa.entryRefusals.set(entryKey, {
      status: 400,
      code: "invalid_properties",
      message: "too long",
    });
    expect((await once(["/atom.xml"])).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain("the server refused");
    marfa.entryRefusals.delete(entryKey);
    expect((await once(["/atom.xml"])).code).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([200, 200]);
    expect(asked[0]?.path).toBe("/atom.xml");
    expect(asked[1]?.headers["if-none-match"]).toBeUndefined();
    expect(marfa.rows).toHaveLength(2);
  });

  const progress = (
    marfa: ScriptedServer,
  ): Record<string, { validators?: object; key?: string }> =>
    (marfa.connectorState?.["state"] as { feeds: never }).feeds;

  it("keeps the other feed's reading progress when one feed has an entry Marfa refuses, and asks the refused feed again", async () => {
    const entryKey =
      readFeed(at(`${base}/atom.xml`), fixture("atom.xml")).entries[0]
        ?.source_id ?? "";
    marfa.entryRefusals.set(entryKey, {
      status: 400,
      code: "invalid_properties",
      message: "too long",
    });
    expect((await once()).code).toBe(0);
    expect(progress(marfa)[feedKey(`${base}/rss.xml`)]?.validators).toEqual({
      last_modified: "Wed, 16 Sep 2026 09:00:00 GMT",
    });
    expect(progress(marfa)[feedKey(`${base}/atom.xml`)]).toBeUndefined();
    expect((await once()).code).toBe(0);
    expect(
      asked.slice(2).map((request) => [request.path, request.answered]),
    ).toEqual([
      ["/atom.xml", 200],
      ["/rss.xml", 304],
    ]);
    expect(asked[2]?.headers["if-none-match"]).toBeUndefined();
    expect(marfa.rows).toHaveLength(3);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `feed 1 in RSS_FEEDS (${base}) is read again next run, since its reading progress was not saved (row-refused)`,
    );
    marfa.entryRefusals.delete(entryKey);
    expect((await once()).code).toBe(0);
    expect(marfa.rows).toHaveLength(4);
    expect((await once()).code).toBe(0);
    expect(
      asked.slice(6).map((request) => [request.path, request.answered]),
    ).toEqual([
      ["/atom.xml", 304],
      ["/rss.xml", 304],
    ]);
  });

  it("keeps a refused feed's earlier validators while the other feed's move on, so it is asked again until its entry lands", async () => {
    expect((await once()).code).toBe(0);
    const atom = served["/atom.xml"];
    const rss = served["/rss.xml"];
    if (typeof atom?.body !== "string" || typeof rss?.body !== "string") {
      throw new Error("no fixtures");
    }
    atom.body = atom.body.replace(
      "<title>First entry</title>",
      "<title>First entry, revised</title>",
    );
    atom.etag = '"atom-2"';
    rss.body = rss.body.replace(
      "<title>Alpha</title>",
      "<title>Alpha, changed</title>",
    );
    rss.lastModified = "Thu, 17 Sep 2026 09:00:00 GMT";
    for (let refused = 0; refused < 2; refused += 1) {
      marfa.refuseNext(
        `PATCH /items/${row("tag:example.com,2026:entry:1").id}`,
        400,
        "invalid_properties",
        "too long",
      );
    }
    expect((await once()).code).toBe(0);
    expect(progress(marfa)[feedKey(`${base}/atom.xml`)]?.validators).toEqual({
      etag: '"atom-1"',
    });
    expect(progress(marfa)[feedKey(`${base}/rss.xml`)]?.validators).toEqual({
      last_modified: "Thu, 17 Sep 2026 09:00:00 GMT",
    });
    expect((await once()).code).toBe(0);
    expect(
      asked.slice(4).map((request) => [request.path, request.answered]),
    ).toEqual([
      ["/atom.xml", 200],
      ["/rss.xml", 304],
    ]);
    expect(asked[4]?.headers["if-none-match"]).toBe('"atom-1"');
    expect(row("tag:example.com,2026:entry:1").properties["title"]).toBe(
      "First entry",
    );
    expect((await once()).code).toBe(0);
    expect(row("tag:example.com,2026:entry:1").properties["title"]).toBe(
      "First entry, revised",
    );
    expect((await once()).code).toBe(0);
    expect(asked.slice(8).map((request) => request.answered)).toEqual([
      304, 304,
    ]);
    expect(asked[8]?.headers["if-none-match"]).toBe('"atom-2"');
  });

  it("skips a feed past the size cap, plain or compressed, naming it, and reads the others", async () => {
    served["/bomb.xml"] = {
      body: await gzipBomb(64 * 1024 * 1024),
      encoding: "gzip",
    };
    served["/big.xml"] = { body: Buffer.alloc(maxFeedBytes + 1, 0x20) };
    expect((await once(["/bomb.xml", "/rss.xml", "/big.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(2);
    const summary = marfa.runs.at(-1)?.summary ?? "";
    for (const position of [1, 3]) {
      expect(summary).toContain(
        `feed ${String(position)} in RSS_FEEDS (${base}) is larger than 24 MiB, so it is skipped`,
      );
    }
  });

  it("skips a feed with more entries than the cap, naming it, and reads the others", async () => {
    served["/many.xml"] = { body: manyItems(maxFeedEntries + 1) };
    expect((await once(["/rss.xml", "/many.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `feed 2 in RSS_FEEDS (${base}) carries more than 5000 entries, so it is skipped`,
    );
  });

  it("refuses a redirect to this machine or a private network, by address, by an IPv6 form carrying one or by a name resolved to it", async () => {
    const port = new URL(base).port;
    const targets = [
      `http://localhost:${port}/rss.xml`,
      `http://[::1]:${port}/rss.xml`,
      `http://[::ffff:127.0.0.1]:${port}/rss.xml`,
      `http://[64:ff9b::7f00:1]:${port}/rss.xml`,
      "http://169.254.169.254/latest/",
    ];
    targets.forEach((target, at) => {
      served[`/to/${String(at)}`] = { body: "", redirect: target };
    });
    const { code } = await once(targets.map((_, at) => `/to/${String(at)}`));
    expect(code).toBe(1);
    expect(marfa.rows).toHaveLength(0);
    expect(asked.map((request) => request.path)).toEqual(
      targets.map((_, at) => `/to/${String(at)}`),
    );
    const summary = marfa.runs.at(-1)?.summary ?? "";
    targets.forEach((_, at) => {
      expect(summary).toContain(
        `feed ${String(at + 1)} in RSS_FEEDS (${base}) redirected to an address on this machine or a private network, which is not followed`,
      );
    });
  });

  it("reads a feed whose host resolves to this machine only when RSS_PRIVATE_HOSTS names it, and follows its redirects there", async () => {
    const port = new URL(base).port;
    served["/via-name"] = {
      body: "",
      redirect: `http://localhost:${port}/rss.xml`,
    };
    const listed = `http://localhost:${port}/via-name`;
    expect((await once([], ["--once"], listed)).code).toBe(1);
    expect(asked).toHaveLength(0);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `feed 1 in RSS_FEEDS (http://localhost:${port}) is on this machine or a private network, which is read only when RSS_PRIVATE_HOSTS names its host`,
    );
    expect(
      (
        await once([], ["--once"], listed, {
          RSS_PRIVATE_HOSTS: "nas.example LOCALHOST",
        })
      ).code,
    ).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([301, 200]);
    expect(marfa.rows).toHaveLength(2);
  });

  it("lets a host named in RSS_PRIVATE_HOSTS through only for the feed listed at it, never as another feed's redirect", async () => {
    const port = new URL(base).port;
    served["/onto-named"] = {
      body: "",
      redirect: `http://localhost:${port}/rss.xml`,
    };
    expect(
      (
        await once(
          [],
          ["--once"],
          `${base}/onto-named\nhttp://localhost.:${port}/atom.xml`,
          { RSS_PRIVATE_HOSTS: "localhost" },
        )
      ).code,
    ).toBe(0);
    expect(asked.map((request) => [request.path, request.answered])).toEqual([
      ["/onto-named", 301],
      ["/atom.xml", 200],
    ]);
    expect(marfa.rows).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `feed 1 in RSS_FEEDS (${base}) redirected to an address on this machine or a private network, which is not followed`,
    );
  });

  it("stops following a feed's redirects after five", async () => {
    for (let hop = 0; hop < 7; hop += 1) {
      served[`/hop/${String(hop)}`] = {
        body: "",
        redirect: `/hop/${String(hop + 1)}`,
      };
    }
    served["/hop/7"] = { body: fixture("rss.xml") };
    expect((await once(["/hop/0"])).code).toBe(1);
    expect(asked).toHaveLength(6);
    expect(marfa.rows).toHaveLength(0);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `feed 1 in RSS_FEEDS (${base}) redirected more than 5 times, so it is skipped`,
    );
  });

  it("sends a listed address's credentials to its own origin alone", async () => {
    const seen: (string | undefined)[] = [];
    const other = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res
        .writeHead(200, { "Content-Type": "application/xml" })
        .end(fixture("rss.xml"));
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    try {
      const elsewhere = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}/feed.xml`;
      served["/basic-hop"] = { body: "", redirect: elsewhere };
      const address = `${base.replace("http://", "http://reader:s3cr3t-pass@")}/basic-hop`;
      expect((await once([], ["--once"], address)).code).toBe(0);
      expect(asked[0]?.headers.authorization).toBe(
        `Basic ${Buffer.from("reader:s3cr3t-pass").toString("base64")}`,
      );
      expect(seen).toEqual([undefined]);
      expect(marfa.rows).toHaveLength(2);
    } finally {
      other.closeAllConnections();
      await new Promise((done) => other.close(done));
    }
  });

  it("keeps a named feed's entries when its address moves or its token rotates", async () => {
    served["/moved.xml"] = { body: fixture("rss.xml") };
    expect(
      (await once([], ["--once"], `news=${base}/rss.xml?token=t1`)).code,
    ).toBe(0);
    const before = new Map(
      marfa.rows.map((candidate) => [candidate.source_id, candidate.id]),
    );
    expect(before.size).toBe(2);
    expect(
      (await once([], ["--once"], `news=${base}/rss.xml?token=t2`)).code,
    ).toBe(0);
    expect(
      (await once([], ["--once"], `news=${base}/moved.xml?token=t3`)).code,
    ).toBe(0);
    expect(
      new Map(
        marfa.rows.map((candidate) => [candidate.source_id, candidate.id]),
      ),
    ).toEqual(before);
    expect(row("https://example.org/beta").properties["feed_hash"]).toBe(
      feedKey(`${base}/rss.xml`, "news"),
    );
    expect(asked.map((request) => request.answered)).toEqual([200, 200, 200]);
  });

  it("moves a feed's rows to its key when it is first named, or renamed, rather than writing them twice", async () => {
    expect((await once(["/atom.xml"])).code).toBe(0);
    const ids = marfa.rows.map((candidate) => candidate.id);
    expect((await once([], ["--once"], `blog=${base}/atom.xml`)).code).toBe(0);
    expect(marfa.rows.map((candidate) => candidate.id)).toEqual(ids);
    expect(
      marfa.rows.every((candidate) =>
        candidate.source_id?.startsWith(
          `${feedKey(`${base}/atom.xml`, "blog")}:`,
        ),
      ),
    ).toBe(true);
    expect((await once([], ["--once"], `journal=${base}/atom.xml`)).code).toBe(
      0,
    );
    expect(marfa.rows.map((candidate) => candidate.id)).toEqual(ids);
    expect(
      marfa.rows.map((candidate) => candidate.properties["feed_hash"]),
    ).toEqual([
      feedKey(`${base}/atom.xml`, "journal"),
      feedKey(`${base}/atom.xml`, "journal"),
    ]);
    expect((await once([], ["--once"], `journal=${base}/atom.xml`)).code).toBe(
      0,
    );
    expect(asked.at(-1)?.answered).toBe(304);
  });

  it("saves a feed's move to its name even when a later feed in the run has an entry Marfa refuses", async () => {
    expect((await once()).code).toBe(0);
    const ids = marfa.rows.map((candidate) => candidate.id);
    const rss = served["/rss.xml"];
    if (typeof rss?.body !== "string") throw new Error("no rss fixture");
    rss.body = rss.body.replace(
      "<title>Alpha</title>",
      "<title>Alpha, changed</title>",
    );
    rss.lastModified = "Thu, 17 Sep 2026 09:00:00 GMT";
    marfa.refuseNext(
      `PATCH /items/${row("1").id}`,
      400,
      "invalid_properties",
      "too long",
    );
    const listed = `blog=${base}/atom.xml\n${base}/rss.xml`;
    expect((await once([], ["--once"], listed)).code).toBe(0);
    expect(Object.keys(progress(marfa)).sort()).toEqual(
      [feedKey(`${base}/atom.xml`, "blog"), feedKey(`${base}/rss.xml`)].sort(),
    );
    expect((await once([], ["--once"], listed)).code).toBe(0);
    expect(marfa.rows.map((candidate) => candidate.id)).toEqual(ids);
    expect(row("1").properties["title"]).toBe("Alpha, changed");
    expect(marfa.runs.at(-1)?.summary).not.toContain("share their key");
    expect(
      Object.values(progress(marfa)).every(
        (feed) => (feed as { shared?: string[] }).shared === undefined,
      ),
    ).toBe(true);
  });

  it("moves rows an Atom feed's declared id keyed to its listed address's key", async () => {
    expect((await once(["/atom.xml"])).code).toBe(0);
    const address = feedKey(`${base}/atom.xml`);
    const declared = createHash("sha256")
      .update("feed-id:tag:example.com,2026:feed")
      .digest("hex")
      .slice(0, 32);
    for (const candidate of marfa.rows) {
      candidate.source_id = candidate.source_id?.replace(address, declared);
    }
    const kept = marfa.states.get("rss") as {
      state: { feeds: Record<string, Record<string, unknown>> };
    };
    kept.state.feeds = {
      [address]: {
        validators: { etag: '"atom-1"' },
        key: declared,
      },
    };
    const ids = marfa.rows.map((candidate) => candidate.id);
    expect((await once(["/atom.xml"])).code).toBe(0);
    expect(asked.at(-1)?.answered).toBe(200);
    expect(marfa.rows.map((candidate) => candidate.id)).toEqual(ids);
    expect(
      marfa.rows.map((candidate) => candidate.source_id?.split(":")[0]),
    ).toEqual([address, address]);
  });

  it("brings back no entry a person trashed or purged before the feed was renamed, however often it is read after", async () => {
    expect((await once([], ["--once"], `blog=${base}/atom.xml`)).code).toBe(0);
    const first = row("tag:example.com,2026:entry:1");
    const second = row("tag:example.com,2026:entry:2");
    marfa.trash(first.id);
    marfa.trash(second.id);
    marfa.purgeById(second.id);
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    for (const [run, name] of ["journal", "journal", "notes"].entries()) {
      atom.body = atom.body.replace("</feed>", "<!-- changed --></feed>");
      atom.etag = `"atom-run-${String(run)}"`;
      expect(
        (await once([], ["--once"], `${name}=${base}/atom.xml`)).code,
      ).toBe(0);
    }
    expect(asked.map((request) => request.answered)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(
      marfa.rows.filter((candidate) => candidate.state === "active"),
    ).toEqual([]);
    expect(marfa.rows).toHaveLength(1);
  });

  it("moves no row from an earlier key two saved feeds held, and says so", async () => {
    served["/other.xml"] = { body: fixture("atom.xml") };
    expect((await once(["/atom.xml", "/other.xml"])).code).toBe(0);
    const atomKey = feedKey(`${base}/atom.xml`);
    const otherKey = feedKey(`${base}/other.xml`);
    const declared = createHash("sha256")
      .update("feed-id:tag:example.com,2026:feed")
      .digest("hex")
      .slice(0, 32);
    for (const candidate of marfa.rows.filter((r) =>
      r.source_id?.startsWith(atomKey),
    )) {
      candidate.source_id = candidate.source_id?.replace(atomKey, declared);
    }
    // Match the server's agreement cascade when removing fixture rows.
    for (const row of marfa.rows.filter((r) =>
      r.source_id?.startsWith(otherKey),
    )) {
      marfa.agreements.delete(row.id);
    }
    marfa.rows = marfa.rows.filter((r) => !r.source_id?.startsWith(otherKey));
    const kept = marfa.states.get("rss") as {
      state: { feeds: Record<string, Record<string, unknown>> };
    };
    kept.state.feeds = {
      [otherKey]: { key: declared },
      [atomKey]: { key: declared },
    };
    const old = marfa.rows.map((candidate) => [
      candidate.id,
      candidate.source_id,
    ]);
    const result = await once(["/other.xml", "/atom.xml"]);
    expect(result.code, result.output).toBe(0);
    expect(
      old.every(([id, key]) =>
        marfa.rows.some((r) => r.id === id && r.source_id === key),
      ),
    ).toBe(true);
    expect(marfa.rows).toHaveLength(6);
    const summary = marfa.runs.at(-1)?.summary ?? "";
    for (const position of [1, 2]) {
      expect(summary).toContain(
        `rows written for feed ${String(position)} in RSS_FEEDS (${base}) before share their key with another feed's, so they are left as they are and its entries are written anew`,
      );
    }
  });

  it("keeps a feed's earlier keys while it is out of the list, so an entry trashed before it left stays out when it returns", async () => {
    expect((await once([], ["--once"], `blog=${base}/atom.xml`)).code).toBe(0);
    marfa.trash(row("tag:example.com,2026:entry:1").id);
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    const runs = [
      `journal=${base}/atom.xml`,
      `${base}/rss.xml`,
      `journal=${base}/atom.xml`,
    ];
    for (const [run, list] of runs.entries()) {
      atom.body = atom.body.replace("</feed>", "<!-- changed --></feed>");
      atom.etag = `"atom-away-${String(run)}"`;
      expect((await once([], ["--once"], list)).code).toBe(0);
    }
    const entries = marfa.rows.filter((candidate) =>
      String(candidate.properties["entry_id"]).startsWith("tag:example.com"),
    );
    expect(entries.map((candidate) => candidate.state).sort()).toEqual([
      "active",
      "trashed",
    ]);
  });

  it("never moves a row from a key another listed feed now owns", async () => {
    expect((await once([], ["--once"], `first=${base}/atom.xml`)).code).toBe(0);
    expect((await once([], ["--once"], `second=${base}/atom.xml`)).code).toBe(
      0,
    );
    const second = feedKey(`${base}/atom.xml`, "second");
    const gone = marfa.rows.find(
      (candidate) =>
        candidate.source_id === `${second}:tag:example.com,2026:entry:2`,
    );
    if (gone === undefined) throw new Error("no second row");
    marfa.trash(gone.id);
    marfa.purgeById(gone.id);
    served["/other.xml"] = { body: fixture("atom.xml") };
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    atom.body = atom.body.replace("</feed>", "<!-- changed --></feed>");
    atom.etag = '"atom-shared"';
    expect(
      (
        await once(
          [],
          ["--once"],
          `first=${base}/other.xml second=${base}/atom.xml`,
        )
      ).code,
    ).toBe(0);
    const first = feedKey(`${base}/other.xml`, "first");
    expect(
      marfa.rows
        .filter((candidate) => candidate.source_id?.startsWith(`${first}:`))
        .map((candidate) => candidate.state),
    ).toEqual(["active", "active"]);
    expect(
      marfa.rows.filter((candidate) =>
        candidate.source_id?.startsWith(`${second}:`),
      ),
    ).toHaveLength(1);
  });

  it("skips a feed that needs more memory to read than the cap, naming it, and reads the others", async () => {
    served["/heavy.xml"] = { body: heavyFeed(20 * 1024 * 1024) };
    expect((await once(["/heavy.xml", "/rss.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `feed 1 in RSS_FEEDS (${base}) needs more than 192 MB to read, so it is skipped`,
    );
  }, 30_000);

  it("finds a feed that left the list again by its key alone, not by its address", async () => {
    expect((await once([], ["--once"], `work=${base}/atom.xml`)).code).toBe(0);
    expect((await once(["/rss.xml"])).code).toBe(0);
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    atom.body = atom.body.replace("</feed>", "<!-- changed --></feed>");
    atom.etag = '"atom-other-account"';
    expect((await once(["/atom.xml"])).code).toBe(0);
    const work = feedKey(`${base}/atom.xml`, "work");
    const plain = feedKey(`${base}/atom.xml`);
    const keys = marfa.rows
      .filter((candidate) =>
        String(candidate.properties["entry_id"]).startsWith("tag:example.com"),
      )
      .map((candidate) => candidate.source_id?.split(":")[0])
      .sort();
    expect(keys).toEqual([work, work, plain, plain].sort());
  });

  it("forgets when a feed left once it returns, read or not", async () => {
    expect((await once([], ["--once"], `work=${base}/atom.xml`)).code).toBe(0);
    expect((await once(["/rss.xml"])).code).toBe(0);
    const kept = (): Record<string, Record<string, unknown>> =>
      (
        marfa.states.get("rss") as {
          state: { feeds: Record<string, Record<string, unknown>> };
        }
      ).state.feeds;
    const work = feedKey(`${base}/atom.xml`, "work");
    expect(kept()[work]?.["left"]).toEqual(expect.any(String));
    Reflect.deleteProperty(served, "/atom.xml");
    expect(
      (await once([], ["--once"], `work=${base}/atom.xml\n${base}/rss.xml`))
        .code,
    ).toBe(0);
    expect(asked.at(-2)?.answered).toBe(404);
    expect(kept()[work]).not.toHaveProperty("left");
  });

  it("keeps no validator longer than 1 KiB, and asks without it", async () => {
    served["/long.xml"] = {
      body: fixture("rss.xml"),
      etag: `"${"e".repeat(2000)}"`,
    };
    expect((await once(["/long.xml"])).code).toBe(0);
    expect((await once(["/long.xml"])).code).toBe(0);
    expect(JSON.stringify(marfa.states.get("rss"))).not.toContain("eeee");
    expect(asked[1]?.headers["if-none-match"]).toBeUndefined();
    expect(asked.map((request) => request.answered)).toEqual([200, 200]);
  });

  it("writes the entries of a feed whose shared title is longer than Marfa takes, without it, and says so", async () => {
    served["/long-title.xml"] = {
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>${"x".repeat(maxFieldLength + 1)}</title><item><title>a</title><guid>a</guid></item><item><title>b</title><guid>b</guid></item></channel></rss>`,
    };
    expect((await once(["/long-title.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toContain(
      `2 values in feed 1 in RSS_FEEDS (${base}) are longer than 100000 characters, and are left out`,
    );
  });

  it("dates an entry with no date by when it was first stored, and moves that date for no later read", async () => {
    served["/undated.xml"] = {
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
        <item><guid>u</guid><title>Undated</title><description>Plain.</description></item></channel></rss>`,
      etag: '"u-1"',
    };
    expect((await once(["/undated.xml"])).code).toBe(0);
    const first = row("u");
    expect(first.occurred_at).toBe(first.created_at);
    const undated = served["/undated.xml"];
    if (typeof undated.body !== "string") throw new Error("no feed");
    undated.body = undated.body.replace("Undated", "Undated, revised");
    undated.etag = '"u-2"';
    await new Promise((later) => setTimeout(later, 20));
    expect((await once(["/undated.xml"])).code).toBe(0);
    const second = row("u");
    expect(second.properties["title"]).toBe("Undated, revised");
    expect(second.version).toBe(2);
    expect(second.occurred_at).toBe(first.occurred_at);
  });

  it("sends the owner of a key that is too wide to the connector's own README, which exists", async () => {
    marfa.grants = {
      permissions: ["keys.mint"],
      type_permissions: { "rss.entry": "write" },
      metadata_permissions: { types: "write" },
    };
    const { code } = await once();
    expect(code).toBe(1);
    const error = marfa.runs.at(-1)?.error ?? "";
    expect(error).toContain("as connectors/rss/README.md says");
    expect(error).not.toContain("template's README");
    expect(
      readFileSync(
        resolve(import.meta.dirname, "../../..", "connectors/rss/README.md"),
        "utf8",
      ),
    ).toContain("marfa keys create");
  });
});
