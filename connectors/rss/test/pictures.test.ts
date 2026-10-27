import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps, type ServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import type { Item as Row } from "@withmarfa/connector";
import type { Picture } from "@withmarfa/connector/pictures";
import {
  addressesOf,
  maxBytesPerRun,
  maxPassMs,
  maxPicturesPerEntry,
  maxPicturesPerRun,
  privateHostsFor,
  savePictures,
  titleOf,
} from "../src/pictures.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");

// ---- A picture with the smallest header the kit's reader needs. ----

function png(seed: number, padding = 0): Buffer {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32(13),
    Buffer.from("IHDR"),
    u32(8),
    u32(8),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4),
    Buffer.alloc(40 + padding, seed),
  ]);
}

const sha = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

// ---- A local HTTPS server, with a certificate made for the run. ----

const directory = mkdtempSync(join(tmpdir(), "rss-pictures-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ],
  { stdio: "ignore" },
);
const tls: ServerOptions = {
  key: readFileSync(join(directory, "key.pem")),
  cert: readFileSync(join(directory, "cert.pem")),
};
const certificate = join(directory, "cert.pem");

type Answer =
  | { body: Buffer; type?: string }
  | { status: number }
  | { drop: true }
  | { hang: true };

let pictures: Record<string, Answer> = {};
let asked: string[] = [];
let picturePort = 0;
const pictureServer = createHttps(tls, (req, res) => {
  const path = req.url ?? "";
  asked.push(path);
  const answer = Object.hasOwn(pictures, path) ? pictures[path] : undefined;
  if (answer === undefined) res.writeHead(404).end();
  else if ("drop" in answer) req.socket.destroy();
  else if ("hang" in answer) return;
  else if ("status" in answer) res.writeHead(answer.status).end();
  else {
    res
      .writeHead(200, { "Content-Type": answer.type ?? "image/png" })
      .end(answer.body);
  }
});
const at = (path: string): string =>
  `https://localhost:${String(picturePort)}${path}`;

beforeAll(async () => {
  await new Promise<void>((done) => pictureServer.listen(0, done));
  picturePort = (pictureServer.address() as AddressInfo).port;
});
afterAll(async () => {
  pictureServer.closeAllConnections();
  await new Promise((done) => pictureServer.close(done));
  rmSync(directory, { recursive: true });
});

// ---- The connector, run as a process, reading JSON Feeds. ----

interface Item {
  id: string;
  title?: string;
  content_html?: string;
  image?: string;
}

describe("the pictures an entry points to", () => {
  let marfa: ScriptedServer;
  let feeds: Server;
  let base: string;
  let port = 0;
  let documents: Record<string, Item[]>;

  const img = (address: string): string => `<img src="${address}" alt="a">`;

  beforeEach(async () => {
    pictures = {};
    asked = [];
    documents = { "/one.json": [] };
    marfa = await new ScriptedServer("rss", {
      types: ["rss.entry", "rss.picture"],
      edges: ["attached-to"],
    }).start();
    feeds = createHttp((req, res) => {
      const path = new URL(req.url ?? "/", "http://feeds.test").pathname;
      const items = documents[path];
      if (items === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/feed+json" }).end(
        JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: "Test",
          items,
        }),
      );
    });
    await new Promise<void>((done) => feeds.listen(0, done));
    port = (feeds.address() as AddressInfo).port;
    base = `http://localhost:${String(port)}`;
  });

  afterEach(async () => {
    await marfa.stop();
    feeds.closeAllConnections();
    await new Promise((done) => feeds.close(done));
  });

  function environment(
    setting: string | null,
    paths: string[],
  ): Record<string, string | undefined> {
    return {
      PATH: process.env["PATH"],
      MARFA_API_URL: marfa.url,
      MARFA_API_KEY: marfa.key,
      RSS_FEEDS: paths
        .map((path) => (path.startsWith("http") ? path : `${base}${path}`))
        .join("\n"),
      RSS_PRIVATE_HOSTS: "localhost",
      NODE_EXTRA_CA_CERTS: certificate,
      ...(setting !== null && { RSS_PICTURES: setting }),
    };
  }

  async function once(
    setting: string | null = "save",
    paths = ["/one.json"],
  ): Promise<{ code: number | null; output: string }> {
    try {
      const { stderr } = await run("node", [built, "--once"], {
        env: environment(setting, paths),
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, output: stderr };
    } catch (error) {
      const failed = error as { code: number | null; stderr: string };
      return { code: failed.code, output: failed.stderr };
    }
  }

  const entry = (entryId: string) => {
    const found = marfa.rows.find(
      (row) =>
        row.type === "rss.entry" && row.properties["entry_id"] === entryId,
    );
    if (found === undefined) throw new Error(`no entry ${entryId}`);
    return found;
  };
  const filesOf = (entryId: string) => {
    const id = entry(entryId).id;
    return marfa.rows.filter(
      (row) =>
        row.type === "rss.picture" &&
        marfa.targetsOf(row.id, "attached-to").includes(id),
    );
  };
  const manifest = (entryId: string) =>
    entry(entryId).properties["rss_pictures"] as {
      text: string;
      saved: string[];
      pending: string[];
      not_kept: Record<string, string>;
      over?: number;
    };

  it("saves nothing, declares no picture type and fetches nothing while the setting is addresses", async () => {
    // A key for the entry type alone is all this setting needs.
    await marfa.stop();
    marfa = await new ScriptedServer("rss", { types: ["rss.entry"] }).start();
    pictures["/a.png"] = { body: png(1) };
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/a.png")) },
    ];
    for (const setting of [null, "addresses"]) {
      expect((await once(setting)).code).toBe(0);
    }
    expect(asked).toEqual([]);
    expect(marfa.types.has("rss.picture")).toBe(false);
    expect(
      Object.keys(marfa.types.get("rss.entry")?.["fields"] as object),
    ).not.toContain("rss_pictures");
    expect(entry("e1").properties).not.toHaveProperty("rss_pictures");
    expect(entry("e1").properties["body"]).toContain(at("/a.png"));
    expect(marfa.rows.filter((row) => row.type === "rss.picture")).toEqual([]);
    expect(marfa.uploads).toBe(0);
  });

  it("refuses a key whose permissions do not match the setting", async () => {
    // A key for pictures, with the setting off.
    const wide = await once("addresses");
    expect(wide.code).toBe(1);
    expect(wide.output).toContain("rss.picture");
    expect(marfa.rows).toEqual([]);

    // A key for the entry type alone, with pictures on.
    await marfa.stop();
    marfa = await new ScriptedServer("rss", { types: ["rss.entry"] }).start();
    const narrow = await once("save");
    expect(narrow.code).toBe(1);
    expect(narrow.output).toContain("rss.picture");
    expect(marfa.rows).toEqual([]);
  });

  it("refuses a setting it does not know, before any feed is read", async () => {
    const result = await once("everything");
    expect(result.code).toBe(2);
    expect(result.output).toContain(
      "RSS_PICTURES must be addresses, save or save-in-library",
    );
    expect(marfa.rows).toEqual([]);
  });

  it("saves the pictures of an entry as files attached to it, and accounts for them on the entry", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/cover.png"] = { body: png(2) };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        image: at("/cover.png"),
        content_html: `<p>Text</p>${img(at("/a.png"))}`,
      },
    ];
    expect((await once()).code).toBe(0);

    expect(marfa.types.get("rss.picture")?.["parent"]).toBe("core.file.image");
    const files = filesOf("e1");
    expect(files.map((file) => file.properties["source_url"]).sort()).toEqual(
      [at("/a.png"), at("/cover.png")].sort(),
    );
    for (const file of files) {
      const address = file.properties["source_url"] as string;
      expect(file.tier).toBe("feed");
      expect(file.state).toBe("active");
      expect(file.properties["title"]).toBe(titleOf(address, "image/png"));
      expect(file.properties["title"]).toMatch(/^p-[0-9a-f]{12}\.png$/);
      expect(file.properties["mime_type"]).toBe("image/png");
      expect(typeof file.properties["blob_ref"]).toBe("string");
    }
    expect(marfa.uploads).toBe(2);

    const held = manifest("e1");
    expect(held.saved.sort()).toEqual([at("/a.png"), at("/cover.png")].sort());
    expect(held.pending).toEqual([]);
    expect(held.not_kept).toEqual({});
    expect(held.text).toMatch(/^[0-9a-f]{64}$/);
    // The entry's text is not rewritten.
    expect(entry("e1").properties["body"]).toContain(at("/a.png"));
  });

  it("changes nothing in a second run, and keeps the manifest through a rewrite of the entry", async () => {
    pictures["/a.png"] = { body: png(1) };
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/a.png")) },
    ];
    expect((await once()).code).toBe(0);
    const first = manifest("e1");
    const version = entry("e1").version;
    const file = filesOf("e1")[0];
    const fileVersion = file?.version;
    asked = [];
    const uploads = marfa.uploads;

    expect((await once()).code).toBe(0);
    expect(asked).toEqual([]);
    expect(marfa.uploads).toBe(uploads);
    expect(filesOf("e1")).toHaveLength(1);
    expect(filesOf("e1")[0]?.version).toBe(fileVersion);
    expect(entry("e1").version).toBe(version);

    // The feed changes the title only: the entry is written again, and the
    // write does not clear the manifest.
    documents["/one.json"] = [
      { id: "e1", title: "One, renamed", content_html: img(at("/a.png")) },
    ];
    expect((await once()).code).toBe(0);
    expect(entry("e1").properties["title"]).toBe("One, renamed");
    expect(manifest("e1")).toEqual(first);
    expect(asked).toEqual([]);
    expect(filesOf("e1")).toHaveLength(1);
  });

  it("records a refused picture as not kept, and does not ask for it again until the text changes", async () => {
    pictures["/missing.png"] = { status: 404 };
    pictures["/page.png"] = {
      body: Buffer.from("<html></html>"),
      type: "text/html",
    };
    pictures["/ok.png"] = { body: png(3) };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: [at("/missing.png"), at("/page.png"), at("/ok.png")]
          .map(img)
          .join(""),
      },
    ];
    expect((await once()).code).toBe(0);
    expect(manifest("e1").saved).toEqual([at("/ok.png")]);
    expect(manifest("e1").not_kept).toEqual({
      [at("/missing.png")]: "bad_status",
      [at("/page.png")]: "not_a_picture",
    });
    expect(filesOf("e1")).toHaveLength(1);

    asked = [];
    expect((await once()).code).toBe(0);
    expect(asked).toEqual([]);

    // A change to the text is a reason to ask again: the address that was
    // gone is back, and it is saved.
    pictures["/missing.png"] = { body: png(4) };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html:
          [at("/missing.png"), at("/page.png"), at("/ok.png")]
            .map(img)
            .join("") + "<p>Edited</p>",
      },
    ];
    expect((await once()).code).toBe(0);
    expect(asked.sort()).toEqual(["/missing.png", "/page.png"]);
    expect(manifest("e1").saved.sort()).toEqual(
      [at("/missing.png"), at("/ok.png")].sort(),
    );
    expect(manifest("e1").not_kept).toEqual({
      [at("/page.png")]: "not_a_picture",
    });
  });

  it("never fetches an address that is not https, and records it", async () => {
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: img(`${base}/plain.png`),
      },
    ];
    expect((await once()).code).toBe(0);
    expect(manifest("e1").not_kept).toEqual({
      [`${base}/plain.png`]: "not_https",
    });
    expect(filesOf("e1")).toEqual([]);
  });

  it("asks again, a run at a time, for a picture whose fetch failed in a way that may pass, then stops", async () => {
    pictures["/flaky.png"] = { drop: true };
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/flaky.png")) },
    ];
    expect((await once()).code).toBe(0);
    expect(manifest("e1").pending).toEqual([at("/flaky.png")]);
    expect(manifest("e1").not_kept).toEqual({});

    expect((await once()).code).toBe(0);
    expect(manifest("e1").pending).toEqual([at("/flaky.png")]);

    pictures["/flaky.png"] = { drop: true };
    expect((await once()).code).toBe(0);
    expect(manifest("e1").pending).toEqual([]);
    expect(manifest("e1").not_kept).toEqual({
      [at("/flaky.png")]: "fetch_failed",
    });
    asked = [];
    expect((await once()).code).toBe(0);
    expect(asked).toEqual([]);

    // A picture that comes back before the last attempt is saved.
    documents["/one.json"] = [
      { id: "e2", title: "Two", content_html: img(at("/later.png")) },
    ];
    pictures["/later.png"] = { drop: true };
    expect((await once()).code).toBe(0);
    pictures["/later.png"] = { body: png(5) };
    expect((await once()).code).toBe(0);
    expect(manifest("e2").saved).toEqual([at("/later.png")]);
    expect(manifest("e2").pending).toEqual([]);
  });

  it("reads at most the first pictures of an entry, and says how many it did not", async () => {
    const addresses = Array.from({ length: maxPicturesPerEntry + 3 }, (_, n) =>
      at(`/n${String(n)}.png`),
    );
    addresses.forEach((address, n) => {
      pictures[new URL(address).pathname] = { body: png(n + 1) };
    });
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: addresses.map(img).join("") },
    ];
    expect((await once()).code).toBe(0);
    expect(filesOf("e1")).toHaveLength(maxPicturesPerEntry);
    expect(manifest("e1").saved).toEqual(
      addresses.slice(0, maxPicturesPerEntry),
    );
    expect(manifest("e1").over).toBe(3);
  });

  it("saves at most 100 pictures in a run, and the rest in the next", async () => {
    const entries = 6;
    documents["/one.json"] = Array.from({ length: entries }, (_, e) => ({
      id: `e${String(e)}`,
      title: `E${String(e)}`,
      content_html: Array.from({ length: maxPicturesPerEntry }, (_, n) => {
        const path = `/e${String(e)}-${String(n)}.png`;
        pictures[path] = { body: png((e * 20 + n) % 250) };
        return img(at(path));
      }).join(""),
    }));
    const result = await once();
    expect(result.code).toBe(0);
    expect(asked).toHaveLength(maxPicturesPerRun);
    const saved = marfa.rows.filter((row) => row.type === "rss.picture");
    expect(saved).toHaveLength(maxPicturesPerRun);
    const pending = Array.from(
      { length: entries },
      (_, e) => manifest(`e${String(e)}`).pending.length,
    ).reduce((sum, n) => sum + n, 0);
    expect(pending).toBe(entries * maxPicturesPerEntry - maxPicturesPerRun);
    expect(marfa.runs.at(-1)?.summary ?? "").toContain("reached its limit");

    asked = [];
    expect((await once()).code).toBe(0);
    expect(asked).toHaveLength(
      entries * maxPicturesPerEntry - maxPicturesPerRun,
    );
    expect(marfa.rows.filter((row) => row.type === "rss.picture")).toHaveLength(
      entries * maxPicturesPerEntry,
    );
    for (let e = 0; e < entries; e += 1) {
      expect(manifest(`e${String(e)}`).pending).toEqual([]);
    }
  });

  it("leaves a picture that would take a run past its byte limit for the next run", async () => {
    const size = 24 * 1024 * 1024;
    const count = Math.floor(maxBytesPerRun / size) + 1;
    const paths = Array.from(
      { length: count },
      (_, n) => `/big${String(n)}.png`,
    );
    paths.forEach((path, n) => {
      pictures[path] = { body: png(n + 1, size) };
    });
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: paths.map((path) => img(at(path))).join(""),
      },
    ];
    expect((await once()).code).toBe(0);
    expect(filesOf("e1")).toHaveLength(count - 1);
    expect(manifest("e1").pending).toEqual([at(paths[count - 1] ?? "")]);

    expect((await once()).code).toBe(0);
    expect(filesOf("e1")).toHaveLength(count);
    expect(manifest("e1").pending).toEqual([]);
  }, 120_000);

  it("keeps two pictures of the same name from two places apart", async () => {
    pictures["/site-a/cat.png"] = { body: png(7) };
    pictures["/site-b/cat.png"] = { body: png(8) };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: img(at("/site-a/cat.png")) + img(at("/site-b/cat.png")),
      },
      { id: "e2", title: "Two", content_html: img(at("/site-a/cat.png")) },
    ];
    expect((await once()).code).toBe(0);
    expect(filesOf("e1")).toHaveLength(2);
    expect(filesOf("e2")).toHaveLength(1);
    const titles = marfa.rows
      .filter((row) => row.type === "rss.picture")
      .map((row) => row.properties["title"]);
    expect(new Set(titles).size).toBe(2);
    const bytes = filesOf("e1").map(
      (row) => marfa.blobs.get(row.properties["blob_ref"] as string)?.bytes,
    );
    expect(bytes.map((one) => one && sha(one)).sort()).toEqual(
      [sha(png(7)), sha(png(8))].sort(),
    );
  });

  it("does not save a picture that was trashed or purged again, even when the entry's text changes", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/b.png"] = { body: png(2) };
    pictures["/c.png"] = { body: png(3) };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: img(at("/a.png")) + img(at("/b.png")),
      },
    ];
    expect((await once()).code).toBe(0);
    const [first, second] = filesOf("e1");
    marfa.trash(first?.id ?? "");
    marfa.trash(second?.id ?? "");
    marfa.purgeById(second?.id ?? "");
    asked = [];
    const uploads = marfa.uploads;

    expect((await once()).code).toBe(0);
    expect(asked).toEqual([]);
    expect(marfa.uploads).toBe(uploads);
    expect(Object.values(manifest("e1").not_kept)).toEqual([
      "removed",
      "removed",
    ]);
    expect(manifest("e1").saved).toEqual([]);
    expect(filesOf("e1").filter((row) => row.state === "active")).toEqual([]);

    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: img(at("/a.png")) + img(at("/b.png")) + img(at("/c.png")),
      },
    ];
    expect((await once()).code).toBe(0);
    expect(asked).toEqual(["/c.png"]);
    expect(manifest("e1").saved).toEqual([at("/c.png")]);
    expect(manifest("e1").not_kept).toEqual({
      [at("/a.png")]: "removed",
      [at("/b.png")]: "removed",
    });
  });

  it("archives the pictures of an entry that is archived or trashed, and brings them back with the entry", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/b.png"] = { body: png(2) };
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/a.png")) },
      { id: "e2", title: "Two", content_html: img(at("/b.png")) },
    ];
    expect((await once()).code).toBe(0);
    marfa.transition(entry("e1").id, "archived");
    marfa.trash(entry("e2").id);
    const trashedFiles = filesOf("e2");
    for (const file of trashedFiles) {
      if (file.state !== "trashed") marfa.transition(file.id, "active");
    }

    const archiving = await once();
    expect(archiving.code).toBe(0);
    expect(archiving.output).toContain("2 archived with their entries");
    expect(filesOf("e1").map((row) => row.state)).toEqual(["archived"]);
    expect(filesOf("e2").map((row) => row.state)).not.toContain("active");

    marfa.transition(entry("e1").id, "active");
    asked = [];
    const uploads = marfa.uploads;
    const restoring = await once();
    expect(restoring.code).toBe(0);
    expect(restoring.output).toContain("1 brought back with theirs");
    expect(filesOf("e1").map((row) => row.state)).toEqual(["active"]);
    expect(filesOf("e1")).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(marfa.uploads).toBe(uploads);
    expect(marfa.rows.filter((row) => row.type === "rss.picture")).toHaveLength(
      2,
    );

    // Settled: another run changes nothing.
    const version = filesOf("e1")[0]?.version;
    expect((await once()).code).toBe(0);
    expect(filesOf("e1")[0]?.version).toBe(version);
  });

  it("leaves a picture that a person archived, trashed or restored where they put it", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/b.png"] = { body: png(2) };
    pictures["/c.png"] = { body: png(3) };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: img(at("/a.png")) + img(at("/b.png")) + img(at("/c.png")),
      },
    ];
    expect((await once()).code).toBe(0);
    const [first, second, third] = filesOf("e1");
    marfa.transition(first?.id ?? "", "archived");
    marfa.trash(second?.id ?? "");

    // The entry goes out and comes back, so the sweep archives the third.
    marfa.transition(entry("e1").id, "archived");
    expect((await once()).code).toBe(0);
    marfa.transition(entry("e1").id, "active");
    expect((await once()).code).toBe(0);

    const states = new Map(
      filesOf("e1").map((row) => [row.id, row.state] as const),
    );
    expect(states.get(first?.id ?? "")).toBe("archived");
    expect(states.get(second?.id ?? "")).toBe("trashed");
    expect(states.get(third?.id ?? "")).toBe("active");
  });

  it("counts the pictures it archived, not the ones the kit left because a person restored them", async () => {
    pictures["/a.png"] = { body: png(1) };
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/a.png")) },
    ];
    expect((await once()).code).toBe(0);
    marfa.transition(entry("e1").id, "archived");
    expect((await once()).output).toContain("1 archived with their entries");

    // A person restores the picture while its entry is still archived.
    marfa.transition(filesOf("e1")[0]?.id ?? "", "active");
    const again = await once();
    expect(again.code).toBe(0);
    expect(again.output).toContain("0 archived with their entries");
    expect(filesOf("e1").map((row) => row.state)).toEqual(["active"]);
  });

  it("repairs the connection of a picture saved by a run that was stopped before it ended", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/b.png"] = { hang: true };
    documents["/one.json"] = [
      {
        id: "e1",
        title: "One",
        content_html: img(at("/a.png")) + img(at("/b.png")),
      },
    ];
    const child = spawn("node", [built, "--once"], {
      env: environment("save", ["/one.json"]),
      stdio: "ignore",
    });
    const exited = new Promise<void>((done) =>
      child.once("exit", () => {
        done();
      }),
    );
    // The first picture is saved before the second is asked for.
    for (let waited = 0; !asked.includes("/b.png"); waited += 1) {
      if (waited > 600) throw new Error("the second picture was not asked for");
      await new Promise((done) => setTimeout(done, 50));
    }
    child.kill("SIGTERM");
    await exited;

    // The witness: the picture is there, and nothing attaches it.
    const rows = () => marfa.rows.filter((row) => row.type === "rss.picture");
    expect(rows()).toHaveLength(1);
    expect(filesOf("e1")).toEqual([]);

    pictures["/b.png"] = { body: png(2) };
    asked = [];
    expect((await once()).code).toBe(0);
    expect(asked).toEqual(["/b.png"]);
    expect(rows()).toHaveLength(2);
    expect(filesOf("e1")).toHaveLength(2);
    expect(manifest("e1").saved).toHaveLength(2);

    // A settled entry is left alone.
    const versions = rows().map((row) => row.version);
    expect((await once()).code).toBe(0);
    expect(rows().map((row) => row.version)).toEqual(versions);
    expect(rows()).toHaveLength(2);
  }, 60_000);

  it("saves the pictures of an entry in the library, at the library tier, and of one in the feed at the feed tier", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/b.png"] = { body: png(2) };
    documents["/one.json"] = [
      { id: "e1", title: "One" },
      { id: "e2", title: "Two" },
    ];
    expect((await once()).code).toBe(0);
    entry("e1").tier = "library";
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/a.png")) },
      { id: "e2", title: "Two", content_html: img(at("/b.png")) },
    ];
    expect((await once()).code).toBe(0);
    expect(filesOf("e1").map((row) => row.tier)).toEqual(["library"]);
    expect(filesOf("e2").map((row) => row.tier)).toEqual(["feed"]);
  });

  it("fetches a picture from a private host only when the host is its own feed's", async () => {
    pictures["/a.png"] = { body: png(1) };
    pictures["/b.png"] = { body: png(2) };
    // The first feed is at the listed host, and the second at its address.
    documents["/one.json"] = [
      { id: "e1", title: "One", content_html: img(at("/a.png")) },
    ];
    documents["/two.json"] = [
      { id: "e2", title: "Two", content_html: img(at("/b.png")) },
    ];
    const other = `http://127.0.0.1:${String(port)}/two.json`;
    expect((await once("save", ["/one.json", other])).code).toBe(0);

    expect(filesOf("e1")).toHaveLength(1);
    expect(manifest("e1").saved).toEqual([at("/a.png")]);
    expect(filesOf("e2")).toEqual([]);
    expect(manifest("e2").not_kept).toEqual({
      [at("/b.png")]: "private_address",
    });
    expect(asked).toEqual(["/a.png"]);
  });

  describe("save-in-library", () => {
    beforeEach(() => {
      pictures["/a.png"] = { body: png(1) };
      pictures["/b.png"] = { body: png(2) };
      documents["/one.json"] = [
        { id: "e1", title: "One", content_html: img(at("/a.png")) },
      ];
    });

    it("saves nothing for an entry in the feed, and saves once for an entry in the library, at the library tier", async () => {
      expect((await once("save-in-library")).code).toBe(0);
      expect(asked).toEqual([]);
      expect(filesOf("e1")).toEqual([]);
      expect(entry("e1").properties).not.toHaveProperty("rss_pictures");

      entry("e1").tier = "library";
      expect((await once("save-in-library")).code).toBe(0);
      expect(asked).toEqual(["/a.png"]);
      expect(filesOf("e1")).toHaveLength(1);
      expect(filesOf("e1")[0]?.tier).toBe("library");
      expect(manifest("e1").saved).toEqual([at("/a.png")]);

      asked = [];
      const uploads = marfa.uploads;
      expect((await once("save-in-library")).code).toBe(0);
      expect(asked).toEqual([]);
      expect(marfa.uploads).toBe(uploads);
      expect(filesOf("e1")).toHaveLength(1);
    });

    it("keeps the pictures of an entry moved back to the feed, and saves no new ones for it", async () => {
      expect((await once("save-in-library")).code).toBe(0);
      entry("e1").tier = "library";
      expect((await once("save-in-library")).code).toBe(0);
      expect(filesOf("e1")).toHaveLength(1);

      entry("e1").tier = "feed";
      documents["/one.json"] = [
        {
          id: "e1",
          title: "One",
          content_html: img(at("/a.png")) + img(at("/b.png")),
        },
      ];
      asked = [];
      expect((await once("save-in-library")).code).toBe(0);
      expect(asked).toEqual([]);
      expect(filesOf("e1")).toHaveLength(1);
      expect(filesOf("e1")[0]?.state).toBe("active");
      expect(manifest("e1").saved).toEqual([at("/a.png")]);
    });

    it("saves the pictures an entry in the library gains with its text", async () => {
      expect((await once("save-in-library")).code).toBe(0);
      entry("e1").tier = "library";
      expect((await once("save-in-library")).code).toBe(0);
      documents["/one.json"] = [
        {
          id: "e1",
          title: "One",
          content_html: img(at("/a.png")) + img(at("/b.png")),
        },
      ];
      expect((await once("save-in-library")).code).toBe(0);
      expect(filesOf("e1")).toHaveLength(2);
      expect(manifest("e1").saved.sort()).toEqual(
        [at("/a.png"), at("/b.png")].sort(),
      );
    });
  });
});

