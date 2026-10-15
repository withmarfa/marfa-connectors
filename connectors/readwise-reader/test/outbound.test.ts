import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Unreachable } from "@withmarfa/connector";
import type {
  Change,
  Entry,
  Item,
  OutboundIntent,
  WatchContext,
} from "@withmarfa/connector";
import { readerIdentity, type ReaderDocument } from "@withmarfa/readwise";
import { onChange, preflight } from "../src/outbound.js";
import { env } from "../src/config.js";
let server: Server;
let base: string;
let token: string;
let rows: Map<string, ReaderDocument>;
let writes: { method: string; path: string; body: Record<string, unknown> }[];
let loseCreate = false;
let losePatch = false;
let badCount = false;
let throttle: "GET" | "PATCH" | "POST" | undefined;
let throttleReadback = false;
beforeEach(async () => {
  token = randomUUID();
  rows = new Map([
    [
      "doc",
      {
        id: "doc",
        category: "article",
        title: "Old",
        author: "Author",
        source_url: "https://example.com/story",
        location: "new",
        tags: { old: {} },
        notes: "Old note",
      },
    ],
  ]);
  writes = [];
  loseCreate = false;
  losePatch = false;
  badCount = false;
  throttle = undefined;
  throttleReadback = false;
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === throttle) {
        response.writeHead(429, { "Retry-After": "60" }).end();
        return;
      }
      if (request.method === "GET") {
        const id = url.searchParams.get("id");
        const result = [...rows.values()].filter(
          (row) => id === null || row.id === id,
        );
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            count: result.length + (badCount ? 1 : 0),
            nextPageCursor: null,
            results: result,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(
        Buffer.concat(chunks).toString() || "{}",
      ) as Record<string, unknown>;
      writes.push({ method: request.method ?? "", path: url.pathname, body });
      let id = decodeURIComponent(
        url.pathname.split("/").filter(Boolean).at(-1) ?? "",
      );
      if (request.method === "POST") {
        if (typeof body["parent_id"] === "string") {
          id = `highlight-${String(rows.size)}`;
          rows.set(id, {
            id,
            category: "highlight",
            parent_id: body["parent_id"],
            content: String(body["content"]),
            notes: typeof body["notes"] === "string" ? body["notes"] : "",
            tags: Object.fromEntries(
              ((body["tags"] as string[] | undefined) ?? []).map((tag) => [
                tag,
                {},
              ]),
            ),
          });
        } else {
          id =
            [...rows.values()].find((row) => row.source_url === body["url"])
              ?.id ?? "new-doc";
          if (!rows.has(id))
            rows.set(id, {
              id,
              category: "article",
              source_url: String(body["url"]),
              title: "Scraped",
            });
        }
        if (loseCreate) {
          response.destroy();
          return;
        }
      } else if (request.method === "DELETE") {
        const doomed = new Set([id]);
        for (;;) {
          const size = doomed.size;
          for (const row of rows.values())
            if (row.parent_id && doomed.has(row.parent_id)) doomed.add(row.id);
          if (size === doomed.size) break;
        }
        for (const key of doomed) rows.delete(key);
        response.writeHead(204).end();
        return;
      } else {
        const row = rows.get(id);
        if (row === undefined) {
          response.writeHead(404).end();
          return;
        }
        Object.assign(
          row,
          body,
          ...(Array.isArray(body["tags"])
            ? [
                {
                  tags: Object.fromEntries(
                    body["tags"].map((tag: string) => [tag, {}]),
                  ),
                },
              ]
            : []),
        );
      }
      if (losePatch && request.method === "PATCH") {
        response.destroy();
        return;
      }
      if (throttleReadback) throttle = "GET";
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no server");
  base = `http://127.0.0.1:${String(address.port)}/api/v3/`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
});
function change(
  kind: Change["kind"] = "updated",
  props: Record<string, unknown> = {},
  type = "readwise.source",
): Change {
  const values = {
    account: "primary",
    reader_managed: true,
    reader_id: "doc",
    canonical_key: readerIdentity("primary", "document", "doc"),
    title: "New",
    ...props,
  };
  return {
    kind,
    changed: new Set(
      Object.keys(props).length ? Object.keys(props) : ["title"],
    ),
    item: {
      id: "local",
      type,
      source: "readwise",
      source_id: "local-key",
      properties: values,
      state: "active",
      version: 1,
      schema_version: 1,
      occurred_at: "2026-10-15T00:00:00Z",
      created_at: "2026-10-15T00:00:00Z",
      updated_at: "2026-10-15T00:00:00Z",
    },
  };
}
function context(propagatePurge = false) {
  let intent: OutboundIntent | undefined;
  let answer: Entry | undefined;
  let link: string | undefined;
  let refuseSave = false;
  const value = {
    env: {
      READWISE_ACCOUNT: "primary",
      READWISE_ACCESS_TOKEN: token,
      READWISE_READER_API_URL: base,
      READWISE_READER_PROPAGATE_PURGE: String(propagatePurge),
    },
    signal: new AbortController().signal,
    waitUntil: () => Promise.reject(new Error("unexpected rate-limit wait")),
    outbound: {
      get: () => intent && structuredClone(intent),
      save: (
        captured: Change,
        saved: Pick<OutboundIntent, "request" | "baseline">,
      ) => {
        if (refuseSave) return Promise.reject(new Error("storage refused"));
        intent = {
          token: "token",
          change: structuredClone(captured),
          ...structuredClone(saved),
          acknowledged: false,
        };
        return Promise.resolve(structuredClone(intent));
      },
      advance: (
        _id: string,
        _token: string,
        next: Pick<OutboundIntent, "request" | "baseline">,
      ) => {
        if (!intent) throw new Error("no intent");
        intent = { ...intent, ...structuredClone(next), token: "next-token" };
        return Promise.resolve(structuredClone(intent));
      },
      prepareRetry: () => {
        if (intent) {
          const next = { ...intent };
          Reflect.deleteProperty(next, "requestNotApplied");
          intent = next;
        }
        return Promise.resolve();
      },
      acknowledge: (_id: string, _token: string, entry?: Entry) => {
        if (intent) intent = { ...intent, acknowledged: true };
        answer = entry;
        return Promise.resolve();
      },
    },
    setLink: (_item: Item, key: string) => {
      link = key;
      return Promise.resolve();
    },
    log: { condition: () => undefined, clear: () => undefined },
  } as unknown as WatchContext<typeof env>;
  return {
    value,
    intent: () => intent,
    answer: () => answer,
    link: () => link,
    refuse: () => {
      refuseSave = true;
    },
  };
}
it("sends only supported changed fields, including explicit note and tag clears, and reads back", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  await onChange(
    change("updated", {
      notes: undefined,
      tags: [],
      description: "Summary",
      url: "https://elsewhere.example",
    }),
    c.value,
  );
  expect(writes).toEqual([
    {
      method: "PATCH",
      path: "/api/v3/update/doc/",
      body: { notes: "", tags: [], summary: "Summary" },
    },
  ]);
  expect(c.intent()?.acknowledged).toBe(true);
  expect(c.answer()?.properties["description"]).toBe("Summary");
});
it("never mutates before durable request storage or without preflight", async () => {
  const c = context();
  await expect(onChange(change(), c.value)).rejects.toThrow("preflight");
  await preflight({ purges: [] }, c.value);
  c.refuse();
  await expect(onChange(change(), c.value)).rejects.toThrow("storage refused");
  expect(writes).toHaveLength(0);
});
it("does not recreate a missing update, and trash is local", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  rows.delete("doc");
  await expect(onChange(change(), c.value)).rejects.toThrow("missing");
  await onChange(change("trashed"), c.value);
  expect(writes).toHaveLength(0);
});
it("reads an existing stable URL save and applies intended values", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  await onChange(
    change("created", {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      url: "https://example.com/story",
      title: "Intended",
    }),
    c.value,
  );
  expect(writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
  expect(writes[0]?.body).toEqual({ url: "https://example.com/story" });
  expect(rows.get("doc")?.title).toBe("Intended");
  expect(c.link()).toBe(readerIdentity("primary", "document", "doc"));
});
it("adopts exactly one new highlight after an uncertain create, excluding old matches", async () => {
  rows.set("old", {
    id: "old",
    category: "highlight",
    parent_id: "doc",
    content: "Passage",
    notes: "",
    tags: {},
  });
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change(
    "created",
    {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      reader_parent_id: "doc",
      text: "Passage",
    },
    "readwise.highlight",
  );
  loseCreate = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  loseCreate = false;
  await onChange(made, c.value);
  expect(writes).toHaveLength(1);
  expect(c.link()).toBe(readerIdentity("primary", "highlight", "highlight-2"));
});
it("does not blindly retry an uncertain highlight with no new match", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change(
    "created",
    {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      reader_parent_id: "doc",
      text: "Passage",
    },
    "readwise.highlight",
  );
  loseCreate = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  rows.delete("highlight-1");
  loseCreate = false;
  await expect(onChange(made, c.value)).rejects.toBeInstanceOf(Unreachable);
  expect(writes).toHaveLength(1);
});
it("blocks every mutation when purges plus vendor cascades exceed twenty", async () => {
  for (let i = 0; i < 20; i++)
    rows.set(`child${String(i)}`, {
      id: `child${String(i)}`,
      category: "highlight",
      parent_id: "doc",
      content: "text",
    });
  const c = context(true);
  await expect(
    preflight({ purges: [change("purged")] }, c.value),
  ).rejects.toThrow("20");
  await expect(onChange(change(), c.value)).rejects.toThrow("preflight");
  expect(writes).toHaveLength(0);
});
it("rejects an incomplete purge inventory but allows the twenty-row boundary", async () => {
  const c = context(true);
  badCount = true;
  await expect(
    preflight({ purges: [change("purged")] }, c.value),
  ).rejects.toThrow("complete");
  badCount = false;
  for (let i = 0; i < 19; i++)
    rows.set(`child${String(i)}`, {
      id: `child${String(i)}`,
      category: "highlight",
      parent_id: "doc",
      content: "text",
    });
  await preflight({ purges: [change("purged")] }, c.value);
  await onChange(change("purged"), c.value);
  expect(writes).toHaveLength(1);
  expect(rows.size).toBe(0);
});
it("refuses a malformed saved create baseline before making another request", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change("created", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_managed: undefined,
    reader_create: true,
    url: "https://example.com/story",
    title: "Intended",
  });
  loseCreate = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  const pending = c.intent();
  if (pending === undefined) throw new Error("no pending intent");
  Object.assign(pending, { baseline: { ids: [], existing: "invalid" } });
  loseCreate = false;
  await expect(onChange(made, c.value)).rejects.toThrow();
  expect(writes).toHaveLength(1);
});
it("retains an uncertain update without overwriting a later vendor edit", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const original = c.value.outbound.acknowledge.bind(c.value.outbound);
  Object.assign(c.value.outbound, {
    acknowledge: () => Promise.reject(new Error("lost confirmation")),
  });
  await expect(onChange(change(), c.value)).rejects.toThrow(
    "lost confirmation",
  );
  const row = rows.get("doc");
  if (!row) throw new Error("no row");
  row.title = "Changed at vendor";
  Object.assign(c.value.outbound, { acknowledge: original });
  await expect(onChange(change(), c.value)).rejects.toThrow("baseline");
  expect(writes).toHaveLength(1);
  expect(row.title).toBe("Changed at vendor");
});
it("refuses two new matching highlights after an uncertain create", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change(
    "created",
    {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      reader_parent_id: "doc",
      text: "Passage",
    },
    "readwise.highlight",
  );
  loseCreate = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  rows.set("other-new", {
    id: "other-new",
    category: "highlight",
    parent_id: "doc",
    content: "Passage",
    notes: "",
    tags: {},
  });
  loseCreate = false;
  await expect(onChange(made, c.value)).rejects.toThrow("uncertain");
  expect(writes).toHaveLength(1);
  expect(c.link()).toBeUndefined();
});
it("leaves highlight text and local trash unchanged at the vendor", async () => {
  rows.set("highlight", {
    id: "highlight",
    category: "highlight",
    parent_id: "doc",
    content: "Original",
    notes: "Before",
    tags: { old: {} },
  });
  const c = context();
  await preflight({ purges: [] }, c.value);
  await onChange(
    change(
      "updated",
      {
        reader_id: "highlight",
        canonical_key: readerIdentity("primary", "highlight", "highlight"),
        text: "Edited local text",
        note: "",
        tags: [],
      },
      "readwise.highlight",
    ),
    c.value,
  );
  expect(writes[0]?.body).toEqual({ notes: "", tags: [] });
  expect(rows.get("highlight")?.content).toBe("Original");
});
it("does not recreate a known URL document deleted during create recovery", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change("created", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_managed: undefined,
    reader_create: true,
    url: "https://example.com/story",
    title: "Intended",
  });
  loseCreate = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  rows.delete("doc");
  loseCreate = false;
  await expect(onChange(made, c.value)).rejects.toThrow("missing");
  expect(writes).toHaveLength(1);
  expect(rows.size).toBe(0);
});

