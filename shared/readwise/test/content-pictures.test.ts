import { describe, expect, it, vi } from "vitest";
import type { Entry, Item } from "@withmarfa/connector";
import type { Picture } from "@withmarfa/connector/pictures";
import {
  drainContent,
  PictureBudget,
  type PictureWork,
} from "../src/content-queue.js";
import {
  contentQueue,
  digest,
  enqueueContent,
  pictureResourceId,
  type ContentJob,
  type Resource,
} from "../src/content.js";
import type { ReaderDocument } from "../src/reader.js";

const canonical = "sample:reader-document:one";
const png = (address: string): Picture => ({
  ok: true,
  bytes: new TextEncoder().encode(`png ${address}`),
  mime_type: "image/png",
  width: 10,
  height: 10,
  url: address,
});

function fixture(tier: "feed" | "library" = "feed") {
  const rows = new Map<string, Item>();
  const uploads: string[] = [];
  const writes: Entry[] = [];
  const state = new Map<string, unknown>();
  rows.set(canonical, {
    id: "one",
    type: "readwise.source",
    source_id: canonical,
    tier,
    properties: { account: "sample" },
    state: "active",
  } as unknown as Item);
  const checkpoint = {
    get: (key: string) => structuredClone(state.get(key)),
    checkpoint: (key: string, value: unknown) => {
      state.set(key, structuredClone(value));
      return Promise.resolve({ committed: true as const });
    },
  };
  const context: Parameters<typeof drainContent>[0] = {
    signal: new AbortController().signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      condition: vi.fn(),
      unreached: vi.fn(),
    },
    known: (_type, keys) =>
      Promise.resolve(new Set(keys.filter((key) => rows.has(key)))),
    inspect: (_type, by) =>
      Promise.resolve({
        items: by.links.flatMap((key) => {
          const row = rows.get(key);
          return row ? [row] : [];
        }),
        tombstones: [],
      }),
    forScope: () => ({
      state: checkpoint,
      async upsert(type, entries: readonly Entry[]) {
        for (const value of entries) {
          writes.push(value);
          const prior = rows.get(value.source_id);
          let blob = prior?.properties["blob_ref"];
          if (value.file && value.file.key !== prior?.properties["file_key"]) {
            const loaded = await value.file.load(context.signal);
            uploads.push(value.source_id);
            blob = `sha256:${digest(
              new Uint8Array(await new Response(loaded.bytes).arrayBuffer()),
            )}`;
          }
          rows.set(value.source_id, {
            id: value.source_id,
            source_id: value.source_id,
            type,
            tier: prior?.tier ?? value.tier ?? "feed",
            state: prior?.state ?? "active",
            properties: {
              ...value.properties,
              file_key: value.file?.key,
              blob_ref: blob,
            },
          } as unknown as Item);
        }
      },
    }),
  };
  const manifest = () =>
    rows.get(`${canonical}:content:manifest`)?.properties as
      Record<string, unknown> | undefined;
  return { rows, uploads, writes, checkpoint, context, manifest, state };
}

/** The manifest's resources, read back from the bytes the fixture hashed. */
async function resources(
  f: ReturnType<typeof fixture>,
  run: () => Promise<void>,
): Promise<Resource[]> {
  let text = "";
  const upsert = f.context.forScope("x").upsert;
  f.context.forScope = () => ({
    state: f.checkpoint,
    async upsert(type, entries) {
      for (const value of entries)
        if (value.source_id.endsWith(":content:manifest") && value.file) {
          const loaded = await value.file.load(f.context.signal);
          text = await new Response(loaded.bytes).text();
        }
      await upsert(type, entries);
    },
  });
  await run();
  return (JSON.parse(text) as { resources: Resource[] }).resources;
}

const job = (revision = "r1"): ContentJob => ({
  id: "one",
  canonical,
  type: "readwise.source",
  revision,
});
const reader = (row: ReaderDocument) => ({
  page: () =>
    Promise.resolve({ results: [row], count: 1, nextPageCursor: null }),
  document: () => Promise.resolve(row),
});
const doc = (html: string, image?: string): ReaderDocument => ({
  id: "one",
  category: "article",
  title: "Article",
  updated_at: "2026-10-01T00:00:00Z",
  html_content: html,
  ...(image !== undefined && { image_url: image }),
});
const work = (
  fetch: PictureWork["fetch"],
  setting: PictureWork["setting"] = "save",
  limits?: ConstructorParameters<typeof PictureBudget>[1],
): PictureWork => ({
  setting,
  budget: new PictureBudget(() => 0, limits),
  ...(fetch && { fetch }),
});
const drain = async (
  f: ReturnType<typeof fixture>,
  row: ReaderDocument,
  pictures?: PictureWork,
  now = 0,
) =>
  drainContent(f.context, reader(row), f.checkpoint, {
    now: () => now,
    ...(pictures && { pictures }),
  });
const pictureKey = (address: string) =>
  `${canonical}:content:${pictureResourceId(address)}`;

