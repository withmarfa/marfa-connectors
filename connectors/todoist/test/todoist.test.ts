import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Log } from "@withmarfa/connector";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { followProjects, knowing, placedIn } from "../src/projects.js";
import {
  accountOf,
  dueOf,
  entryOf,
  langOf,
  readShape,
  taskFields,
  timezoneOf,
  type SyncAnswer,
  type TodoistItem,
  type TodoistProject,
} from "../src/todoist.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "todoist-test-token-value";

const served = {
  id: "todoist.task",
  label: "Todoist Task",
  parent: "core.task",
  link_field: "todoist_id",
  fields: {
    todoist_id: { type: "string" },
    project_id: { type: "string" },
    section_id: { type: "string" },
    parent_id: { type: "string" },
    labels: { type: "array", items_type: "string" },
    child_order: { type: "integer" },
    recurrence: { type: "string" },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

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
    added_at: "2026-09-01T10:00:00.000000Z",
    ...overrides,
  };
}

const inbox: TodoistProject = { id: "p1", name: "Inbox", inbox_project: true };

let marfa: ScriptedServer;
let todoist: Server;
let todoistUrl: string;
let answer: (syncToken: string, resources: string) => SyncAnswer | number;
let received: { syncToken: string; resources: string; authorized: boolean }[];
let completedAnswer: (
  query: URLSearchParams,
) => { items: TodoistItem[]; next_cursor: string | null } | number;
let completedAsked: URLSearchParams[];
let taskAnswer: (id: string) => TodoistItem | number;
let projectAnswer: (id: string) => TodoistProject | number;
let tasksAsked: string[];