it.each(["baseline", "write", "readback"] as const)(
  "returns a durable retry deadline for Reader %s throttling",
  async (stage) => {
    const c = context(true);
    await preflight({ purges: [] }, c.value);
    if (stage === "baseline") throttle = "GET";
    if (stage === "write") throttle = "PATCH";
    if (stage === "readback") throttleReadback = true;
    const before = Date.now();
    const error: unknown = await onChange(change(), c.value).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ name: "Unreachable", scope: "Reader" });
    if (
      !(error instanceof Error) ||
      !("retryAt" in error) ||
      typeof error.retryAt !== "string"
    )
      throw new Error("missing durable retry deadline");
    expect(Date.parse(error.retryAt)).toBeGreaterThanOrEqual(before + 60000);
    expect(c.intent()?.acknowledged).not.toBe(true);
  },
);

it("retries a highlight only after consuming proven no-apply evidence from POST429", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change(
    "created",
    {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      reader_parent_id: "doc",
      text: "Passage",
    },
    "readwise.highlight",
  );
  throttle = "POST";
  const error: unknown = await onChange(made, c.value).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ name: "Unreachable", requestNotApplied: true });
  expect(writes).toHaveLength(0);
  const intent = c.intent();
  if (!intent) throw new Error("no intent");
  Object.assign(intent, { requestNotApplied: true });
  throttle = undefined;
  await onChange(made, c.value);
  expect(writes).toHaveLength(1);
  expect(c.intent()?.requestNotApplied).toBeUndefined();
});
it("does not treat a throttled highlight readback as a rejected create", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change(
    "created",
    {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      reader_parent_id: "doc",
      text: "Passage",
    },
    "readwise.highlight",
  );
  throttleReadback = true;
  const error: unknown = await onChange(made, c.value).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ name: "Unreachable" });
  expect(error).not.toHaveProperty("requestNotApplied", true);
  expect(writes).toHaveLength(1);
  throttle = undefined;
  throttleReadback = false;
  await onChange(made, c.value);
  expect(writes).toHaveLength(1);
});