describe("the addresses an entry points to", () => {
  it("takes the image first and then the Markdown images of the body, each once, https and http alone", () => {
    const body = [
      "![one](https://example.org/1.png)",
      "![again](https://example.org/1.png)",
      '![titled](https://example.org/2.png "A title")',
      "![relative](/3.png)",
      "![data](data:image/png;base64,AAAA)",
      "![plain](http://example.org/4.png)",
      "[not a picture](https://example.org/5.png)",
    ].join("\n");
    expect(addressesOf(body, "https://example.org/cover.png")).toEqual({
      addresses: [
        "https://example.org/cover.png",
        "https://example.org/1.png",
        "https://example.org/2.png",
        "http://example.org/4.png",
      ],
      over: 0,
    });
    expect(addressesOf(undefined, undefined)).toEqual({
      addresses: [],
      over: 0,
    });
  });

  it("leaves out an address that is too long to be one", () => {
    const long = `https://example.org/${"a".repeat(2100)}.png`;
    expect(addressesOf(`![x](${long})`, undefined).addresses).toEqual([]);
  });
});

describe("the hosts a picture may be fetched from", () => {
  const listed = new Set(["feeds.internal.example"]);

  it("allows a listed host for a picture on the host of the entry's own feed", () => {
    expect(
      privateHostsFor(
        listed,
        "https://feeds.internal.example:8443",
        "https://feeds.internal.example/a.png",
      ),
    ).toEqual(new Set(["feeds.internal.example"]));
  });

  it("allows nothing for a picture on another host, a feed that names none, or an address that is not one", () => {
    const own = "https://feeds.internal.example";
    const none = new Set<string>();
    expect(
      privateHostsFor(
        listed,
        "https://other.example",
        "https://feeds.internal.example/a.png",
      ),
    ).toEqual(none);
    expect(privateHostsFor(listed, own, "https://other.example/a.png")).toEqual(
      none,
    );
    expect(
      privateHostsFor(
        listed,
        undefined,
        "https://feeds.internal.example/a.png",
      ),
    ).toEqual(none);
    expect(privateHostsFor(listed, own, "not an address")).toEqual(none);
    expect(
      privateHostsFor(new Set(), own, "https://feeds.internal.example/a.png"),
    ).toEqual(none);
  });
});

