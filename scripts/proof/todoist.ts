import type { MarfaClient } from "@withmarfa/client";
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
  lastRun,
  mintAsReadmeSays,
  moved,
  promoteAndFind,
  registration,
  rowsOf,
  trash,
  type Item,
} from "./connector.js";
import { TodoistStub } from "./todoist-stub.js";

/**
 * A person's core.task from a Todoist row. The row is a kind of core task
 * and carries the core's values already, so promoting maps nothing.
 */
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
): Promise<void> {
  const todoist = await new TodoistStub("todoist-proof-token").start();
  const account = todoist.account;
  let connector: ConnectorUnderProof | undefined;
  try {
    const key = await mintAsReadmeSays(marfa, {
      label: "todoist",
      source: "todoist",
      typePermission: "todoist.task",
    });
    const runner = new ConnectorUnderProof("todoist", url, key.key, {
      TODOIST_API_TOKEN: "todoist-proof-token",
      TODOIST_API_URL: todoist.url,
    });
    connector = runner;
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
      String((await lastRun(marfa, key.id)).summary);

    const a = todoist.task("a", {
      content: "Buy milk",
      priority: 4,
      due: { date: "2026-09-30", is_recurring: false },
      section_id: "s1",
      labels: ["Food", "Errands"],
      child_order: 2,
      note_count: 3,
    });
    const b = todoist.task("b", {
      content: "Write the note",
      description: "With the details",
      parent_id: "a",
    });
    const c = todoist.task("c", { content: "Call back" });
    // Open, since a full sync lists active tasks only; completed later,
    // through a delta.
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
          "child_order,comment_count,labels,parent_id,project_id,section_id,todoist_id";
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
          comment_count: first["comment_count"],
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
          comment_count: 3,
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
        const found = await registration(marfa, key.id);
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
      "todoist: the trash was carried back, closing the task",
      async () => {
        const task = todoist.tasks.get("c");
        const closes = todoist
          .commands("item_close")
          .map((command) => command.args["id"]);
        if (task?.checked !== true || closes.join() !== "c") {
          throw new Error(
            `task c checked ${String(task?.checked)}; item_close sent for ${closes.join(", ") || "nothing"}`,
          );
        }
        const reported = await summary();
        if (!reported.includes("pushed 1, ")) {
          throw new Error(`the summary reads ${reported}`);
        }
        return `item_close sent for c, uuid ${String(todoist.commands("item_close")[0]?.uuid)}; task c completed; reported ${reported}`;
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
        // Stamped the day before the server's clock, so the edit made in
        // Marfa is the later one; the content differs from what the two
        // sides last agreed on, so it is a change of the vendor's and a
        // conflict, not a listing of the same entry again.
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
  } finally {
    await connector?.dispose();
    await todoist.close();
  }
}