it("recovers a lost new document save response before applying the captured update", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change("created", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_managed: undefined,
    reader_create: true,
    url: "https://example.com/new",
    title: "Intended",
  });
  loseCreate = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  expect(writes).toHaveLength(1);
  loseCreate = false;
  await onChange(made, c.value);
  expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  expect(rows.get("new-doc")?.title).toBe("Intended");
});
it("sends no patch after losing the phase replacement acknowledgment, then resumes the saved phase", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change("created", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_managed: undefined,
    reader_create: true,
    url: "https://example.com/new",
    title: "Intended",
  });
  const advance = c.value.outbound.advance.bind(c.value.outbound);
  Object.assign(c.value.outbound, {
    advance: async (...args: Parameters<typeof advance>) => {
      await advance(...args);
      throw new Error("lost phase ACK");
    },
  });
  await expect(onChange(made, c.value)).rejects.toThrow("lost phase ACK");
  expect(writes.map((write) => write.method)).toEqual(["POST"]);
  Object.assign(c.value.outbound, { advance });
  await onChange(made, c.value);
  expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  expect(rows.get("new-doc")?.title).toBe("Intended");
});

it("recovers a source patch with a lost response without replaying either phase", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change("created", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_managed: undefined,
    reader_create: true,
    url: "https://example.com/new",
    title: "Intended",
  });
  losePatch = true;
  await expect(onChange(made, c.value)).rejects.toThrow();
  expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  losePatch = false;
  await onChange(made, c.value);
  expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  expect(c.intent()?.acknowledged).toBe(true);
});
it("does not patch when phase replacement was refused and later resumes from the saved URL step", async () => {
  const c = context();
  await preflight({ purges: [] }, c.value);
  const made = change("created", {
    reader_id: undefined,
    canonical_key: undefined,
    reader_managed: undefined,
    reader_create: true,
    url: "https://example.com/new",
    title: "Intended",
  });
  const advance = c.value.outbound.advance.bind(c.value.outbound);
  Object.assign(c.value.outbound, {
    advance: () => Promise.reject(new Error("replacement refused")),
  });
  await expect(onChange(made, c.value)).rejects.toThrow("replacement refused");
  expect(writes).toHaveLength(1);
  Object.assign(c.value.outbound, { advance });
  await onChange(made, c.value);
  expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
});

