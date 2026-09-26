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
  type TaskAnswer,
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
 * The account's timezone this run, which a whole-day due date is written
 * in. The sync keeps it in the state, and only the sync writes it there,
 * since it reads every whole-day date anew when the zone it kept moves. A
 * change carried before the first sync, or after the state was lost,
 * asks Todoist for the account alone, once for the run.
 */
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
    })();
    zones.set(context, asked);
  }
  return asked;
}

function linkOf(item: Item): string | undefined {
  const value = item.properties[linkField];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Todoist's refusal of a command naming a task it does not have. */
function isNotFound(answer: CommandError): boolean {
  return answer.error_code === 22 || answer.error_tag === "ITEM_NOT_FOUND";
}

function isCompleted(item: Item): boolean {
  return item.properties["status"] === "completed";
}

/**
 * A command's id from the row as the change showed it and what the
 * command does. The row's moment is in it because a transition moves no
 * version: a restore carried as an edit is a command of its own, not the
 * edit before it sent again. A run replayed after a failure shows the
 * same row, so it sends the same command.
 */
function commandId(item: Item, type: string): string {
  return uuidFor(item.id, String(item.version), item.updated_at, type);
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
  const { env, signal } = context;
  const todoist = new Door(base, env.TODOIST_API_TOKEN, signal);
  const timeZone = await timeZoneFor(context, todoist);
  let taskId = linkOf(item);

  // Archiving keeps a task; Todoist has no state for a task set aside.
  if (kind === "archived") return;

  if (taskId === undefined) {
    // A row Todoist was never told about and that is gone has nothing to
    // carry: adding a task only to delete it would be work for nothing.
    if (kind === "trashed" || kind === "purged") return;
    taskId = await add(item, timeZone, todoist, context);
    if (taskId === undefined) return;
    // The create carried the row as it was; what the row holds now, after
    // a run that failed between the create and the link, is compared
    // against the task like any change, and a completed row closes it.
  }

  if (kind === "trashed" || kind === "purged") {
    // A trash deletes the task: closing a recurring one would move it to
    // its next occurrence and leave it live. The command is named by the
    // row and the task, since a task is deleted once: a purge sends the
    // trash's delete again under the same id, which Todoist answers
    // without acting twice, and a trash and a purge that reach the watch
    // together, as the purge alone, still delete it. A task made again
    // after a restore has an id of its own, and so does its delete.
    const answer = await todoist.one(
      "item_delete",
      uuidFor(item.id, taskId, "item_delete"),
      { id: taskId },
    );
    // A task Todoist no longer has, whether the trash's delete landed
    // before or a person deleted it there, is what the delete asked for.
    if (answer !== "ok" && !isNotFound(answer)) {
      context.log.condition(
        `todoist-refused:${item.id}`,
        `Todoist refused deleting task ${taskId} for row ${item.id}: ${describeError(answer)}`,
      );
    }
    return;
  }

  await sync(item, taskId, timeZone, todoist, context);
}

/**
 * Makes a restored row's task again where Todoist no longer has it: the
 * trash that deleted it was carried, or a person deleted it there and the
 * row, archived for it, was brought back. Answers whether it made one; a
 * task Todoist still has is carried after the read like any change.
 */
export async function remake(
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
  // Abandoned with a condition: the change is done all the same.
  if (made === undefined) return true;
  // Held to the row like any other, so a completed row's task is closed.
  await sync(item, made, timeZone, todoist, context);
  return true;
}

/**
 * The task as Todoist has it first, so only what differs travels and the
 * round after a lost state is a round of reads; then completion, which
 * `item_update` does not carry.
 */
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
    log.condition(
      `todoist-refused:${item.id}`,
      `Todoist refuses access to task ${taskId} for row ${item.id}, so its changes are not carried`,
    );
    return;
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
    if (answer !== "ok") {
      log.condition(
        `todoist-refused:${item.id}`,
        `Todoist refused updating task ${taskId} for row ${item.id}: ${describeError(answer)}`,
      );
      return;
    }
  }
  const completed = isCompleted(item);
  if (completed === (task.checked === true)) return;
  const type = completed ? "item_close" : "item_uncomplete";
  const answer = await todoist.one(type, commandId(item, type), {
    id: taskId,
  });
  if (answer !== "ok") {
    log.condition(
      `todoist-refused:${item.id}`,
      `Todoist refused ${completed ? "closing" : "reopening"} task ${taskId} for row ${item.id}: ${describeError(answer)}`,
    );
  }
}

/**
 * A row Todoist has not been told about becomes a task, and the task's id
 * is written back onto the row. The command's ids come from the row and
 * the task it replaces, if any, so a run replayed after a failure sends
 * Todoist the same create, and a task made again after a restore is a
 * create of its own rather than the first one answered again. Answers the
 * task's id, or nothing where the row was abandoned with a condition.
 */
async function add(
  item: Item,
  timeZone: string,
  todoist: Door,
  context: WatchContext<OutboundEnv>,
  replacing?: string,
): Promise<string | undefined> {
  const { log } = context;
  const again = replacing === undefined ? [] : [replacing];
  const uuid = uuidFor(item.id, "item_add", ...again);
  let tempId = uuidFor(item.id, "temp_id", ...again);
  // A task made again goes back where it was: its project, section and
  // labels, which an edit does not carry, are the row's from Todoist.
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
  if (status !== "ok" && Object.keys(where).length > 0) {
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
  if (status !== "ok") {
    log.condition(
      `todoist-refused:${item.id}`,
      `Todoist refused creating a task for row ${item.id}: ${status === undefined ? "no answer for the command" : describeError(status)}`,
    );
    return undefined;
  }
  const taskId = answer.temp_id_mapping?.[tempId];
  if (taskId === undefined) {
    log.condition(
      `todoist-unmapped:${item.id}`,
      `Todoist took the create for row ${item.id} without naming the task it made; link the row to its task by hand`,
    );
    return undefined;
  }
  try {
    await context.setLink(item, taskId);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    log.condition(`todoist-link-taken:${item.id}`, error.message);
    return undefined;
  }
  return taskId;
}

/** The Todoist doors the carry uses, bound to a token and a signal. */
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

  task(id: string): Promise<TaskAnswer> {
    return getTask(this.base, this.token, id, this.signal);
  }

  user(): Promise<SyncAnswer["user"]> {
    return user(this.base, this.token, this.signal);
  }
}
