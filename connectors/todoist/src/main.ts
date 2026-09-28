import {
  defineConnector,
  main,
  type TypeDefinition,
} from "@withmarfa/connector";
import { carry, remake, linkField, outboundEnv } from "./outbound.js";
import {
  accountOf,
  defaultBase,
  entryOf,
  taskFields,
  firstSync,
  namedZoneOf,
  sync,
  timezoneOf,
} from "./todoist.js";
import todoistTask from "./todoist.task.json" with { type: "json" };

const connector = defineConnector({
  name: "todoist",
  description:
    "Tasks from a Todoist account, read through the Sync API, and every todoist.task in Marfa carried back to it.",
  source: "todoist",
  // Imported JSON widens every string, so its field types read as `string`
  // here; the check on start holds the file to the server's type.
  type: todoistTask as TypeDefinition,
  fields: taskFields,
  // Only what `item_add` and `item_update` take, and completion, travel.
  readOnly: [
    "completed_at",
    "url",
    "project_id",
    "section_id",
    "parent_id",
    "labels",
    "child_order",
    "comment_count",
  ],
  link: linkField,
  env: outboundEnv,
  async run({ env, signal, state, log, upsert, archive }) {
    const base = env.TODOIST_API_URL ?? defaultBase;
    const held = state.get("sync_token");
    const heldToken = typeof held === "string" ? held : firstSync;
    let answer = await sync(base, env.TODOIST_API_TOKEN, heldToken, signal);
    const knownZone = state.get("timezone");
    const kept = typeof knownZone === "string" ? knownZone : undefined;
    // A timezone that moved, or first became known, reads every floating
    // and whole-day due date anew, and a delta carries only the tasks that
    // changed; so the run asks for them all. A full sync lists only active
    // tasks, so the delta's deletions and completions are kept beside it.
    const newZone = timezoneOf(answer.user);
    if (heldToken !== firstSync && newZone !== undefined && newZone !== kept) {
      const full = await sync(base, env.TODOIST_API_TOKEN, firstSync, signal);
      const byId = new Map(answer.items.map((item) => [item.id, item]));
      for (const item of full.items) byId.set(item.id, item);
      answer = {
        ...full,
        items: [...byId.values()],
        // The delta's token, older than the full sync's: a change that
        // landed between the two requests comes back in the next delta
        // rather than being skipped, and what comes back again is unchanged.
        sync_token: answer.sync_token,
      };
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
    // Keyed by what they say, so a changed one is reported as it changes.
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

    // A deleted task is archived, and a completed one stays active with its
    // status and completion set. A full sync lists only active tasks, so a
    // task it leaves out is left as it is.
    await upsert(
      answer.items
        .filter((item) => item.is_deleted !== true)
        .map((item) => entryOf(account, timeZone, item)),
    );
    // By the link: a row is archived by the task it is, whoever created it.
    await archive(
      answer.items
        .filter((item) => item.is_deleted === true)
        .map((item) => item.id),
    );
    state.set("account", account);
    if (named !== undefined) state.set("timezone", named);
    state.set("sync_token", answer.sync_token);
  },
  onChange(change, context) {
    return carry(change, context, context.env.TODOIST_API_URL ?? defaultBase);
  },
  remake(change, context) {
    return remake(change, context, context.env.TODOIST_API_URL ?? defaultBase);
  },
});

await main(connector);
