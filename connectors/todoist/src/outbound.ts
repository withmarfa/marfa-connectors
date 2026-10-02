import {
  LinkTaken,
  Refused,
  Unreachable,
  type Change,
  type EnvDeclaration,
  type Item,
  type WatchContext,
} from "@withmarfa/connector";
import {
  describeError,
  dueFor,
  dueOf,
  getTask,
  namedZoneOf,
  priorityFor,
  send,
  timezoneOf,
  Unanswered,
  user,
  uuidFor,
  type Command,
  type CommandAnswer,
  type CommandError,
  type SyncAnswer,
  type TaskAnswer,
  type TodoistItem,
} from "./todoist.js";
import todoistTask from "./todoist.task.json" with { type: "json" };

export const outboundEnv = {
  TODOIST_API_TOKEN: "secret",
  TODOIST_API_URL: "optional",
} as const satisfies EnvDeclaration;

export type OutboundEnv = typeof outboundEnv;

export const linkField = todoistTask.link_field;

export interface TaskArgs {
  content: string;
  description: string;
  priority: number;
  due: { date: string } | null;
}

export function argsOf(item: Item, timeZone: string): TaskArgs {
  const p = item.properties;
  return {
    content: typeof p["title"] === "string" ? p["title"] : "",
    // An empty description clears Todoist's, as an absent one on the row
    // is a description the row does not have.
    description: typeof p["description"] === "string" ? p["description"] : "",
    priority: priorityFor(p["priority"]),
    due: dueFor(p["due_at"], p["precision"], timeZone),
  };
}

export function differing(
  wanted: TaskArgs,
  task: TodoistItem,
  timeZone: string,
): Partial<TaskArgs> {
  const out: Partial<TaskArgs> = {};
  if (wanted.content !== task.content) out.content = wanted.content;
  if (wanted.description !== (task.description ?? "")) {
    out.description = wanted.description;
  }
  if (wanted.priority !== (task.priority ?? 1)) out.priority = wanted.priority;
  const have = dueOf(task.due, timeZone);
  const want = dueOf(wanted.due, timeZone);
  if (JSON.stringify(have) !== JSON.stringify(want)) out.due = wanted.due;
  return out;
}

const zones = new WeakMap<object, Promise<string>>();

function timeZoneFor(
  context: WatchContext<OutboundEnv>,
  todoist: Door,
): Promise<string> {
  const held = context.state.get("timezone");
  if (typeof held === "string") return Promise.resolve(held);
  let asked = zones.get(context);
  if (asked === undefined) {
    asked = (async (): Promise<string> => {
      const account = await todoist.user();
      const zone = timezoneOf(account);
      if (zone !== undefined) return zone;
      const unknown = namedZoneOf(account);
      if (unknown === undefined) {
        context.log.condition(
          "timezone-none",
          "Todoist named no timezone for the account, so its due dates are read in UTC",
        );
      } else {
        context.log.condition(
          `timezone-unknown:${unknown}`,
          `Todoist named the timezone ${unknown} for the account, which this platform does not know, so its due dates are read in UTC`,
        );
      }
      return "UTC";
    })();
    zones.set(context, asked);
  }
  return asked;
}

function linkOf(item: Item): string | undefined {
  const value = item.properties[linkField];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isNotFound(answer: CommandError | undefined): boolean {
  return answer?.error_code === 22 || answer?.error_tag === "ITEM_NOT_FOUND";
}

const scope = "Todoist";

// Sent again: a rate limit held past every resend, a server error, or no
// answer for the command, which Todoist runs once whatever is resent.
function passing(answer: CommandError | undefined): boolean {
  const code = answer?.http_code;
  return answer === undefined || code === 429 || (code ?? 0) >= 500;
}

function notTaken(answer: CommandError | undefined, what: string): Error {
  const reason =
    answer === undefined ? "no answer for the command" : describeError(answer);
  return passing(answer)
    ? new Unreachable(`Todoist is not taking changes for now: ${reason}`, {
        scope,
      })
    : new Refused(`Todoist refused ${what}: ${reason}`);
}

async function delivering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Unanswered) {
      throw new Unreachable(
        `Todoist is not taking changes for now: ${error.message}`,
        { scope },
      );
    }
    if (error instanceof LinkTaken) throw new Refused(error.message);
    throw error;
  }
}

function isCompleted(item: Item): boolean {
  return item.properties["status"] === "completed";
}

// The row's moment is in the id because a transition moves no version: a
// restore carried as an edit must not reuse the edit before it. A run replayed
// after a failure shows the same row, so it sends the same command.
function commandId(item: Item, type: string): string {
  return uuidFor(item.id, String(item.version), item.updated_at, type);
}

export function carry(
  change: Change,
  context: WatchContext<OutboundEnv>,
  base: string,
): Promise<undefined> {
  return delivering(() => carried(change, context, base));
}

export function remake(
  change: Change,
  context: WatchContext<OutboundEnv>,
  base: string,
): Promise<boolean> {
  return delivering(() => remade(change, context, base));
}