beforeEach(async () => {
  marfa = await new ScriptedServer("todoist", {
    types: ["todoist.task"],
  }).start();
  marfa.types.set("todoist.task", served);
  received = [];
  completedAsked = [];
  completedAnswer = () => ({ items: [], next_cursor: null });
  taskAnswer = () => 404;
  projectAnswer = () => 404;
  tasksAsked = [];
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
      const asked = new URL(req.url ?? "/", "http://todoist");
      if (asked.pathname === "/api/v1/tasks/completed/by_completion_date") {
        completedAsked.push(asked.searchParams);
        const page = authorized ? completedAnswer(asked.searchParams) : 401;
        if (typeof page === "number") {
          res.writeHead(page).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(page));
        return;
      }
      const byId = /^\/api\/v1\/tasks\/([^/]+)$/.exec(asked.pathname);
      if (req.method === "GET" && byId !== null) {
        const id = decodeURIComponent(byId[1] ?? "");
        tasksAsked.push(id);
        const found = authorized ? taskAnswer(id) : 401;
        if (typeof found === "number") {
          res.writeHead(found).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(found));
        return;
      }
      const project = /^\/api\/v1\/projects\/([^/]+)$/.exec(asked.pathname);
      if (req.method === "GET" && project !== null) {
        const found = authorized
          ? projectAnswer(decodeURIComponent(project[1] ?? ""))
          : 401;
        if (typeof found === "number") {
          res.writeHead(found).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(found));
        return;
      }
      const syncToken = form.get("sync_token") ?? "";
      const resources = form.get("resource_types") ?? "";
      received.push({ syncToken, resources, authorized });
      const body = authorized ? answer(syncToken, resources) : 401;
      if (typeof body === "number") {
        res.writeHead(body).end();
        return;
      }
      // A full sync lists the Inbox, where every task here is, unless an
      // answer names its own projects; a delta names none that changed.
      const whole = syncToken === "*" || body.full_sync === true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...body,
          ...(resources.includes("projects") &&
            body.projects === undefined && {
              projects: whole ? [inbox] : [],
            }),
        }),
      );
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
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
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
    expect(at("2026-03-08T02:30:00", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(at("2026-03-29T01:30:00", "Europe/London")).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(at("2026-10-04T02:30:00", "Australia/Sydney")).toBe(
      "2026-10-03T16:30:00.000Z",
    );
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

  it("keeps a recurring task's recurrence as Todoist words it, and none for a one-off", () => {
    const recurrence = (due: NonNullable<TodoistItem["due"]> | null): unknown =>
      entryOf("1", "UTC", task("a", { due })).properties["recurrence"];
    expect(recurrence(fixedSent)).toBe("every day at 2pm");
    expect(
      recurrence({
        date: "2026-10-04",
        string: "jeden Tag",
        lang: "de",
        is_recurring: true,
      }),
    ).toBe("jeden Tag");
    // Todoist words a one-off's date too, and keeps text it could not read
    // as a recurrence on a one-off (seen live in October 2026).
    expect(recurrence(wholeDaySent)).toBeUndefined();
    expect(
      recurrence({
        date: "2026-10-10",
        string: "every flibbertigibbet",
        is_recurring: false,
      }),
    ).toBeUndefined();
    expect(
      recurrence({ date: "2026-10-10", is_recurring: true }),
    ).toBeUndefined();
    expect(
      recurrence({ date: "2026-10-10", string: "", is_recurring: true }),
    ).toBeUndefined();
    expect(recurrence(null)).toBeUndefined();
  });

  it("reads the language a due is worded in from the account's, which Todoist names differently", () => {
    // The user's `lang` takes `pt_BR`, `zh_CN` and `zh_TW` and `tr`; a due's
    // `lang` takes `pt`, `zh` and `tw` and has no `tr`.
    const due = (lang: unknown): string | undefined => langOf({ lang });
    expect(
      [
        "da",
        "de",
        "en",
        "es",
        "fi",
        "fr",
        "it",
        "ja",
        "ko",
        "nl",
        "pl",
        "ru",
        "sv",
        "pt_BR",
        "zh_CN",
        "zh_TW",
      ].map(due),
    ).toEqual([
      "da",
      "de",
      "en",
      "es",
      "fi",
      "fr",
      "it",
      "ja",
      "ko",
      "nl",
      "pl",
      "ru",
      "sv",
      "pt",
      "zh",
      "tw",
    ]);
    for (const none of ["tr", "xx", "", 3, null, undefined, "constructor"]) {
      expect(due(none)).toBeUndefined();
    }
    expect(langOf(undefined)).toBeUndefined();
    expect(langOf({})).toBeUndefined();
  });

  it("reads the language the account sets for date recognition instead, whatever the account's own", () => {
    const set = (dateist_lang: unknown, lang = "en"): string | undefined =>
      langOf({ lang, features: { dateist_lang } });
    expect(set("fr")).toBe("fr");
    expect(set("zh_TW", "de")).toBe("tw");
    // No words for it: not the account's language, which it overrides.
    expect(set("tr", "de")).toBeUndefined();
    expect(set(null, "de")).toBe("de");
    expect(set("", "de")).toBe("de");
    expect(langOf({ features: { dateist_lang: "pt_BR" } })).toBe("pt");
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
      resources: '["items","projects","user"]',
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
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0, pushed 0, own 0, conflicts 0",
    );
    expect(state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      projects: ["p1"],
      sync_token: "t1",
      read_shape: readShape(taskFields),
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
      projects: [inbox, { id: "shared-project", name: "Shared" }],
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
    expect(marfa.runs.at(-1)?.summary).toBe(
      "created 0, updated 2, archived 1, unchanged 0, skipped 0, pushed 0, own 4, conflicts 0",
    );
    expect(state()).toEqual({
      account: "2671355",
      timezone: "Europe/London",
      projects: ["p1"],
      sync_token: "t2",
      read_shape: readShape(taskFields),
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

  it("reads due dates in UTC when Todoist names no timezone, and says so on every run it lasts", async () => {
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
    expect(marfa.runs.at(-1)?.summary).toMatch(
      /^created 0, .*named no timezone/,
    );
    expect(state()).toEqual({
      account: "2671355",
      projects: ["p1"],
      sync_token: "t1",
      read_shape: readShape(taskFields),
    });
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
      projects: ["p1"],
      sync_token: "t1",
      read_shape: readShape(taskFields),
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
          items: [task("a", { content: fulls === 1 ? "One" : "One, newer" })],
          user,
        };
      }
      deltas += 1;
      return {
        sync_token: `t-delta-${String(deltas)}`,
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

  it("syncs in full once when it reads tasks in a new shape, so rows held from before gain the new fields", async () => {
    // Each full sync words the recurrence anew, which no delta brings: only a
    // full sync puts it on the row.
    const worded = [undefined, "every day at 2pm", "every weekday at 2pm"];
    let fulls = 0;
    let deltas = 0;
    answer = (syncToken) => {
      const user = { id: "2671355", tz_info: { timezone: "Europe/London" } };
      if (syncToken === "*") {
        fulls += 1;
        const string = worded[fulls - 1];
        return {
          sync_token: `t-full-${String(fulls)}`,
          items: [
            task("a", {
              due:
                string === undefined ? wholeDaySent : { ...fixedSent, string },
            }),
            ...(fulls === 1 ? [task("b"), task("c")] : []),
          ],
          user,
        };
      }
      deltas += 1;
      return {
        sync_token: `t-delta-${String(deltas)}`,
        items:
          deltas === 1
            ? [
                task("b", { is_deleted: true }),
                task("c", {
                  checked: true,
                  completed_at: "2026-10-02T10:00:00.000000Z",
                }),
              ]
            : [],
        user,
      };
    };
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["recurrence"]).toBeUndefined();
    const shape = readShape(taskFields);
    expect(state()["read_shape"]).toBe(shape);
    // As a connector that read fewer fields left it: the state names no
    // shape, or another one.
    for (const held of [undefined, "an older shape"]) {
      const stored = structuredClone(marfa.states.get("todoist") ?? {});
      const kept = stored["state"] as Record<string, unknown>;
      if (held === undefined) delete kept["read_shape"];
      else kept["read_shape"] = held;
      marfa.states.set("todoist", stored);
      expect((await once()).code).toBe(0);
      expect(marfa.row("2671355:a").properties["recurrence"]).toBe(
        worded[fulls - 1],
      );
      expect(state()["read_shape"]).toBe(shape);
    }
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full-1",
      "*",
      "t-delta-1",
      "*",
      "t-delta-2",
    ]);
    expect(fulls).toBe(3);
    expect(marfa.row("2671355:a").properties["recurrence"]).toBe(
      "every weekday at 2pm",
    );
    // The delta's deletion and completion are kept beside the full sync, as
    // for a moved zone.
    expect(marfa.row("2671355:b").state).toBe("archived");
    expect(marfa.row("2671355:c").properties).toMatchObject({
      status: "completed",
      completed_at: "2026-10-02T10:00:00.000Z",
    });
    expect(state()).toMatchObject({ sync_token: "t-delta-3" });
  });

  it("syncs in full once when a narrowing lifts, so rows held without recurrence gain it", async () => {
    // The kit runs without a field the key may not add to the type, and
    // writes it once the type has it: the fields the connector declares are
    // the same throughout, but what it writes is not, and a delta brings a
    // recurring task only when it changes in Todoist.
    marfa.types.set("todoist.task", {
      ...served,
      fields: Object.fromEntries(
        Object.entries(served.fields).filter(([name]) => name !== "recurrence"),
      ),
    });
    let fulls = 0;
    let deltas = 0;
    answer = (syncToken) => {
      const user = { id: "2671355", tz_info: { timezone: "Europe/London" } };
      if (syncToken === "*") {
        fulls += 1;
        return {
          sync_token: `t-full-${String(fulls)}`,
          items: [task("a", { due: fixedSent })],
          user,
        };
      }
      deltas += 1;
      return { sync_token: `t-delta-${String(deltas)}`, items: [], user };
    };
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["title"]).toBe("Task a");
    expect(marfa.row("2671355:a").properties["recurrence"]).toBeUndefined();
    const narrowed = state()["read_shape"];

    // Still narrowed: nothing about what is written has changed.
    expect((await once()).code).toBe(0);
    expect(state()["read_shape"]).toBe(narrowed);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full-1",
    ]);

    marfa.types.set("todoist.task", served);
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual([
      "*",
      "t-full-1",
      "t-delta-1",
      "*",
    ]);
    expect(marfa.row("2671355:a").properties["recurrence"]).toBe(
      "every day at 2pm",
    );
    expect(state()["read_shape"]).not.toBe(narrowed);
    expect(state()["read_shape"]).toBe(readShape(taskFields));

    // One full sync only.
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken).slice(4)).toEqual([
      "t-delta-2",
    ]);
    expect(fulls).toBe(2);
  });

  it("reads a different shape for the fields it writes, whatever it declares", () => {
    const narrowed = taskFields.filter((field) => field !== "recurrence");
    expect(readShape(taskFields)).toBe(readShape([...taskFields]));
    expect(readShape(narrowed)).not.toBe(readShape(taskFields));
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

  it("reads the tasks completed in the last twelve weeks after a full sync, page by page, and never after a delta", async () => {
    answer = (syncToken) => ({
      sync_token: syncToken === "*" ? "t-full" : "t-delta",
      items: syncToken === "*" ? [task("a")] : [],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    completedAnswer = (query) =>
      query.get("cursor") === null
        ? {
            items: [
              task("b", {
                checked: true,
                completed_at: "2026-09-28T10:00:00.000000Z",
              }),
            ],
            next_cursor: "page-2",
          }
        : {
            items: [
              task("c", {
                checked: true,
                completed_at: "2026-09-27T10:00:00.000000Z",
              }),
            ],
            next_cursor: null,
          };
    expect((await once()).code).toBe(0);
    expect(completedAsked.map((query) => query.get("cursor"))).toEqual([
      null,
      "page-2",
    ]);
    const [first] = completedAsked;
    const since = Date.parse(first?.get("since") ?? "");
    const until = Date.parse(first?.get("until") ?? "");
    expect(first?.get("since")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(first?.get("until")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(until - since).toBe(84 * 86_400_000);
    expect(Math.abs(until - Date.now())).toBeLessThan(60_000);
    expect(first?.get("limit")).toBe("200");
    expect(marfa.row("2671355:a").properties["status"]).toBe("pending");
    expect(marfa.row("2671355:b").properties).toMatchObject({
      status: "completed",
      completed_at: "2026-09-28T10:00:00.000Z",
    });
    expect(marfa.row("2671355:c").properties["status"]).toBe("completed");
    expect((await once()).code).toBe(0);
    expect(completedAsked).toHaveLength(2);
  });

  it("reads a task completed while the state was lost as completed", async () => {
    let completed = false;
    answer = () => ({
      sync_token: "t1",
      items: completed ? [] : [task("a"), task("b")],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["status"]).toBe("pending");
    marfa.states.delete("todoist");
    completed = true;
    completedAnswer = () => ({
      items: [
        task("a", {
          checked: true,
          completed_at: "2026-09-28T10:00:00.000000Z",
        }),
      ],
      next_cursor: null,
    });
    expect((await once()).code).toBe(0);
    expect(received.map((request) => request.syncToken)).toEqual(["*", "*"]);
    expect(marfa.row("2671355:a").properties).toMatchObject({
      status: "completed",
      completed_at: "2026-09-28T10:00:00.000Z",
    });
    expect(marfa.row("2671355:a").state).toBe("active");
    expect(tasksAsked).toEqual(["b"]);
    expect(marfa.row("2671355:b").state).toBe("active");
  });

  it("takes a delta Todoist answers in full as a full sync, and asks about each open row it left out", async () => {
    answer = (syncToken) => ({
      sync_token: syncToken === "*" ? "t1" : "t2",
      ...(syncToken !== "*" && { full_sync: true }),
      items:
        syncToken === "*" ? [task("a"), task("b"), task("c")] : [task("a")],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    taskAnswer = (id) =>
      id === "b"
        ? task("b", { is_deleted: true })
        : task(id, {
            checked: true,
            completed_at: "2026-03-02T10:00:00.000000Z",
          });
    expect((await once()).code).toBe(0);
    expect(tasksAsked).toEqual([]);
    expect((await once()).code).toBe(0);
    expect(completedAsked).toHaveLength(2);
    expect(tasksAsked.sort()).toEqual(["b", "c"]);
    expect(marfa.row("2671355:a").state).toBe("active");
    expect(marfa.row("2671355:b").state).toBe("archived");
    expect(marfa.row("2671355:c").properties).toMatchObject({
      status: "completed",
      completed_at: "2026-03-02T10:00:00.000Z",
    });
    expect(state()["sync_token"]).toBe("t2");
  });

  it("reads a completed task's due date anew when the account's timezone moves", async () => {
    const done = task("a", {
      due: wholeDaySent,
      checked: true,
      completed_at: "2026-09-28T10:00:00.000000Z",
    });
    let zone = "Europe/London";
    answer = (syncToken) => ({
      sync_token: syncToken === "*" ? "t-full" : "t-delta",
      items: syncToken === "*" ? [] : [done],
      user: { id: "2671355", tz_info: { timezone: zone } },
    });
    expect((await once()).code).toBe(0);
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["due_at"]).toBe(
      "2026-09-29T23:00:00.000Z",
    );
    answer = (syncToken) => ({
      sync_token: syncToken === "*" ? "t-full" : "t-delta",
      items: [],
      user: { id: "2671355", tz_info: { timezone: zone } },
    });
    completedAnswer = () => ({ items: [done], next_cursor: null });
    zone = "America/New_York";
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties).toMatchObject({
      due_at: "2026-09-30T04:00:00.000Z",
      status: "completed",
    });
  });

  it("lets a full sync's open task win over a completion the completed tasks list for it", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("r", { content: "Water the plants" })],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    completedAnswer = () => ({
      items: [
        task("r", {
          content: "Water the plants, an older copy",
          checked: true,
          completed_at: "2026-09-28T10:00:00.000000Z",
        }),
      ],
      next_cursor: null,
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:r").properties).toMatchObject({
      title: "Water the plants",
      status: "pending",
    });
  });

  it("goes on without the completed tasks when Todoist closes their list to the token, and says so", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [task("a")],
      user: { id: "2671355", tz_info: { timezone: "Europe/London" } },
    });
    completedAnswer = () => 403;
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").properties["status"]).toBe("pending");
    expect(marfa.runs.at(-1)?.summary).toContain(
      "Todoist refused to list the account's completed tasks",
    );
    expect(state()).toMatchObject({ sync_token: "t1" });
  });

  it("registers its type on an instance that has none", async () => {
    marfa.types.delete("todoist.task");
    expect((await once()).code).toBe(0);
    expect(marfa.requestsTo("POST", "/types")).toHaveLength(1);
  });
});

