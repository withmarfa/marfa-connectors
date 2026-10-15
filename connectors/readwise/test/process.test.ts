import { execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import type { ExportPage } from "@withmarfa/readwise";

const exec = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const children = new Map<ChildProcess, Promise<unknown>>();
let marfa: ScriptedServer;
let vendor: Server;
let base: string;
let pages: ExportPage[];
let readerRows: Record<string, unknown>[];
let status: number;
let retryAfter: string | undefined;
let asked: URL[];
let failCursor: string | undefined;
const source = (id: number) => ({
  user_book_id: id,
  title: `Source ${String(id)}`,
  source: "reader",
  external_id: `reader-${String(id)}`,
  highlights: [
    {
      id,
      text: "Full passage 漢字\n",
      note: "Annotation",
      updated_at: new Date().toISOString(),
      location_type: "offset",
      location: 5,
    },
  ],
});

beforeEach(async () => {
  marfa = await new ScriptedServer("readwise", {
    types: ["readwise.source", "readwise.highlight", "readwise.file"],
    edges: ["references", "attached-to"],
  }).start();
  marfa.advance(Date.now() - Date.parse("2026-09-25T00:00:00.000Z"));
  marfa.types.set("core.media", {
    id: "core.media",
    fields: Object.fromEntries(
      ["title", "author", "description", "notes", "url", "image_url"].map(
        (name) => [name, { type: "string" }],
      ),
    ),
  });
  marfa.types.set("core.highlight", {
    id: "core.highlight",
    fields: Object.fromEntries(
      [
        "text",
        "note",
        "color",
        "locator_type",
        "start_location",
        "end_location",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  marfa.types.set("core.file", {
    id: "core.file",
    fields: {
      title: { type: "string" },
      blob_ref: { type: "string" },
      mime_type: { type: "string" },
    },
  });
  marfa.edgeTypes.set("attached-to", {
    id: "attached-to",
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
    shipped: true,
  });
  marfa.edgeTypes.set("references", {
    id: "references",
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
    shipped: true,
  });
  pages = [{ count: 2, nextPageCursor: null, results: [source(1), source(2)] }];
  readerRows = [];
  status = 200;
  retryAfter = undefined;
  asked = [];
  failCursor = undefined;
  vendor = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://example.com");
    asked.push(url);
    if (
      request.method !== "GET" ||
      request.headers.authorization !== "Token test-readwise-token"
    ) {
      response.writeHead(401).end();
      return;
    }
    if (status !== 200) {
      response
        .writeHead(status, retryAfter ? { "Retry-After": retryAfter } : {})
        .end();
      return;
    }
    if (url.pathname === "/list/") {
      const results = readerRows.filter(
        (row) => row["id"] === url.searchParams.get("id"),
      );
      response.end(
        JSON.stringify({
          count: results.length,
          nextPageCursor: null,
          results,
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/highlights/")) {
      const id = Number(url.pathname.split("/")[2]);
      const found = pages
        .flatMap((page) => page.results)
        .find((book) =>
          book.highlights.some((hl) => hl.id === id && !hl.is_deleted),
        );
      if (found === undefined) response.writeHead(404).end();
      else response.end(JSON.stringify({ id, book_id: found.user_book_id }));
      return;
    }
    if (url.searchParams.get("pageCursor") === failCursor) {
      response.writeHead(503).end();
      return;
    }
    const sourceId = url.searchParams.get("ids");
    const result = sourceId
      ? {
          count: 1,
          nextPageCursor: null,
          results: pages
            .flatMap((page) => page.results)
            .filter((book) => String(book.user_book_id) === sourceId),
        }
      : pages[Number(url.searchParams.get("pageCursor") ?? 0)];
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`;
});
afterEach(async () => {
  for (const child of children.keys()) child.kill("SIGKILL");
  await Promise.all(children.values());
  children.clear();
  await marfa.stop();
  vendor.closeAllConnections();
  await new Promise<void>((done) =>
    vendor.close(() => {
      done();
    }),
  );
});
function launch() {
  const running = exec("node", [built, "--once"], {
    env: {
      PATH: process.env["PATH"],
      MARFA_API_URL: marfa.url,
      MARFA_API_KEY: marfa.key,
      READWISE_ACCESS_TOKEN: "test-readwise-token",
      READWISE_ACCOUNT: "primary",
      READWISE_API_URL: base,
      READWISE_READER_API_URL: base,
    },
    timeout: 15_000,
  });
  const result = running.then(
    ({ stderr }) => ({ code: 0, output: stderr }),
    (error: unknown) => {
      const failed = error as { code: number; stderr: string };
      return { code: failed.code, output: failed.stderr };
    },
  );
  children.set(running.child, result);
  void result.then(() => children.delete(running.child));
  return { child: running.child, result };
}
function once() {
  return launch().result;
}
const progress = () =>
  ((marfa.connectorState?.["state"] as Record<string, unknown> | undefined)?.[
    "export"
  ] ?? {}) as { completed?: string; walk?: { cursor: string | null } };
const pending = () =>
  marfa.connectorState?.["inbound"] as
    { identity: { sourceId: string }; dueAt: string }[] | undefined;
function due() {
  for (const record of pending() ?? [])
    record.dueAt = "2000-01-01T00:00:00.000Z";
}

describe("Readwise process on the kit", () => {
  it("keeps canonical adoption and local notes when an existing Highlights agreement observes Reader", async () => {
    expect((await once()).code).toBe(0);
    const original = marfa.row("primary:source:1");
    marfa.touch("primary:source:1", {
      canonical_key: "primary:reader-document:reader-1",
      reader_managed: true,
      reader_id: "reader-1",
      notes: "Local pending",
    });
    readerRows = [
      {
        id: "reader-1",
        category: "article",
        title: "Source 1",
        notes: "Vendor note",
      },
    ];
    const result = await once();
    expect(result.code, result.output).toBe(0);
    const current = marfa.row("primary:source:1");
    expect(current.id).toBe(original.id);
    expect(current.properties["canonical_key"]).toBe(
      "primary:reader-document:reader-1",
    );
    expect(current.properties["notes"]).toBe("Local pending");
  });
  it("registers core-derived types, links complete passages, and leaves a repeat unchanged", async () => {
    const first = await once();
    expect(first.code, first.output).toBe(0);
    expect(marfa.types.get("readwise.source")?.["parent"]).toBe("core.media");
    expect(marfa.types.get("readwise.highlight")?.["parent"]).toBe(
      "core.highlight",
    );
    expect(marfa.row("primary:highlight:1").properties["text"]).toBe(
      "Full passage 漢字\n",
    );
    expect(
      marfa.targetsOf(marfa.row("primary:highlight:1").id, "references"),
    ).toEqual([marfa.row("primary:source:1").id]);
    const before = structuredClone({ rows: marfa.rows, edges: marfa.edges });
    const repeated = await once();
    expect(repeated.code, repeated.output).toBe(0);
    expect({ rows: marfa.rows, edges: marfa.edges }).toEqual(before);
    expect(marfa.requestsTo("POST", "/edge-types")).toHaveLength(0);
  });
  it("resumes after a later page fails and keeps the original watermark", async () => {
    pages = [
      { count: 2, nextPageCursor: "1", results: [source(1)] },
      { count: 2, nextPageCursor: null, results: [source(2)] },
    ];
    failCursor = "1";
    expect((await once()).code).not.toBe(0);
    expect(progress().walk?.cursor).toBe("1");
    expect(progress().completed).toBeUndefined();
    failCursor = undefined;
    asked = [];
    const result = await once();
    expect(result.code, result.output).toBe(0);
    expect(asked[0]?.searchParams.get("pageCursor")).toBe("1");
    expect(progress().completed).toBeDefined();
    expect(marfa.rows).toHaveLength(4);
  });
  it("holds progress when references are refused and recovers without duplicate rows", async () => {
    marfa.refuseNext("POST /edges", 503, "internal_error");
    expect((await once()).code).not.toBe(0);
    expect(progress().completed).toBeUndefined();
    const result = await once();
    expect(result.code, result.output).toBe(0);
    expect(marfa.rows).toHaveLength(4);
    expect(marfa.edges).toHaveLength(2);
  });
  it("retains isolated row refusals and refetches the complete source when due", async () => {
    marfa.entryRefusals.set("primary:highlight:1", {
      status: 400,
      code: "invalid_properties",
      message: "Bad passage",
    });
    const result = await once();
    expect(result.code, result.output).toBe(0);
    expect(progress().completed).toBeDefined();
    expect(pending()?.[0]?.identity.sourceId).toBe("primary:highlight:1");
    marfa.entryRefusals.clear();
    due();
    asked = [];
    const retry = await once();
    expect(retry.code, retry.output).toBe(0);
    expect(
      asked.some(
        (url) =>
          url.searchParams.get("ids") === "1" &&
          !url.searchParams.has("updatedAfter"),
      ),
    ).toBe(true);
    expect(pending()).toBeUndefined();
    expect(marfa.rows).toHaveLength(4);
    expect(marfa.edges).toHaveLength(2);
  });
  it("keeps permanently refused source retries from blocking unrelated highlights", async () => {
    const bad = source(1);
    const first = bad.highlights[0];
    if (first === undefined) throw new Error("missing fixture");
    bad.highlights.push({ ...first, id: 3 });
    pages = [{ count: 3, nextPageCursor: null, results: [bad, source(2)] }];
    for (const id of [1, 3])
      marfa.entryRefusals.set(`primary:highlight:${String(id)}`, {
        status: 400,
        code: "invalid_properties",
        message: "bad",
      });
    expect((await once()).code).toBe(0);
    expect(pending()).toHaveLength(2);
    due();
    const page = pages[0];
    if (page === undefined) throw new Error("missing fixture");
    page.results.push(source(4));
    asked = [];
    const retry = await once();
    expect(retry.code, retry.output).toBe(0);
    expect(marfa.row("primary:highlight:4").properties["text"]).toBe(
      "Full passage 漢字\n",
    );
    expect(pending()).toHaveLength(2);
    expect(
      asked.some(
        (url) => url.pathname === "/export/" && !url.searchParams.has("ids"),
      ),
    ).toBe(true);
  });
  it("settles a rejected highlight only when its explicit tombstone arrives", async () => {
    marfa.entryRefusals.set("primary:highlight:1", {
      status: 400,
      code: "invalid_properties",
      message: "Bad passage",
    });
    expect((await once()).code).toBe(0);
    expect(pending()).toHaveLength(1);
    marfa.entryRefusals.clear();
    due();
    const first = pages[0]?.results[0]?.highlights[0];
    if (first === undefined) throw new Error("missing fixture");
    first.is_deleted = true;
    const result = await once();
    expect(result.code, result.output).toBe(0);
    expect(pending()).toBeUndefined();
    expect(
      marfa.rows.some((row) => row.source_id === "primary:highlight:1"),
    ).toBe(false);
  });
  it("archives explicit deletions with content intact and restores upstream records", async () => {
    expect((await once()).code).toBe(0);
    const highlight = pages[0]?.results[0]?.highlights[0];
    if (highlight === undefined) throw new Error("missing fixture");
    highlight.is_deleted = true;
    expect((await once()).code).toBe(0);
    expect(marfa.row("primary:highlight:1").state).toBe("archived");
    expect(marfa.row("primary:highlight:1").properties["text"]).toBe(
      highlight.text,
    );
    highlight.is_deleted = false;
    expect((await once()).code).toBe(0);
    expect(marfa.row("primary:highlight:1").state).toBe("active");
  });
  it("respects user archive, trash and purge without sending anything upstream", async () => {
    expect((await once()).code).toBe(0);
    const first = marfa.row("primary:highlight:1");
    marfa.transition(first.id, "archived");
    expect((await once()).code).toBe(0);
    expect(marfa.row("primary:highlight:1").state).toBe("archived");
    const second = marfa.row("primary:highlight:2");
    marfa.trash(second.id);
    expect((await once()).code).toBe(0);
    expect(marfa.row("primary:highlight:2").state).toBe("trashed");
    marfa.purge("primary:highlight:2");
    expect((await once()).code).toBe(0);
    expect(
      marfa.rows.some((row) => row.source_id === "primary:highlight:2"),
    ).toBe(false);
  });
  it("persists throttle deadlines so a restarted process makes no early request", async () => {
    status = 429;
    retryAfter = "120";
    const first = launch();
    await expect
      .poll(() => marfa.connectorState?.["outboundRetryAt"], {
        timeout: 10_000,
        interval: 10,
      })
      .toBeTypeOf("string");
    const deadline = String(marfa.connectorState?.["outboundRetryAt"]);
    expect(Date.parse(deadline)).toBeGreaterThan(Date.now() + 100_000);
    expect(first.child.exitCode).toBeNull();
    const count = asked.length;
    expect(count).toBeGreaterThan(0);
    first.child.kill("SIGTERM");
    const stopped = await first.result;
    expect(stopped.code, stopped.output).toBe(0);
    expect(marfa.connectorState?.["outboundRetryAt"]).toBe(deadline);
    const restarted = await once();
    expect(restarted.code, restarted.output).toBe(1);
    expect(asked).toHaveLength(count);
    expect(progress().completed).toBeUndefined();
    const saved = marfa.connectorState;
    if (saved === undefined) throw new Error("missing durable retry state");
    saved["outboundRetryAt"] = "2000-01-01T00:00:00.000Z";
    status = 200;
    const due = await once();
    expect(due.code, due.output).toBe(0);
    expect(asked.length).toBeGreaterThan(count);
    expect(progress().completed).toBeDefined();
  });
  it("reports wrong credentials as failure and a valid empty account as completed", async () => {
    status = 401;
    expect((await once()).code).not.toBe(0);
    expect(progress().completed).toBeUndefined();
    status = 200;
    pages = [{ count: 0, results: [], nextPageCursor: null }];
    expect((await once()).code).toBe(0);
    expect(progress().completed).toBeDefined();
    expect(marfa.rows).toEqual([]);
  });
});