async function carried(
  change: Change,
  context: WatchContext<OutboundEnv>,
  base: string,
): Promise<undefined> {
  const { item, kind } = change;
  const { env, signal } = context;
  const todoist = new Door(base, env.TODOIST_API_TOKEN, signal);
  const timeZone = await timeZoneFor(context, todoist);
  let taskId = linkOf(item);

  if (kind === "archived" && change.changed.size === 0) return;

  if (taskId === undefined) {
    if (kind === "trashed" || kind === "purged") return;
    taskId = await add(item, timeZone, todoist, context);
  }

  if (kind === "trashed" || kind === "purged") {
    // A trash deletes: closing a recurring task would move it to its next
    // occurrence. The id is per row and task so a purge resends the same
    // delete, while a task made again after a restore gets its own.
    const answer = await todoist.one(
      "item_delete",
      uuidFor(item.id, taskId, "item_delete"),
      { id: taskId },
    );
    if (answer !== "ok" && !isNotFound(answer)) {
      throw notTaken(answer, `deleting task ${taskId}`);
    }
    return;
  }

  await sync(item, taskId, timeZone, todoist, context);
}

async function remade(
  change: Change,
  context: WatchContext<OutboundEnv>,
  base: string,
): Promise<boolean> {
  const { item } = change;
  const taskId = linkOf(item);
  if (taskId === undefined) return false;
  const todoist = new Door(base, context.env.TODOIST_API_TOKEN, context.signal);
  if ((await todoist.task(taskId)) !== "missing") return false;
  const timeZone = await timeZoneFor(context, todoist);
  const made = await add(item, timeZone, todoist, context, taskId);
  await sync(item, made, timeZone, todoist, context);
  return true;
}

async function sync(
  item: Item,
  taskId: string,
  timeZone: string,
  todoist: Door,
  context: WatchContext<OutboundEnv>,
): Promise<void> {
  const { log } = context;
  const task = await todoist.task(taskId);
  if (task === "forbidden") {
    throw new Refused(`Todoist refuses access to task ${taskId}`);
  }
  if (task === "missing") {
    // The door answers a completed task as well as an open one, so none
    // is a task deleted in Todoist, and nothing is asked of it.
    log.condition(
      `todoist-gone:${item.id}`,
      `Todoist no longer has task ${taskId} for row ${item.id}`,
    );
    return;
  }

  const diff = differing(argsOf(item, timeZone), task, timeZone);
  if (Object.keys(diff).length > 0) {
    const answer = await todoist.one(
      "item_update",
      commandId(item, "item_update"),
      { id: taskId, ...diff },
    );
    if (answer !== "ok") throw notTaken(answer, `updating task ${taskId}`);
  }
  const completed = isCompleted(item);
  if (completed === (task.checked === true)) return;
  const type = completed ? "item_close" : "item_uncomplete";
  const answer = await todoist.one(type, commandId(item, type), {
    id: taskId,
  });
  if (answer !== "ok") {
    throw notTaken(
      answer,
      `${completed ? "closing" : "reopening"} task ${taskId}`,
    );
  }
}

async function add(
  item: Item,
  timeZone: string,
  todoist: Door,
  context: WatchContext<OutboundEnv>,
  replacing?: string,
): Promise<string> {
  const again = replacing === undefined ? [] : [replacing];
  // `again` makes a restore a new create, not the first create's answer again.
  const uuid = uuidFor(item.id, "item_add", ...again);
  let tempId = uuidFor(item.id, "temp_id", ...again);
  // An edit does not carry project, section and labels; they are the row's from
  // Todoist.
  const p = item.properties;
  const where =
    replacing === undefined
      ? {}
      : {
          ...(typeof p["project_id"] === "string" && {
            project_id: p["project_id"],
          }),
          ...(typeof p["section_id"] === "string" && {
            section_id: p["section_id"],
          }),
          ...(Array.isArray(p["labels"]) && { labels: p["labels"] }),
        };
  let answer = await todoist.send([
    {
      type: "item_add",
      uuid,
      temp_id: tempId,
      args: { ...argsOf(item, timeZone), ...where },
    },
  ]);
  let status = answer.sync_status[uuid];
  if (status !== "ok" && !passing(status) && Object.keys(where).length > 0) {
    // Where the task was is gone, a project or a section deleted since:
    // it is made in the Inbox rather than not at all, under ids of its
    // own, since Todoist remembers the refused command.
    const inboxUuid = uuidFor(item.id, "item_add", ...again, "inbox");
    const inboxTemp = uuidFor(item.id, "temp_id", ...again, "inbox");
    answer = await todoist.send([
      {
        type: "item_add",
        uuid: inboxUuid,
        temp_id: inboxTemp,
        args: { ...argsOf(item, timeZone) },
      },
    ]);
    status = answer.sync_status[inboxUuid];
    tempId = inboxTemp;
  }
  if (status !== "ok") throw notTaken(status, "creating a task");
  const taskId = answer.temp_id_mapping?.[tempId];
  if (taskId === undefined) {
    throw new Refused(
      "Todoist took the create without naming the task it made; link the row to its task by hand",
    );
  }
  await context.setLink(item, taskId);
  return taskId;
}

class Door {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  send(commands: readonly Command[]): Promise<CommandAnswer> {
    return send(this.base, this.token, commands, this.signal);
  }

  async one(
    type: string,
    uuid: string,
    args: Record<string, unknown>,
  ): Promise<"ok" | CommandError | undefined> {
    const answer = await this.send([{ type, uuid, args }]);
    return answer.sync_status[uuid];
  }

  task(id: string): Promise<TaskAnswer> {
    return getTask(this.base, this.token, id, this.signal);
  }

  user(): Promise<SyncAnswer["user"]> {
    return user(this.base, this.token, this.signal);
  }
}