it.each([
  ["title", "title", "Intended", "Newer"],
  ["author", "author", "Intended author", "Newer author"],
  ["description", "summary", "Intended summary", "Newer summary"],
  ["notes", "notes", "Intended note", "Newer note"],
  ["tags", "tags", ["intended"], { newer: {} }],
  ["reader_location", "location", "later", "archive"],
  ["category", "category", "article", "email"],
  ["language", "language", "en", "fr"],
  ["published_at", "published_date", "2026-10-14", "2026-10-15"],
  [
    "image_url",
    "image_url",
    "https://example.com/intended.png",
    "https://example.com/newer.png",
  ],
])(
  "retains the original existing URL %s baseline after a lost save response",
  async (field, vendorField, intended, newer) => {
    const c = context();
    await preflight({ purges: [] }, c.value);
    const made = change("created", {
      reader_id: undefined,
      canonical_key: undefined,
      reader_managed: undefined,
      reader_create: true,
      url: "https://example.com/story",
      [field]: intended,
    });
    loseCreate = true;
    await expect(onChange(made, c.value)).rejects.toThrow();
    const row = rows.get("doc");
    if (!row) throw new Error("no row");
    Object.assign(row, { [vendorField]: newer });
    loseCreate = false;
    await expect(onChange(made, c.value)).rejects.toThrow("baseline");
    expect(writes.map((write) => write.method)).toEqual(["POST"]);
    expect(row[vendorField as keyof ReaderDocument]).toEqual(newer);
    expect(c.intent()?.acknowledged).toBe(false);
    expect(c.link()).toBeUndefined();
  },
);

it("waits for durable Retry-After permission before resuming a throttled purge preflight", async () => {
  const c = context(true);
  throttle = "GET";
  const before = Date.now();
  const wait = vi.fn((until: string) => {
    expect(Date.parse(until)).toBeGreaterThanOrEqual(before + 60_000);
    expect(writes).toHaveLength(0);
    throttle = undefined;
    return Promise.resolve();
  });
  Object.assign(c.value, { waitUntil: wait });
  await preflight({ purges: [change("purged")] }, c.value);
  expect(wait).toHaveBeenCalledOnce();
  expect(writes).toHaveLength(0);
  await onChange(change("purged"), c.value);
  expect(writes.map((write) => write.method)).toEqual(["DELETE"]);
});

it("makes no mutation if the retry deadline cannot be acknowledged", async () => {
  const c = context(true);
  throttle = "GET";
  Object.assign(c.value, {
    waitUntil: () => Promise.reject(new Error("deadline ACK lost")),
  });
  await expect(
    preflight({ purges: [change("purged")] }, c.value),
  ).rejects.toThrow("deadline ACK lost");
  throttle = undefined;
  await expect(onChange(change(), c.value)).rejects.toThrow("preflight");
  expect(writes).toHaveLength(0);
});
