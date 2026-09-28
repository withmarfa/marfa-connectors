import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  canonicalFeedUrl,
  decodeFeed,
  feedKey,
  feedList,
  readFeed,
} from "../src/feeds.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");

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
    expect(feedKey("https://reader:pass@example.org/rss.xml", undefined)).toBe(
      feedKey("https://reader:rotated@example.org/rss.xml", undefined),
    );
    expect(canonicalFeedUrl("https://example.org:8443/rss.xml")).toBe(
      "example.org:8443/rss.xml",
    );
    expect(canonicalFeedUrl("https://example.org/rss.xml?page=2")).toBe(
      "example.org/rss.xml?page=2",
    );
  });

  it("hashes an Atom id with colons to one fixed shape, apart from any address", () => {
    const byId = feedKey(
      "https://example.com/atom.xml",
      "tag:example.com,2026:feed",
    );
    expect(byId).toMatch(/^[0-9a-f]{32}$/);
    expect(byId).toBe(
      feedKey(
        "https://elsewhere.example.net/moved.xml",
        "tag:example.com,2026:feed",
      ),
    );
    expect(byId).not.toBe(feedKey("tag:example.com,2026:feed", undefined));
    expect(feedKey("https://example.com/a.xml", "tag:x:2")).not.toBe(
      feedKey("https://example.com/a.xml", "tag:x"),
    );
  });

  it("keys a feed by its Atom id apart from its address, where the two read alike", () => {
    const address = "https://example.com/feed.xml";
    const id = canonicalFeedUrl(address);
    expect(id).toBe("example.com/feed.xml");
    expect(feedKey(address, id)).not.toBe(feedKey(address, undefined));
  });

  it("keys two feeds' bare guid of 1 apart", () => {
    const one = readFeed("https://example.org/rss.xml", fixture("rss.xml"));
    const other = readFeed("https://example.net/rss.xml", fixture("rss.xml"));
    expect(one.entries[0]?.source_id).toMatch(/^[0-9a-f]{32}:1$/);
    expect(one.entries[0]?.source_id).not.toBe(other.entries[0]?.source_id);
  });
});

