import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
          feed_url: "https://example.com/atom.xml",
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
          feed_url: "https://example.com/atom.xml",
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
      feed_url: "https://example.org/feed.xml",
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
    ).toThrow(/1 entries/);
  });
});

interface Served {
  body: string | Buffer;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

describe("the connector, run as a process", () => {
  let marfa: ScriptedServer;
  let feeds: Server;
  let base: string;
  let stateDir: string;
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
      const path = req.url ?? "/";
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
    stateDir = await mkdtemp(join(tmpdir(), "connector-rss-"));
  });

  afterEach(async () => {
    await marfa.stop();
    feeds.closeAllConnections();
    await new Promise((done) => feeds.close(done));
    await rm(stateDir, { recursive: true, force: true });
  });

  async function once(
    paths = ["/atom.xml", "/rss.xml"],
  ): Promise<{ code: number; output: string }> {
    try {
      const { stderr } = await run("node", [built, "--once"], {
        env: {
          PATH: process.env["PATH"],
          MARFA_URL: marfa.url,
          MARFA_KEY: marfa.key,
          MARFA_STATE_DIR: stateDir,
          RSS_FEEDS: paths.map((path) => `${base}${path}`).join("\n"),
        },
      });
      return { code: 0, output: stderr };
    } catch (error) {
      const failed = error as { code: number; stderr: string };
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
      "feed_url",
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
    expect(marfa.runs.at(-1)?.summary).toContain("/gone.xml answered 404");
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
