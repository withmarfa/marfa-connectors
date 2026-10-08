import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  derivedFrom,
  fieldsOf,
  registeredAsKindOf,
  typeHeld,
  item,
  lastRun,
  mintWithTheReadmeKeyFlags,
  moved,
  promoteAndFind,
  registration,
  rowsOf,
  runsOf,
  trash,
  type Item,
} from "./connector.js";

const fixtures = resolve(
  import.meta.dirname,
  "../../../connectors/rss/test/fixtures",
);

interface Feed {
  body: string | Buffer;
  etag: string;
  encoding?: string;
  redirect?: string;
  /** Called on a request it never answers. */
  hang?: () => void;
}

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
    if (feed?.hang !== undefined) {
      feed.hang();
      return;
    }
    const status =
      feed === undefined
        ? 404
        : req.headers["if-none-match"] === feed.etag
          ? 304
          : 200;
    if (feed?.redirect !== undefined) {
      answers.push(302);
      res.writeHead(302, { Location: feed.redirect }).end();
      return;
    }
    answers.push(status);
    if (status !== 200 || feed === undefined) {
      res.writeHead(status).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "application/xml",
        ETag: feed.etag,
        ...(feed.encoding !== undefined && {
          "Content-Encoding": feed.encoding,
        }),
      })
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

function feedHashed(item: Item): unknown {
  return item.properties["feed_hash"];
}

function edit(
  feed: Feed | undefined,
  change: (body: string) => string,
  etag: string,
): void {
  if (feed === undefined) throw new Error("no such fixture");
  feed.body = change(String(feed.body));
  feed.etag = etag;
}

