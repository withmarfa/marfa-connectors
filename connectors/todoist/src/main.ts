import {
  defineConnector,
  main,
  type Entry,
  type Log,
  type TypeDefinition,
} from "@withmarfa/connector";
import { carry, readOnly, remake, outboundEnv } from "./outbound.js";
import {
  accountOf,
  completed,
  defaultBase,
  entryOf,
  firstSync,
  getTask,
  namedZoneOf,
  sourceId,
  sync,
  taskFields,
  timezoneOf,
  Unanswered,
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
      readOnly: [
        "url",
        "project_id",
        "section_id",
        "parent_id",
        "labels",
        "child_order",
      ],
    },
  ],
  env: outboundEnv,
  carries: (env) => (readOnly(env) ? [] : [taskType]),
  async run({ env, signal, state, log, hints, upsert, archive, held }) {
    const base = env.TODOIST_API_URL ?? defaultBase;
    const keptAccount = state.get("account");
    if (hints !== undefined && typeof keptAccount === "string") {
      // A run for named tasks does not save the sync token: the rest was not
      // read.
      const zone = state.get("timezone");
      const found: Entry[] = [];
      const gone: string[] = [];
      for (const id of hints.get(taskType) ?? []) {
        const task = await getTask(base, env.TODOIST_API_TOKEN, id, signal);
        if (task === "deleted") gone.push(id);
        else if (task === "forbidden" || task === "unknown") {
          unanswered(log, id, task);
        } else {
          found.push(
            entryOf(keptAccount, typeof zone === "string" ? zone : "UTC", task),
          );
        }
      }
      await upsert(taskType, found);
      await archive(taskType, gone);
      return;
    }
    const saved = state.get("sync_token");
    const heldToken = typeof saved === "string" ? saved : firstSync;
    let answer = await sync(base, env.TODOIST_API_TOKEN, heldToken, signal);
    const knownZone = state.get("timezone");
    const kept = typeof knownZone === "string" ? knownZone : undefined;
    const newZone = timezoneOf(answer.user);
    let fullSync = heldToken === firstSync || answer.full_sync === true;
    // A moved zone reads every whole-day and floating due date differently, so
    // the run asks for all tasks. A full sync lists only active tasks, so the
    // delta's deletions and completions are kept beside it.
    if (heldToken !== firstSync && newZone !== undefined && newZone !== kept) {
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
        log.condition(
          "completed-forbidden",
          "Todoist refused to list the account's completed tasks, so a task completed while the connector was not following is read as open until Todoist next sends it",
        );
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

    await upsert(
      taskType,
      answer.items
        .filter((item) => item.is_deleted !== true)
        .map((item) => entryOf(account, timeZone, item)),
    );
    await archive(
      taskType,
      answer.items
        .filter((item) => item.is_deleted === true)
        .map((item) => item.id),
    );
    state.set("account", account);
    if (named !== undefined) state.set("timezone", named);
    // A run a change started, with the state lost, archives only what it was
    // handed: the next scheduled run syncs in full again.
    if (hints !== undefined) return;
    // A full sync leaves out a task deleted since the last token, and the
    // completed tasks only reach back twelve weeks: an open row it left out
    // is asked about by id, a share each run.
    const listed = new Set(answer.items.map((item) => item.id));
    const left = state.get("unasked");
    const unasked = fullSync
      ? (await held(taskType)).flatMap((row) => {
          const id = row.properties["todoist_id"];
          return typeof id !== "string" ||
            listed.has(id) ||
            row.properties["status"] === "completed" ||
            (row.source === source && row.source_id !== sourceId(account, id))
            ? []
            : [id];
        })
      : (Array.isArray(left) ? left : []).filter(
          (id): id is string => typeof id === "string" && !listed.has(id),
        );
    const rest = await askAbout(unasked, {
      base,
      token: env.TODOIST_API_TOKEN,
      account,
      timeZone,
      signal,
      log,
      upsert,
      archive,
    });
    state.set("unasked", rest.length > 0 ? rest : undefined);
    state.set("sync_token", answer.sync_token);
  },
  onChange(change, context) {
    return carry(change, context, context.env.TODOIST_API_URL ?? defaultBase);
  },
  remake(change, context) {
    return remake(change, context, context.env.TODOIST_API_URL ?? defaultBase);
  },
});

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

/** Answers the ids not asked about, for the next run. */
async function askAbout(
  ids: readonly string[],
  context: {
    base: string;
    token: string;
    account: string;
    timeZone: string;
    signal: AbortSignal;
    log: Log;
    upsert: (type: string, entries: readonly Entry[]) => Promise<void>;
    archive: (type: string, keys: readonly string[]) => Promise<void>;
  },
): Promise<string[]> {
  const { log } = context;
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
        unanswered(log, id, task);
      } else found.push(entryOf(context.account, context.timeZone, task));
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
  return ids.slice(at);
}

await main(connector);
