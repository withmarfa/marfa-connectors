import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  accountOf,
  dueOf,
  entryOf,
  timezoneOf,
  type SyncAnswer,
  type TodoistItem,
} from "../src/todoist.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "todoist-test-token-value";

/** `todoist.task` as the connector carries it, which the scripted server answers as it was registered. */
const served = {
  id: "todoist.task",
  version: 1,
  label: "Todoist Task",
  parent: "core.task",
  fields: {
    project_id: { type: "string" },
    section_id: { type: "string" },
    parent_id: { type: "string" },
    labels: { type: "array", items_type: "string" },
    child_order: { type: "integer" },
    comment_count: { type: "integer" },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

function task(id: string, overrides: Partial<TodoistItem> = {}): TodoistItem {
  return {
    id,
    content: `Task ${id}`,
    description: "",
    project_id: "p1",
    section_id: null,
    parent_id: null,
    labels: [],
    priority: 1,
    due: null,
    child_order: 1,
    checked: false,
    is_deleted: false,
    note_count: 0,
    added_at: "2026-09-01T10:00:00.000000Z",
    ...overrides,
  };
}

let marfa: ScriptedServer;
let todoist: Server;
let todoistUrl: string;
let answer: (syncToken: string) => SyncAnswer | number;
let received: { syncToken: string; resources: string; authorized: boolean }[];
let stateDir: string;

beforeEach(async () => {
  marfa = await new ScriptedServer("todoist").start();
  marfa.types.set("todoist.task", served);
  received = [];
  answer = () => ({
    sync_token: "t1",
    items: [],
    user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
  });
  todoist = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const authorized = req.headers.authorization === `Bearer ${token}`;
      const syncToken = form.get("sync_token") ?? "";
      received.push({
        syncToken,
        resources: form.get("resource_types") ?? "",
        authorized,
      });
      const body = authorized ? answer(syncToken) : 401;
      if (typeof body === "number") {
        res.writeHead(body).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => todoist.listen(0, "127.0.0.1", done));
  todoistUrl = `http://127.0.0.1:${String((todoist.address() as AddressInfo).port)}`;
  stateDir = await mkdtemp(join(tmpdir(), "connector-todoist-"));
});

afterEach(async () => {
  await marfa.stop();
  todoist.closeAllConnections();
  await new Promise((done) => todoist.close(done));
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
        TODOIST_API_TOKEN: token,
        TODOIST_API_URL: todoistUrl,
        ...env,
      },
    });
    return { code: 0, output: stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, output: failed.stderr };
  }
}

async function state(): Promise<Record<string, unknown>> {
  const stored = JSON.parse(
    await readFile(join(stateDir, "todoist.json"), "utf8"),
  ) as {
    state: Record<string, unknown>;
  };
  return stored.state;
}

