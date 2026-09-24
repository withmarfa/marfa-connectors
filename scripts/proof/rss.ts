import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  derivedFrom,
  item,
  mint,
  moved,
  promote,
  registration,
  rowsOf,
  trash,
  type Item,
} from "./connector.js";

const fixtures = resolve(
  import.meta.dirname,
  "../../../connectors/rss/test/fixtures",
);

/** The fields a bookmark has, which an entry carries under the same names. */
const bookmarkFields = [
  "url",
  "title",
  "description",
  "body",
  "author",
  "published_at",
  "image_url",
  "language",
  "source_url",
  "source_title",
];

interface Feed {
  body: string;
  etag: string;
}

/** Two feeds, Atom and RSS 2.0, served with ETags and honoring them. */
async function serveFeeds(): Promise<{
  url: string;
  feeds: Record<string, Feed>;
  answers: number[];
  close: () => Promise<void>;
}> {
  const feeds: Record<string, Feed> = {
    "/atom.xml": {
      body: readFileSync(resolve(fixtures, "atom.xml"), "utf8"),
      etag: '"atom-1"',
    },
    "/rss.xml": {
      body: readFileSync(resolve(fixtures, "rss.xml"), "utf8"),
      etag: '"rss-1"',
    },
  };
  const answers: number[] = [];
  const server = createServer((req, res) => {
    const feed = feeds[req.url ?? ""];
    const status =
      feed === undefined
        ? 404
        : req.headers["if-none-match"] === feed.etag
          ? 304
          : 200;
    answers.push(status);
    if (status !== 200 || feed === undefined) {
      res.writeHead(status).end();
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/xml", ETag: feed.etag })
      .end(feed.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    feeds,
    answers,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

function edit(
  feed: Feed | undefined,
  change: (body: string) => string,
  etag: string,
): void {
  if (feed === undefined) throw new Error("no such fixture");
  feed.body = change(feed.body);
  feed.etag = etag;
}

export async function proveRss(marfa: MarfaClient, url: string): Promise<void> {
  const served = await serveFeeds();
  let connector: ConnectorUnderProof | undefined;
  try {
    const key = await mint(marfa, {
      label: "rss",
      source: "rss",
      typePermission: "rss.entry",
      registersType: true,
    });
    await check("rss: its key is minted as the template's README says", () => {
      if (key.source !== "rss" || key.default_tier !== "feed") {
        throw new Error(
          `source ${key.source}, default tier ${key.default_tier}`,
        );
      }
      return `source ${key.source}, type_permissions ${JSON.stringify(key.type_permissions)}, metadata_permissions ${JSON.stringify(key.metadata_permissions)}, default tier ${key.default_tier}`;
    });
    const runner = new ConnectorUnderProof("rss", url, key.key, {
      RSS_FEEDS: `${served.url}/atom.xml\n${served.url}/rss.xml`,
    });
    connector = runner;
    const runOnce = async (): Promise<void> => {
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
    };
    const rows = (): Promise<Map<string, Item>> =>
      rowsOf(marfa, "rss.entry", "rss");
    const entry = async (entryId: string): Promise<Item> => {
      const found = [...(await rows()).values()].find(
        (candidate) => candidate.properties["entry_id"] === entryId,
      );
      if (found === undefined) throw new Error(`no row for entry ${entryId}`);
      return found;
    };

    await check(
      "rss: a first run registers rss.entry and writes both feeds' entries at the feed tier",
      async () => {
        await runOnce();
        const { data: type } = await marfa.GET("/types/{id}", {
          params: { path: { id: "rss.entry" } },
        });
        const written = await rows();
        const tiers = [...new Set([...written.values()].map((r) => r.tier))];
        if (written.size !== 4 || tiers.join() !== "feed") {
          throw new Error(
            `${String(written.size)} rows at ${tiers.join(", ")}`,
          );
        }
        if (JSON.stringify(type?.compatible_with) !== '["core.bookmark"]') {
          throw new Error(
            `rss.entry is compatible with ${JSON.stringify(type?.compatible_with)}`,
          );
        }
        return `rss.entry compatible_with ${JSON.stringify(type?.compatible_with)}; ${String(written.size)} rows, tier feed`;
      },
    );

    await check(
      "rss: the registration shows its heartbeat and its last run",
      async () => {
        const found = await registration(marfa, key.id);
        if (
          found.last_heartbeat_at === null ||
          found.last_run?.outcome !== "succeeded"
        ) {
          throw new Error(
            `heartbeat ${String(found.last_heartbeat_at)}, last run ${String(found.last_run?.outcome)}`,
          );
        }
        return `"${found.name}", source ${found.source}, heartbeat ${found.last_heartbeat_at}, last run ${found.last_run.outcome}: ${String(found.last_run.summary)}`;
      },
    );

    await check(
      "rss: a second run is answered 304 and moves no version",
      async () => {
        const before = await rows();
        const asked = served.answers.length;
        await runOnce();
        const changed = moved(before, await rows());
        const answers = served.answers.slice(asked);
        if (changed.length > 0 || answers.some((status) => status !== 304)) {
          throw new Error(
            `answers ${answers.join(", ")}, moved ${changed.join(", ")}`,
          );
        }
        return `both feeds answered ${answers.join(", ")}; none of ${String(before.size)} rows moved`;
      },
    );

    await check(
      "rss: a change upstream moves exactly that row, by one version",
      async () => {
        const before = await rows();
        edit(
          served.feeds["/atom.xml"],
          (body) =>
            body.replace(
              "<title>First entry</title>",
              "<title>First entry, revised</title>",
            ),
          '"atom-2"',
        );
        await runOnce();
        const changed = moved(before, await rows());
        const revised = await entry("tag:example.com,2026:entry:1");
        if (changed.length !== 1 || revised.version !== 2)
          throw new Error(`moved ${changed.join(", ") || "nothing"}`);
        return `moved ${changed.join(", ")}`;
      },
    );

    await check("rss: a field cleared upstream is cleared", async () => {
      const before = await entry("tag:example.com,2026:entry:2");
      if (before.properties["description"] !== "The second summary.")
        throw new Error("the summary never landed");
      edit(
        served.feeds["/atom.xml"],
        (body) => body.replace("<summary>The second summary.</summary>", ""),
        '"atom-3"',
      );
      await runOnce();
      const after = await entry("tag:example.com,2026:entry:2");
      if ("description" in after.properties)
        throw new Error("the summary is still there");
      return `description present at version ${String(before.version)}, absent at version ${String(after.version)}`;
    });

    await check(
      "rss: a trashed row is left alone, where an active one changing with it moves",
      async () => {
        const target = await entry("1");
        await trash(marfa, target.id);
        const before = await rows();
        edit(
          served.feeds["/rss.xml"],
          (body) =>
            body
              .replace("<title>Alpha</title>", "<title>Alpha, changed</title>")
              .replace("<title>Beta</title>", "<title>Beta, changed</title>"),
          '"rss-2"',
        );
        await runOnce();
        const after = await rows();
        const trashed = after.get(target.source_id ?? "");
        if (
          trashed?.state !== "trashed" ||
          trashed.version !== target.version
        ) {
          throw new Error(
            `the trashed row is ${String(trashed?.state)} at version ${String(trashed?.version)}`,
          );
        }
        return `guid 1 stays trashed at version ${String(target.version)}; moved ${moved(before, after).join(", ")}`;
      },
    );

    await check(
      "rss: a promoted core.bookmark sits in the library with a derived-from edge",
      async () => {
        const source = await entry("https://example.org/beta");
        const properties = Object.fromEntries(
          bookmarkFields
            .filter((field) => field in source.properties)
            .map((field) => [field, source.properties[field]]),
        );
        const copy = await promote(marfa, "core.bookmark", properties, source);
        const read = await item(marfa, copy.id);
        const found = await derivedFrom(marfa, "core.bookmark", source);
        if (
          read.tier !== "library" ||
          !found.some((candidate) => candidate.id === copy.id)
        ) {
          throw new Error(
            `tier ${String(read.tier)}, found by the edge filter: ${String(found.length)}`,
          );
        }
        return `core.bookmark at tier ${read.tier} with ${Object.keys(read.properties).join(", ")}, found by edge[derived-from]`;
      },
    );

    await check(
      "rss: the next run leaves the promoted copy alone",
      async () => {
        const source = await entry("https://example.org/beta");
        const [copy] = await derivedFrom(marfa, "core.bookmark", source);
        if (copy === undefined) throw new Error("no promoted copy");
        edit(
          served.feeds["/rss.xml"],
          (body) =>
            body.replace(
              "<title>Beta, changed</title>",
              "<title>Beta, changed again</title>",
            ),
          '"rss-3"',
        );
        await runOnce();
        const again = await item(marfa, copy.id);
        const moving = await entry("https://example.org/beta");
        if (
          again.version !== copy.version ||
          moving.version === source.version
        ) {
          throw new Error(
            `copy ${String(copy.version)}→${String(again.version)}, source ${String(source.version)}→${String(moving.version)}`,
          );
        }
        return `the feed row moved ${String(source.version)}→${String(moving.version)}; the copy stays at version ${String(copy.version)}`;
      },
    );
  } finally {
    await connector?.dispose();
    await served.close();
  }
}
