import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "example-vendor-token";

interface VendorItem {
  id: string;
  title?: string;
  url?: string;
  note?: string;
  created: string;
  updated?: string;
  deleted?: boolean;
}

interface VendorWrite {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  idempotencyKey: string | undefined;
}

function withoutNulls(
  body: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body ?? {}).filter(([, value]) => value !== null),
  );
}

let marfa: ScriptedServer;
let vendor: Server;
let vendorUrl: string;
let items: VendorItem[];
let writes: VendorWrite[];
let refuseNextWrite: number | undefined;

beforeEach(async () => {
  marfa = await new ScriptedServer("example", {
    types: ["example.item"],
  }).start();
  items = [];
  writes = [];
  refuseNextWrite = undefined;
  let made = 0;
  const madeByKey = new Map<string, string>();
  // A day behind the scripted server's clock, so a change in Marfa is later
  // than the vendor's.
  let vendorClock = Date.parse("2026-09-24T00:00:00.000Z");
  const stamp = (): string => {
    vendorClock += 1000;
    return new Date(vendorClock).toISOString();
  };
  vendor = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const body =
        text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>);
      const path = req.url ?? "/";
      const method = req.method ?? "GET";
      const one = /^\/items\/(.+)$/.exec(path);
      if (method === "GET" && one !== null) {
        const found = items.find(
          (item) => item.id === decodeURIComponent(one[1] ?? ""),
        );
        if (found === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(found));
        return;
      }
      if (method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ account: "acct", items }));
        return;
      }
      const idempotencyKey = req.headers["idempotency-key"];
      writes.push({
        method,
        path,
        body,
        idempotencyKey:
          typeof idempotencyKey === "string" ? idempotencyKey : undefined,
      });
      if (refuseNextWrite !== undefined) {
        res.writeHead(refuseNextWrite).end();
        refuseNextWrite = undefined;
        return;
      }
      const id = decodeURIComponent(path.replace(/^\/items\/?/, ""));
      const ok = { "Content-Type": "application/json" };
      if (method === "POST") {
        const known =
          idempotencyKey === undefined
            ? undefined
            : madeByKey.get(String(idempotencyKey));
        if (known !== undefined) {
          res.writeHead(200, ok).end(JSON.stringify({ id: known }));
          return;
        }
        made += 1;
        const at = stamp();
        const item: VendorItem = {
          id: `made-${String(made)}`,
          ...(withoutNulls(body) as Partial<VendorItem>),
          created: at,
          updated: at,
        };
        items.push(item);
        if (idempotencyKey !== undefined) {
          madeByKey.set(String(idempotencyKey), item.id);
        }
        res.writeHead(200, ok).end(JSON.stringify({ id: item.id }));
        return;
      }
      const found = items.find((item) => item.id === id);
      if (found === undefined) {
        res.writeHead(404).end();
        return;
      }
      if (method === "DELETE") {
        found.deleted = true;
      } else {
        for (const [key, value] of Object.entries(body ?? {})) {
          if (value === null) Reflect.deleteProperty(found, key);
          else Reflect.set(found, key, value);
        }
      }
      found.updated = stamp();
      res.writeHead(200, ok).end(JSON.stringify({ id }));
    });
  });
  await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
  vendorUrl = `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`;
});

afterEach(async () => {
  await marfa.stop();
  vendor.closeAllConnections();
  await new Promise((done) => vendor.close(done));
});

async function once(
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        EXAMPLE_URL: vendorUrl,
        EXAMPLE_TOKEN: token,
        ...env,
      },
    });
    return { code: 0, output: stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, output: failed.stderr };
  }
}

