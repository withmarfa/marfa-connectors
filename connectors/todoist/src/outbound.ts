import {
  LinkTaken,
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
  user,
  uuidFor,
  type Command,
  type CommandAnswer,
  type CommandError,
  type SyncAnswer,
  type TodoistItem,
} from "./todoist.js";

/** The environment the connector declares, as `main.ts` passes it on. */
export const outboundEnv = {
  TODOIST_API_TOKEN: "secret",
  TODOIST_API_URL: "optional",
} as const satisfies EnvDeclaration;

export type OutboundEnv = typeof outboundEnv;

/** The property that holds the Todoist task a row is. */
export const linkField = "todoist_id";

/** What of a row travels, as `item_add` and `item_update` take it. */
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

/**
 * The arguments that differ from the task as Todoist has it, so only a
 * change travels and a task that already matches gets nothing. Due dates
 * are compared as the instants they name, so a floating time Todoist
 * holds and the fixed one the row would write are one date.
 */
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

/**
 * The account's timezone, which a whole-day due date is written in. The
 * sync keeps it in the state; a row carried before the first sync, or
 * after the state was lost, asks Todoist for the account alone and keeps
 * the answer, so the date is never written in the wrong zone.
 */
async function timeZoneFor(
  context: WatchContext<OutboundEnv>,
  todoist: Door,
): Promise<string> {
  const held = context.state.get("timezone");
  if (typeof held === "string") return held;
  const account = await todoist.user();
  const zone = timezoneOf(account);
  if (zone === undefined) {
    // The conditions the sync raises, under the same keys, so a zone
    // Todoist does not name or this platform does not know is reported
    // once however it was found missing.
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
  }
  context.state.set("timezone", zone);
  return zone;
}

function linkOf(item: Item): string | undefined {
  const value = item.properties[linkField];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isCompleted(item: Item): boolean {
  return item.properties["status"] === "completed";
}

/**
 * Carries one change made in Marfa to Todoist. Resolving means the change
 * landed or was abandoned with a condition naming the row; a throw fails
 * the run and holds the cursor, so the change is offered again.
 */
export async function carry(
  change: Change,
  context: WatchContext<OutboundEnv>,
  base: string,
): Promise<void> {
  const { item, kind } = change;
  const { env, signal, log } = context;
  const todoist = new Door(base, env.TODOIST_API_TOKEN, signal);
  const timeZone = await timeZoneFor(context, todoist);
  const taskId = linkOf(item);

  // Archiving keeps a task; Todoist has no state for a task set aside.
  if (kind === "archived") return;

  if (taskId === undefined) {
    // A row Todoist was never told about and that is gone has nothing to
    // carry: adding a task only to close it would leave one nobody made.
    if (kind === "trashed" || kind === "purged") return;
    await add(item, timeZone, todoist, context);
    return;
  }

  if (kind === "trashed" || kind === "purged") {
    const answer = await todoist.one(
      "item_close",
      uuidFor(item.id, String(item.version), "item_close"),
      { id: taskId },
    );
    if (answer !== "ok") {
      // A task already completed or deleted in Todoist is what the row's
      // trash asked for; the refusal is recorded and the change is done.
      log.condition(
        `todoist-refused:${item.id}`,
        `Todoist refused closing task ${taskId} for row ${item.id}: ${describeError(answer)}`,
      );
    }
    return;
  }

  // Updated or restored: the task as Todoist has it first, so only what
  // differs travels, and the round after a lost state is a round of reads.
  let task = await todoist.task(taskId);
  if (task === undefined) {
    // The door answers only open tasks, so none means completed or gone.
    if (isCompleted(item)) return;
    const answer = await todoist.one(
      "item_uncomplete",
      uuidFor(item.id, String(item.version), "item_uncomplete"),
      { id: taskId },
    );
    if (answer !== "ok") {
      log.condition(
        `todoist-gone:${item.id}`,
        `Todoist no longer has task ${taskId} for row ${item.id}: ${describeError(answer)}`,
      );
      return;
    }
    task = await todoist.task(taskId);
    if (task === undefined) {
      log.condition(
        `todoist-gone:${item.id}`,
        `Todoist no longer has task ${taskId} for row ${item.id}`,
      );
      return;
    }
  }

  const diff = differing(argsOf(item, timeZone), task, timeZone);
  if (Object.keys(diff).length > 0) {
    const answer = await todoist.one(
      "item_update",
      uuidFor(item.id, String(item.version), "item_update"),
      { id: taskId, ...diff },
    );
    if (answer !== "ok") {
      log.condition(
        `todoist-refused:${item.id}`,
        `Todoist refused updating task ${taskId} for row ${item.id}: ${describeError(answer)}`,
      );
      return;
    }
  }
  if (isCompleted(item) && task.checked !== true) {
    const answer = await todoist.one(
      "item_close",
      uuidFor(item.id, String(item.version), "item_close"),
      { id: taskId },
    );
    if (answer !== "ok") {
      log.condition(
        `todoist-refused:${item.id}`,
        `Todoist refused closing task ${taskId} for row ${item.id}: ${describeError(answer)}`,
      );
    }
  }
}

/**
 * A row Todoist has not been told about becomes a task, and the task's id
 * is written back onto the row. The command's ids come from the row alone,
 * so a run replayed after a failure sends Todoist the same create.
 */
async function add(
  item: Item,
  timeZone: string,
  todoist: Door,
  context: WatchContext<OutboundEnv>,
): Promise<void> {
  const { log } = context;
  const uuid = uuidFor(item.id, "item_add");
  const tempId = uuidFor(item.id, "temp_id");
  const answer = await todoist.send([
    {
      type: "item_add",
      uuid,
      temp_id: tempId,
      args: { ...argsOf(item, timeZone) },
    },
  ]);
  const status = answer.sync_status[uuid];
  if (status !== "ok") {
    log.condition(
      `todoist-refused:${item.id}`,
      `Todoist refused creating a task for row ${item.id}: ${status === undefined ? "no answer for the command" : describeError(status)}`,
    );
    return;
  }
  const taskId = answer.temp_id_mapping?.[tempId];
  if (taskId === undefined) {
    log.condition(
      `todoist-unmapped:${item.id}`,
      `Todoist took the create for row ${item.id} without naming the task it made; link the row to its task by hand`,
    );
    return;
  }
  try {
    await context.setLink(item, taskId);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    log.condition(`todoist-link-taken:${item.id}`, error.message);
    return;
  }
  if (isCompleted(item)) {
    const closed = await todoist.one(
      "item_close",
      uuidFor(item.id, String(item.version), "item_close"),
      { id: taskId },
    );
    if (closed !== "ok") {
      log.condition(
        `todoist-refused:${item.id}`,
        `Todoist refused closing the new task ${taskId} for row ${item.id}: ${describeError(closed)}`,
      );
    }
  }
}

/** The two Todoist doors the carry uses, bound to a token and a signal. */
class Door {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
  ) {}

  send(commands: readonly Command[]): Promise<CommandAnswer> {
    return send(this.base, this.token, commands, this.signal);
  }

  /** One command, answered as Todoist did or as a missing answer. */
  async one(
    type: string,
    uuid: string,
    args: Record<string, unknown>,
  ): Promise<"ok" | CommandError> {
    const answer = await this.send([{ type, uuid, args }]);
    return answer.sync_status[uuid] ?? { error: "no answer for the command" };
  }

  task(id: string): Promise<TodoistItem | undefined> {
    return getTask(this.base, this.token, id, this.signal);
  }

  user(): Promise<SyncAnswer["user"]> {
    return user(this.base, this.token, this.signal);
  }
}