describe("the time a pass over pictures may take", () => {
  const entry = (n: number, pictures: number): Row =>
    ({
      id: `entry-${String(n)}`,
      type: "rss.entry",
      source: "rss",
      source_id: `feed:e${String(n)}`,
      state: "active",
      tier: "feed",
      properties: {
        body: Array.from(
          { length: pictures },
          (_, p) => `![](https://pics.example/${String(n)}-${String(p)}.png)`,
        ).join("\n"),
        feed_origin: "https://pics.example",
      },
    }) as unknown as Row;

  async function pass(minutes: number) {
    const entries = [entry(1, 3), entry(2, 2)];
    const saved: Row[] = [];
    const conditions: string[] = [];
    const manifests: unknown[] = [];
    let clock = 0;
    let n = 0;
    const context = {
      held: (type: string) =>
        Promise.resolve(type === "rss.entry" ? entries : saved),
      archive: () => Promise.resolve(),
      derive: (_: string, keys: readonly string[], values: unknown) => {
        manifests.push([keys, values]);
        return Promise.resolve();
      },
      upsert: (
        _: string,
        rows: readonly {
          source_id: string;
          properties: Record<string, unknown>;
        }[],
      ) => {
        for (const row of rows) {
          saved.push({
            id: `picture-${String((n += 1))}`,
            type: "rss.picture",
            source_id: row.source_id,
            state: "active",
            tier: "feed",
            properties: { ...row.properties, blob_ref: "blob" },
          } as unknown as Row);
        }
        return Promise.resolve();
      },
      inspect: (_: string, by: { source_ids: readonly string[] }) =>
        Promise.resolve({
          items: saved.filter((row) =>
            by.source_ids.includes(row.source_id ?? ""),
          ),
          tombstones: [],
        }),
      linked: () => Promise.resolve(saved),
      signal: new AbortController().signal,
      log: {
        condition: (_: string, text: string) => void conditions.push(text),
      },
    };
    const done = await savePictures(context as never, {
      setting: "save",
      privateHosts: new Set(),
      now: () => clock,
      fetch: () => {
        clock += minutes * 60_000;
        return Promise.resolve({
          ok: true,
          bytes: Uint8Array.of(1, 2, 3, n),
          mime_type: "image/png",
          width: 8,
          height: 8,
          url: "https://pics.example/x.png",
        } satisfies Picture);
      },
    });
    return { done, conditions, manifests, saved };
  }

  it("is ten minutes", () => {
    expect(maxPassMs).toBe(10 * 60 * 1000);
  });

  it("starts no fetch after that, leaves the rest pending for the next run, and says so", async () => {
    // Each fetch takes four minutes: three start before the tenth minute.
    const slow = await pass(4);
    expect(slow.done.fetched).toBe(3);
    expect(slow.done.saved).toBe(3);
    expect(slow.done.left).toBe(2);
    expect(slow.conditions).toHaveLength(1);
    expect(slow.conditions[0]).toContain("10 minutes");
    const pending = slow.manifests.flatMap((one) => {
      const [, values] = one as [
        unknown,
        { rss_pictures: { pending: string[] } },
      ];
      return values.rss_pictures.pending;
    });
    expect(pending).toHaveLength(2);
  });

  it("raises nothing when every picture was fetched in time", async () => {
    const quick = await pass(0);
    expect(quick.done.saved).toBe(5);
    expect(quick.done.left).toBe(0);
    expect(quick.conditions).toEqual([]);
  });
});