describe("reading a feed", () => {
  it("reads an Atom feed's entries under bookmark names", () => {
    const { entries, unkeyed } = readFeed(
      "https://example.com/atom.xml",
      fixture("atom.xml"),
    );
    expect(unkeyed).toBe(0);
    const key = feedKey(
      "https://example.com/atom.xml",
      "tag:example.com,2026:feed",
    );
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
          feed_hash: feedKey("https://example.com/atom.xml", undefined),
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
          feed_hash: feedKey("https://example.com/atom.xml", undefined),
        },
        occurred_at: "2026-09-19T09:00:00.000Z",
      },
    ]);
  });

  it("reads an RSS 2.0 feed, keying an entry without a guid by its link and leaving out one with neither", () => {
    const { entries, unkeyed } = readFeed(
      "https://example.org/rss.xml",
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
      "https://reader:pass@example.org/feed.xml#top",
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>/</link>
        <item><title>A</title><link>/posts/a</link><guid>a</guid></item>
      </channel></rss>`,
    );
    expect(rss.entries[0]?.properties).toMatchObject({
      url: "https://example.org/posts/a",
      source_url: "https://example.org/",
      feed_origin: "https://example.org",
      feed_hash: feedKey("https://example.org/feed.xml", undefined),
    });
    const atom = readFeed(
      "https://reader:pass@example.com/atom.xml",
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
      "https://example.org/feed.xml",
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
      "https://example.com/atom.xml",
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

  it("reads an RSS 2.0 description's entity-encoded HTML as plain text", () => {
    const { entries } = readFeed(
      "https://example.org/rss.xml",
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
      "https://example.com/atom.xml",
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
      "https://example.org/rss.xml",
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://example.org/</link>
        <item><title>A</title><link>https://example.org/a</link><guid> </guid></item>
      </channel></rss>`,
    );
    const atom = readFeed(
      "https://example.com/atom.xml",
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
    // The header's charset is read before the declaration's.
    const latinDeclaredUtf8 = Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?><t>Résumé</t>',
      "latin1",
    );
    expect(
      decodeFeed(latinDeclaredUtf8, "text/xml; charset=ISO-8859-1"),
    ).toContain("Résumé");
    // A UTF-8 byte order mark outranks the header.
    const markedUtf8 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<?xml version='1.0'?><t>Résumé</t>", "utf8"),
    ]);
    expect(decodeFeed(markedUtf8, "text/xml; charset=ISO-8859-1")).toContain(
      "Résumé",
    );
    // UTF-16 with no mark shows itself by its zero bytes.
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
      readFeed("https://example.org/rss.xml", text).entries.map(
        (entry) => entry.properties["title"],
      ),
    ).toEqual(["Résumé"]);
  });

  it("refuses what is neither Atom nor RSS 2.0", () => {
    expect(() =>
      readFeed("https://example.org/x", "<html><body>not a feed</body></html>"),
    ).toThrow();
  });

  it("reads a list of feeds, and refuses an entry that is not an address", () => {
    expect(
      feedList(
        "https://a.example.com/1\nhttps://b.example.com/2, https://a.example.com/1",
      ),
    ).toEqual(["https://a.example.com/1", "https://b.example.com/2"]);
    expect(() =>
      feedList("https://a.example.com/1 ftp://b.example.com/2"),
    ).toThrow("an entry that is not an http or https address");
    expect(() => feedList("ftp://a.example.com/1 mailto:b")).toThrow(
      "2 entries that are not",
    );
  });

  it("lists a feed once however it is spelled, keeping the first spelling", () => {
    expect(
      feedList(
        "https://a.example.com/feed https://a.example.com/feed/ http://www.a.example.com/feed https://a.example.com/feed?page=2",
      ),
    ).toEqual([
      "https://a.example.com/feed",
      "https://a.example.com/feed?page=2",
    ]);
  });

  it("keeps a feed's query and path out of the rows, where a token rides, and writes no link relative to that path", () => {
    const address =
      "https://example.org/private/p4th-t0ken/feed.xml?token=s3cr3t-token";
    const rss = readFeed(
      address,
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>./</link>
        <item><title>A</title><link>#frag</link><guid>a</guid></item>
        <item><title>B</title><link>item/2</link><guid>b</guid>
          <enclosure url="img.png" type="image/png" length="1"/></item>
        <item><title>C</title><link>/posts/c</link><guid>c</guid></item>
        <item><title>D</title><link>item/4</link></item>
      </channel></rss>`,
    );
    const atom = readFeed(
      address,
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
      feed_hash: feedKey(address, undefined),
    });
  });

  it("reads markup as text, and a < that opens no tag as text", () => {
    const description = (html: string): unknown =>
      readFeed(
        "https://example.org/rss.xml",
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
      "https://example.org/rss.xml",
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
      address,
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https:./</link>
        <item><title>A</title><link>https:item/2</link><guid>a</guid></item>
        <item><title>B</title><link>HTTPS:item/3</link><guid>b</guid></item>
        <item><title>C</title><link>https://example.org/c</link><guid>c</guid>
          <enclosure url="https:img.png" type="image/png" length="1"/></item>
      </channel></rss>`,
    );
    const based = readFeed(
      address,
      `<?xml version="1.0"?><rss version="2.0"><channel xml:base="./"><title>T</title><link>https://example.org/</link>
        <item><title>D</title><link>item/5</link><guid>d</guid></item>
      </channel></rss>`,
    );
    const atom = readFeed(
      address,
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
      "https://example.org/old/feed",
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
      feed_hash: feedKey("https://example.org/old/feed", undefined),
    });
    expect(entries[1]?.properties["url"]).toBeUndefined();
  });
});

