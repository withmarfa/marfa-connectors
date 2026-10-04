import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  create,
  derivedFrom,
  edit,
  fieldsOf,
  registeredAsKindOf,
  typeHeld,
  item,
  keyBody,
  lastRun,
  mintWithTheReadmeKeyFlags,
  moved,
  promoteAndFind,
  purge,
  registration,
  restore,
  rowsOf,
  trash,
  type Item,
} from "./connector.js";
import { TodoistStub } from "./todoist-stub.js";

async function asTask(
  marfa: MarfaClient,
  row: Item,
): Promise<Record<string, unknown>> {
  const { fields } = await fieldsOf(marfa, "core.task");
  return Object.fromEntries(
    fields
      .filter((field) => field in row.properties)
      .map((field) => [field, row.properties[field]]),
  );
}

export async function proveTodoist(
  marfa: MarfaClient,
  url: string,
  operator: MarfaClient,
): Promise<void> {
  const todoist = await new TodoistStub("todoist-proof-token").start();
  const account = todoist.account;
  try {
    const key = await mintWithTheReadmeKeyFlags(marfa, {
      label: "todoist",
      source: "todoist",
      typePermission: "todoist.task",
    });
    const runner = new ConnectorUnderProof("todoist", url, key.key, {
      TODOIST_API_TOKEN: "todoist-proof-token",
      TODOIST_API_URL: todoist.url,
    });
    const runOnce = async (): Promise<void> => {
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
    };
    const rows = (): Promise<Map<string, Item>> =>
      rowsOf(marfa, "todoist.task", "todoist");
    const row = async (id: string): Promise<Item> => {
      const found = (await rows()).get(`${account}:${id}`);
      if (found === undefined) throw new Error(`no row for task ${id}`);
      return found;
    };
    const summary = async (): Promise<string> =>
      String((await lastRun(operator, key.id)).summary);

    const a = todoist.task("a", {
      content: "Buy milk",
      priority: 4,
      due: { date: "2026-09-30", is_recurring: false },
      section_id: "s1",
      labels: ["Food", "Errands"],
      child_order: 2,
    });
    const b = todoist.task("b", {
      content: "Write the note",
      description: "With the details",
      parent_id: "a",
    });
    const c = todoist.task("c", { content: "Call back" });
    // A full sync lists active tasks only, so it is completed later, by a
    // delta.
    const d = todoist.task("d", { content: "Post the letter" });
    const e = todoist.task("e", { content: "Book the room" });
    const all = [a, b, c, d, e];
    todoist.put(...all);
    await check(
      "todoist: a first run registers todoist.task as a kind of core.task and writes the account's tasks at the feed tier, each linked to its task",
      async () => {
        const wasHeld = await typeHeld(marfa, "todoist.task");
        await runOnce();
        const written = await rows();
        const tiers = [...new Set([...written.values()].map((r) => r.tier))];
        if (written.size !== all.length || tiers.join() !== "feed") {
          throw new Error(
            `${String(written.size)} rows at ${tiers.join(", ")}`,
          );
        }
        const { own, inherited } = await registeredAsKindOf(
          marfa,
          "todoist.task",
          "core.task",
          wasHeld,
          written.values(),
        );
        const expected =
          "child_order,labels,parent_id,project_id,recurrence,section_id,todoist_id";
        if (own.join() !== expected) {
          throw new Error(`own fields ${own.join(", ")}`);
        }
        const links = [...written.values()]
          .map((r) => r.properties["todoist_id"])
          .sort();
        if (links.join() !== "a,b,c,d,e") {
          throw new Error(`the rows carry todoist_id ${links.join(", ")}`);
        }
        const first = written.get(`${account}:a`)?.properties ?? {};
        const done = written.get(`${account}:d`)?.properties ?? {};
        const sub = written.get(`${account}:b`)?.properties ?? {};
        const landed = {
          priority: first["priority"],
          due_at: first["due_at"],
          precision: first["precision"],
          section_id: first["section_id"],
          labels: first["labels"],
          child_order: first["child_order"],
          parent_id: sub["parent_id"],
          status: done["status"],
          completed_at: done["completed_at"],
        };
        const wanted = {
          priority: "urgent",
          due_at: "2026-09-29T23:00:00.000Z",
          precision: "day",
          section_id: "s1",
          labels: ["Food", "Errands"],
          child_order: 2,
          parent_id: "a",
          status: "pending",
          completed_at: undefined,
        };
        if (JSON.stringify(landed) !== JSON.stringify(wanted)) {
          throw new Error(`the server holds ${JSON.stringify(landed)}`);
        }
        return `todoist.task, absent before the run, registered with parent core.task, all ${String(inherited)} of its fields and ${own.join(", ")} beside them; ${String(written.size)} rows, tier feed, every property a field of the type, todoist_id ${links.join(", ")}; on the server ${JSON.stringify(landed)}`;
      },
    );

    await check(
      "todoist: the registration shows its heartbeat and its last run, with the counts of what was carried back",
      async () => {
        const found = await registration(operator, key.id);
        if (
          found.last_heartbeat_at === null ||
          found.last_run?.outcome !== "succeeded"
        ) {
          throw new Error(
            `heartbeat ${String(found.last_heartbeat_at)}, last run ${String(found.last_run?.outcome)}`,
          );
        }
        const reported = String(found.last_run.summary);
        if (!reported.includes("pushed 0, own 0, conflicts 0")) {
          throw new Error(`the summary reads ${reported}`);
        }
        return `"${found.name}", source ${found.source}, heartbeat ${found.last_heartbeat_at}, last run ${found.last_run.outcome}: ${reported}`;
      },
    );

    await check(
      "todoist: a second run, with nothing changed on either side, moves no version and carries nothing back",
      async () => {
        const before = await rows();
        const sent = todoist.commands().length;
        await runOnce();
        const changed = moved(before, await rows());
        const reported = await summary();
        if (
          changed.length > 0 ||
          !reported.startsWith("created 0, updated 0, archived 0") ||
          !reported.includes("pushed 0, own 5, conflicts 0") ||
          todoist.commands().length !== sent
        ) {
          throw new Error(
            `moved ${changed.join(", ") || "nothing"}; reported ${reported}; ${String(todoist.commands().length - sent)} commands sent`,
          );
        }
        return `${String(before.size)} rows, none moved; the five creates read back as the connector's own; reported ${reported}`;
      },
    );

    await check(
      "todoist: a change upstream moves exactly that row, by one version",
      async () => {
        const before = await rows();
        todoist.edit("a", { content: "Buy oat milk" });
        await runOnce();
        const changed = moved(before, await rows());
        if (changed.join() !== `${account}:a 1→2`)
          throw new Error(`moved ${changed.join(", ") || "nothing"}`);
        return `moved ${changed.join(", ")}`;
      },
    );

    await check("todoist: a field cleared upstream is cleared", async () => {
      const before = await row("b");
      if (before.properties["description"] !== "With the details")
        throw new Error("the description never landed");
      todoist.edit("b", { description: "" });
      await runOnce();
      const after = await row("b");
      if ("description" in after.properties)
        throw new Error("the description is still there");
      return `description present at version ${String(before.version)}, absent at version ${String(after.version)}`;
    });

    await check(
      "todoist: a task completed upstream is completed and one deleted is archived, and nothing else moves",
      async () => {
        const before = await rows();
        todoist.complete("d");
        todoist.delete("e");
        await runOnce();
        const after = await rows();
        const changed = moved(before, after).sort();
        const done = after.get(`${account}:d`);
        const archived = after.get(`${account}:e`);
        if (
          done?.properties["status"] !== "completed" ||
          done.properties["completed_at"] !== "2026-09-24T12:00:00.000Z" ||
          done.state !== "active" ||
          archived?.state !== "archived" ||
          changed.length !== 2 ||
          !changed[0]?.startsWith(`${account}:d `) ||
          !changed[1]?.startsWith(`${account}:e `)
        ) {
          throw new Error(
            `d is ${String(done?.properties["status"])} at ${String(done?.properties["completed_at"])}, ${String(done?.state)}; e is ${String(archived?.state)}; moved ${changed.join(", ") || "nothing"}`,
          );
        }
        return `d completed at ${done.properties["completed_at"]}, still active; e ${String(before.get(`${account}:e`)?.state)} → ${archived.state}; moved ${changed.join(", ")}`;
      },
    );

    await check(
      "todoist: a trashed row is left alone, where an active one changing with it moves",
      async () => {
        const target = await row("c");
        await trash(marfa, target.id);
        const before = await rows();
        todoist.edit("c", { content: "Call back, changed" });
        todoist.edit("a", { content: "Buy oat milk and bread" });
        await runOnce();
        const after = await rows();
        const trashed = after.get(`${account}:c`);
        const changed = moved(before, after);
        if (
          trashed?.state !== "trashed" ||
          trashed.version !== target.version ||
          changed.length !== 1 ||
          !changed[0]?.startsWith(`${account}:a `)
        ) {
          throw new Error(
            `the trashed row is ${String(trashed?.state)} at version ${String(trashed?.version)}; moved ${changed.join(", ") || "nothing"}`,
          );
        }
        return `c stays trashed at version ${String(target.version)}; moved ${changed.join(", ")}`;
      },
    );

    await check(
      "todoist: the trash was carried back, deleting the task",
      async () => {
        const task = todoist.tasks.get("c");
        const deletes = todoist
          .commands("item_delete")
          .map((command) => command.args["id"]);
        if (
          task?.is_deleted !== true ||
          deletes.join() !== "c" ||
          todoist.commands("item_close").length !== 0
        ) {
          throw new Error(
            `task c deleted ${String(task?.is_deleted)}; item_delete sent for ${deletes.join(", ") || "nothing"}; ${String(todoist.commands("item_close").length)} closes`,
          );
        }
        const reported = await summary();
        if (!reported.includes("pushed 1, ")) {
          throw new Error(`the summary reads ${reported}`);
        }
        return `item_delete sent for c, uuid ${String(todoist.commands("item_delete")[0]?.uuid)}; task c deleted; reported ${reported}`;
      },
    );

    await check(
      "todoist: a promoted core.task sits in the library with a derived-from edge",
      async () => {
        const source = await row("a");
        const { copy } = await promoteAndFind(
          marfa,
          "core.task",
          await asTask(marfa, source),
          source,
          await row("b"),
        );
        const read = await item(marfa, copy.id);
        if (
          read.tier !== "library" ||
          read.properties["priority"] !== "urgent" ||
          read.properties["due_at"] !== source.properties["due_at"] ||
          read.properties["precision"] !== "day"
        ) {
          throw new Error(
            `tier ${String(read.tier)}, priority ${String(read.properties["priority"])}, due ${String(read.properties["due_at"])} at ${String(read.properties["precision"])}`,
          );
        }
        return `core.task at tier ${read.tier} with ${Object.keys(read.properties).join(", ")}: priority ${read.properties["priority"]} from Todoist's 4, due ${String(read.properties["due_at"])} at day precision, taken from the row with no mapping; the edge filter finds it alone, beside an item with no edge and one derived from another row`;
      },
    );

    await check(
      "todoist: the next run leaves the promoted copy alone",
      async () => {
        const source = await row("a");
        const [copy] = await derivedFrom(marfa, "core.task", source);
        if (copy === undefined) throw new Error("no promoted copy");
        todoist.edit("a", { content: "Buy oat milk, bread and eggs" });
        await runOnce();
        const again = await item(marfa, copy.id);
        const moving = await row("a");
        if (
          again.version !== copy.version ||
          moving.version === source.version
        ) {
          throw new Error(
            `copy ${String(copy.version)}→${String(again.version)}, source ${String(source.version)}→${String(moving.version)}`,
          );
        }
        return `the feed row moved ${String(source.version)}→${String(moving.version)}; the copy stays at version ${String(copy.version)}`;
      },
    );

    await check(
      "todoist: a row edited in Marfa through the working key arrives in Todoist, as only what changed",
      async () => {
        const before = await row("b");
        await edit(marfa, before, { title: "Write the note, from Marfa" });
        await runOnce();
        const task = todoist.tasks.get("b");
        const updates = todoist
          .commands("item_update")
          .map((command) => command.args);
        const reported = await summary();
        if (
          task?.content !== "Write the note, from Marfa" ||
          updates.length !== 1 ||
          JSON.stringify(updates[0]) !==
            JSON.stringify({
              id: "b",
              content: "Write the note, from Marfa",
            }) ||
          !reported.includes("pushed 1, ")
        ) {
          throw new Error(
            `task b reads "${String(task?.content)}"; item_update sent ${JSON.stringify(updates)}; reported ${reported}`,
          );
        }
        return `item_update ${JSON.stringify(updates[0])}; task b reads "${task.content}"; reported ${reported}`;
      },
    );

    await check(
      "todoist: the run after carries nothing back and moves nothing: Todoist's copy of the edit is what the row already holds",
      async () => {
        const before = await rows();
        const sent = todoist.commands().length;
        await runOnce();
        const changed = moved(before, await rows());
        const reported = await summary();
        if (
          changed.length > 0 ||
          todoist.commands().length !== sent ||
          !/unchanged 1, .*pushed 0, own 0, conflicts 0/.test(reported)
        ) {
          throw new Error(
            `moved ${changed.join(", ") || "nothing"}; ${String(todoist.commands().length - sent)} commands sent; reported ${reported}`,
          );
        }
        return `none moved, nothing sent; reported ${reported}`;
      },
    );

    let made: Item | undefined;
    await check(
      "todoist: a todoist.task created in Marfa through the working key, under its own source, becomes a task in Todoist and gains its todoist_id",
      async () => {
        const created = await create(marfa, "todoist.task", {
          title: "Made in Marfa",
          description: "Carried out",
          priority: "high",
          due_at: "2026-10-02T09:00:00.000Z",
          precision: "time",
          status: "pending",
        });
        made = created;
        if (created.source === "todoist") {
          throw new Error(
            "the working key writes under the connector's source",
          );
        }
        await runOnce();
        const adds = todoist.commands("item_add");
        const linked = await item(marfa, created.id);
        const taskId = linked.properties["todoist_id"];
        const task =
          typeof taskId === "string" ? todoist.tasks.get(taskId) : undefined;
        if (
          adds.length !== 1 ||
          typeof taskId !== "string" ||
          task?.content !== "Made in Marfa" ||
          task.description !== "Carried out" ||
          task.priority !== 3 ||
          task.due?.["date"] !== "2026-10-02T09:00:00Z" ||
          linked.properties["url"] !==
            `https://app.todoist.com/app/task/${taskId}`
        ) {
          throw new Error(
            `item_add sent ${String(adds.length)} times; the row carries todoist_id ${String(taskId)}; the task is ${JSON.stringify(task)}; the row holds ${JSON.stringify(linked.properties)}`,
          );
        }
        return `item_add with uuid ${String(adds[0]?.uuid)} and temp_id ${String(adds[0]?.temp_id)}; Todoist made ${taskId} with content, description, priority 3 and a fixed due date; the row, source ${created.source}, carries todoist_id ${taskId} and the url the sync gave it, at version ${String(linked.version)}`;
      },
    );

    await check(
      "todoist: a conflict is won by the later change, and the loser is named in the run: Marfa's edit over an earlier one in Todoist",
      async () => {
        const before = await row("a");
        await edit(marfa, before, { title: "Buy everything, from Marfa" });
        // Earlier than the server's clock, so the edit made in Marfa is the later
        // one.
        todoist.now = "2026-09-24T12:30:00.000000Z";
        todoist.edit("a", { content: "Buy everything, from Todoist" });
        await runOnce();
        const after = await row("a");
        const task = todoist.tasks.get("a");
        const reported = await summary();
        if (
          after.properties["title"] !== "Buy everything, from Marfa" ||
          task?.content !== "Buy everything, from Marfa" ||
          !reported.includes("conflicts 1") ||
          !reported.includes(before.id)
        ) {
          throw new Error(
            `the row reads "${String(after.properties["title"])}", the task "${String(task?.content)}"; reported ${reported}`,
          );
        }
        return `the row and the task both read "Buy everything, from Marfa"; reported ${reported}`;
      },
    );

    await check(
      "todoist: a conflict is won by the later change, and the loser is named in the run: Todoist's edit over an earlier one in Marfa",
      async () => {
        const before = await row("b");
        await edit(marfa, before, {
          title: "Write the note, again from Marfa",
        });
        todoist.now = "2030-01-01T00:00:00.000000Z";
        todoist.edit("b", { content: "Write the note, from Todoist" });
        const sent = todoist.commands().length;
        await runOnce();
        const after = await row("b");
        const task = todoist.tasks.get("b");
        const reported = await summary();
        if (
          after.properties["title"] !== "Write the note, from Todoist" ||
          task?.content !== "Write the note, from Todoist" ||
          todoist.commands().length !== sent ||
          !reported.includes("conflicts 1") ||
          !reported.includes(before.id)
        ) {
          throw new Error(
            `the row reads "${String(after.properties["title"])}", the task "${String(task?.content)}"; ${String(todoist.commands().length - sent)} commands sent; reported ${reported}`,
          );
        }
        return `the row and the task both read "Write the note, from Todoist", nothing sent; reported ${reported}`;
      },
    );

    await check(
      "todoist: a run with nothing changed on either side, after all of that, moves no version and sends nothing",
      async () => {
        if (made === undefined) throw new Error("no row was made in Marfa");
        const before = await rows();
        const person = await item(marfa, made.id);
        const sent = todoist.commands().length;
        await runOnce();
        const changed = moved(before, await rows());
        const again = await item(marfa, made.id);
        const reported = await summary();
        if (
          changed.length > 0 ||
          again.version !== person.version ||
          todoist.commands().length !== sent ||
          !reported.includes("pushed 0, ") ||
          !reported.includes("conflicts 0")
        ) {
          throw new Error(
            `moved ${changed.join(", ") || "nothing"}; the made row ${String(person.version)}→${String(again.version)}; ${String(todoist.commands().length - sent)} commands sent; reported ${reported}`,
          );
        }
        return `${String(before.size + 1)} rows, none moved, nothing sent; reported ${reported}`;
      },
    );

    await check(
      "todoist: a restore in Marfa makes the deleted task again, and the row is linked to it",
      async () => {
        const target = await row("c");
        await restore(marfa, target.id);
        await runOnce();
        const back = await item(marfa, target.id);
        const adds = todoist.commands("item_add");
        const add = adds.at(-1);
        const madeId = String(back.properties["todoist_id"]);
        const task = todoist.tasks.get(madeId);
        const reported = await summary();
        if (
          back.state !== "active" ||
          madeId === "c" ||
          task === undefined ||
          task.is_deleted ||
          task.content !== "Call back" ||
          add?.args["content"] !== "Call back" ||
          !reported.includes("conflicts 0")
        ) {
          throw new Error(
            `row c ${back.state}, linked to ${madeId}; task ${JSON.stringify(task)}; last add ${JSON.stringify(add?.args)}; reported ${reported}`,
          );
        }
        await runOnce();
        const synced = await item(marfa, target.id);
        await runOnce();
        const settled = await item(marfa, target.id);
        if (
          !String(synced.properties["url"]).includes(madeId) ||
          settled.version !== synced.version ||
          settled.state !== "active" ||
          settled.properties["todoist_id"] !== madeId
        ) {
          throw new Error(
            `row c at url ${String(synced.properties["url"])}, then version ${String(synced.version)}→${String(settled.version)}, ${settled.state}, linked to ${String(settled.properties["todoist_id"])}`,
          );
        }
        return `item_add sent, task ${madeId} made with "Call back"; row c active and linked to it; the next run brought its url ${String(synced.properties["url"])}, and the one after moved nothing; reported ${reported}`;
      },
    );

    await check(
      "todoist: a purge in Marfa after a trash changes nothing more in Todoist",
      async () => {
        const target = await row("c");
        const madeId = String(target.properties["todoist_id"]);
        await trash(marfa, target.id);
        await runOnce();
        const afterTrash = todoist.commands().length;
        await purge(marfa, target.id);
        await runOnce();
        const deletes = todoist
          .commands("item_delete")
          .filter((command) => command.args["id"] === madeId);
        const sentAfter = todoist.commands().slice(afterTrash);
        const live = [...todoist.tasks.values()].filter((t) => !t.is_deleted);
        const gone = (await rows()).get(`${account}:c`);
        if (
          todoist.tasks.get(madeId)?.is_deleted !== true ||
          deletes.length !== 2 ||
          deletes[0]?.uuid !== deletes[1]?.uuid ||
          sentAfter.some((command) => command.type !== "item_delete") ||
          gone !== undefined
        ) {
          throw new Error(
            `task ${madeId} deleted ${String(todoist.tasks.get(madeId)?.is_deleted)}; ${String(deletes.length)} deletes; after the trash sent ${sentAfter.map((c) => c.type).join(", ") || "nothing"}; row c ${gone === undefined ? "gone" : "still there"}`,
          );
        }
        return `the trash deleted ${madeId}; the purge sent the same item_delete, uuid ${String(deletes[0]?.uuid)}, which Todoist takes once; row c gone, ${String(live.length)} tasks live`;
      },
    );

    await check(
      "todoist: a trashed recurring task is deleted, not moved on to its next occurrence",
      async () => {
        todoist.put(
          todoist.task("r", {
            content: "Water the plants",
            due: {
              date: "2026-09-27",
              is_recurring: true,
              string: "every day",
            },
          }),
        );
        await runOnce();
        const target = await row("r");
        await trash(marfa, target.id);
        await runOnce();
        const task = todoist.tasks.get("r");
        if (
          task?.is_deleted !== true ||
          task.due?.["date"] !== "2026-09-27" ||
          todoist.commands("item_close").some((c) => c.args["id"] === "r")
        ) {
          throw new Error(`task r ${JSON.stringify(task)}`);
        }
        return `item_delete sent for r; the task is deleted and its due date still ${task.due["date"]}`;
      },
    );

    // The connector asks its completion window by the real clock.
    const lately = (): string =>
      new Date(Date.now() - 60 * 60_000).toISOString();
    const completedDoor = "/api/v1/tasks/completed/by_completion_date";
    const clearState = async (): Promise<void> => {
      const connectorId = (await registration(operator, key.id)).id;
      const cleared = await createClient({
        baseUrl: url,
        credential: key.key,
      }).DELETE("/connectors/{id}/state", {
        params: { path: { id: connectorId } },
      });
      if (!cleared.response.ok) {
        throw new Error(
          `the clear was refused: ${JSON.stringify(cleared.error)}`,
        );
      }
    };

    await check(
      "todoist: a task completed in Todoist while the connector's state was lost reads as completed after the full sync that follows",
      async () => {
        todoist.put(todoist.task("l", { content: "Renew the passport" }));
        await runOnce();
        const open = await row("l");
        await clearState();
        const at = lately();
        todoist.edit("l", { checked: true, completed_at: at });
        const asked = todoist.received.length;
        const sent = todoist.commands().length;
        await runOnce();
        const done = await row("l");
        const requests = todoist.received.slice(asked);
        if (
          open.properties["status"] !== "pending" ||
          done.properties["status"] !== "completed" ||
          done.properties["completed_at"] !== at ||
          done.state !== "active" ||
          !requests.some((r) => r.syncToken === "*") ||
          !requests.some((r) => r.path === completedDoor) ||
          todoist.commands().length !== sent
        ) {
          throw new Error(
            `l was ${String(open.properties["status"])}, is ${String(done.properties["status"])} at ${String(done.properties["completed_at"])}, ${done.state}; asked ${requests.map((r) => r.syncToken ?? r.path).join(", ")}; ${String(todoist.commands().length - sent)} commands`,
          );
        }
        return `with the state cleared the run synced in full and read the completed tasks: l ${open.properties["status"]} → ${done.properties["status"]} at ${done.properties["completed_at"]}`;
      },
    );

    await check(
      "todoist: a task completed before the account's timezone moved has its due date read in the new zone",
      async () => {
        todoist.put(
          todoist.task("z", {
            content: "File the return",
            due: { date: "2026-10-05", is_recurring: false },
          }),
        );
        await runOnce();
        todoist.edit("z", { checked: true, completed_at: lately() });
        await runOnce();
        const before = await row("z");
        todoist.renameZone("America/New_York");
        await runOnce();
        const after = await row("z");
        if (
          before.properties["due_at"] !== "2026-10-04T23:00:00.000Z" ||
          before.properties["status"] !== "completed" ||
          after.properties["due_at"] !== "2026-10-05T04:00:00.000Z" ||
          after.properties["status"] !== "completed"
        ) {
          throw new Error(
            `z was due ${String(before.properties["due_at"])}, ${String(before.properties["status"])}; is due ${String(after.properties["due_at"])}, ${String(after.properties["status"])}`,
          );
        }
        return `z, completed, due ${before.properties["due_at"]} in London → ${after.properties["due_at"]} in New York`;
      },
    );

    await check(
      "todoist: an edit Todoist refuses is kept over Todoist's next read and not sent again, and lands once the row changes",
      async () => {
        todoist.put(todoist.task("w", { content: "Refuse me" }));
        await runOnce();
        const before = await row("w");
        await edit(marfa, before, { title: "Refused title" });
        todoist.scriptCommand("item_update", {
          error_code: 20,
          error: "Invalid argument value",
          http_code: 400,
        });
        await runOnce();
        const refused = await summary();
        todoist.edit("w", { description: "Edited in Todoist" });
        const updates = todoist.commands("item_update").length;
        await runOnce();
        const kept = await row("w");
        const resent = todoist.commands("item_update").length - updates;
        await edit(marfa, kept, { title: "Accepted title" });
        await runOnce();
        const landed = todoist.tasks.get("w")?.content;
        const cleared = await summary();
        if (
          !refused.includes(
            `the change to ${before.id} was refused, so it waits until the row changes in Marfa: Todoist refused updating task w: Invalid argument value (20)`,
          ) ||
          resent !== 0 ||
          kept.properties["title"] !== "Refused title" ||
          kept.properties["description"] !== "Edited in Todoist" ||
          landed !== "Accepted title" ||
          cleared.includes("was refused")
        ) {
          throw new Error(
            `refused: ${refused}; resent ${String(resent)}; kept ${JSON.stringify(kept.properties)}; Todoist holds ${String(landed)}; then ${cleared}`,
          );
        }
        return `refused run: ${refused}; the next run sent nothing and the row kept "Refused title" beside Todoist's description; once edited again Todoist holds "${landed}"`;
      },
    );

    await check(
      "todoist: an edit Todoist rate-limits past every resend waits, the run lands, and the next run carries it",
      async () => {
        const before = await row("w");
        await edit(marfa, before, { title: "Limited title" });
        todoist.scriptCommand(
          "item_update",
          {
            error_code: 35,
            error: "Too many requests",
            http_code: 429,
            error_extra: { retry_after: 0 },
          },
          6,
        );
        await runOnce();
        const waited = await summary();
        const held = todoist.tasks.get("w")?.content;
        const kept = (await row("w")).properties["title"];
        await runOnce();
        const landed = todoist.tasks.get("w")?.content;
        if (
          !waited.includes(
            "1 change waits: Todoist is not taking changes for now: Too many requests (35)",
          ) ||
          held !== "Accepted title" ||
          kept !== "Limited title" ||
          landed !== "Limited title"
        ) {
          throw new Error(
            `${waited}; Todoist held ${String(held)}, the row ${String(kept)}, then Todoist ${String(landed)}`,
          );
        }
        return `${waited}; Todoist kept "${held}" and the row "${kept}", and the next run sent it: Todoist holds "${landed}"`;
      },
    );

    await check(
      "todoist: moving a recurring task's due date in Marfa keeps it recurring in Todoist, due on the new date",
      async () => {
        todoist.put(
          todoist.task("rr", {
            content: "Take out the bins",
            due: {
              date: "2026-10-01",
              string: "every day",
              lang: "en",
              is_recurring: true,
              timezone: null,
            },
          }),
        );
        await runOnce();
        await edit(marfa, await row("rr"), {
          due_at: "2026-10-07T12:00:00.000Z",
          precision: "day",
        });
        await runOnce();
        const sent = todoist
          .commands("item_update")
          .filter((c) => c.args["id"] === "rr")
          .map((c) => c.args["due"]);
        const due = todoist.tasks.get("rr")?.due;
        if (
          JSON.stringify(sent) !==
            JSON.stringify([
              { string: "every day", lang: "en", date: "2026-10-07" },
            ]) ||
          due?.["date"] !== "2026-10-07" ||
          due["is_recurring"] !== true ||
          due["string"] !== "every day"
        ) {
          throw new Error(
            `sent ${JSON.stringify(sent)}; Todoist holds ${JSON.stringify(due)}`,
          );
        }
        return `item_update sent due ${JSON.stringify(sent[0])}; Todoist holds ${JSON.stringify(due)}`;
      },
    );

    await check(
      "todoist: an edit to a row completed in Todoist reaches the task, looked at by id as Todoist answers a completed one",
      async () => {
        todoist.put(todoist.task("k", { content: "Return the books" }));
        await runOnce();
        todoist.complete("k");
        await runOnce();
        const done = await row("k");
        const asked = todoist.received.length;
        await edit(marfa, done, { title: "Return the library books" });
        await runOnce();
        const task = todoist.tasks.get("k");
        const looked = todoist.received
          .slice(asked)
          .some((r) => r.method === "GET" && r.path === "/api/v1/tasks/k");
        if (
          done.properties["status"] !== "completed" ||
          task?.content !== "Return the library books" ||
          !task.checked ||
          !looked
        ) {
          throw new Error(
            `the row was ${String(done.properties["status"])}; Todoist holds ${JSON.stringify(task)}; looked up by id ${String(looked)}`,
          );
        }
        return `k completed in Todoist, edited in Marfa: GET /api/v1/tasks/k answered the completed task and Todoist holds "${task.content}", still completed`;
      },
    );

    await check(
      "todoist: a task deleted in Todoist while the connector's state was lost is archived after the full sync that follows",
      async () => {
        todoist.put(todoist.task("x", { content: "Cancel the order" }));
        await runOnce();
        const before = await row("x");
        await clearState();
        todoist.delete("x");
        await runOnce();
        const after = await row("x");
        if (before.state !== "active" || after.state !== "archived") {
          throw new Error(`x was ${before.state}, is ${after.state}`);
        }
        return `with the state cleared, the full sync left x out, the connector asked Todoist for it by id and archived its row: ${before.state} → ${after.state}`;
      },
    );

    let filed: string | undefined;
    await check(
      "todoist: a todoist.task created in Marfa naming a project, section and labels is made there in Todoist and keeps them",
      async () => {
        const created = await create(marfa, "todoist.task", {
          title: "Filed from Marfa",
          project_id: "p-work",
          section_id: "s-later",
          labels: ["Home"],
          status: "pending",
        });
        filed = created.id;
        await runOnce();
        await runOnce();
        const linked = await item(marfa, created.id);
        const taskId = linked.properties["todoist_id"];
        const task =
          typeof taskId === "string" ? todoist.tasks.get(taskId) : undefined;
        if (
          task?.project_id !== "p-work" ||
          task.section_id !== "s-later" ||
          task.labels.join() !== "Home" ||
          linked.properties["project_id"] !== "p-work" ||
          linked.properties["section_id"] !== "s-later" ||
          JSON.stringify(linked.properties["labels"]) !== '["Home"]'
        ) {
          throw new Error(
            `Todoist holds ${JSON.stringify(task)}; the row holds ${JSON.stringify(linked.properties)}`,
          );
        }
        return `Todoist made ${String(taskId)} in p-work, section s-later, labelled Home, and the row keeps them after the next run`;
      },
    );

    await check(
      "todoist: a todoist.task edited in Marfa to change its labels, project and section is moved and relabelled in Todoist, and the row keeps the change",
      async () => {
        if (filed === undefined) throw new Error("no row was filed");
        const before = await item(marfa, filed);
        const taskId = before.properties["todoist_id"];
        if (typeof taskId !== "string") throw new Error("the row has no task");
        todoist.sections = new Map([["s-home", "p-home"]]);
        const sent = todoist.commands().length;
        await edit(marfa, before, {
          project_id: "p-home",
          section_id: "s-home",
          labels: ["Home", "Errands"],
        });
        await runOnce();
        await runOnce();
        const task = todoist.tasks.get(taskId);
        const commands = todoist
          .commands()
          .slice(sent)
          .map((command) => [command.type, command.args]);
        const after = await item(marfa, filed);
        if (
          JSON.stringify(commands) !==
            JSON.stringify([
              ["item_update", { id: taskId, labels: ["Home", "Errands"] }],
              ["item_move", { id: taskId, section_id: "s-home" }],
            ]) ||
          task?.project_id !== "p-home" ||
          task.section_id !== "s-home" ||
          task.labels.join() !== "Errands,Home" ||
          after.properties["project_id"] !== "p-home" ||
          after.properties["section_id"] !== "s-home" ||
          JSON.stringify(after.properties["labels"]) !== '["Errands","Home"]'
        ) {
          throw new Error(
            `commands ${JSON.stringify(commands)}; Todoist holds ${JSON.stringify(task)}; the row holds ${JSON.stringify(after.properties)}`,
          );
        }
        return `item_update set the labels and item_move put ${taskId} in section s-home of p-home; the row keeps project, section and labels after the next run`;
      },
    );

    await check(
      "todoist: with TODOIST_READ_ONLY=true nothing goes back to Todoist, and an edit made in Marfa is put back",
      async () => {
        const readOnly = new ConnectorUnderProof("todoist", url, key.key, {
          TODOIST_API_TOKEN: "todoist-proof-token",
          TODOIST_API_URL: todoist.url,
          TODOIST_READ_ONLY: "true",
        });
        const before = await row("a");
        const held = todoist.tasks.get("a")?.content;
        await edit(marfa, before, { title: "Edited in Marfa" });
        const sent = todoist.commands().length;
        const { code, output } = await readOnly.once();
        const after = await row("a");
        const reported = await summary();
        if (
          code !== 0 ||
          todoist.commands().length !== sent ||
          after.properties["title"] !== held ||
          !reported.includes("put back")
        ) {
          throw new Error(
            `exit ${String(code)}; ${String(todoist.commands().length - sent)} commands; the row holds ${String(after.properties["title"])}; ${reported}; ${output.slice(-300)}`,
          );
        }
        return `no command sent; the row's title is "${String(after.properties["title"])}" again; reported ${reported}`;
      },
    );

    await check(
      "todoist: a key holding permissions beside its type, among them schema.write, is refused at start, before it registers the type or writes a row, naming every one",
      async () => {
        const { data: wide, error } = await marfa.POST("/keys", {
          body: {
            ...keyBody({
              label: "todoist-wide",
              source: "todoist-wide",
              typePermission: "todoist.task",
            }),
            permissions: [
              "schema.write",
              "keys.mint",
              "items.purge",
              "webhooks.manage",
              "config.manage",
              "audit.read",
              "grants.manage",
            ],
          },
        });
        if (wide === undefined)
          throw new Error(`the wide key was refused: ${JSON.stringify(error)}`);
        const before = await rows();
        const sent = todoist.commands().length;
        const refused = new ConnectorUnderProof("todoist", url, wide.key, {
          TODOIST_API_TOKEN: "todoist-proof-token",
          TODOIST_API_URL: todoist.url,
        });
        const { code, output } = await refused.once();
        const changed = moved(before, await rows());
        const named = output.slice(output.indexOf("is refused:"));
        if (
          code !== 1 ||
          !output.includes("holds more than read and write on todoist.task") ||
          !named.includes("schema.write") ||
          !output.includes("keys.mint") ||
          !output.includes("items.purge") ||
          output.includes("type todoist.task") ||
          changed.length > 0 ||
          todoist.commands().length !== sent
        ) {
          throw new Error(
            `exit ${String(code)}; moved ${changed.join(", ") || "nothing"}; ${String(todoist.commands().length - sent)} commands; ${output.slice(-400)}`,
          );
        }
        const line = output
          .split("\n")
          .find((l) => l.includes("holds more than"));
        return `exit 1, nothing written or sent, while the connector's own key, holding the permissions beside its type, runs: ${String(line).slice(0, 300)}`;
      },
    );
  } finally {
    await todoist.close();
  }
}
