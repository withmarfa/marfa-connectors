import {
  defineConnector,
  main,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  accountOf,
  entryOf,
  firstSync,
  namedZoneOf,
  sourceId,
  sync,
  timezoneOf,
} from "./todoist.js";
import todoistTask from "./todoist.task.json" with { type: "json" };

const connector = defineConnector({
  name: "todoist",
  description: "Tasks from a Todoist account, read through the Sync API.",
  source: "todoist",
  // Imported JSON widens every string, so its field types read as `string`
  // here; the check on start holds the file to the server's type.
  type: todoistTask as TypeDefinition,
  env: {
    TODOIST_API_TOKEN: "secret",
    TODOIST_API_URL: "optional",
  },
  async run({ env, signal, state, log, upsert, archive }) {
    const base = env.TODOIST_API_URL ?? "https://api.todoist.com";
    const held = state.get("sync_token");
    const heldToken = typeof held === "string" ? held : firstSync;
    let answer = await sync(base, env.TODOIST_API_TOKEN, heldToken, signal);
    const knownZone = state.get("timezone");
    const kept = typeof knownZone === "string" ? knownZone : undefined;
    // A timezone that moved, or first became known, reads every floating
    // and whole-day due date anew, and a delta carries only the tasks that
    // changed; so the run asks for them all.
    const newZone = timezoneOf(answer.user);
    if (heldToken !== firstSync && newZone !== undefined && newZone !== kept) {
      answer = await sync(base, env.TODOIST_API_TOKEN, firstSync, signal);
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
    if (named === undefined) {
      const unknown = namedZoneOf(answer.user);
      log.condition(
        "timezone",
        unknown === undefined
          ? "Todoist named no timezone for the account, so its due dates are read in UTC"
          : `Todoist named the timezone ${unknown} for the account, which this platform does not know, so its due dates are read in UTC`,
      );
    }
    const timeZone = named ?? "UTC";

    // A deleted task is archived, and a completed one stays active with its
    // status and completion set. A full sync lists only active tasks, so a
    // task it leaves out is left as it is.
    await upsert(
      answer.items
        .filter((item) => item.is_deleted !== true)
        .map((item) => entryOf(account, timeZone, item)),
    );
    await archive(
      answer.items
        .filter((item) => item.is_deleted === true)
        .map((item) => sourceId(account, item.id)),
    );
    state.set("account", account);
    if (named !== undefined) state.set("timezone", named);
    state.set("sync_token", answer.sync_token);
  },
});

await main(connector);