export async function proveRss(
  marfa: MarfaClient,
  url: string,
  manager: MarfaClient,
): Promise<void> {
  const served = await serveFeeds();
  try {
    const key = await mintWithTheReadmeKeyFlags(marfa, {
      label: "rss",
      source: "rss",
      typePermission: "rss.entry",
    });
    const runner = new ConnectorUnderProof("rss", url, key.key, {
      RSS_FEEDS: `${served.url}/atom.xml\n${served.url}/rss.xml`,
    });
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
      "rss: a first run registers rss.entry as a kind of core.bookmark and writes both feeds' entries at the feed tier",
      async () => {
        const wasHeld = await typeHeld(marfa, "rss.entry");
        await runOnce();
        const written = await rows();
        const tiers = [...new Set([...written.values()].map((r) => r.tier))];
        if (written.size !== 4 || tiers.join() !== "feed") {
          throw new Error(
            `${String(written.size)} rows at ${tiers.join(", ")}`,
          );
        }
        const { own, inherited } = await registeredAsKindOf(
          marfa,
          "rss.entry",
          "core.bookmark",
          wasHeld,
          written.values(),
        );
        if (own.join() !== "entry_id,feed_hash,feed_origin") {
          throw new Error(`own fields ${own.join(", ")}`);
        }
        return `rss.entry, absent before the run, registered with parent core.bookmark, all ${String(inherited)} of its fields and ${own.join(", ")} beside them; ${String(written.size)} rows, tier feed, every property a field of the type`;
      },
    );

    await check(
      "rss: the registration shows its heartbeat and its last run",
      async () => {
        const found = await registration(manager, key.id);
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
        if (
          changed.length > 0 ||
          answers.length !== 2 ||
          answers.some((status) => status !== 304)
        ) {
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
        const beta = await entry("https://example.org/beta");
        await runOnce();
        const after = await rows();
        const trashed = after.get(target.source_id ?? "");
        const changed = moved(before, after);
        const { summary } = await lastRun(manager, key.id);
        if (
          trashed?.state !== "trashed" ||
          trashed.version !== target.version ||
          changed.length !== 1 ||
          !changed[0]?.startsWith(`${beta.source_id ?? ""} `) ||
          !summary?.includes("skipped 1")
        ) {
          throw new Error(
            `the trashed row is ${String(trashed?.state)} at version ${String(trashed?.version)}; moved ${changed.join(", ") || "nothing"}; reported ${String(summary)}`,
          );
        }
        return `guid 1 stays trashed at version ${String(target.version)}; moved ${changed.join(", ")}; reported ${summary}`;
      },
    );

    await check(
      "rss: a promoted core.bookmark sits in the library with a derived-from edge",
      async () => {
        const source = await entry("https://example.org/beta");
        const { fields } = await fieldsOf(marfa, "core.bookmark");
        const properties = Object.fromEntries(
          fields
            .filter((field) => field in source.properties)
            .map((field) => [field, source.properties[field]]),
        );
        const { copy } = await promoteAndFind(
          marfa,
          "core.bookmark",
          properties,
          source,
          await entry("tag:example.com,2026:entry:1"),
        );
        const read = await item(marfa, copy.id);
        if (
          read.tier !== "library" ||
          read.properties["url"] !== source.properties["url"]
        ) {
          throw new Error(
            `tier ${String(read.tier)}, url ${String(read.properties["url"])}`,
          );
        }
        return `core.bookmark at tier ${read.tier} with ${Object.keys(read.properties).join(", ")}; the edge filter finds it alone, beside an item with no edge and one derived from another row`;
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

    await check(
      "rss: a feed past the size cap is skipped, two feeds declaring one id are kept apart and a redirect to this machine is refused, and the other feed's rows stand",
      async () => {
        const port = new URL(served.url).port;
        const atom = served.feeds["/atom.xml"];
        if (atom === undefined) throw new Error("no atom fixture");
        served.feeds["/bomb.xml"] = {
          body: gzipSync(Buffer.alloc(256 * 1024 * 1024)),
          etag: '"bomb"',
          encoding: "gzip",
        };
        served.feeds["/twin.xml"] = {
          body: String(atom.body).replace(
            /<title>[^<]*<\/title>/g,
            "<title>Twin</title>",
          ),
          etag: '"twin"',
        };
        served.feeds["/hop"] = {
          body: "",
          etag: '"hop"',
          redirect: `http://localhost:${port}/rss.xml`,
        };
        const hostile = new ConnectorUnderProof("rss", url, key.key, {
          RSS_FEEDS: [
            `${served.url}/bomb.xml`,
            `${served.url}/twin.xml`,
            `${served.url}/hop`,
            `${served.url}/atom.xml`,
          ].join("\n"),
        });
        const before = await rows();
        const { code, output } = await hostile.once();
        if (code !== 0)
          throw new Error(`the run exited ${String(code)}: ${output}`);
        const after = [...(await rows()).values()];
        const twins = after.filter((row) => row.properties["title"] === "Twin");
        const others = after.filter(
          (row) =>
            String(row.properties["entry_id"]).startsWith("tag:example.com") &&
            row.properties["title"] !== "Twin",
        );
        const { summary } = await lastRun(manager, key.id);
        const said = [
          "feed 1 in RSS_FEEDS",
          "is larger than 24 MiB, so it is skipped",
          "feed 4 in RSS_FEEDS",
          "declares the same feed id as feed 2 in RSS_FEEDS",
          `feed 3 in RSS_FEEDS (${served.url}) redirected to an address on this machine or a private network`,
        ];
        const missing = said.filter((text) => summary?.includes(text) !== true);
        if (
          twins.length !== 2 ||
          others.length < 2 ||
          new Set(twins.map(feedHashed)).size !== 1 ||
          twins.some((row) => before.has(row.source_id ?? "")) ||
          others.some((row) =>
            twins.some((twin) => feedHashed(twin) === feedHashed(row)),
          ) ||
          missing.length > 0
        ) {
          throw new Error(
            `${String(twins.length)} rows of the second feed, ${String(others.length)} of the first; missing ${missing.join(" | ")}; reported ${String(summary)}`,
          );
        }
        return `the oversized feed skipped, the redirect refused, the second feed declaring the first's id written under its own key beside the first's rows, which kept their titles; reported ${String(summary)}`;
      },
    );

    const refused = "http://127.0.0.1:1/private/feed.xml";
    const dead = [
      `feed 2 in RSS_FEEDS (${served.url}) answered 404`,
      "feed 3 in RSS_FEEDS (http://127.0.0.1:1) could not be fetched: its server refused the connection (ECONNREFUSED)",
    ];
    await check(
      "rss: a feed that keeps failing is named, with its cause, in the report of every run it fails, and the run still succeeds",
      async () => {
        const failing = new ConnectorUnderProof("rss", url, key.key, {
          RSS_FEEDS: [
            `${served.url}/atom.xml`,
            `${served.url}/dead.xml`,
            refused,
          ].join("\n"),
        });
        const before = (await runsOf(manager, key.id)).length;
        const seen: string[] = [];
        for (let at = 1; at <= 3; at += 1) {
          const { code, output } = await failing.once();
          const runs = await runsOf(manager, key.id);
          const last = runs[0];
          const missing = dead.filter(
            (text) => last?.summary?.includes(text) !== true,
          );
          if (
            code !== 0 ||
            runs.length !== before + at ||
            last?.outcome !== "succeeded" ||
            missing.length > 0 ||
            last.summary?.includes("/private/") === true ||
            last.summary?.includes("dead.xml") === true
          ) {
            throw new Error(
              `run ${String(at)} exited ${String(code)}, ${String(runs.length - before)} reported, the last ${String(last?.outcome)}: ${String(last?.summary)}; ${output}`,
            );
          }
          seen.push(last.summary ?? "");
        }
        return `three runs, each reported succeeded and each naming both: ${seen.join(" | ")}`;
      },
    );

    await check(
      "rss: a run in which every feed failed is reported failed, naming each feed and why",
      async () => {
        const failing = new ConnectorUnderProof("rss", url, key.key, {
          RSS_FEEDS: [`${served.url}/dead.xml`, refused].join("\n"),
        });
        const { code, output } = await failing.once();
        const last = await lastRun(manager, key.id);
        const named = [
          `feed 1 in RSS_FEEDS (${served.url}) answered 404`,
          "feed 2 in RSS_FEEDS (http://127.0.0.1:1) could not be fetched: its server refused the connection (ECONNREFUSED)",
        ];
        if (
          code !== 1 ||
          last.outcome !== "failed" ||
          last.error?.includes(
            "none of the 2 feeds in RSS_FEEDS could be read",
          ) !== true ||
          named.some((text) => last.summary?.includes(text) !== true)
        ) {
          throw new Error(
            `exited ${String(code)}, reported ${last.outcome}: ${String(last.error)}; ${String(last.summary)}; ${output}`,
          );
        }
        return `exited 1, reported failed: ${last.error}; ${String(last.summary)}`;
      },
    );

    await check(
      "rss: a run whose state the server will not keep, being past its cap, is reported failed after the save, and the state kept before stands",
      async () => {
        const many: string[] = [];
        // Each validator is kept up to 1 KiB, so enough feeds pass the cap.
        for (let at = 0; at < 600; at += 1) {
          const path = `/big-etag/${String(at)}.xml`;
          served.feeds[path] = {
            body: '<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>',
            etag: `"${String(at)}-${"e".repeat(1000)}"`,
          };
          many.push(`${served.url}${path}`);
        }
        const heavy = new ConnectorUnderProof("rss", url, key.key, {
          RSS_FEEDS: many.join("\n"),
        });
        const before = (await runsOf(manager, key.id)).length;
        const { code, output } = await heavy.once();
        const runs = await runsOf(manager, key.id);
        const last = runs[0];
        if (
          code !== 1 ||
          runs.length !== before + 1 ||
          last?.outcome !== "failed" ||
          last.error?.includes("the connector's state could not be kept") !==
            true
        ) {
          throw new Error(
            `exited ${String(code)}, ${String(runs.length - before)} reported, ${String(last?.outcome)}: ${String(last?.error)}; ${output}`,
          );
        }
        await runOnce();
        return `exited 1, reported failed: ${last.error}; the next run with the usual feeds succeeded`;
      },
    );

    await check(
      "rss: a run stopped while it fetches is not reported, says it stopped, and exits 0",
      async () => {
        let arrived: () => void = () => undefined;
        const fetching = new Promise<void>((done) => {
          arrived = done;
        });
        served.feeds["/slow.xml"] = { body: "", etag: '"slow"', hang: arrived };
        const slow = new ConnectorUnderProof("rss", url, key.key, {
          RSS_FEEDS: `${served.url}/atom.xml\n${served.url}/slow.xml`,
        });
        const before = await runsOf(manager, key.id);
        const { code, output } = await slow.stopped(["--once"], () => fetching);
        const after = await runsOf(manager, key.id);
        if (
          code !== 0 ||
          after.length !== before.length ||
          !output.includes("run stopped before it finished") ||
          output.includes("run failed")
        ) {
          throw new Error(
            `exited ${String(code)}, ${String(after.length - before.length)} runs reported: ${output}`,
          );
        }
        await runOnce();
        return `exited 0 with no run reported, the log saying: ${output.split("\n").find((line) => line.includes("run stopped")) ?? ""}`;
      },
    );
  } finally {
    await served.close();
  }
}