describe("the template, run as a process", () => {
  it("registers its type, writes its rows, and writes nothing on a second run", async () => {
    items = [
      {
        id: "1",
        title: "One",
        url: "https://example.com/1",
        created: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "2",
        title: "Two",
        note: "a note",
        created: "2026-09-02T10:00:00.000Z",
      },
    ];
    expect((await once()).code).toBe(0);
    expect(marfa.types.has("example.item")).toBe(true);
    expect(
      marfa.rows.map((row) => [row.source_id, row.tier, row.properties]),
    ).toEqual([
      [
        "acct:1",
        "feed",
        { example_id: "1", title: "One", url: "https://example.com/1" },
      ],
      ["acct:2", "feed", { example_id: "2", title: "Two", note: "a note" }],
    ]);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0, pushed 0, own 0, conflicts 0",
    );

    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 2, skipped 0, pushed 0, own 2, conflicts 0",
    );
    expect(writes).toEqual([]);
  });

  it("archives an item the vendor deleted, which needs no title to be", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    items = [{ id: "1", created: "2026-09-01T10:00:00.000Z", deleted: true }];
    expect((await once()).code).toBe(0);
    expect(marfa.row("acct:1").state).toBe("archived");
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 0, archived 1, unchanged 0, skipped 0, pushed 0, own 1, conflicts 0",
    );
  });

  it("carries a row a person made to the vendor and links it, and a change and a trash back", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    const theirs = marfa.insert(
      undefined,
      { title: "Theirs", note: "made in Marfa" },
      "example.item",
      "person",
    );
    expect((await once()).code).toBe(0);
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/items",
        body: { title: "Theirs", url: null, note: "made in Marfa" },
        idempotencyKey: theirs.id,
      },
    ]);
    expect(marfa.byId(theirs.id).properties["example_id"]).toBe("made-1");
    expect(marfa.rows).toHaveLength(2);

    const mine = marfa.row("acct:1");
    marfa.edit(mine.id, { title: "One, edited in Marfa" });
    marfa.trash(theirs.id);
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/items/1",
        body: { title: "One, edited in Marfa", url: null, note: null },
        idempotencyKey: undefined,
      },
      {
        method: "DELETE",
        path: "/items/made-1",
        body: undefined,
        idempotencyKey: undefined,
      },
    ]);
    expect(items.find((item) => item.id === "1")?.title).toBe(
      "One, edited in Marfa",
    );
    expect(items.find((item) => item.id === "made-1")?.deleted).toBe(true);
    expect(marfa.runs.at(-1)?.summary).toMatch(/pushed 2, /);
    expect(marfa.rows).toHaveLength(2);
  });

  it("brings the vendor's item back when the row is restored, and deletes it again on a purge", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.trash(mine.id);
    expect((await once()).code).toBe(0);
    expect(items[0]?.deleted).toBe(true);

    marfa.restore(mine.id);
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(writes.map((write) => [write.method, write.path])).toEqual([
      ["PUT", "/items/1"],
    ]);
    expect(writes[0]?.body).toEqual({
      title: "One",
      url: null,
      note: null,
      deleted: false,
    });
    expect(items[0]?.deleted).toBe(false);
    expect(marfa.row("acct:1").state).toBe("active");
    expect(marfa.runs.at(-1)?.summary).toMatch(/archived 0, .*pushed 1/);

    marfa.trash(mine.id);
    marfa.purge("acct:1");
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(writes.map((write) => [write.method, write.path])).toEqual([
      ["DELETE", "/items/1"],
    ]);
    expect(marfa.rows).toHaveLength(0);
  });

  it("brings the vendor's item back when the row is restored and edited before the next run", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.trash(mine.id);
    expect((await once()).code).toBe(0);
    marfa.restore(mine.id);
    marfa.edit(mine.id, { title: "One, back" });
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(
      writes.map((write) => [write.method, write.body?.["deleted"]]),
    ).toEqual([["PUT", false]]);
    expect(items[0]?.deleted).toBe(false);
    expect((await once()).code).toBe(0);
    expect(marfa.row("acct:1").state).toBe("active");
  });

  it("makes the item again when the row is restored and the vendor no longer has it", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.trash(mine.id);
    expect((await once()).code).toBe(0);
    items = items.filter((item) => item.id !== "1");

    marfa.restore(mine.id);
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(writes.map((write) => [write.method, write.path])).toEqual([
      ["POST", "/items"],
    ]);
    expect(writes[0]?.idempotencyKey).toBe(`${mine.id}:1`);
    const made = items.find((item) => item.id.startsWith("made-"));
    expect(made?.title).toBe("One");
    expect(marfa.row("acct:1").properties["example_id"]).toBe(made?.id);
    expect(marfa.row("acct:1").state).toBe("active");
  });

  it("keeps a change the vendor refuses, unsent until the row changes, and the run lands", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.edit(mine.id, { title: "One, refused" });
    refuseNextWrite = 422;
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.outcome).toBe("succeeded");
    expect(marfa.runs.at(-1)?.summary).toContain(
      `the change to ${mine.id} was refused, so it waits until the row changes in Marfa: the example vendor answered 422`,
    );
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(writes).toEqual([]);
    expect(marfa.byId(mine.id).properties["title"]).toBe("One, refused");
    marfa.edit(mine.id, { title: "One, taken" });
    expect((await once()).code).toBe(0);
    expect(items[0]?.title).toBe("One, taken");
  });

  it("sends an edit again on the next run where the vendor answered 503, and never takes the vendor's old value over it", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.edit(mine.id, { title: "One, edited" });
    refuseNextWrite = 503;
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.outcome).toBe("succeeded");
    expect(marfa.runs.at(-1)?.summary).toContain(
      "1 change waits: the example vendor answered 503",
    );
    expect(items[0]?.title).toBe("One");
    expect((await once()).code).toBe(0);
    expect(items[0]?.title).toBe("One, edited");
    expect(marfa.byId(mine.id).properties["title"]).toBe("One, edited");
  });

  it("deletes on the next run where the vendor answered a trash with 429", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    marfa.trash(marfa.row("acct:1").id);
    refuseNextWrite = 429;
    expect((await once()).code).toBe(0);
    expect(items[0]?.deleted).toBeUndefined();
    expect((await once()).code).toBe(0);
    expect(items[0]?.deleted).toBe(true);
  });

  it("makes the item again on the next run where the vendor answered the remake with 503", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.trash(mine.id);
    expect((await once()).code).toBe(0);
    items = items.filter((item) => item.id !== "1");
    marfa.restore(mine.id);
    refuseNextWrite = 503;
    expect((await once()).code).toBe(0);
    expect(items).toEqual([]);
    expect(marfa.row("acct:1").properties["example_id"]).toBe("1");
    expect((await once()).code).toBe(0);
    const made = items.find((item) => item.id.startsWith("made-"));
    expect(made?.title).toBe("One");
    expect(marfa.row("acct:1").properties["example_id"]).toBe(made?.id);
  });

  it("fails the run when the vendor refuses the token, and never prints it", async () => {
    const { code, output } = await once({ EXAMPLE_TOKEN: "wrong-token-value" });
    expect(code).toBe(1);
    expect(marfa.runs.at(-1)?.outcome).toBe("failed");
    expect(marfa.runs.at(-1)?.error).toContain("401");
    expect(output).toContain("refused the token: 401");
    expect(output).not.toContain("wrong-token-value");
  });

  it("leaves out an item with no title and says so once", async () => {
    items = [
      { id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" },
      { id: "2", created: "2026-09-02T10:00:00.000Z" },
    ];
    expect((await once()).code).toBe(0);
    expect(marfa.rows.map((row) => row.source_id)).toEqual(["acct:1"]);
    expect(marfa.runs.at(-1)?.summary).toContain("an item has no title");
    expect((await once()).code).toBe(0);
    expect(marfa.runs).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toContain("unchanged 1");
    expect(marfa.runs.at(-1)?.summary).not.toContain("no title");
  });

  it("clears at the vendor what was cleared in Marfa, and keeps it cleared", async () => {
    items = [
      {
        id: "1",
        title: "One",
        note: "a note",
        created: "2026-09-01T10:00:00.000Z",
        updated: "2026-09-01T10:00:00.000Z",
      },
    ];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.rewrite("acct:1", { example_id: "1", title: "One" });
    writes.length = 0;
    expect((await once()).code).toBe(0);
    expect(writes[0]?.body).toEqual({ title: "One", url: null, note: null });
    expect(items[0]).not.toHaveProperty("note");
    expect((await once()).code).toBe(0);
    expect(marfa.byId(mine.id).properties).toEqual({
      example_id: "1",
      title: "One",
    });
    expect(marfa.runs.at(-1)?.summary).toMatch(/^created 0, updated 0, /);
  });

  it("counts a plain edit as no conflict when the vendor lists the item unchanged", async () => {
    items = [
      {
        id: "1",
        title: "One",
        created: "2026-09-01T10:00:00.000Z",
        updated: "2026-09-01T10:00:00.000Z",
      },
    ];
    expect((await once()).code).toBe(0);
    marfa.edit(marfa.row("acct:1").id, { title: "One, edited in Marfa" });
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0, pushed 1, own 1, conflicts 0",
    );
    expect(items[0]?.title).toBe("One, edited in Marfa");
  });

  it("carries a second edit made after a carried one, and counts no conflict on the vendor's copy of the first", async () => {
    items = [
      {
        id: "1",
        title: "One",
        created: "2026-09-01T10:00:00.000Z",
        updated: "2026-09-01T10:00:00.000Z",
      },
    ];
    expect((await once()).code).toBe(0);
    const mine = marfa.row("acct:1");
    marfa.edit(mine.id, { title: "A" });
    expect((await once()).code).toBe(0);
    expect(items[0]?.title).toBe("A");
    marfa.edit(mine.id, { title: "B" });
    expect((await once()).code).toBe(0);
    expect(items[0]?.title).toBe("B");
    expect(marfa.byId(mine.id).properties["title"]).toBe("B");
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0, pushed 1, own 0, conflicts 0",
    );
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toMatch(
      /^created 0, updated 0, archived 0, unchanged 1, skipped 0, pushed 0, own 0, conflicts 0$/,
    );
  });

  it("takes an item already gone as deleted, sends one create under a repeated key, and names a link another row carries", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    marfa.trash(marfa.row("acct:1").id);
    refuseNextWrite = 404;
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toMatch(/pushed 1, own 1, conflicts 0$/);

    const theirs = marfa.insert(
      undefined,
      { title: "Theirs" },
      "example.item",
      "person",
    );
    marfa.refuseNext(`PATCH /items/${theirs.id}`, 503, "unavailable");
    expect((await once()).code).not.toBe(0);
    expect((await once()).code).toBe(0);
    expect(writes.filter((write) => write.method === "POST")).toHaveLength(2);
    expect(items.filter((item) => item.title === "Theirs")).toHaveLength(1);
    expect(marfa.byId(theirs.id).properties["example_id"]).toBe("made-1");

    const holder = marfa.insert(
      undefined,
      { title: "Holder", example_id: "made-2" },
      "example.item",
      "person",
    );
    const taken = marfa.insert(
      undefined,
      { title: "Taken" },
      "example.item",
      "person",
    );
    expect((await once()).code).toBe(0);
    expect(marfa.byId(taken.id).properties["example_id"]).toBeUndefined();
    expect(marfa.runs.at(-1)?.summary).toContain(
      `the link made-2 is already carried by ${holder.id}`,
    );
  });

  it("fails the run on a refused token during a push, and offers the change again", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    marfa.edit(marfa.row("acct:1").id, { title: "One, edited" });
    refuseNextWrite = 403;
    expect((await once()).code).toBe(1);
    expect(marfa.runs.at(-1)?.outcome).toBe("failed");
    expect(items[0]?.title).toBe("One");
    expect((await once()).code).toBe(0);
    expect(items[0]?.title).toBe("One, edited");
  });

  it("carries nothing for a row a person archived", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    marfa.transition(marfa.row("acct:1").id, "archived");
    expect((await once()).code).toBe(0);
    expect(writes).toEqual([]);
    expect(marfa.runs.at(-1)?.summary).toMatch(/pushed 1, /);
  });

  it("fails visibly at start without its vendor's address", async () => {
    const { code, output } = await once({ EXAMPLE_URL: undefined });
    expect(code).toBe(2);
    expect(output).toContain("EXAMPLE_URL");
    expect(marfa.requests).toEqual([]);
    expect((await once()).code).toBe(0);
    expect(marfa.requests.length).toBeGreaterThan(0);
  });
});
