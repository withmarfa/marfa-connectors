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
import { canonicalFeedUrl, feedKey, feedList, readFeed } from "../src/feeds.js";

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

  it("keeps no credentials of the address it was given", () => {
    const { entries } = readFeed(
      "https://reader:pass@example.org/rss.xml",
      fixture("rss.xml"),
    );
    expect(entries[0]?.properties["feed_url"]).toBe(
      "https://example.org/rss.xml",
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
  body: string;
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
        body = "",
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
          "Content-Type": "application/xml",
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

  it("registers rss.entry as readable as a bookmark, and writes both feeds' entries at the feed tier", async () => {
    expect((await once()).code).toBe(0);
    const registered = marfa.types.get("rss.entry");
    expect(registered?.["compatible_with"]).toEqual(["core.bookmark"]);
    expect(Object.keys(registered?.["fields"] as object)).not.toContain(
      "source",
    );
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
    await once();
    await once();
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
    await once();
    const atom = served["/atom.xml"];
    if (atom === undefined) throw new Error("no atom fixture");
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
    await once();
    const atom = served["/atom.xml"];
    if (atom === undefined) throw new Error("no atom fixture");
    atom.body = atom.body.replace(
      /<entry>\s*<title>Second entry[\s\S]*?<\/entry>/,
      "",
    );
    atom.etag = '"atom-3"';
    await once();
    expect(row("tag:example.com,2026:entry:2").state).toBe("active");
    expect(row("tag:example.com,2026:entry:2").version).toBe(1);
  });

  it("reads the other feeds when one fails, and reports the failing one once", async () => {
    expect((await once(["/atom.xml", "/gone.xml", "/rss.xml"])).code).toBe(0);
    expect(marfa.rows).toHaveLength(4);
    expect(marfa.runs.at(-1)?.outcome).toBe("succeeded");
    expect(marfa.runs.at(-1)?.summary).toContain("/gone.xml answered 404");
    await once(["/atom.xml", "/gone.xml", "/rss.xml"]);
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
    await once(["/atom.xml"]);
    marfa.entryRefusals.delete(entryKey);
    await once(["/atom.xml"]);
    expect(asked.map((request) => request.answered)).toEqual([200, 200]);
    expect(asked[1]?.headers["if-none-match"]).toBeUndefined();
    expect(marfa.rows).toHaveLength(2);
  });
});
