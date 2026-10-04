import {
  defineConnector,
  main,
  type Entry,
  type Log,
  type TypeDefinition,
} from "@withmarfa/connector";
import { carry, readOnly, remake, outboundEnv } from "./outbound.js";
import { followProjects, knowing, placedIn } from "./projects.js";
import {
  accountOf,
  completed,
  defaultBase,
  entryOf,
  firstSync,
  getTask,
  langOf,
  namedZoneOf,
  projects,
  readShape,
  sourceId,
  sync,
  taskFields,
  timezoneOf,
  Unanswered,
  type TodoistItem,
} from "./todoist.js";
import todoistTask from "./todoist.task.json" with { type: "json" };

const taskType = todoistTask.id;
const source = "todoist";

const connector = defineConnector({
  name: "todoist",
  description:
    "Tasks from a Todoist account, read through the Sync API, and every todoist.task in Marfa carried back to it.",
  source,
  types: [
    {
      // Imported JSON widens every string, so its field types read as
      // `string` here; the check on start holds the file to the server's.
      type: todoistTask as TypeDefinition,
      fields: taskFields,
      readOnly: ["url", "parent_id", "child_order"],
    },
  ],
  env: outboundEnv,
  carries: (env) => (readOnly(env) ? [] : [taskType]),
  async run({
    env,
    signal,
    state,
    log,
    hints,
    upsert,
    archive,
    held,
    written,
  }) {
    const base = env.TODOIST_API_URL ?? defaultBase;
    const keptAccount = state.get("account");
    if (hints !== undefined && typeof keptAccount === "string") {
      // A run for named tasks does not save the sync token: the rest was not
      // read.
      const zone = state.get("timezone");
      const named: TodoistItem[] = [];
      const gone: string[] = [];
      for (const id of hints.get(taskType) ?? []) {
        const task = await getTask(base, env.TODOIST_API_TOKEN, id, signal);
        if (task === "deleted") gone.push(id);
        else if (task === "forbidden" || task === "unknown") {
          unanswered(log, id, task);
        } else named.push(task);
      }
      const placed = placedIn(
        await knowing(named, projectsOf(state.get("projects")), () =>
          projects(base, env.TODOIST_API_TOKEN, signal),
        ),
      );
      const found = named
        .filter(placed)
        .map((task) =>
          entryOf(keptAccount, typeof zone === "string" ? zone : "UTC", task),
        );
      await upsert(taskType, found);
      await archive(taskType, gone);
      return;
    }
    const shape = readShape(written(taskType));
    const saved = state.get("sync_token");
    const heldToken = typeof saved === "string" ? saved : firstSync;
    let answer = await sync(base, env.TODOIST_API_TOKEN, heldToken, signal);
    const knownZone = state.get("timezone");
    const kept = typeof knownZone === "string" ? knownZone : undefined;
    const newZone = timezoneOf(answer.user);
    let fullSync = heldToken === firstSync || answer.full_sync === true;
    // A moved zone reads every whole-day and floating due date differently,
    // and a new shape reads fields a delta would bring only for tasks that
    // change, so the run asks for all tasks. A full sync lists only active
    // tasks, so the delta's deletions and completions are kept beside it.
    if (
      heldToken !== firstSync &&
      ((newZone !== undefined && newZone !== kept) ||
        state.get("read_shape") !== shape)
    ) {
      fullSync = true;
      const full = await sync(base, env.TODOIST_API_TOKEN, firstSync, signal);
      const byId = new Map(answer.items.map((item) => [item.id, item]));
      for (const item of full.items) byId.set(item.id, item);
      answer = {
        ...full,
        items: [...byId.values()],
        // The delta's token, older than the full sync's: a change that
        // landed between the two requests comes back in the next delta
        // rather than being skipped, and what comes back again is unchanged.
        // A completion landing between the two comes back in the next delta.
        sync_token: answer.sync_token,
      };
    }
    // An open task the full sync lists wins over a completion listed for it:
    // the sync token predates the list.
    if (fullSync) {
      const done = await completed(
        base,
        env.TODOIST_API_TOKEN,
        new Date(),
        signal,
      );
      if (done === "forbidden") {
        completedForbidden(log);
      } else {
        const byId = new Map(done.map((item) => [item.id, item]));
        for (const item of answer.items) byId.set(item.id, item);
        answer = { ...answer, items: [...byId.values()] };
      }
    }
    const known = state.get("account");
    const account =
      accountOf(answer.user) ?? (typeof known === "string" ? known : undefined);
    if (account === undefined) {
      throw new Error(
        "Todoist named no account for the token, so no task can be keyed to one",
      );
    }
    const named = timezoneOf(answer.user) ?? kept;
    const timeZone = named ?? "UTC";
    const unknown = namedZoneOf(answer.user);
    if (unknown !== undefined && timezoneOf(answer.user) === undefined) {
      log.condition(
        `timezone-unknown:${unknown}`,
        `Todoist named the timezone ${unknown} for the account, which this platform does not know, so its due dates are read in ${timeZone}`,
      );
    } else if (named === undefined) {
      log.condition(
        "timezone-none",
        "Todoist named no timezone for the account, so its due dates are read in UTC",
      );
    }

    const view = await followProjects(
      answer,
      fullSync,
      projectsOf(state.get("projects")),
      () => projects(base, env.TODOIST_API_TOKEN, signal),
      log,
    );
    // A delta sends again the open tasks of a project brought back, but not
    // its completed ones.
    if (view.back.length > 0) {
      const byId = new Map(answer.items.map((item) => [item.id, item]));
      for (const id of view.back) {
        const done = await completed(
          base,
          env.TODOIST_API_TOKEN,
          new Date(),
          signal,
          id,
        );
        if (done === "forbidden") completedForbidden(log);
        else
          for (const item of done)
            if (!byId.has(item.id)) byId.set(item.id, item);
      }
      answer = { ...answer, items: [...byId.values()] };
    }
    const placed = placedIn(view.inUse);
    const upserting = answer.items.filter(
      (item) => item.is_deleted !== true && placed(item),
    );
    await upsert(
      taskType,
      upserting.map((item) => entryOf(account, timeZone, item)),
    );
    await archive(
      taskType,
      answer.items
        .filter((item) => item.is_deleted === true)
        .map((item) => item.id),
    );
    state.set("account", account);
    if (named !== undefined) state.set("timezone", named);
    // The user comes with a delta only when it changed.
    if (answer.user !== undefined) state.set("lang", langOf(answer.user));
    // A run a change started, with the state lost, archives only what it was
    // handed: the next scheduled run syncs in full again.
    if (hints !== undefined) return;
    const inUseNow = view.inUse;
    if (inUseNow !== undefined && (view.gone.size > 0 || view.firstList)) {
      const upserted = new Set(upserting.map((item) => item.id));
      await archive(
        taskType,
        (await held(taskType)).flatMap((row) => {
          const id = row.properties["todoist_id"];
          const project = row.properties["project_id"];
          if (
            typeof id !== "string" ||
            typeof project !== "string" ||
            upserted.has(id) ||
            (row.source === source && row.source_id !== sourceId(account, id))
          ) {
            return [];
          }
          return (
            view.firstList ? !inUseNow.has(project) : view.gone.has(project)
          )
            ? [id]
            : [];
        }),
      );
    }
    // A full sync leaves out a task deleted since the last token, and the
    // completed tasks only reach back twelve weeks: an open row it left out
    // is asked about by id, a share each run.
    // A task Todoist does not answer is asked about again each run, first,
    // and named until it answers or its row is no longer open.
    const listed = new Set(answer.items.map((item) => item.id));
    const keptUnasked = idsOf(state.get("unasked"));
    const keptUnanswered = unansweredOf(state.get("unanswered"));
    const open =
      fullSync || keptUnasked.length > 0 || keptUnanswered.length > 0
        ? new Set(
            (await held(taskType)).flatMap((row) => {
              const id = row.properties["todoist_id"];
              const project = row.properties["project_id"];
              // A row whose project is gone is not asked about: Todoist
              // answers a task of a deleted project as one it never had, and
              // the project already says why the row is left as it is.
              return typeof id !== "string" ||
                row.properties["status"] === "completed" ||
                (row.source === source &&
                  row.source_id !== sourceId(account, id)) ||
                (typeof project === "string" &&
                  inUseNow !== undefined &&
                  !inUseNow.has(project))
                ? []
                : [id];
            }),
          )
        : new Set<string>();
    const asking = (id: string): boolean => open.has(id) && !listed.has(id);
    const waiting = keptUnanswered.filter(({ id }) => asking(id));
    const unasked = (fullSync ? [...open] : keptUnasked).filter(
      (id) => asking(id) && !waiting.some((one) => one.id === id),
    );
    const asked = await askAbout([...waiting.map(({ id }) => id), ...unasked], {
      base,
      token: env.TODOIST_API_TOKEN,
      account,
      timeZone,
      signal,
      log,
      placed,
      upsert,
      archive,
    });
    const notAsked = new Set(asked.rest);
    const stillWaiting = [
      ...waiting.filter(({ id }) => notAsked.has(id)),
      ...asked.unanswered,
    ];
    for (const { id, answer: said } of stillWaiting) {
      unanswered(log, id, said);
    }
    const stillUnasked = unasked.filter((id) => notAsked.has(id));
    const overflow =
      Math.max(0, stillUnasked.length - heldAtMost) +
      Math.max(0, stillWaiting.length - heldAtMost);
    if (overflow > 0) {
      log.condition(
        "unasked-overflow",
        `${String(overflow)} rows the full sync left out are not held to ask about, and wait for the next full sync`,
      );
    }
    state.set(
      "unasked",
      stillUnasked.length > 0 ? stillUnasked.slice(0, heldAtMost) : undefined,
    );
    state.set(
      "unanswered",
      stillWaiting.length > 0 ? stillWaiting.slice(0, heldAtMost) : undefined,
    );
    if (view.inUse !== undefined) state.set("projects", [...view.inUse]);
    state.set("sync_token", answer.sync_token);
    state.set("read_shape", shape);
  },
  onChange(change, context) {
    return carry(change, context, context.env.TODOIST_API_URL ?? defaultBase);
  },
  remake(change, context) {
    return remake(change, context, context.env.TODOIST_API_URL ?? defaultBase);
  },
});