describe("the mapping", () => {
  it("keys a task by the account the Sync API names, as a core task with Todoist's own fields beside it", () => {
    const entry = entryOf(
      "2671355",
      "Europe/London",
      task("6X7r", {
        content: "Buy milk",
        description: "Organic",
        labels: ["Food"],
        priority: 4,
        due: {
          date: "2026-09-30",
          is_recurring: false,
          string: "Sep 30",
          lang: "en",
          timezone: null,
        },
        section_id: "s1",
        note_count: 2,
        checked: true,
        completed_at: "2026-09-02T08:30:00.000000Z",
      }),
    );
    expect(entry).toEqual({
      source_id: "2671355:6X7r",
      properties: {
        title: "Buy milk",
        description: "Organic",
        priority: "urgent",
        due_at: "2026-09-29T23:00:00.000Z",
        precision: "day",
        status: "completed",
        completed_at: "2026-09-02T08:30:00.000Z",
        url: "https://app.todoist.com/app/task/6X7r",
        project_id: "p1",
        section_id: "s1",
        parent_id: undefined,
        labels: ["Food"],
        child_order: 1,
        comment_count: 2,
      },
      occurred_at: "2026-09-01T10:00:00.000000Z",
    });
  });

  it("maps Todoist's priorities 1 to 4 onto the core's, as ruled", () => {
    expect(
      [1, 2, 3, 4].map(
        (priority) =>
          entryOf("1", "UTC", task("a", { priority })).properties["priority"],
      ),
    ).toEqual(["low", "medium", "high", "urgent"]);
  });

  it("reads each kind of due date: a whole day, a floating time and a fixed one", () => {
    const zone = "America/New_York";
    expect(dueOf({ date: "2026-09-30" }, zone)).toEqual({
      due_at: "2026-09-30T04:00:00.000Z",
      precision: "day",
    });
    expect(dueOf({ date: "2026-12-06T12:00:00.000000" }, zone)).toEqual({
      due_at: "2026-12-06T17:00:00.000Z",
      precision: "time",
    });
    expect(
      dueOf(
        { date: "2026-12-06T13:00:00.000000Z", timezone: "Europe/Madrid" },
        zone,
      ),
    ).toEqual({ due_at: "2026-12-06T13:00:00.000Z", precision: "time" });
    // Either side of the clocks going forward in New York, 8 March 2026.
    expect(dueOf({ date: "2026-03-08T01:30:00" }, zone)?.due_at).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(dueOf({ date: "2026-03-08T03:30:00" }, zone)?.due_at).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(dueOf({ date: "next week" }, zone)).toBeUndefined();
    expect(dueOf(null, zone)).toBeUndefined();
  });

  it("reads the account's timezone only where the platform knows it", () => {
    expect(timezoneOf({ tz_info: { timezone: "Europe/London" } })).toBe(
      "Europe/London",
    );
    for (const user of [
      undefined,
      {},
      { tz_info: {} },
      { tz_info: { timezone: "" } },
      { tz_info: { timezone: "Mars/Olympus" } },
      { tz_info: { timezone: 60 } },
    ]) {
      expect(timezoneOf(user)).toBeUndefined();
    }
  });

  it("clears what Todoist leaves empty", () => {
    const set = entryOf(
      "1",
      "UTC",
      task("a", {
        description: "D",
        labels: ["L"],
        due: { date: "2026-09-30" },
        section_id: "s",
      }),
    ).properties;
    const { properties } = entryOf("1", "UTC", task("a"));
    for (const field of [
      "description",
      "labels",
      "due_at",
      "precision",
      "section_id",
    ]) {
      expect(set[field]).toBeDefined();
      expect(properties[field]).toBeUndefined();
    }
    expect(properties["status"]).toBe("pending");
    expect(properties["completed_at"]).toBeUndefined();
  });

  it("refuses an account it could not key a task by", () => {
    expect(accountOf({ id: "2671355" })).toBe("2671355");
    // The v1 API's ids are strings; a number is an older API's answer.
    for (const user of [
      undefined,
      {},
      { id: 2671355 },
      { id: null },
      { id: "" },
      { id: "a:b" },
    ]) {
      expect(accountOf(user)).toBeUndefined();
    }
  });
});

