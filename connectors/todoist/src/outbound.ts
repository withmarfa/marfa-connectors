import {
  Declined,
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
  getProject,
  getTask,
  langOf,
  isGone,
  namedZoneOf,
  priorityFor,
  recurrenceOf,
  send,
  timezoneOf,
  Unanswered,
  user,
  uuidFor,
  floatingTime,
  type Command,
  type CommandAnswer,
  type CommandError,
  type ProjectAnswer,
  type SyncAnswer,
  type TaskAnswer,
  type TodoistItem,
} from "./todoist.js";
import todoistTask from "./todoist.task.json" with { type: "json" };

export const outboundEnv = {
  TODOIST_API_TOKEN: "secret",
  TODOIST_API_URL: "optional",
  TODOIST_READ_ONLY: "optional",
} as const satisfies EnvDeclaration;

export type OutboundEnv = typeof outboundEnv;

export function readOnly(env: {
  TODOIST_READ_ONLY?: string | undefined;
}): boolean {
  return env.TODOIST_READ_ONLY === "true";
}

export const linkField = todoistTask.link_field;

export interface TaskArgs {
  content: string;
  description: string;
  priority: number;
  due: Due | null;
  // Absent where the row holds none, which `differing` reads as no labels.
  labels?: string[];
  // Absent where the row holds none; null in a diff where the row ended it.
  // Todoist takes it as the due's text, never as a field of its own.
  recurrence?: string | null;
}

interface Due {
  date: string;
  string?: string;
  lang?: string;
  timezone?: string;
}

/** A due as sent: a recurrence sent alone is dated by Todoist. */
type SentDue = Omit<Due, "date"> & { date?: string };

export function argsOf(item: Item, timeZone: string): TaskArgs {
  const p = item.properties;
  return {
    content: typeof p["title"] === "string" ? p["title"] : "",
    // An empty description clears Todoist's, as an absent one on the row
    // is a description the row does not have.
    description: typeof p["description"] === "string" ? p["description"] : "",
    priority: priorityFor(p["priority"]),
    due: dueFor(p["due_at"], p["precision"], timeZone),
    ...(Array.isArray(p["labels"]) && {
      labels: p["labels"].filter(
        (label): label is string => typeof label === "string",
      ),
    }),
    ...(typeof p["recurrence"] === "string" &&
      p["recurrence"] !== "" && { recurrence: p["recurrence"] }),
  };
}

// Fields sent only when the row changed them, by their name in `TaskArgs` and
// their property on the row. Todoist can change these between a read and a
// write, so a row that did not change one never sends it, and the task keeps
// what Todoist holds.
const whenChanged = {
  labels: "labels",
  recurrence: "recurrence",
} as const satisfies Partial<Record<keyof TaskArgs, string>>;