describe("a project that goes", () => {
  const work: TodoistProject = { id: "pw", name: "Work" };
  const home: TodoistProject = { id: "ph", name: "Home" };
  const user = { id: "2671355", tz_info: { timezone: "Europe/London" } };
  const a = task("a", { project_id: "pw" });
  const b = task("b", { project_id: "pw", parent_id: "a" });
  const c = task("c", {
    project_id: "pw",
    checked: true,
    completed_at: "2026-09-28T10:00:00.000000Z",
  });
  const h = task("h", { project_id: "ph" });

  function states(): Record<string, string> {
    return Object.fromEntries(
      ["a", "b", "c", "h"].map((id) => [id, marfa.row(`2671355:${id}`).state]),
    );
  }

  async function followed(): Promise<void> {
    answer = () => ({
      sync_token: "t1",
      items: [a, b, h],
      projects: [inbox, work, home],
      user,
    });
    completedAnswer = (query) => ({
      items: query.get("project_id") === null ? [c] : [],
      next_cursor: null,
    });
    expect((await once()).code).toBe(0);
    expect(states()).toEqual({
      a: "active",
      b: "active",
      c: "active",
      h: "active",
    });
  }

  function delta(
    projects: TodoistProject[],
    items: TodoistItem[] = [],
    listed: TodoistProject[] = [inbox, work, home],
  ): void {
    answer = (syncToken) =>
      syncToken === "*"
        ? { sync_token: "t-full", items: [], projects: listed, user }
        : { sync_token: "t2", items, projects };
  }

  it("archives the rows of an archived project's tasks, subtasks and completed ones included, and leaves another project's alone", async () => {
    await followed();
    delta([{ ...work, is_archived: true }]);
    expect((await once()).code).toBe(0);
    expect(states()).toEqual({
      a: "archived",
      b: "archived",
      c: "archived",
      h: "active",
    });
    expect(marfa.row("2671355:h").version).toBe(1);
    expect(state()["projects"]).toEqual(["p1", "ph"]);
    expect(state()["sync_token"]).toBe("t2");
    delta([]);
    expect((await once()).code).toBe(0);
    expect(states()).toMatchObject({ a: "archived", c: "archived" });
    expect(tasksAsked).toEqual([]);
  });

  it("archives the rows of a deleted project's tasks, which Todoist does not send", async () => {
    await followed();
    delta([{ ...work, is_deleted: true }]);
    expect((await once()).code).toBe(0);
    expect(states()).toEqual({
      a: "archived",
      b: "archived",
      c: "archived",
      h: "active",
    });
  });

  it("brings an archived project's tasks back as they were when it is unarchived, asking Todoist for the completed ones it does not send again", async () => {
    await followed();
    delta([{ ...work, is_archived: true }]);
    expect((await once()).code).toBe(0);
    delta([{ ...work, is_archived: false }], [a, b]);
    completedAnswer = (query) => ({
      items: query.get("project_id") === "pw" ? [c] : [],
      next_cursor: null,
    });
    const asked = completedAsked.length;
    expect((await once()).code).toBe(0);
    expect(completedAsked.slice(asked).map((q) => q.get("project_id"))).toEqual(
      ["pw"],
    );
    expect(states()).toEqual({
      a: "active",
      b: "active",
      c: "active",
      h: "active",
    });
    expect(marfa.row("2671355:b").properties["parent_id"]).toBe("a");
    expect(marfa.row("2671355:c").properties["status"]).toBe("completed");
    expect([...(state()["projects"] as string[])].sort()).toEqual([
      "p1",
      "ph",
      "pw",
    ]);
  });

  it("never writes back a task of a gone project that a later delta, full sync or the completed tasks list names", async () => {
    await followed();
    delta([{ ...work, is_archived: true }]);
    expect((await once()).code).toBe(0);
    // Todoist sends a task edited in an archived project in the next delta
    // (seen live in October 2026).
    delta(
      [],
      [{ ...a, content: "Edited while archived" }],
      [inbox, { ...work, is_archived: true }, home],
    );
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").state).toBe("archived");
    expect(marfa.row("2671355:a").properties["title"]).not.toBe(
      "Edited while archived",
    );
    answer = () => ({
      sync_token: "t3",
      full_sync: true,
      items: [h, a],
      projects: [inbox, { ...work, is_archived: true }, home],
      user,
    });
    completedAnswer = () => ({ items: [c], next_cursor: null });
    expect((await once()).code).toBe(0);
    expect(states()).toEqual({
      a: "archived",
      b: "archived",
      c: "archived",
      h: "active",
    });
  });

  it("archives the rows of a project a whole list leaves out, whatever a delta left unsaid", async () => {
    await followed();
    answer = () => ({
      sync_token: "t3",
      full_sync: true,
      items: [h],
      projects: [inbox, home],
      user,
    });
    expect((await once()).code).toBe(0);
    expect(states()).toEqual({
      a: "archived",
      b: "archived",
      c: "archived",
      h: "active",
    });
  });

  it("lists every project first with a token held from before projects were followed, and archives the rows of a project it leaves out", async () => {
    await followed();
    Reflect.deleteProperty(state(), "projects");
    answer = (syncToken, resources) =>
      syncToken === "*"
        ? {
            sync_token: "t-projects",
            items: [],
            projects: resources === '["projects"]' ? [inbox, home] : [],
          }
        : { sync_token: "t2", items: [], projects: [], user };
    expect((await once()).code).toBe(0);
    expect(received.slice(1)).toEqual([
      {
        syncToken: "t1",
        resources: '["items","projects","user"]',
        authorized: true,
      },
      { syncToken: "*", resources: '["projects"]', authorized: true },
    ]);
    expect(states()).toEqual({
      a: "archived",
      b: "archived",
      c: "archived",
      h: "active",
    });
    expect(state()).toMatchObject({ projects: ["p1", "ph"], sync_token: "t2" });
  });

  it("holds the token and archives nothing when the list of projects cannot be read", async () => {
    await followed();
    Reflect.deleteProperty(state(), "projects");
    answer = (syncToken, resources) =>
      resources === '["projects"]'
        ? 400
        : { sync_token: "t2", items: [], projects: [], user };
    const { code } = await once();
    expect(code).toBe(1);
    expect(states()).toMatchObject({ a: "active", c: "active" });
    expect(state()["sync_token"]).toBe("t1");
  });

  it("takes a list of projects that names no Inbox as not whole, archives nothing for it, and says so", async () => {
    answer = () => ({
      sync_token: "t1",
      items: [a, h],
      projects: [home],
      user,
    });
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").state).toBe("active");
    expect(marfa.runs.at(-1)?.summary).toContain("named no Inbox");
    expect(state()).not.toHaveProperty("projects");
  });

  it("reads the whole list of projects when a delta sends a task of a project it neither named nor held, and writes that task", async () => {
    await followed();
    const fresh: TodoistProject = { id: "pn", name: "New" };
    answer = (syncToken) =>
      syncToken === "*"
        ? {
            sync_token: "t-full",
            items: [],
            projects: [inbox, work, home, fresh],
            user,
          }
        : {
            sync_token: "t2",
            items: [task("n", { project_id: "pn" })],
            projects: [],
            user,
          };
    expect((await once()).code).toBe(0);
    expect(received.slice(1).map((r) => r.resources)).toEqual([
      '["items","projects","user"]',
      '["projects"]',
    ]);
    expect(marfa.row("2671355:n").state).toBe("active");
    expect([...(state()["projects"] as string[])].sort()).toEqual([
      "p1",
      "ph",
      "pn",
      "pw",
    ]);
    expect(states()).toEqual({
      a: "active",
      b: "active",
      c: "active",
      h: "active",
    });
  });

  it("does not archive a row a person restored when Todoist sends its archived project again", async () => {
    await followed();
    delta([{ ...work, is_archived: true }]);
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").state).toBe("archived");
    projectAnswer = (id) => ({ ...work, id, is_archived: true });
    marfa.transition(marfa.row("2671355:a").id, "active");
    delta([]);
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").state).toBe("active");
    expect(marfa.runs.at(-1)?.summary).toContain("is archived");
    // A rename of an archived project sends its record again.
    delta([{ ...work, name: "Work, renamed", is_archived: true }]);
    expect((await once()).code).toBe(0);
    expect(marfa.row("2671355:a").state).toBe("active");
  });

  it("does not ask about a restored row whose project is gone, nor name it as unanswered", async () => {
    await followed();
    delta([{ ...work, is_deleted: true }]);
    expect((await once()).code).toBe(0);
    marfa.transition(marfa.row("2671355:a").id, "active");
    delta([]);
    expect((await once()).code).toBe(0);
    answer = () => ({
      sync_token: "t3",
      full_sync: true,
      items: [h],
      projects: [inbox, home],
      user,
    });
    tasksAsked.length = 0;
    const { code, output } = await once();
    expect(code).toBe(0);
    expect(tasksAsked).not.toContain("a");
    expect(output).not.toContain("so its row is left as it is");
    expect(marfa.row("2671355:a").state).toBe("active");
  });

  it("leaves a row as it is when a task Todoist answers for has moved to a project that is gone", async () => {
    await followed();
    answer = () => ({
      sync_token: "t3",
      full_sync: true,
      items: [a, b],
      projects: [
        inbox,
        work,
        home,
        { id: "px", name: "Old", is_archived: true },
      ],
      user,
    });
    taskAnswer = (id) =>
      id === "h" ? task("h", { content: "Moved", project_id: "px" }) : 404;
    completedAnswer = () => ({ items: [c], next_cursor: null });
    expect((await once()).code).toBe(0);
    expect(tasksAsked).toContain("h");
    expect(marfa.row("2671355:h").properties["title"]).toBe("Task h");
    expect(marfa.row("2671355:h").properties["project_id"]).toBe("ph");
  });
});

