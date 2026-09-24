import {
  defineConnector,
  main,
  type TypeDefinition,
} from "@withmarfa/connector";
import { accountOf, entryOf, firstSync, sourceId, sync } from "./todoist.js";
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
  async run({ env, signal, state, upsert, archive }) {
    const held = state.get("sync_token");
    const answer = await sync(
      env.TODOIST_API_URL ?? "https://api.todoist.com",
      env.TODOIST_API_TOKEN,
      typeof held === "string" ? held : firstSync,
      signal,
    );
    const known = state.get("account");
    const account =
      accountOf(answer.user) ?? (typeof known === "string" ? known : undefined);
    if (account === undefined) {
      throw new Error(
        "Todoist named no account for the token, so no task can be keyed to one",
      );
    }

    // A deleted task is archived, and a completed one stays active with
    // `completed` set. A full sync lists only active tasks, so a task it
    // leaves out is left as it is.
    await upsert(
      answer.items
        .filter((item) => item.is_deleted !== true)
        .map((item) => entryOf(account, item)),
    );
    await archive(
      answer.items
        .filter((item) => item.is_deleted === true)
        .map((item) => sourceId(account, item.id)),
    );
    state.set("account", account);
    state.set("sync_token", answer.sync_token);
  },
});

await main(connector);
