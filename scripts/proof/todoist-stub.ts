import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  labels: string[];
  priority: number;
  due: Record<string, unknown> | null;
  child_order: number;
  checked: boolean;
  completed_at: string | null;
  is_deleted: boolean;
  added_at: string;
  updated_at: string;
}

export interface ReceivedCommand {
  type: string;
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  at: number;
  syncToken?: string;
  commands?: ReceivedCommand[];
}

interface Refusal {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  when?: (request: ReceivedRequest) => boolean;
}

type CommandStatus = "ok" | Record<string, unknown>;

// Todoist remembers a command's `uuid` with the answer it took: a replayed
// command is answered as before and changes nothing. A refused one is not
// remembered: a valid command sent again under its uuid is run (seen live in
// October 2026, with `item_add` and `item_update`).
// Deltas are by a sequence each change moves, so the connector's own change
// comes back on the next sync.
export class TodoistStub {
  projects: Set<string> | undefined;
  // Each section's project, so a move into a section lands in its project.
  sections: Map<string, string> | undefined;
  // Called with each request as it arrives, before it is answered, so a test
  // can have Todoist change between the connector's reading and its writing.
  before: ((request: ReceivedRequest) => void) | undefined;
  readonly tasks = new Map<string, StubTask>();
  readonly received: ReceivedRequest[] = [];
  account = "1001";
  timezone: string | null = "Europe/London";
  private userSeq = 0;
  // A day before the scripted server's clock, so a command the connector
  // sends is earlier than a person's later change in Marfa.
  now = "2026-09-24T12:00:00.000000Z";
  url = "";
  private seq = 0;
  private readonly changed = new Map<string, number>();
  private readonly answered = new Map<
    string,
    { status: CommandStatus; mapped?: [string, string] }
  >();
  private readonly refusals: Refusal[] = [];
  private readonly scripted = new Map<
    string,
    { status: CommandStatus | "nothing"; times: number }
  >();
  private made = 0;
  private readonly http: Server;

