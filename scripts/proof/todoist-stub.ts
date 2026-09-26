import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A task as the stub holds it and as both doors answer it: the Sync API's
 * item and the REST door's task carry the same fields for what the
 * connector reads.
 */
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
  note_count: number;
  added_at: string;
  updated_at: string;
}

/** One command as it arrived, for a test to assert on. */
export interface ReceivedCommand {
  type: string;
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  /** When it arrived, in milliseconds, so a wait between two can be measured. */
  at: number;
  syncToken?: string;
  commands?: ReceivedCommand[];
}

/** A refusal the next request is answered with, in place of the door. */
interface Refusal {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Only a request this admits is refused; the rest are answered as usual. */
  when?: (request: ReceivedRequest) => boolean;
}

type CommandStatus = "ok" | Record<string, unknown>;

/**
 * Todoist, as far as the connector can tell: a stateful account whose
 * tasks the Sync API lists whole and by delta, whose commands change them
 * and answer under `sync_status` and `temp_id_mapping`, and whose REST
 * door answers a task open or completed and 404 for one deleted.
 *
 * A command's `uuid` is remembered with its answer, so a command sent
 * again is answered as it was and changes nothing, which is what Todoist
 * was seen to do with a replayed `item_add` in the real run. Deltas are by a
 * sequence each change moves, so a change the connector made comes back
 * to it on the next sync, as Todoist's does.
 */
export class TodoistStub {
  /** The account's projects, where a test names them; any project otherwise. */
  projects: Set<string> | undefined;
  readonly tasks = new Map<string, StubTask>();
  readonly received: ReceivedRequest[] = [];
  account = "1001";
  timezone: string | null = "Europe/London";
  /** The sequence at which the account itself last changed, for a delta to carry it. */
  private userSeq = 0;
  /**
   * The moment a change is stamped with, the connector's own commands
   * included; a test moves it to place a change in time. It starts a day
   * before the scripted server's clock, so a command the connector sends
   * is earlier than any change a person then makes in Marfa, as it is
   * with real clocks.
   */
  now = "2026-09-24T12:00:00.000000Z";
  url = "";
  private seq = 0;
  private readonly changed = new Map<string, number>();
  private readonly answered = new Map<
    string,
    { status: CommandStatus; mapped?: [string, string] }
  >();
  private readonly refusals: Refusal[] = [];
  /** Answers scripted for the next commands of a type: a status, or none at all. */
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

  /** A task with every field, as a test starts one. */
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
      note_count: 0,
      added_at: "2026-09-20T09:00:00.000000Z",
      updated_at: "2026-09-20T09:00:00.000000Z",
      ...overrides,
    };
  }

  /** Puts tasks in the account, each as a change the next delta carries. */
  put(...tasks: StubTask[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      this.touch(task.id, false);
    }
  }

  /** A person changes a task in Todoist, at the stub's moment. */
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

  /** The account's zone moves, which the next delta carries as the account changed. */
  renameZone(zone: string | null): void {
    this.timezone = zone;
    this.seq += 1;
    this.userSeq = this.seq;
  }

  /**
   * The next request is answered with this status in place of the door,
   * or the next one `when` admits, so a test can refuse one command and
   * let the rest through.
   */
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

  /** The next command of this type is answered with this status instead of run. */
  scriptCommand(type: string, status: CommandStatus, times = 1): void {
    this.scripted.set(type, { status, times });
  }

  /** The next command of this type gets no entry under `sync_status` at all. */
  answerNothing(type: string): void {
    this.scripted.set(type, { status: "nothing", times: 1 });
  }

  /** The commands received, in order, of one type or all. */
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
    const path = new URL(url, "http://stub").pathname;
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
    const task = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path);
    if (method === "GET" && task !== null) {
      // A completed task is answered, checked, as the real door answers
      // it; only a deleted one is not found.
      const found = this.tasks.get(decodeURIComponent(task[1] ?? ""));
      if (found === undefined || found.is_deleted) {
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

  /**
   * A full sync lists the account's active tasks, completed and deleted
   * ones left out, and names the account; a delta lists what changed
   * since the token, completions and deletions included.
   */
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
      items,
      ...((syncToken === "*" || this.userSeq > since) && {
        user: {
          id: this.account,
          tz_info: { timezone: this.timezone },
        },
      }),
    };
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
        // A refusal is not remembered: Todoist answers a command that
        // did not run afresh when it is sent again.
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

  /** Runs one command: its status, and the id of a task `item_add` made. */
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
              error_code: 21,
              error: "Project not found",
              http_code: 404,
            },
          };
        }
        this.made += 1;
        const made = `made-${String(this.made)}`;
        this.tasks.set(
          made,
          this.task(made, {
            ...this.fields(args),
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
        Object.assign(task, this.fields(args));
        this.touch(task.id);
        return { status: "ok" };
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
        if (task === undefined || task.is_deleted) return { status: notFound };
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

  /** The task fields a command carries, as Todoist stores them. */
  private fields(args: Record<string, unknown>): Partial<StubTask> {
    const out: Partial<StubTask> = {};
    if (typeof args["content"] === "string") out.content = args["content"];
    if (typeof args["description"] === "string") {
      out.description = args["description"];
    }
    if (typeof args["priority"] === "number") out.priority = args["priority"];
    if (typeof args["project_id"] === "string") {
      out.project_id = args["project_id"];
    }
    if (typeof args["section_id"] === "string") {
      out.section_id = args["section_id"];
    }
    if (Array.isArray(args["labels"])) out.labels = args["labels"] as string[];
    if ("due" in args) {
      const due = args["due"];
      out.due =
        due === null
          ? null
          : {
              ...(due as Record<string, unknown>),
              is_recurring: false,
              timezone: null,
              lang: "en",
            };
    }
    return out;
  }
}

/** A daily recurring due date, a day on. */
function nextOccurrence(due: Record<string, unknown>): Record<string, unknown> {
  const date = typeof due["date"] === "string" ? due["date"] : "";
  const next = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { ...due, date: next.toISOString().slice(0, 10) };
}