describe("following projects", () => {
  const log = { condition: () => undefined } as unknown as Log;
  const user = { id: "2671355" };
  const work: TodoistProject = { id: "pw", name: "Work" };

  it("places a task where its project is in use, where it names none, or where none is known", () => {
    const placed = placedIn(new Set(["pw"]));
    expect(placed(task("a", { project_id: "pw" }))).toBe(true);
    expect(placed(task("a", { project_id: "px" }))).toBe(false);
    expect(placed(task("a", { project_id: null as unknown as string }))).toBe(
      true,
    );
    expect(placedIn(undefined)(task("a", { project_id: "px" }))).toBe(true);
  });

  it("reads the whole list only for a task whose project is not held", async () => {
    const reads: string[] = [];
    const list = (): Promise<TodoistProject[]> => {
      reads.push("list");
      return Promise.resolve([inbox, work, { id: "pn", name: "New" }]);
    };
    const kept = new Set(["p1", "pw"]);
    const held = await knowing([task("a", { project_id: "pw" })], kept, list);
    expect(held).toBe(kept);
    expect(reads).toEqual([]);
    const fresh = await knowing([task("n", { project_id: "pn" })], kept, list);
    expect([...(fresh ?? [])].sort()).toEqual(["p1", "pn", "pw"]);
    expect(reads).toEqual(["list"]);
    expect(await knowing([task("n")], undefined, list)).toBeUndefined();
    expect(reads).toEqual(["list"]);
  });

  it("keeps what is held when the list read for a task of an unheld project names no Inbox", async () => {
    const kept = new Set(["p1"]);
    const held = await knowing([task("n", { project_id: "pn" })], kept, () =>
      Promise.resolve([work]),
    );
    expect(held).toBe(kept);
  });

  it("takes a project as gone only when it was held", async () => {
    const answer = {
      sync_token: "t",
      items: [],
      projects: [
        { id: "pw", name: "Work", is_archived: true },
        { id: "pz", name: "Never held", is_archived: true },
      ],
      user,
    };
    const followed = await followProjects(
      answer,
      false,
      new Set(["p1", "pw"]),
      () => Promise.reject(new Error("no list is needed")),
      log,
    );
    expect([...followed.gone]).toEqual(["pw"]);
    expect([...(followed.inUse ?? [])]).toEqual(["p1"]);
  });
});