export function onlyChanged(
  diff: Partial<TaskArgs>,
  changed: ReadonlySet<string>,
): Partial<TaskArgs> {
  const out = { ...diff };
  for (const [arg, field] of Object.entries(whenChanged)) {
    if (!changed.has(field)) Reflect.deleteProperty(out, arg);
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const held = new Set(b);
  return new Set(a).size === held.size && a.every((item) => held.has(item));
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
  const labels = wanted.labels ?? [];
  if (!sameSet(labels, task.labels ?? [])) out.labels = labels;
  if (wanted.recurrence !== recurrenceOf(task.due)) {
    out.recurrence = wanted.recurrence ?? null;
  }
  return out;
}

// A date Todoist holds, as `dueFor` words one: Todoist answers a time with
// fractions of a second, which a date sent never carries.
function heldDue(due: TodoistItem["due"]): Due | null {
  if (typeof due?.date !== "string") return null;
  return {
    date: due.date.replace(/\.\d+(?=Z?$)/, ""),
    ...(typeof due.timezone === "string" && { timezone: due.timezone }),
  };
}

// Todoist reads a recurrence's text on the date sent with it as its next
// occurrence, and a date alone as a task due once (seen live in October
// 2026), so an ended recurrence leaves the task due once on its date.
function recurring(
  due: SentDue | null,
  recurrence: string | null,
  lang: string | undefined,
): SentDue | null | undefined {
  const when: SentDue = {
    ...(due?.date !== undefined && { date: due.date }),
    ...(due?.timezone !== undefined && { timezone: due.timezone }),
  };
  if (recurrence === null) return due === null ? undefined : when;
  return {
    string: recurrence,
    ...(lang !== undefined && { lang }),
    ...when,
  };
}

// What `item_add` and `item_update` take: the recurrence goes as the due's
// text.
function sendable(
  { recurrence, ...args }: Partial<TaskArgs>,
  lang: string | undefined,
  held: Due | null,
): Omit<Partial<TaskArgs>, "due" | "recurrence"> & { due?: SentDue | null } {
  if (recurrence === undefined) return args;
  const due = recurring(
    args.due === undefined ? held : args.due,
    recurrence,
    lang,
  );
  return { ...args, ...(due !== undefined && { due }) };
}

export type Move = { section_id: string } | { project_id: string };

function placeOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// The one place `item_move` takes: the section when the row changed it and
// names one, whose project the task takes; else a project, whose root the
// task goes to, from a changed project or from a cleared section in the
// project the task is in. A project the row does not change is the task's
// own, so a stale one on the row never moves it back.
export function destination(
  item: Item,
  task: TodoistItem,
  changed: ReadonlySet<string>,
): Move | undefined {
  const section = placeOf(item.properties["section_id"]);
  const project = placeOf(item.properties["project_id"]);
  const sectionChanged = changed.has("section_id");
  const projectChanged = changed.has("project_id");
  if (sectionChanged && section !== undefined) {
    return section === task.section_id ? undefined : { section_id: section };
  }
  if (!sectionChanged && !projectChanged) return undefined;
  const root =
    projectChanged && project !== undefined ? project : task.project_id;
  if (root === undefined || root === null) return undefined;
  const inSection = sectionChanged && task.section_id != null;
  return root === task.project_id && !inSection
    ? undefined
    : { project_id: root };
}

const zones = new WeakMap<object, Promise<string>>();
const users = new WeakMap<object, Promise<SyncAnswer["user"]>>();

function userFor(
  context: WatchContext<OutboundEnv>,
  todoist: Door,
): Promise<SyncAnswer["user"]> {
  let asked = users.get(context);
  if (asked === undefined) {
    asked = todoist.user();
    users.set(context, asked);
  }
  return asked;
}

/** Asked only for a recurrence the row sets, from the sync where it can be. */
type Lang = () => Promise<string | undefined>;

function langFor(context: WatchContext<OutboundEnv>, todoist: Door): Lang {
  return async () => {
    const held = context.state.get("lang");
    if (typeof held === "string") return held;
    return langOf(await userFor(context, todoist));
  };
}

function timeZoneFor(
  context: WatchContext<OutboundEnv>,
  todoist: Door,
): Promise<string> {
  const held = context.state.get("timezone");
  if (typeof held === "string") return Promise.resolve(held);
  let asked = zones.get(context);
  if (asked === undefined) {
    asked = (async (): Promise<string> => {
      const account = await userFor(context, todoist);
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

function isProjectGone(answer: CommandError | undefined): boolean {
  return answer?.error_code === 21 || answer?.error_tag === "PROJECT_NOT_FOUND";
}

function isSectionGone(answer: CommandError | undefined): boolean {
  return answer?.error_code === 58 || answer?.error_tag === "SECTION_NOT_FOUND";
}

function isProjectArchived(answer: CommandError | undefined): boolean {
  return answer?.error_code === 588 || answer?.error_tag === "PROJECT_ARCHIVED";
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

function notMoved(
  answer: CommandError | undefined,
  taskId: string,
  move: Move,
): Error {
  const [gone, place] =
    "section_id" in move
      ? [isSectionGone(answer), `section ${move.section_id}`]
      : [isProjectGone(answer), `project ${move.project_id}`];
  return gone
    ? new Refused(`Todoist has no ${place} to move task ${taskId} into`)
    : notTaken(answer, `moving task ${taskId}`);
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
  const lang = langFor(context, todoist);
  let taskId = linkOf(item);

  if (kind === "archived" && change.changed.size === 0) return;

  // A task has its labels, project, section and recurrence from its create,
  // or the Inbox where its project was gone, which a move would undo. That
  // holds for one made in this run and for one a run made, linked and then
  // failed to finish, whose row has none of its fields agreed.
  let changed = change.changed;
  let made = change.made !== undefined;
  if (taskId === undefined) {
    if (kind === "trashed" || kind === "purged") return;
    taskId = await add(item, timeZone, lang, todoist, context, change.refused);
    made = true;
  }
  if (made) changed = new Set();

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

  const task = await held(taskId, kind, todoist);
  if (task === undefined) return;
  await sync(item, kind, changed, taskId, task, timeZone, lang, todoist);
  await readBack(
    item,
    made ? undefined : changed,
    taskId,
    task.due,
    timeZone,
    todoist,
  );
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
  const found = await todoist.task(taskId);
  if (found === "forbidden" || found === "unknown") {
    // Todoist answers a task of a deleted project as one it never had.
    if (found === "unknown") {
      await declineShelved(
        item.properties["project_id"],
        taskId,
        todoist,
        context,
        change,
      );
    }
    throw new Refused(unreached(taskId, found));
  }
  if (found !== "deleted") {
    await declineShelved(found.project_id, taskId, todoist, context, change);
    return false;
  }
  const timeZone = await timeZoneFor(context, todoist);
  const lang = langFor(context, todoist);
  const made = await add(
    item,
    timeZone,
    lang,
    todoist,
    context,
    change.refused,
    taskId,
  );
  const task = await held(made, change.kind, todoist);
  if (task === undefined) return true;
  await sync(item, change.kind, new Set(), made, task, timeZone, lang, todoist);
  await readBack(item, undefined, made, task.due, timeZone, todoist);
  return true;
}

// The run archives the rows of a project once, when it goes, so a row
// restored in Marfa stays restored, with its reason named. A restore that
// came with an edit is refused rather than declined, since a decline puts
// the edit back, and Todoist takes the edit of a task in an archived project.
async function declineShelved(
  projectId: unknown,
  taskId: string,
  todoist: Door,
  context: WatchContext<OutboundEnv>,
  change: Change,
): Promise<void> {
  if (typeof projectId !== "string") return;
  const inUse = context.state.get("projects");
  if (Array.isArray(inUse) && inUse.includes(projectId)) return;
  const project = await todoist.project(projectId);
  if (project === "unknown") {
    throw shelved(
      change,
      `Todoist no longer has project ${projectId}, deleted or left by the account, so task ${taskId} cannot be brought back`,
    );
  }
  if (project === "forbidden" || !isGone(project)) return;
  throw shelved(
    change,
    `Todoist's project ${project.name ?? projectId} is archived, so task ${taskId} stays there; unarchive the project in Todoist to bring back its tasks`,
  );
}

function shelved(change: Change, message: string): Error {
  return change.changed.size === 0
    ? new Declined(message)
    : new Refused(message);
}

// The project's name where Todoist still answers for it, else its id.
async function archivedProject(
  projectId: string,
  todoist: Door,
  signal: AbortSignal,
): Promise<Refused> {
  let name = projectId;
  try {
    const project = await todoist.project(projectId);
    if (typeof project === "object" && project.name !== undefined) {
      name = project.name;
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return new Refused(
    `Todoist's project ${name} is archived, so a task cannot be created in it; unarchive the project in Todoist, or move the row to another project`,
  );
}

async function held(
  taskId: string,
  kind: Change["kind"],
  todoist: Door,
): Promise<TodoistItem | undefined> {
  const task = await todoist.task(taskId);
  if (task === "forbidden" || task === "unknown") {
    throw new Refused(unreached(taskId, task));
  }
  if (task === "deleted") {
    // An archive owes a deleted task nothing; the sync that brings the
    // deletion archives the row of any other change.
    if (kind === "archived") return undefined;
    throw new Refused(`Todoist deleted task ${taskId}`);
  }
  return task;
}

async function sync(
  item: Item,
  kind: Change["kind"],
  changed: ReadonlySet<string>,
  taskId: string,
  task: TodoistItem,
  timeZone: string,
  lang: Lang,
  todoist: Door,
): Promise<void> {
  const wanted = argsOf(item, timeZone);
  const changes = onlyChanged(differing(wanted, task, timeZone), changed);
  if (changes.due !== undefined && changes.due !== null) {
    changes.due = moved(changes.due.date, task.due, timeZone);
  }
  // A recurring task always has a date: a row made holding a recurrence and
  // no date takes the one Todoist gives it, and one whose date alone a person
  // cleared is put back. With other edits, those are carried and the date
  // comes back with the next read.
  if (changes.due === null && wanted.recurrence !== undefined) {
    if (changed.has("due_at") && Object.keys(changes).length === 1) {
      throw new Declined(
        `A repeating task needs a date, so clearing the date of ${item.id} is not sent; clear its recurrence first`,
      );
    }
    delete changes.due;
  }
  const diff = sendable(
    changes,
    typeof changes.recurrence === "string" ? await lang() : undefined,
    heldDue(task.due),
  );
  if (Object.keys(diff).length > 0) {
    const answer = await todoist.one(
      "item_update",
      commandId(item, "item_update"),
      { id: taskId, ...diff },
    );
    if (answer !== "ok") throw notTaken(answer, `updating task ${taskId}`);
  }
  // The close or reopen goes first, so a move Todoist refuses never holds
  // the completion back.
  const completed = isCompleted(item);
  if (completed !== (task.checked === true)) {
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
  const move = destination(item, task, changed);
  if (move === undefined) return;
  const answer = await todoist.one("item_move", commandId(item, "item_move"), {
    id: taskId,
    ...move,
  });
  if (answer === "ok") return;
  throw notMoved(answer, taskId, move);
}

// Todoist keeps text it cannot read as a recurrence, sent with a date, as a
// task due once rather than refusing it (seen live in October 2026), so a
// task made with the row's recurrence, or sent one the row changed, is read
// back once the other fields have landed. A task that repeated before is
// given its recurrence again, on the date it holds now.
async function readBack(
  item: Item,
  changed: ReadonlySet<string> | undefined,
  taskId: string,
  before: TodoistItem["due"],
  timeZone: string,
  todoist: Door,
): Promise<void> {
  const recurrence = argsOf(item, timeZone).recurrence;
  if (typeof recurrence !== "string") return;
  if (changed !== undefined && !changed.has("recurrence")) return;
  const task = await todoist.task(taskId);
  if (typeof task !== "object" || task.due?.is_recurring === true) return;
  const kept = recurrenceOf(before);
  if (kept === undefined) {
    throw new Refused(
      `Todoist could not read the recurrence "${recurrence}", so task ${taskId} is due once`,
    );
  }
  const answer = await todoist.one(
    "item_update",
    commandId(item, "item_update:recurrence"),
    {
      id: taskId,
      due: recurring(
        heldDue(task.due),
        kept,
        typeof before?.lang === "string" ? before.lang : undefined,
      ),
    },
  );
  if (answer !== "ok") {
    throw notTaken(answer, `putting back the recurrence of task ${taskId}`);
  }
  throw new Refused(
    `Todoist could not read the recurrence "${recurrence}", so task ${taskId} keeps repeating "${kept}"`,
  );
}

function unreached(taskId: string, answer: "forbidden" | "unknown"): string {
  return answer === "forbidden"
    ? `Todoist refuses access to task ${taskId}`
    : `Todoist does not answer task ${taskId} for this token`;
}

// Todoist keeps the date sent, but a date alone ends a recurrence and moves
// a time to the account's zone (seen live in October 2026): the recurrence
// goes with it, and the time stays fixed in the task's zone or floating. A
// floating time the clocks show twice is fixed in the account's zone instead.
function moved(date: string, have: TodoistItem["due"], timeZone: string): Due {
  const timed = date.includes("T");
  const held = typeof have?.timezone === "string" ? have.timezone : undefined;
  const floating =
    timed && held === undefined && /T[^Z]*$/.test(have?.date ?? "")
      ? floatingTime(date, timeZone)
      : undefined;
  const zone =
    held ??
    (timed && floating === undefined && /T[^Z]*$/.test(have?.date ?? "")
      ? timeZone
      : undefined);
  return {
    ...(have?.is_recurring === true &&
      typeof have.string === "string" && {
        string: have.string,
        ...(typeof have.lang === "string" && { lang: have.lang }),
      }),
    date: floating ?? date,
    ...(timed && zone !== undefined && { timezone: zone }),
  };
}

async function add(
  item: Item,
  timeZone: string,
  lang: Lang,
  todoist: Door,
  context: WatchContext<OutboundEnv>,
  refused: string | undefined,
  replacing?: string,
): Promise<string> {
  // `again` makes a restore a new create, not the first create's answer
  // again, and a create after a refused one a new command, since the refused
  // one made nothing.
  const again = [
    ...(replacing === undefined ? [] : [replacing]),
    ...(refused === undefined ? [] : [refused]),
  ];
  const uuid = uuidFor(item.id, "item_add", ...again);
  let tempId = uuidFor(item.id, "temp_id", ...again);
  const p = item.properties;
  const wanted = argsOf(item, timeZone);
  const args = sendable(
    wanted,
    wanted.recurrence === undefined ? undefined : await lang(),
    null,
  );
  const where = {
    ...(typeof p["project_id"] === "string" && {
      project_id: p["project_id"],
    }),
    ...(typeof p["section_id"] === "string" && {
      section_id: p["section_id"],
    }),
  };
  let answer = await todoist.send([
    {
      type: "item_add",
      uuid,
      temp_id: tempId,
      args: { ...args, ...where },
    },
  ]);
  let status = answer.sync_status[uuid];
  if (status !== "ok" && isProjectGone(status)) {
    // Made in the Inbox rather than not at all, under ids of its own, apart
    // from the refused command's. Todoist makes a task whose section is gone
    // at its project's root, so only a project gone is refused.
    const inboxUuid = uuidFor(item.id, "item_add", ...again, "inbox");
    const inboxTemp = uuidFor(item.id, "temp_id", ...again, "inbox");
    answer = await todoist.send([
      {
        type: "item_add",
        uuid: inboxUuid,
        temp_id: inboxTemp,
        args,
      },
    ]);
    status = answer.sync_status[inboxUuid];
    tempId = inboxTemp;
  }
  if (status !== "ok") {
    if (isProjectArchived(status) && where.project_id !== undefined) {
      throw await archivedProject(where.project_id, todoist, context.signal);
    }
    throw notTaken(status, "creating a task");
  }
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

  project(id: string): Promise<ProjectAnswer> {
    return getProject(this.base, this.token, id, this.signal);
  }

  user(): Promise<SyncAnswer["user"]> {
    return user(this.base, this.token, this.signal);
  }
}
