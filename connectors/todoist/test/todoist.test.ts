import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
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
  label: "Todoist Task",
  parent: "core.task",
  fields: {
    todoist_id: { type: "string" },
    project_id: { type: "string" },
    section_id: { type: "string" },
    parent_id: { type: "string" },
    labels: { type: "array", items_type: "string" },
    child_order: { type: "integer" },
    comment_count: { type: "integer" },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

/** Due dates as Todoist sends them, with the fields the connector does not read. */
const wholeDaySent = {
  date: "2026-09-30",
  is_recurring: false,
  string: "Sep 30",
  lang: "en",
  timezone: null,
};
const fixedSent = {
  date: "2026-12-06T13:00:00.000000Z",
  is_recurring: true,
  string: "every day at 2pm",
  lang: "en",
  timezone: "Europe/Madrid",
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
});

afterEach(async () => {
  await marfa.stop();
  todoist.closeAllConnections();
  await new Promise((done) => todoist.close(done));
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

function state(): Record<string, unknown> {
  return (marfa.states.get("todoist")?.["state"] ?? {}) as Record<
    string,
    unknown
  >;
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
        due: wholeDaySent,
        section_id: "s1",
        parent_id: "p0",
        note_count: 2,
        checked: true,
        completed_at: "2026-09-02T08:30:00.000000Z",
        updated_at: "2026-09-02T08:31:00Z",
      }),
    );
    expect(entry).toEqual({
      source_id: "2671355:6X7r",
      properties: {
        todoist_id: "6X7r",
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
        parent_id: "p0",
        labels: ["Food"],
        child_order: 1,
        comment_count: 2,
      },
      occurred_at: "2026-09-01T10:00:00.000000Z",
      changed_at: "2026-09-02T08:31:00.000Z",
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
    expect(dueOf(fixedSent, zone)).toEqual({
      due_at: "2026-12-06T13:00:00.000Z",
      precision: "time",
    });
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

  it("moves a time the clocks skipped later, and takes a time shown twice at its first showing, on either side of UTC", () => {
    const at = (date: string, zone: string): string | undefined =>
      dueOf({ date }, zone)?.due_at;
    // Skipped: New York, London, Sydney.
    expect(at("2026-03-08T02:30:00", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(at("2026-03-29T01:30:00", "Europe/London")).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(at("2026-10-04T02:30:00", "Australia/Sydney")).toBe(
      "2026-10-03T16:30:00.000Z",
    );
    // Shown twice: the earlier instant, in daylight time.
    expect(at("2026-11-01T01:30:00", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(at("2026-10-25T01:30:00", "Europe/London")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(at("2026-04-05T02:30:00", "Australia/Sydney")).toBe(
      "2026-04-04T15:30:00.000Z",
    );
  });

  it("keeps a whole day on its date where its midnight is skipped", () => {
    const local = (iso: string | undefined, zone: string): string =>
      new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
        new Date(iso ?? Number.NaN),
      );
    for (const [date, zone] of [
      ["2026-03-08", "America/Havana"],
      ["2026-09-06", "America/Santiago"],
      ["2026-03-29", "Atlantic/Azores"],
    ] as const) {
      const due = dueOf({ date }, zone);
      expect(due?.precision).toBe("day");
      expect(local(due?.due_at, zone)).toBe(date);
    }
  });

  it("reads no due date from a date the calendar does not have", () => {
    expect(dueOf({ date: "2026-02-28" }, "UTC")?.due_at).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(dueOf({ date: "2026-02-30" }, "UTC")).toBeUndefined();
    expect(dueOf({ date: "2026-13-45T25:61:61" }, "UTC")).toBeUndefined();
  });

  it("reads a fixed time and a completion strictly, as Todoist writes them", () => {
    expect(dueOf({ date: "2026-09-30T13:00:00.123456Z" }, "UTC")?.due_at).toBe(
      "2026-09-30T13:00:00.123Z",
    );
    for (const date of [
      "2026-02-30T13:00:00Z",
      "2026-09-30T24:00:00Z",
      "Sep 30 Z",
      "2026-09-30T13:00Z",
    ]) {
      expect(dueOf({ date }, "UTC")).toBeUndefined();
    }
    const completed = (completedAt: string): unknown =>
      entryOf(
        "1",
        "UTC",
        task("a", { checked: true, completed_at: completedAt }),
      ).properties["completed_at"];
    expect(completed("2026-09-02T08:30:00.000000Z")).toBe(
      "2026-09-02T08:30:00.000Z",
    );
    expect(completed("2026-02-30T08:30:00Z")).toBeUndefined();
    expect(completed("yesterday")).toBeUndefined();
    expect(completed("2026-09-02T08:30:00.000000")).toBeUndefined();
    expect(dueOf({ date: "2026-09-30Z" }, "UTC")).toBeUndefined();
    expect(dueOf({ date: "2026-09-30T23:59:60" }, "UTC")).toBeUndefined();
    expect(dueOf({ date: "0050-06-01" }, "UTC")?.due_at).toBe(
      "0050-06-01T00:00:00.000Z",
    );
  });

  it("reads an item carrying null where Todoist sends a value without failing", () => {
    const odd = task("a", { labels: null, due: { date: null } });
    const { properties } = entryOf("1", "UTC", odd);
    expect(properties["title"]).toBe("Task a");
    expect(properties["labels"]).toBeUndefined();
    expect(properties["due_at"]).toBeUndefined();
  });

  it("writes a completion only for a completed task", () => {
    const completedAt = "2026-09-02T08:30:00.000000Z";
    const done = entryOf(
      "1",
      "UTC",
      task("a", { checked: true, completed_at: completedAt }),
    ).properties;
    const open = entryOf(
      "1",
      "UTC",
      task("a", { checked: false, completed_at: completedAt }),
    ).properties;
    expect([done["status"], done["completed_at"]]).toEqual([
      "completed",
      "2026-09-02T08:30:00.000Z",
    ]);
    expect([open["status"], open["completed_at"]]).toEqual([
      "pending",
      undefined,
    ]);
  });

  it("reads when a task changed strictly, as Todoist writes it, and nothing from a floating time", () => {
    const at = (updated_at: string | undefined): unknown =>
      entryOf(
        "1",
        "UTC",
        task("a", updated_at === undefined ? {} : { updated_at }),
      ).changed_at;
    expect(at("2026-09-02T08:31:00Z")).toBe("2026-09-02T08:31:00.000Z");
    expect(at("2026-09-02T08:31:00.250000Z")).toBe("2026-09-02T08:31:00.250Z");
    expect(at("2026-09-02T08:31:00")).toBeUndefined();
    expect(at(undefined)).toBeUndefined();
  });

  it("encodes a task's id in its link", () => {
    expect(entryOf("1", "UTC", task("a/b c")).properties["url"]).toBe(
      "https://app.todoist.com/app/task/a%2Fb%20c",
    );
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
    expect(accountOf({ id: " 2671355 " })).toBe("2671355");
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
    // With the account's zone named, no timezone condition rides the report.
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0, pushed 0, own 0, conflicts 0",
    );
    expect(state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      sync_token: "t1",
    });
  });

  it("keys a shared project's task by the account, never by the task's owner", async () => {
    const shared = {
      ...task("s", { content: "Shared", project_id: "shared-project" }),
      user_id: "31415926",
    };
    answer = () => ({
      sync_token: "t1",
      items: [shared],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.rows.map((row) => row.source_id)).toEqual(["2671355:s"]);
    expect(state()).toMatchObject({ account: "2671355" });
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
    // The four creates of the first run are read back as the connector's
    // own, and nothing is carried to Todoist.
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 2, archived 1, unchanged 0, skipped 0, pushed 0, own 4, conflicts 0",
    );
    expect(state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      sync_token: "t2",
    });
  });

  it("clears a due date Todoist removed", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a", { due: wholeDaySent })],
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
    expect(state()).toEqual({ account: "2671355", sync_token: "t1" });
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
    expect(state()).toEqual({});

    marfa.entryRefusals.delete("2671355:b");
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual(["*", "*"]);
    expect(marfa.rows).toHaveLength(2);
    expect(state()).toEqual({
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

  it("fails the run on a 403 as on a 401", async () => {
    answer = () => 403;
    expect((await once()).code).toBe(1);
    expect(marfa.runs.at(-1)?.error).toContain("refused the token: 403");
  });

  it("reads every due date anew when the account's timezone moves", async () => {
    const floating = task("a", { due: { date: "2026-10-01T09:00:00" } });
    let zone = "Europe/London";
    answer = (syncToken) =>
      syncToken === "*"
        ? {
            sync_token: "t-full",
            items: [floating, task("b")],
            user: { id: "2671355", tz_info: { timezone: zone } },
          }
        : {
            sync_token: "t-delta",
            items: [task("b", { content: "Task b, renamed" })],
            user: { id: "2671355", tz_info: { timezone: zone } },
          };
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T08:00:00.000Z",
    );
    // The same zone again: a delta, and nothing more.
    expect((await once()).code).toBe(0);
    zone = "America/New_York";
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full",
      "t-delta",
      "*",
    ]);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T13:00:00.000Z",
    );
    expect(state()).toMatchObject({ timezone: "America/New_York" });
  });

  it("reads due dates anew once a timezone is named, having read them in UTC", async () => {
    const floating = task("a", { due: { date: "2026-10-01T09:00:00" } });
    let named: { timezone?: string } = {};
    answer = (syncToken) => ({
      sync_token: syncToken === "*" ? "t-full" : "t-delta",
      items: syncToken === "*" ? [floating] : [],
      user: { id: "2671355", tz_info: named },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    named = { timezone: "Europe/London" };
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full",
      "*",
    ]);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T08:00:00.000Z",
    );
  });

  it("keeps a delta's completions and deletions when a moved zone asks for a full sync", async () => {
    const a = task("a", { due: { date: "2026-10-01T09:00:00" } });
    let zone = "Europe/London";
    let fulls = 0;
    answer = (syncToken) => {
      if (syncToken === "*") {
        fulls += 1;
        return {
          sync_token: `t-full-${String(fulls)}`,
          items: fulls === 1 ? [a, task("b"), task("c")] : [a],
          user: { id: "2671355", tz_info: { timezone: zone } },
        };
      }
      return {
        sync_token: "t-delta",
        items: [
          task("b", {
            checked: true,
            completed_at: "2026-10-02T10:00:00.000000Z",
          }),
          task("c", { is_deleted: true }),
        ],
        user: { id: "2671355", tz_info: { timezone: zone } },
      };
    };
    expect((await once()).code).toBe(0);
    zone = "America/New_York";
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full-1",
      "*",
    ]);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T13:00:00.000Z",
    );
    expect(marfa.row("2671355:b").properties).toMatchObject({
      status: "completed",
      completed_at: "2026-10-02T10:00:00.000Z",
    });
    expect(marfa.row("2671355:c").state).toBe("archived");
    expect(state()).toMatchObject({ sync_token: "t-delta" });
  });

  it("lets a moved zone's full sync win over the delta, and keeps the delta's token for what lands between", async () => {
    let zone = "Europe/London";
    let fulls = 0;
    let deltas = 0;
    answer = (syncToken) => {
      const user = { id: "2671355", tz_info: { timezone: zone } };
      if (syncToken === "*") {
        fulls += 1;
        return {
          sync_token: `t-full-${String(fulls)}`,
          // The second full sync is served after the delta, and holds a
          // newer title for a than the delta did.
          items: [task("a", { content: fulls === 1 ? "One" : "One, newer" })],
          user,
        };
      }
      deltas += 1;
      return {
        sync_token: `t-delta-${String(deltas)}`,
        // The first delta carries an older a; the next, a completion that
        // landed between the first delta and the full sync.
        items:
          deltas === 1
            ? [task("a", { content: "One, older" })]
            : [
                task("a", {
                  content: "One, newer",
                  checked: true,
                  completed_at: "2026-10-02T10:00:00.000000Z",
                }),
              ],
        user,
      };
    };
    expect((await once()).code).toBe(0);
    zone = "America/New_York";
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["title"]).toBe("One, newer");
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full-1",
      "*",
      "t-delta-1",
    ]);
    expect(marfa.row("2671355:a").properties["status"]).toBe("completed");
  });

  it("names an unknown zone even with one held, and reads in the one held", async () => {
    let named = "Europe/London";
    answer = (syncToken) => ({
      sync_token: syncToken === "*" ? "t-full" : "t-delta",
      items: [task("a", { due: { date: "2026-10-01T09:00:00" } })],
      user: { id: "2671355", tz_info: { timezone: named } },
    });
    expect((await once()).code).toBe(0);
    named = "Mars/Olympus";
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full",
    ]);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-10-01T08:00:00.000Z",
    );
    expect(marfa.runs.at(-1)?.summary).toContain(
      "Mars/Olympus for the account, which this platform does not know, so its due dates are read in Europe/London",
    );
  });

  it("reports a timezone condition anew when what it says changes", async () => {
    let tzInfo: { timezone?: string } = {};
    answer = () => ({
      sync_token: "t1",
      items: [task("a")],
      user: { id: "2671355", tz_info: tzInfo },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain("named no timezone");
    tzInfo = { timezone: "Mars/Olympus" };
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain(
      "named the timezone Mars/Olympus",
    );
    tzInfo = { timezone: "Venus/Maxwell" };
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain(
      "named the timezone Venus/Maxwell",
    );
    tzInfo = { timezone: "" };
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain("named no timezone");
    tzInfo = { timezone: "Europe/London" };
    expect((await once()).code).toBe(0);
    expect(marfa.runs).toHaveLength(5);
    expect(marfa.runs.at(-1)?.summary).toMatch(/^created 0, /);
    expect(marfa.runs.at(-1)?.summary).not.toContain("timezone");
  });

  it("names a timezone the platform does not know, rather than saying none was named", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a")],
      user: { id: "2671355", tz_info: { timezone: "Mars/Olympus" } },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.runs.at(-1)?.summary).toContain(
      "named the timezone Mars/Olympus for the account, which this platform does not know",
    );
  });

  it("registers its type on an instance that has none", async () => {
    marfa.types.delete("todoist.task");
    expect((await once()).code).toBe(0);
    expect(marfa.requestsTo("POST", "/types")).toHaveLength(1);
  });
});
