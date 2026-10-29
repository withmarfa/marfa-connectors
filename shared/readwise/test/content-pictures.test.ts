import { describe, expect, it, vi } from "vitest";
import type { Entry, Item } from "@withmarfa/connector";
import type { Picture } from "@withmarfa/connector/pictures";
import { drainContent } from "../src/content-queue.js";
import {
  admitPictures,
  drainPictures,
  PictureBudget,
  pictureListing,
} from "../src/content-pictures.js";
import {
  contentQueue,
  digest,
  enqueueContent,
  pictureResourceId,
  type ContentJob,
  type Resource,
} from "../src/content.js";
import type { ReaderDocument } from "../src/reader.js";

const png = (address: string): Picture => ({
  ok: true,
  bytes: new TextEncoder().encode(`png ${address}`),
  mime_type: "image/png",
  width: 10,
  height: 10,
  url: address,
});
const key = (id: string) => `sample:reader-document:${id}`;
const doc = (id: string, html: string): ReaderDocument => ({
  id,
  category: "article",
  title: "Article",
  updated_at: "2026-10-01T00:00:00Z",
  html_content: html,
});
const job = (id: string, revision = "r1"): ContentJob => ({
  id,
  canonical: key(id),
  type: "readwise.source",
  revision,
});
const pictureKey = (id: string, address: string) =>
  `${key(id)}:content:${pictureResourceId(address)}`;

/**
 * One Marfa shared by two connectors. Each has its own agreements, so
 * `known` answers only what that connector wrote, and a connection a run
 * names lands only when the run ends.
 */
function marfa(documents: ReaderDocument[], tier: "feed" | "library" = "feed") {
  const rows = new Map<string, Item>();
  const landed = new Map<string, string[]>();
  const named = new Map<string, string[]>();
  const agreed = { reader: new Set<string>(), highlights: new Set<string>() };
  const uploads: string[] = [];
  const manifests = new Map<string, Resource[]>();
  const states = {
    reader: new Map<string, unknown>(),
    highlights: new Map<string, unknown>(),
  };
  const fetch = vi.fn((address: string) => Promise.resolve(png(address)));
  let clock = 0;
  for (const one of documents)
    rows.set(key(one.id), {
      id: key(one.id),
      type: "readwise.source",
      source_id: key(one.id),
      tier,
      properties: { account: "sample", canonical_key: key(one.id) },
      state: "active",
    } as unknown as Item);
  const reader = {
    calls: 0,
    page: ({ id }: { id?: string }) => {
      reader.calls++;
      const row = documents.find((one) => one.id === id);
      return Promise.resolve({
        results: row ? [row] : [],
        count: row ? 1 : 0,
        nextPageCursor: null,
      });
    },
    document: (id: string) =>
      Promise.resolve(documents.find((one) => one.id === id)),
  };
  const checkpoint = (who: keyof typeof states) => ({
    get: (name: string) => structuredClone(states[who].get(name)),
    checkpoint: (name: string, value: unknown) => {
      states[who].set(name, structuredClone(value));
      return Promise.resolve({ committed: true as const });
    },
  });
  const context = (who: keyof typeof agreed) => ({
    signal: new AbortController().signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      condition: vi.fn(),
      unreached: vi.fn(),
    },
    known: (_type: string, keys: readonly string[]) =>
      Promise.resolve(new Set(keys.filter((one) => agreed[who].has(one)))),
    inspect: (_type: string, by: { links: readonly string[] }) =>
      Promise.resolve({
        items: by.links.flatMap((one) => rows.get(one) ?? []),
        tombstones: [],
      }),
    linked: (
      _type: string,
      _connection: string,
      target: { type: string; id: string },
    ) =>
      Promise.resolve(
        [...rows.values()].filter(
          (row) =>
            row.state === "active" &&
            landed.get(row.source_id ?? "")?.includes(target.id),
        ),
      ),
    held: (type: string) =>
      Promise.resolve([...rows.values()].filter((row) => row.type === type)),
    forScope: () => ({
      state: checkpoint(who),
      async upsert(type: string, entries: readonly Entry[]) {
        for (const value of entries) {
          const prior = rows.get(value.source_id);
          let blob = prior?.properties["blob_ref"];
          if (value.file && value.file.key !== prior?.properties["file_key"]) {
            const loaded = await value.file.load(new AbortController().signal);
            const bytes = new Uint8Array(
              await new Response(loaded.bytes).arrayBuffer(),
            );
            uploads.push(value.source_id);
            blob = `sha256:${digest(bytes)}`;
            if (value.source_id.endsWith(":content:manifest"))
              manifests.set(
                value.source_id,
                (
                  JSON.parse(new TextDecoder().decode(bytes)) as {
                    resources: Resource[];
                  }
                ).resources,
              );
          }
          agreed[who].add(value.source_id);
          const target = value.connections?.["attached-to"]?.map(
            (one) => one.id,
          );
          if (target) named.set(value.source_id, target);
          rows.set(value.source_id, {
            id: value.source_id,
            source_id: value.source_id,
            type,
            tier: prior?.tier ?? value.tier ?? "feed",
            state: prior?.state ?? "active",
            properties: {
              ...value.properties,
              file_key: value.file?.key ?? prior?.properties["file_key"],
              blob_ref: blob,
            },
          } as unknown as Item);
        }
      },
    }),
  });
  /** A run of a connector, ending with its connections written. */
  const run = async (
    who: keyof typeof agreed,
    jobs: ContentJob[],
    options: {
      setting?: "save" | "save-in-library";
      limits?: ConstructorParameters<typeof PictureBudget>[1];
      land?: boolean;
    } = {},
  ) => {
    const ctx = context(who);
    const state = checkpoint(who);
    if (jobs.length) await enqueueContent(state, jobs);
    if (options.setting && jobs.length)
      await admitPictures(state, jobs, ctx.log);
    await drainContent(ctx, reader, state, {
      now: () => clock,
      ...(options.setting && {
        pictures: pictureListing(state, options.setting),
      }),
    });
    if (options.setting)
      await drainPictures(ctx, reader, state, {
        setting: options.setting,
        account: "sample",
        contentState: state,
        now: () => clock,
        fetch,
        budget: new PictureBudget(() => clock, options.limits),
      });
    if (options.land !== false)
      for (const [one, targets] of named) landed.set(one, targets);
    named.clear();
  };
  const picture = (id: string, address: string) =>
    manifests
      .get(`${key(id)}:content:manifest`)
      ?.find((one) => one.id === pictureResourceId(address));
  return {
    rows,
    uploads,
    manifests,
    states,
    fetch,
    reader,
    run,
    picture,
    context,
    checkpoint,
    now: () => clock,
    tick: (ms: number) => (clock += ms),
  };
}