function completedForbidden(log: Log): void {
  log.condition(
    "completed-forbidden",
    "Todoist refused to list the account's completed tasks, so a task completed while the connector was not following is read as open until Todoist next sends it",
  );
}

function projectsOf(value: unknown): Set<string> | undefined {
  return Array.isArray(value) ? new Set(idsOf(value)) : undefined;
}

function unanswered(
  log: Log,
  id: string,
  answer: "forbidden" | "unknown",
): void {
  log.condition(
    `task-unanswered:${id}`,
    answer === "forbidden"
      ? `Todoist refuses the token access to task ${id}, so its row is left as it is`
      : `Todoist does not answer task ${id} for this token, so its row is left as it is`,
  );
}

/** Well inside Todoist's 1000 requests in 15 minutes. */
const asksPerRun = 200;
const writtenEvery = 50;
/** Well inside what the instance keeps as a connector's state. */
const heldAtMost = 2000;

interface Unheard {
  id: string;
  answer: "forbidden" | "unknown";
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

function unansweredOf(value: unknown): Unheard[] {
  return Array.isArray(value)
    ? value.filter(
        (one): one is Unheard =>
          typeof one === "object" &&
          one !== null &&
          typeof (one as Unheard).id === "string" &&
          ((one as Unheard).answer === "forbidden" ||
            (one as Unheard).answer === "unknown"),
      )
    : [];
}

/** The ids not asked about, and those Todoist did not answer. */
async function askAbout(
  ids: readonly string[],
  context: {
    base: string;
    token: string;
    account: string;
    timeZone: string;
    signal: AbortSignal;
    log: Log;
    placed: (item: TodoistItem) => boolean;
    upsert: (type: string, entries: readonly Entry[]) => Promise<void>;
    archive: (type: string, keys: readonly string[]) => Promise<void>;
  },
): Promise<{ rest: string[]; unanswered: Unheard[] }> {
  const { log } = context;
  const unknown: Unheard[] = [];
  const found: Entry[] = [];
  const gone: string[] = [];
  const write = async (): Promise<void> => {
    await context.upsert(taskType, found.splice(0));
    await context.archive(taskType, gone.splice(0));
  };
  let at = 0;
  try {
    for (; at < Math.min(ids.length, asksPerRun); at += 1) {
      const id = ids[at] ?? "";
      const task = await getTask(
        context.base,
        context.token,
        id,
        context.signal,
      );
      if (task === "deleted") gone.push(id);
      else if (task === "forbidden" || task === "unknown") {
        unknown.push({ id, answer: task });
      } else if (context.placed(task)) {
        found.push(entryOf(context.account, context.timeZone, task));
      }
      if (found.length + gone.length >= writtenEvery) await write();
    }
  } catch (error) {
    if (!(error instanceof Unanswered)) throw error;
    log.condition(
      "unasked",
      `${String(ids.length - at)} rows the full sync left out wait to be asked about: ${error.message}`,
    );
  }
  await write();
  return { rest: ids.slice(at), unanswered: unknown };
}

await main(connector);
