import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  deleted?: boolean;
}

let marfa: ScriptedServer;
let vendor: Server;
let vendorUrl: string;
let items: VendorItem[];
let stateDir: string;

beforeEach(async () => {
  marfa = await new ScriptedServer("example").start();
  items = [];
  vendor = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ account: "acct", items }));
  });
  await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
  vendorUrl = `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`;
  stateDir = await mkdtemp(join(tmpdir(), "connector-template-"));
});

afterEach(async () => {
  await marfa.stop();
  vendor.closeAllConnections();
  await new Promise((done) => vendor.close(done));
  await rm(stateDir, { recursive: true, force: true });
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
        MARFA_STATE_DIR: stateDir,
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
      ["acct:1", "feed", { title: "One", url: "https://example.com/1" }],
      ["acct:2", "feed", { title: "Two", note: "a note" }],
    ]);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0",
    );

    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 2, skipped 0",
    );
  });

  it("archives an item the vendor deleted", async () => {
    items = [{ id: "1", title: "One", created: "2026-09-01T10:00:00.000Z" }];
    expect((await once()).code).toBe(0);
    items = [
      {
        id: "1",
        title: "One",
        created: "2026-09-01T10:00:00.000Z",
        deleted: true,
      },
    ];
    expect((await once()).code).toBe(0);
    expect(marfa.row("acct:1").state).toBe("archived");
  });

  it("fails the run when the vendor refuses the token, and never prints it", async () => {
    const { code, output } = await once({ EXAMPLE_TOKEN: "wrong-token-value" });
    expect(code).toBe(1);
    expect(marfa.runs.at(-1)?.outcome).toBe("failed");
    expect(marfa.runs.at(-1)?.error).toContain("401");
    // The output carries the failure, so the token's absence is not an
    // empty stream's.
    expect(output).toContain("answered 401");
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

  it("fails visibly at start without its vendor's address", async () => {
    const { code, output } = await once({ EXAMPLE_URL: undefined });
    expect(code).toBe(2);
    expect(output).toContain("EXAMPLE_URL");
    expect(marfa.requests).toEqual([]);
    expect((await once()).code).toBe(0);
    expect(marfa.requests.length).toBeGreaterThan(0);
  });
});