const a = "https://cdn.example.com/a.png?w=1&h=2";
const thirdParty = doc(
  "one",
  '<p><img src="https://cdn.example.com/a.png?w=1&amp;h=2"></p>',
);

describe("Reader pictures on other websites", () => {
  it("plans, writes and lists them as before while the setting is unset", async () => {
    const m = marfa([thirdParty]);
    await m.run("reader", [job("one")]);
    expect(m.manifests.get(`${key("one")}:content:manifest`)).toEqual([
      {
        id: "html",
        kind: "html",
        status: "kept",
        fileKey: `${key("one")}:content:html`,
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
    expect(m.uploads).toEqual([
      `${key("one")}:content:html`,
      `${key("one")}:content:manifest`,
    ]);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.states.reader.has("pictures")).toBe(false);

    const witness = marfa([thirdParty]);
    await witness.run("reader", [job("one")], { setting: "save" });
    expect(witness.fetch).toHaveBeenCalledWith(a, expect.anything());
  });

  it("lists a picture Reader saved as kept when Highlights, with its own agreements, writes the manifest", async () => {
    const m = marfa([thirdParty]);
    await m.run("reader", [job("one")], { setting: "save" });
    await m.run("highlights", [job("one", "r2")]);
    expect(m.picture("one", a)).toMatchObject({
      kind: "picture",
      status: "kept",
    });
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves the manifest stable when the two connectors alternate, fetching nothing again", async () => {
    const html = [
      '<img src="https://cdn.example.com/a.png?w=1&amp;h=2">',
      '<img src="https://cdn.example.com/gone.png">',
      '<img src="https://cdn.example.com/busy.png">',
    ].join("");
    const m = marfa([doc("one", html)]);
    m.fetch.mockImplementation((address: string) =>
      Promise.resolve<Picture>(
        address.endsWith("gone.png")
          ? { ok: false, reason: "bad_status", status: 404 }
          : address.endsWith("busy.png")
            ? { ok: false, reason: "bad_status", status: 503 }
            : png(address),
      ),
    );
    for (let round = 0; round < 4; round++) {
      await m.run("reader", round === 0 ? [job("one")] : [], {
        setting: "save",
      });
      await m.run("highlights", [job("one")]);
    }
    const manifests = () =>
      m.uploads.filter((one) => one.endsWith(":manifest"));
    const settled = manifests().length;
    await m.run("reader", [job("one")], { setting: "save" });
    await m.run("highlights", [job("one")]);
    expect(manifests()).toHaveLength(settled);
    expect(m.fetch.mock.calls.map(([address]) => address)).toEqual([
      a,
      "https://cdn.example.com/gone.png",
      "https://cdn.example.com/busy.png",
      "https://cdn.example.com/busy.png",
      "https://cdn.example.com/busy.png",
    ]);
    expect(m.picture("one", a)?.status).toBe("kept");
    expect(m.picture("one", "https://cdn.example.com/gone.png")).toMatchObject({
      status: "unavailable",
      reason: "bad_status",
      httpStatus: 404,
    });
    expect(m.picture("one", "https://cdn.example.com/busy.png")).toMatchObject({
      status: "unavailable",
      httpStatus: 503,
    });
    expect(
      m.rows.get(`${key("one")}:content:manifest`)?.properties,
    ).toMatchObject({
      reader_revision: "r1",
      preservation: "accounted",
    });
  });

  it("repairs a saved picture that lacks its link and lists it as kept only once it has one", async () => {
    const m = marfa([thirdParty]);
    await m.run("reader", [job("one")], { setting: "save", land: false });
    await m.run("reader", [], { setting: "save" });
    expect(m.picture("one", a)?.status).not.toBe("kept");
    await m.run("reader", [], { setting: "save" });
    expect(m.picture("one", a)?.status).toBe("kept");
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it("starts the picture time limit at the first fetch, not with the run", async () => {
    const m = marfa([thirdParty]);
    const budget = new PictureBudget(m.now);
    m.tick(11 * 60_000);
    const state = m.checkpoint("reader");
    const ctx = m.context("reader");
    await enqueueContent(state, [job("one")]);
    await admitPictures(state, [job("one")], ctx.log);
    await drainContent(ctx, m.reader, state);
    await drainPictures(ctx, m.reader, state, {
      setting: "save",
      account: "sample",
      contentState: state,
      fetch: m.fetch,
      budget,
    });
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it("lets a new document be listed and preserved while a backfill waits past a run's limit", async () => {
    const old = ["b", "c", "d"].map((id) =>
      doc(
        id,
        `<img src="https://cdn.example.com/${id}1.png"><img src="https://cdn.example.com/${id}2.png">`,
      ),
    );
    const fresh = doc("e", '<img src="https://cdn.example.com/e.png">');
    const m = marfa([...old, fresh]);
    await m.run(
      "reader",
      old.map((one) => job(one.id)),
    );
    const limits = { pictures: 2, bytes: 1024, ms: 60_000 };
    await m.run("reader", [], { setting: "save", limits });
    expect(m.fetch).toHaveBeenCalledTimes(2);
    const calls = m.reader.calls;

    m.rows.set(key("e"), {
      ...m.rows.get(key("b")),
      id: key("e"),
      source_id: key("e"),
      properties: { account: "sample", canonical_key: key("e") },
    } as Item);
    await m.run("reader", [job("e")], { setting: "save", limits });
    expect(
      m.rows.get(`${key("e")}:content:manifest`)?.properties["preservation"],
    ).toBe("accounted");
    expect(contentQueue(m.checkpoint("reader"))).toEqual([]);
    expect(m.fetch).toHaveBeenCalledTimes(4);
    // Once the run's limit is reached, no document waiting for pictures is asked for.
    expect(m.reader.calls - calls).toBeLessThanOrEqual(3);
  });

  it("saves the pictures of library documents alone with save-in-library", async () => {
    const feed = marfa([thirdParty], "feed");
    await feed.run("reader", [job("one")], { setting: "save-in-library" });
    expect(feed.fetch).not.toHaveBeenCalled();
    const library = marfa([thirdParty], "library");
    await library.run("reader", [job("one")], { setting: "save-in-library" });
    expect(library.fetch).toHaveBeenCalledTimes(1);
    expect(library.rows.get(pictureKey("one", a))?.tier).toBe("library");
  });
});