  constructor(private readonly token: string) {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        this.answer(
          req.method ?? "GET",
          req.url ?? "/",
          req.headers.authorization === `Bearer ${this.token}`,
          Buffer.concat(chunks).toString("utf8"),
          (status, body, headers) => {
            res.writeHead(status, {
              "Content-Type": "application/json",
              ...headers,
            });
            res.end(body === undefined ? "" : JSON.stringify(body));
          },
        );
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((done) => this.http.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${String((this.http.address() as AddressInfo).port)}`;
    return this;
  }

  close(): Promise<void> {
    return new Promise((done) => {
      this.http.closeAllConnections();
      this.http.close(() => {
        done();
      });
    });
  }

  task(id: string, overrides: Partial<StubTask> = {}): StubTask {
    return {
      id,
      content: `Task ${id}`,
      description: "",
      project_id: "inbox",
      section_id: null,
      parent_id: null,
      labels: [],
      priority: 1,
      due: null,
      child_order: 1,
      checked: false,
      completed_at: null,
      is_deleted: false,
      added_at: "2026-09-20T09:00:00.000000Z",
      updated_at: "2026-09-20T09:00:00.000000Z",
      ...overrides,
    };
  }

  put(...tasks: StubTask[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      this.touch(task.id, false);
    }
  }

  edit(id: string, patch: Partial<StubTask>): StubTask {
    const task = this.get(id);
    Object.assign(task, patch);
    this.touch(id);
    return task;
  }

  complete(id: string): StubTask {
    return this.edit(id, { checked: true, completed_at: this.now });
  }

  reopen(id: string): StubTask {
    return this.edit(id, { checked: false, completed_at: null });
  }

  delete(id: string): StubTask {
    return this.edit(id, { is_deleted: true });
  }

  renameZone(zone: string | null): void {
    this.timezone = zone;
    this.seq += 1;
    this.userSeq = this.seq;
  }

  refuseNext(
    status: number,
    options: {
      headers?: Record<string, string>;
      body?: unknown;
      when?: (request: ReceivedRequest) => boolean;
    } = {},
  ): void {
    this.refusals.push({
      status,
      body: options.body,
      ...(options.headers !== undefined && { headers: options.headers }),
      ...(options.when !== undefined && { when: options.when }),
    });
  }

  scriptCommand(type: string, status: CommandStatus, times = 1): void {
    this.scripted.set(type, { status, times });
  }

  answerNothing(type: string): void {
    this.scripted.set(type, { status: "nothing", times: 1 });
  }

  commands(type?: string): ReceivedCommand[] {
    return this.received
      .flatMap((request) => request.commands ?? [])
      .filter((command) => type === undefined || command.type === type);
  }

  private get(id: string): StubTask {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`the stub holds no task ${id}`);
    return task;
  }

  private touch(id: string, stamp = true): void {
    this.seq += 1;
    this.changed.set(id, this.seq);
    if (stamp) this.get(id).updated_at = this.now;
  }

  private answer(
    method: string,
    url: string,
    authorized: boolean,
    body: string,
    reply: (
      status: number,
      body?: unknown,
      headers?: Record<string, string>,
    ) => void,
  ): void {
    const asked = new URL(url, "http://stub");
    const path = asked.pathname;
    const record: ReceivedRequest = { method, path, at: Date.now() };
    if (method === "POST" && path === "/api/v1/sync") {
      const form = new URLSearchParams(body);
      const commands = form.get("commands");
      if (commands !== null) {
        record.commands = JSON.parse(commands) as ReceivedCommand[];
      } else {
        record.syncToken = form.get("sync_token") ?? "*";
      }
    }
    this.received.push(record);
    this.before?.(record);
    const refusing = this.refusals.findIndex(
      (refusal) => refusal.when === undefined || refusal.when(record),
    );
    if (refusing !== -1) {
      const [refusal] = this.refusals.splice(refusing, 1);
      reply(refusal?.status ?? 500, refusal?.body, refusal?.headers);
      return;
    }
    if (!authorized) {
      reply(401, { error: "Unauthorized" });
      return;
    }
    if (
      method === "GET" &&
      path === "/api/v1/tasks/completed/by_completion_date"
    ) {
      const [status, page] = this.completedPage(asked.searchParams);
      reply(status, page);
      return;
    }
    const task = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path);
    if (method === "GET" && task !== null) {
      // Todoist answers a completed or deleted task with 200, flagged, though
      // its reference calls the door active-only (seen live in October 2026);
      // only one never made is a 404.
      const found = this.tasks.get(decodeURIComponent(task[1] ?? ""));
      if (found === undefined) {
        reply(404, { error: "Task not found" });
        return;
      }
      reply(200, found);
      return;
    }
    if (record.commands !== undefined) {
      reply(200, this.run(record.commands));
      return;
    }
    if (record.syncToken !== undefined) {
      reply(200, this.delta(record.syncToken));
      return;
    }
    reply(404, { error: "no such door" });
  }

  // Todoist's full sync lists active tasks only; a delta lists every change
  // since the token, completions and deletions included.
  private delta(syncToken: string): unknown {
    const since =
      syncToken === "*" ? 0 : Number(syncToken.replace("token-", ""));
    const items = [...this.tasks.values()].filter((task) =>
      syncToken === "*"
        ? !task.is_deleted && !task.checked
        : (this.changed.get(task.id) ?? 0) > since,
    );
    return {
      sync_token: `token-${String(this.seq)}`,
      full_sync: syncToken === "*",
      items,
      ...((syncToken === "*" || this.userSeq > since) && {
        user: {
          id: this.account,
          tz_info: { timezone: this.timezone },
        },
      }),
    };
  }

  /**
   * The tasks completed between `since` and `until`, both required and at
   * most three months apart, newest completion first, `limit` to a page
   * (50 unless named, at most 200) and the next page by `next_cursor`.
   */
  private completedPage(query: URLSearchParams): [number, unknown] {
    const since = Date.parse(query.get("since") ?? "");
    const until = Date.parse(query.get("until") ?? "");
    const limit = Number(query.get("limit") ?? "50");
    const offset = Number(query.get("cursor") ?? "0");
    const furthest = new Date(since);
    furthest.setUTCMonth(furthest.getUTCMonth() + 3);
    if (
      Number.isNaN(since) ||
      Number.isNaN(until) ||
      until < since ||
      until > furthest.getTime() ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      return [400, { error: "Invalid argument value" }];
    }
    const done = [...this.tasks.values()]
      .filter((task) => {
        const at = Date.parse(task.completed_at ?? "");
        return task.checked && !task.is_deleted && at >= since && at <= until;
      })
      .sort(
        (a, b) =>
          Date.parse(b.completed_at ?? "") - Date.parse(a.completed_at ?? ""),
      );
    const items = done.slice(offset, offset + limit);
    return [
      200,
      {
        items,
        next_cursor:
          offset + limit < done.length ? String(offset + limit) : null,
      },
    ];
  }

  private run(commands: ReceivedCommand[]): unknown {
    const sync_status: Record<string, CommandStatus> = {};
    const temp_id_mapping: Record<string, string> = {};
    for (const command of commands) {
      const before = this.answered.get(command.uuid);
      if (before !== undefined) {
        sync_status[command.uuid] = before.status;
        if (before.mapped !== undefined) {
          temp_id_mapping[before.mapped[0]] = before.mapped[1];
        }
        continue;
      }
      const scripted = this.scripted.get(command.type);
      if (scripted !== undefined) {
        scripted.times -= 1;
        if (scripted.times <= 0) this.scripted.delete(command.type);
        if (scripted.status !== "nothing") {
          sync_status[command.uuid] = scripted.status;
        }
        continue;
      }
      const { status, made } = this.apply(command);
      let mapped: [string, string] | undefined;
      if (made !== undefined && command.temp_id !== undefined) {
        mapped = [command.temp_id, made];
        temp_id_mapping[command.temp_id] = made;
      }
      this.answered.set(command.uuid, {
        status,
        ...(mapped !== undefined && { mapped }),
      });
      sync_status[command.uuid] = status;
    }
    return { sync_status, temp_id_mapping };
  }

  private apply(command: ReceivedCommand): {
    status: CommandStatus;
    made?: string;
  } {
    const args = command.args;
    const id = typeof args["id"] === "string" ? args["id"] : undefined;
    const notFound: CommandStatus = {
      error_code: 22,
      error: "Item not found",
      http_code: 400,
    };
    switch (command.type) {
      case "item_add": {
        const project = args["project_id"];
        if (
          typeof project === "string" &&
          this.projects !== undefined &&
          !this.projects.has(project)
        ) {
          return {
            status: {
              error: "Project not found",
              error_code: 21,
              error_extra: { project_id: project },
              error_tag: "PROJECT_NOT_FOUND",
              http_code: 400,
            },
          };
        }
        this.made += 1;
        const made = `made-${String(this.made)}`;
        const fields: Partial<StubTask> = this.fields(args);
        if (typeof project === "string") fields.project_id = project;
        const section = args["section_id"];
        // Todoist makes a task naming a section deleted since at the root of
        // its project rather than refusing it.
        if (typeof section === "string") {
          fields.section_id =
            this.sections === undefined || this.sections.has(section)
              ? section
              : null;
        }
        this.tasks.set(
          made,
          this.task(made, {
            ...fields,
            added_at: this.now,
            updated_at: this.now,
          }),
        );
        this.touch(made);
        return { status: "ok", made };
      }
      case "item_update": {
        const task = id === undefined ? undefined : this.tasks.get(id);
        if (task === undefined || task.is_deleted) return { status: notFound };
        // `item_update` takes no project or section: a task moves only
        // through `item_move` (seen live in October 2026).
        Object.assign(task, this.fields(args));
        this.touch(task.id);
        return { status: "ok" };
      }
      case "item_move": {
        const task = id === undefined ? undefined : this.tasks.get(id);
        if (task === undefined || task.is_deleted) return { status: notFound };
        return { status: this.move(task, args) };
      }
      case "item_close": {
        const task = id === undefined ? undefined : this.tasks.get(id);
        if (task === undefined || task.is_deleted) return { status: notFound };
        // Todoist closes a recurring task by moving it to its next
        // occurrence, open, rather than completing it.
        if (task.due?.["is_recurring"] === true) {
          this.edit(task.id, { due: nextOccurrence(task.due) });
          return { status: "ok" };
        }
        if (!task.checked) this.complete(task.id);
        return { status: "ok" };
      }
      case "item_uncomplete": {
        const task = id === undefined ? undefined : this.tasks.get(id);
        if (task === undefined || task.is_deleted) return { status: notFound };
        if (task.checked) this.reopen(task.id);
        return { status: "ok" };
      }
      case "item_delete": {
        const task = id === undefined ? undefined : this.tasks.get(id);
        if (task === undefined) return { status: notFound };
        // Todoist answers the delete of a task already deleted as done.
        if (task.is_deleted) return { status: "ok" };
        // Todoist deletes a task with every task beneath it.
        const doomed = [task.id];
        // An array's iterator reaches what is pushed while it runs, so
        // this walks every generation.
        for (const parent of doomed) {
          for (const child of this.tasks.values()) {
            if (child.parent_id === parent && !child.is_deleted) {
              doomed.push(child.id);
            }
          }
        }
        for (const gone of doomed) this.delete(gone);
        return { status: "ok" };
      }
      default:
        return {
          status: {
            error_code: 16,
            error: "Invalid command type",
            http_code: 400,
          },
        };
    }
  }

  // Exactly one destination, as Todoist takes. A move to a project or a
  // section leaves the task a task of its own at the end of that place, and
  // one to the project it is in takes it out of its section (seen live in
  // October 2026). A project or section Todoist does not hold, or one
  // deleted, is refused as not found; an archived project takes the task.
  private move(task: StubTask, args: Record<string, unknown>): CommandStatus {
    const named = ["parent_id", "section_id", "project_id"].filter(
      (key) => typeof args[key] === "string",
    );
    if (named.length !== 1) {
      return {
        error: "Invalid argument value",
        error_code: 20,
        error_extra: {
          argument: "args",
          expected: `Value error, ${named.length === 0 ? "One" : "Only one"} of parent_id, section_id, project_id must be defined`,
        },
        error_tag: "INVALID_ARGUMENT_VALUE",
        http_code: 400,
      };
    }
    const project = args["project_id"];
    const section = args["section_id"];
    if (typeof project === "string") {
      if (this.projects !== undefined && !this.projects.has(project)) {
        return {
          error: "Project not found",
          error_code: 21,
          error_extra: {},
          error_tag: "PROJECT_NOT_FOUND",
          http_code: 400,
        };
      }
      this.edit(task.id, {
        project_id: project,
        section_id: null,
        parent_id: null,
      });
    } else if (typeof section === "string") {
      const home = this.sections?.get(section);
      if (this.sections !== undefined && home === undefined) {
        return {
          error: "Section not found",
          error_code: 58,
          error_extra: {},
          error_tag: "SECTION_NOT_FOUND",
          http_code: 400,
        };
      }
      this.edit(task.id, {
        section_id: section,
        parent_id: null,
        ...(home !== undefined && { project_id: home }),
      });
    } else {
      throw new Error("the stub does not move a task under another task");
    }
    return "ok";
  }

  private fields(args: Record<string, unknown>): Partial<StubTask> {
    const out: Partial<StubTask> = {};
    if (typeof args["content"] === "string") out.content = args["content"];
    if (typeof args["description"] === "string") {
      out.description = args["description"];
    }
    if (typeof args["priority"] === "number") out.priority = args["priority"];
    if (Array.isArray(args["labels"])) out.labels = args["labels"] as string[];
    if ("due" in args) {
      const due = args["due"];
      out.due =
        due === null
          ? null
          : dueOf(due as Record<string, unknown>, this.timezone);
    }
    return out;
  }
}

/**
 * A due as Todoist answers it, seen live in October 2026: a date alone makes a
 * task due once, a recurring one included, with the date as its text; a
 * recurrence's text sent with a date keeps the recurrence and takes the date
 * as its next occurrence, whatever day it falls on, and keeps a whole day or
 * a time as sent whatever the recurrence names; a time fixed in UTC takes the
 * zone sent with it, or the account's, and a floating one none. The stub reads a text beginning "every" or "after"
 * as a recurrence, where Todoist parses it.
 */
function dueOf(
  sent: Record<string, unknown>,
  zone: string | null,
): Record<string, unknown> {
  const date = typeof sent["date"] === "string" ? sent["date"] : null;
  const text = typeof sent["string"] === "string" ? sent["string"] : date;
  return {
    date,
    timezone:
      typeof sent["timezone"] === "string"
        ? sent["timezone"]
        : date?.endsWith("Z") === true
          ? zone
          : null,
    string: text,
    lang: typeof sent["lang"] === "string" ? sent["lang"] : "en",
    is_recurring:
      typeof sent["string"] === "string" &&
      /^(every|after)\b/i.test(sent["string"]),
  };
}

function nextOccurrence(due: Record<string, unknown>): Record<string, unknown> {
  const date = typeof due["date"] === "string" ? due["date"] : "";
  const next = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { ...due, date: next.toISOString().slice(0, 10) };
}