describe("Reader pictures on other websites", () => {
  const thirdParty = doc(
    '<p><img src="https://cdn.example.com/a.png?w=1&amp;h=2"></p>',
  );
  it("plans, writes and lists them as before while the setting is unset", async () => {
    const f = fixture();
    await enqueueContent(f.checkpoint, [job()]);
    const listed = await resources(f, () => drain(f, thirdParty));
    expect(listed).toEqual([
      {
        id: "html",
        kind: "html",
        status: "kept",
        fileKey: `${canonical}:content:html`,
      },
      {
        id: "original",
        kind: "original",
        status: "unavailable",
        reason: "not-provided",
      },
      {
        id: `image:${digest("https://cdn.example.com/a.png")}`,
        kind: "image",
        status: "deliberately-unkept",
        reason: "third-party",
      },
    ]);
    expect(f.writes.map((entry) => entry.source_id)).toEqual([
      `${canonical}:content:html`,
      `${canonical}:content:manifest`,
    ]);
    expect(f.manifest()?.["reader_revision"]).toBe("r1");
    expect(contentQueue(f.checkpoint)).toEqual([]);

    const witness = fixture();
    const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
    await enqueueContent(witness.checkpoint, [job()]);
    await drain(witness, thirdParty, work(fetch));
    expect(fetch).toHaveBeenCalledWith(
      "https://cdn.example.com/a.png?w=1&h=2",
      expect.anything(),
    );
  });

  it("saves each address once and lets one failure leave the others", async () => {
    const f = fixture();
    const html = [
      '<img src="https://www.example.com/_next/image?url=%2Fa.png&amp;w=640">',
      '<img src="https://www.example.com/_next/image?url=%2Fb.png&amp;w=640">',
      '<img src="https://cdn.example.com/same.png">',
      '<img data-src="https://cdn.example.com/same.png">',
      '<img src="http://cdn.example.com/plain.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="/relative.png">',
      '<img src="https://cdn.example.com/drawing.svg">',
      '<img src="https://cdn.example.com/gone.png">',
      '<img src="https://cdn.example.com/busy.png">',
      '<img srcset="https://cdn.example.com/wide.png 2x" src="https://cdn.example.com/main.png">',
    ].join("");
    const fetch = vi.fn((address: string) =>
      Promise.resolve<Picture>(
        address.endsWith(".svg")
          ? { ok: false, reason: "svg" }
          : address.endsWith("gone.png")
            ? { ok: false, reason: "bad_status", status: 404 }
            : address.endsWith("busy.png")
              ? { ok: false, reason: "bad_status", status: 503 }
              : png(address),
      ),
    );
    const row = doc(html, "https://cdn.example.com/cover.png");
    await enqueueContent(f.checkpoint, [job()]);
    const first = await resources(f, () => drain(f, row, work(fetch)));
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([
      "https://www.example.com/_next/image?url=%2Fa.png&w=640",
      "https://www.example.com/_next/image?url=%2Fb.png&w=640",
      "https://cdn.example.com/same.png",
      "https://cdn.example.com/drawing.svg",
      "https://cdn.example.com/gone.png",
      "https://cdn.example.com/busy.png",
      "https://cdn.example.com/main.png",
      "https://cdn.example.com/cover.png",
    ]);
    const saved = f.rows.get(
      pictureKey("https://www.example.com/_next/image?url=%2Fb.png&w=640"),
    );
    expect(saved?.properties).toMatchObject({
      resource_kind: "picture",
      source_url: "https://www.example.com/_next/image?url=%2Fb.png&w=640",
    });
    expect(
      f.writes.find((entry) => entry.source_id === saved?.source_id)
        ?.connections,
    ).toEqual({
      "attached-to": [{ type: "readwise.source", id: canonical }],
    });
    const status = (list: Resource[], address: string) =>
      list.find((one) => one.id === pictureResourceId(address));
    expect(status(first, "http://cdn.example.com/plain.png")).toMatchObject({
      status: "deliberately-unkept",
      reason: "not_https",
    });
    expect(status(first, "https://cdn.example.com/drawing.svg")).toMatchObject({
      status: "unavailable",
      reason: "svg",
    });
    expect(status(first, "https://cdn.example.com/gone.png")).toMatchObject({
      status: "unavailable",
      reason: "bad_status",
      httpStatus: 404,
    });
    expect(status(first, "https://cdn.example.com/busy.png")).toMatchObject({
      status: "pending",
    });
    expect(status(first, "https://cdn.example.com/cover.png")?.status).toBe(
      "kept",
    );
    expect(f.manifest()?.["preservation"]).toBe("pending");

    // The busy host is asked twice more, a run at a time, and nothing else is.
    fetch.mockClear();
    await drain(f, row, work(fetch), 10 * 60_000);
    const last = await resources(f, () =>
      drain(f, row, work(fetch), 60 * 60_000),
    );
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([
      "https://cdn.example.com/busy.png",
      "https://cdn.example.com/busy.png",
    ]);
    expect(status(last, "https://cdn.example.com/busy.png")).toMatchObject({
      status: "unavailable",
      reason: "bad_status",
      httpStatus: 503,
    });
    expect(status(last, "https://cdn.example.com/gone.png")).toMatchObject({
      status: "unavailable",
      httpStatus: 404,
    });
    expect(f.manifest()?.["preservation"]).toBe("accounted");
    expect(contentQueue(f.checkpoint)).toEqual([]);
  });

  it("fetches no more than 50 pictures of one document", async () => {
    const f = fixture();
    const html = Array.from(
      { length: 55 },
      (_, at) => `<img src="https://cdn.example.com/${String(at)}.png">`,
    ).join("");
    const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
    await enqueueContent(f.checkpoint, [job()]);
    const listed = await resources(f, () => drain(f, doc(html), work(fetch)));
    expect(fetch).toHaveBeenCalledTimes(50);
    expect(
      listed.filter((one) => one.reason === "over-document-limit"),
    ).toHaveLength(5);
    expect(f.manifest()?.["preservation"]).toBe("accounted");
  });

  it("lists a held picture as kept when Highlights writes the manifest", async () => {
    const f = fixture();
    const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
    await enqueueContent(f.checkpoint, [job()]);
    await drain(f, thirdParty, work(fetch));
    fetch.mockClear();
    await enqueueContent(f.checkpoint, [job("r2")]);
    const listed = await resources(f, () => drain(f, thirdParty));
    expect(fetch).not.toHaveBeenCalled();
    expect(
      listed.find(
        (one) =>
          one.id === pictureResourceId("https://cdn.example.com/a.png?w=1&h=2"),
      ),
    ).toMatchObject({ status: "kept" });
    expect(listed.some((one) => one.kind === "image")).toBe(false);
  });

  it("saves the pictures of library documents alone with save-in-library", async () => {
    const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
    const feed = fixture("feed");
    await enqueueContent(feed.checkpoint, [job()]);
    await drain(feed, thirdParty, work(fetch, "save-in-library"));
    expect(fetch).not.toHaveBeenCalled();
    expect(feed.manifest()?.["reader_revision"]).toBe("r1");

    const library = fixture("library");
    await enqueueContent(library.checkpoint, [job()]);
    await drain(library, thirdParty, work(fetch, "save-in-library"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      library.rows.get(pictureKey("https://cdn.example.com/a.png?w=1&h=2"))
        ?.tier,
    ).toBe("library");
  });

  it("does not fetch again a picture removed in Marfa", async () => {
    const f = fixture();
    const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
    await enqueueContent(f.checkpoint, [job()]);
    await drain(f, thirdParty, work(fetch));
    const key = pictureKey("https://cdn.example.com/a.png?w=1&h=2");
    const row = f.rows.get(key);
    if (row) f.rows.set(key, { ...row, state: "trashed" });
    fetch.mockClear();
    await enqueueContent(f.checkpoint, [job("r2")]);
    const listed = await resources(f, () => drain(f, thirdParty, work(fetch)));
    expect(fetch).not.toHaveBeenCalled();
    expect(listed.find((one) => one.kind === "picture")).toMatchObject({
      status: "deliberately-unkept",
      reason: "removed",
    });
  });

  it("reaches a document accounted for before the setting and resumes past a run's limit", async () => {
    const f = fixture();
    const row = doc(
      '<img src="https://cdn.example.com/1.png"><img src="https://cdn.example.com/2.png">',
    );
    await enqueueContent(f.checkpoint, [job()]);
    await drain(f, row);
    expect(f.manifest()?.["preservation"]).toBe("accounted");
    expect(f.uploads).toEqual([
      `${canonical}:content:html`,
      `${canonical}:content:manifest`,
    ]);
    const htmlVersion = f.rows.get(`${canonical}:content:html`);

    // The walk lists the document again with its unchanged revision.
    const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
    await enqueueContent(f.checkpoint, [job()]);
    await drain(
      f,
      row,
      work(fetch, "save", { pictures: 1, bytes: 1024, ms: 60_000 }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.manifest()?.["preservation"]).toBe("pending");
    expect(contentQueue(f.checkpoint)).toEqual([job()]);

    await drain(
      f,
      row,
      work(fetch, "save", { pictures: 1, bytes: 1024, ms: 60_000 }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.manifest()?.["preservation"]).toBe("accounted");
    expect(contentQueue(f.checkpoint)).toEqual([]);
    expect(f.uploads.filter((key) => !key.includes(":picture:"))).toEqual([
      `${canonical}:content:html`,
      `${canonical}:content:manifest`,
      `${canonical}:content:manifest`,
      `${canonical}:content:manifest`,
    ]);
    expect(f.rows.get(`${canonical}:content:html`)).toEqual(htmlVersion);

    // Once accounted for with its pictures, the document is not planned again.
    fetch.mockClear();
    await enqueueContent(f.checkpoint, [job()]);
    await drain(f, row, work(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(contentQueue(f.checkpoint)).toEqual([]);
  });
});