interface Served {
  body: string | Buffer;
  /** Answered 401 without this Authorization header. */
  authorization?: string;
  redirect?: string;
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
    marfa = await new ScriptedServer("rss").start();
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
  ): Promise<{ code: number | null; output: string }> {
    try {
      const { stderr } = await run("node", [built, ...argv], {
        env: {
          PATH: process.env["PATH"],
          MARFA_URL: marfa.url,
          MARFA_KEY: marfa.key,
          RSS_FEEDS: feedList,
        },
        // A process that should have refused its start runs on under
        // --every; this ends it, and its exit code shows it ran.
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
      /^created 4, updated 0, archived 0, unchanged 0, skipped 0\. an entry in the feed/,
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
    expect(marfa.runs.at(-1)?.summary).toBe(
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
    expect(marfa.runs.at(-1)?.summary).toBe(
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
    // The second run read the feed whole, without the entry.
    expect(asked.map((request) => [request.path, request.answered])).toEqual([
      ["/atom.xml", 200],
      ["/rss.xml", 200],
      ["/atom.xml", 200],
      ["/rss.xml", 304],
    ]);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0",
    );
    expect(row("tag:example.com,2026:entry:2").state).toBe("active");
    expect(row("tag:example.com,2026:entry:2").version).toBe(1);
  });

  it("reports an entry left out once, across a 304 and the feed's next change", async () => {
    expect((await once(["/rss.xml"])).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain("neither an id nor a link");
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
      expect.stringContaining("neither an id nor a link"),
      "created 0, updated 0, archived 0, unchanged 0, skipped 0",
      "created 0, updated 1, archived 0, unchanged 1, skipped 0",
    ]);
  });

  it("writes a feed reached at two addresses once, and says so once", async () => {
    const atom = served["/atom.xml"];
    if (typeof atom?.body !== "string") throw new Error("no atom fixture");
    served["/mirror.xml"] = { body: atom.body };
    served["/atom.xml"] = { body: atom.body };
    for (let run = 0; run < 3; run += 1) {
      expect((await once(["/atom.xml", "/mirror.xml"])).code).toBe(0);
    }
    expect(asked.map((request) => request.answered)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(marfa.rows).toHaveLength(2);
    expect(marfa.rows.map((candidate) => candidate.version)).toEqual([1, 1]);
    const atomHash = feedKey(`${base}/atom.xml`, undefined);
    const mirrorHash = feedKey(`${base}/mirror.xml`, undefined);
    expect(
      marfa.rows.map((candidate) => [
        candidate.properties["feed_origin"],
        candidate.properties["feed_hash"],
      ]),
    ).toEqual([
      [base, atomHash],
      [base, atomHash],
    ]);
    expect(marfa.runs.map((reported) => reported.summary)).toEqual([
      expect.stringContaining(
        `the feed ${base} (${mirrorHash}) is the feed ${base} (${atomHash}) under another address`,
      ),
      "created 0, updated 0, archived 0, unchanged 2, skipped 0",
      "created 0, updated 0, archived 0, unchanged 2, skipped 0",
    ]);
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

  it("names a private feed by its origin and a hash, and its path reaches no row, log line, condition, report or state", async () => {
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
    const hash = feedKey(`${base}${paths[0] ?? ""}`, undefined);
    expect(marfa.rows[0]?.properties).toMatchObject({
      feed_origin: base,
      feed_hash: hash,
    });
    expect(reported).toContain(`an entry in the feed ${base} (${hash})`);
    expect(reported).toContain(
      `the feed ${base} (${feedKey(`${base}${paths[1] ?? ""}`, undefined)}) answered 404`,
    );
    expect(reported).toContain(
      `the feed ${base} (${feedKey(`${base}${paths[2] ?? ""}`, undefined)}) is not an Atom or RSS 2.0 feed`,
    );
    expect(reported).toContain(
      `the feed http://127.0.0.1:1 (${feedKey(closed, undefined)}) could not be fetched`,
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
      feed_hash: feedKey(`${base}/old/feed`, undefined),
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

  it("reads the other feeds when one fails, and reports the failing one once", async () => {
    expect((await once(["/atom.xml", "/gone.xml", "/rss.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(4);
    expect(marfa.runs.at(-1)?.outcome).toBe("succeeded");
    expect(marfa.runs.at(-1)?.summary).toContain(
      `the feed ${base} (${feedKey(`${base}/gone.xml`, undefined)}) answered 404`,
    );
    expect((await once(["/atom.xml", "/gone.xml", "/rss.xml"])).code).toBe(0);
    expect(marfa.runs).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toMatch(/^created 0, /);
    expect(marfa.runs.at(-1)?.summary).not.toContain("gone.xml");
  });

  it("asks a feed whose entries did not land again whole", async () => {
    const entryKey =
      readFeed(`${base}/atom.xml`, fixture("atom.xml")).entries[0]?.source_id ??
      "";
    marfa.entryRefusals.set(entryKey, {
      status: 400,
      code: "invalid_properties",
      message: "too long",
    });
    // A refused entry is the run's condition, and holds the state.
    expect((await once(["/atom.xml"])).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain("the server refused");
    marfa.entryRefusals.delete(entryKey);
    expect((await once(["/atom.xml"])).code).toBe(0);
    expect(asked.map((request) => request.answered)).toEqual([200, 200]);
    expect(asked[0]?.path).toBe("/atom.xml");
    expect(asked[1]?.headers["if-none-match"]).toBeUndefined();
    expect(marfa.rows).toHaveLength(2);
  });
});