describe("the connector, run as a process", () => {
  it("writes a full sync's tasks at the feed tier, keyed by account, with the token and account kept", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [
        task("a", { content: "One" }),
        task("b", { content: "Two", priority: 3 }),
      ],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    expect((await once()).code).toBe(0);
    expect(received[0]).toEqual({
      syncToken: "*",
      resources: '["items","user"]',
      authorized: true,
    });
    expect(
      marfa.rows.map((row) => [
        row.source_id,
        row.tier,
        row.properties["title"],
        row.occurred_at,
      ]),
    ).toEqual([
      ["2671355:a", "feed", "One", "2026-09-01T10:00:00.000Z"],
      ["2671355:b", "feed", "Two", "2026-09-01T10:00:00.000Z"],
    ]);
    expect(marfa.requestsTo("POST", "/types")).toEqual([]);
    expect(await state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      sync_token: "t1",
    });
  });

  it("follows a delta: a change updated, a completion kept active, a deletion archived", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a"), task("b"), task("c"), task("d")],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    expect((await once()).code).toBe(0);
    answer = () => ({
      sync_token: "t2",
      items: [
        task("a", { content: "Task a, renamed" }),
        task("b", { checked: true }),
        task("c", { is_deleted: true }),
      ],
    });
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual(["*", "t1"]);
    expect(marfa.row("2671355:a").properties["title"]).toBe("Task a, renamed");
    expect(marfa.row("2671355:a").version).toBe(2);
    expect(marfa.row("2671355:b").properties["status"]).toBe("completed");
    expect(marfa.row("2671355:b").state).toBe("active");
    expect(marfa.row("2671355:c").state).toBe("archived");
    expect(marfa.row("2671355:d").version).toBe(1);
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 2, archived 1, unchanged 0, skipped 0",
    );
    expect(await state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      sync_token: "t2",
    });
  });

  it("clears a due date Todoist removed", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a", { due: { date: "2026-09-30", is_recurring: false } })],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties).toMatchObject({
      due_at: "2026-09-29T23:00:00.000Z",
      precision: "day",
    });
    // A delta names no user; the timezone kept from the full sync reads it.
    answer = () => ({
      sync_token: "t2",
      items: [task("a", { due: { date: "2026-10-01T09:00:00" } })],
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties).toMatchObject({
      due_at: "2026-10-01T08:00:00.000Z",
      precision: "time",
    });
    answer = () => ({
      sync_token: "t3",
      items: [task("a", { due: null })],
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties).not.toHaveProperty("due_at");
    expect(marfa.row("2671355:a").properties).not.toHaveProperty("precision");
  });

  it("reads due dates in UTC when Todoist names no timezone, and says so once", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a", { due: { date: "2026-10-01T09:00:00" } })],
      user: { id: "2671355" },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    expect(marfa.runs.at(-1)?.summary).toContain("named no timezone");
    expect((await once()).code).toBe(0);
    expect(marfa.runs).toHaveLength(2);
    expect(marfa.runs.at(-1)?.summary).toMatch(/^created 0, /);
    expect(marfa.runs.at(-1)?.summary).not.toContain("timezone");
    expect(await state()).toEqual({ account: "2671355", sync_token: "t1" });
  });

  it("holds the token when a write did not land, and asks for the same delta again", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a"), task("b")],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    marfa.entryRefusals.set("2671355:b", {
      status: 400,
      code: "invalid_properties",
      message: "too long",
    });
    expect((await once()).code).toBe(0);
    expect(await state()).toEqual({});

    marfa.entryRefusals.delete("2671355:b");
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual(["*", "*"]);
    expect(marfa.rows).toHaveLength(2);
    expect(await state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      sync_token: "t1",
    });
  });

  it("writes nothing when Todoist names no account", async () => {
    answer = () => ({ sync_token: "t1", items: [task("a")] });
    const { code } = await once();
    expect(code).toBe(1);
    expect(marfa.rows).toEqual([]);
    expect(marfa.runs.at(-1)?.error).toContain("no account");
  });

  it("fails the run when Todoist refuses the token, and never prints it", async () => {
    const { code, output } = await once({
      TODOIST_API_TOKEN: "a-wrong-token-value",
    });
    expect(code).toBe(1);
    expect(marfa.runs.at(-1)?.error).toContain("refused the token");
    // The output carries the failure, so the token's absence is not an
    // empty stream's.
    expect(output).toContain("refused the token");
    expect(output).not.toContain("a-wrong-token-value");
  });

  it("registers its type on an instance that has none", async () => {
    marfa.types.delete("todoist.task");
    expect((await once()).code).toBe(0);
    expect(marfa.requestsTo("POST", "/types")).toHaveLength(1);
  });
});
