import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer, type Row } from "../../../kit/test/scripted-server.js";
import { TodoistStub } from "../../../scripts/proof/todoist-stub.js";
import { argsOf, differing } from "../src/outbound.js";
import { dueFor, priorityFor, uuidFor } from "../src/todoist.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "todoist-test-token-value";
const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const served = {
  id: "todoist.task",
  label: "Todoist Task",
  parent: "core.task",
  link_field: "todoist_id",
  fields: {
    todoist_id: { type: "string" },
    project_id: { type: "string" },
    section_id: { type: "string" },
    parent_id: { type: "string" },
    labels: { type: "array", items_type: "string" },
    child_order: { type: "integer" },
    comment_count: { type: "integer" },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

let marfa: ScriptedServer;
let todoist: TodoistStub;

beforeEach(async () => {
  marfa = await new ScriptedServer("todoist", {
    types: ["todoist.task"],
  }).start();
  marfa.types.set("todoist.task", served);
  todoist = await new TodoistStub(token).start();
});

afterEach(async () => {
  const sent = todoist.commands();
  for (const command of sent) expect(command.uuid).toMatch(uuidShape);
  // Args are left out: a create replayed after a failed run carries the row as
  // it is by then.
  const what = (c: (typeof sent)[number]): string =>
    JSON.stringify([c.type, c.temp_id, c.args["id"]]);
  const byUuid = new Map(sent.map((c) => [c.uuid, what(c)]));
  for (const command of sent) {
    expect(byUuid.get(command.uuid)).toBe(what(command));
  }
  await marfa.stop();
  await todoist.close();
});

async function once(): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        TODOIST_API_TOKEN: token,
        TODOIST_API_URL: todoist.url,
      },
    });
    return { code: 0, output: stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, output: failed.stderr };
  }
}

async function landed(): Promise<string> {
  const { code, output } = await once();
  expect(code, output).toBe(0);
  return output;
}

function summary(): string {
  return marfa.runs.at(-1)?.summary ?? "";
}

function personsRow(properties: Record<string, unknown>): Row {
  return marfa.insert(undefined, properties, "todoist.task", "person");
}

async function synced(id: string, content = `Task ${id}`): Promise<Row> {
  todoist.put(todoist.task(id, { content }));
  await landed();
  return marfa.row(`${todoist.account}:${id}`);
}

describe("the mapping back", () => {
  it("writes the core's priority as Todoist's, and none as Todoist's 1", () => {
    expect(
      ["low", "medium", "high", "urgent", undefined].map(priorityFor),
    ).toEqual([1, 2, 3, 4, 1]);
  });

  it("writes a whole day as its date in the account's timezone, a time fixed in UTC, and none as null", () => {
    expect(dueFor("2026-09-29T23:00:00.000Z", "day", "Europe/London")).toEqual({
      date: "2026-09-30",
    });
    expect(dueFor("2026-09-29T23:00:00.000Z", "day", "UTC")).toEqual({
      date: "2026-09-29",
    });
    expect(dueFor("2026-09-30T10:00:00.000Z", "time", "Europe/London")).toEqual(
      {
        date: "2026-09-30T10:00:00Z",
      },
    );
    expect(dueFor(undefined, undefined, "UTC")).toBeNull();
    expect(dueFor("not a date", "time", "UTC")).toBeNull();
  });

  it("sends only what differs, and reads a floating time Todoist holds as the fixed one the row names", () => {
    const row = {
      id: "r",
      type: "todoist.task",
      version: 1,
      state: "active",
      properties: {
        title: "Buy milk",
        description: "Organic",
        priority: "high",
        due_at: "2026-09-30T11:00:00.000Z",
        precision: "time",
      },
    } as unknown as Parameters<typeof argsOf>[0];
    const wanted = argsOf(row, "Europe/London");
    expect(wanted).toEqual({
      content: "Buy milk",
      description: "Organic",
      priority: 3,
      due: { date: "2026-09-30T11:00:00Z" },
    });
    const same = todoist.task("t", {
      content: "Buy milk",
      description: "Organic",
      priority: 3,
      due: { date: "2026-09-30T12:00:00" },
    });
    expect(differing(wanted, same, "Europe/London")).toEqual({});
    const other = todoist.task("t", {
      content: "Buy oat milk",
      description: "",
      priority: 3,
      due: null,
    });
    expect(differing(wanted, other, "Europe/London")).toEqual({
      content: "Buy milk",
      description: "Organic",
      due: { date: "2026-09-30T11:00:00Z" },
    });
  });

  it("derives one uuid from what a command does, laid out as a UUID", () => {
    const first = uuidFor("row", "1", "item_update");
    expect(first).toMatch(uuidShape);
    expect(uuidFor("row", "1", "item_update")).toBe(first);
    expect(uuidFor("row", "2", "item_update")).not.toBe(first);
    expect(uuidFor("row", "1", "item_close")).not.toBe(first);
  });
});

describe("a row Todoist has not been told about", () => {
  it("is created there with every traveling field, linked to the task it made, and closed if completed", async () => {
    todoist.put(todoist.task("seed"));
    const timed = personsRow({
      title: "Write the note",
      description: "With the details",
      priority: "high",
      due_at: "2026-09-30T10:00:00.000Z",
      precision: "time",
      status: "pending",
    });
    const wholeDay = personsRow({
      title: "Post the letter",
      priority: "urgent",
      due_at: "2026-09-29T23:00:00.000Z",
      precision: "day",
      status: "completed",
      completed_at: "2026-09-25T09:00:00.000Z",
    });
    await landed();

    const adds = todoist.commands("item_add");
    expect(adds.map((command) => command.args)).toEqual([
      {
        content: "Write the note",
        description: "With the details",
        priority: 3,
        due: { date: "2026-09-30T10:00:00Z" },
      },
      {
        content: "Post the letter",
        description: "",
        priority: 4,
        due: { date: "2026-09-30" },
      },
    ]);
    for (const command of adds) {
      expect(command.uuid).toMatch(uuidShape);
      expect(command.temp_id).toMatch(uuidShape);
    }
    expect(marfa.byId(timed.id).properties["todoist_id"]).toBe("made-1");
    expect(marfa.byId(wholeDay.id).properties["todoist_id"]).toBe("made-2");
    expect(todoist.tasks.get("made-1")?.checked).toBe(false);
    expect(todoist.tasks.get("made-2")?.checked).toBe(true);
    expect(todoist.commands("item_close").map((c) => c.args["id"])).toEqual([
      "made-2",
    ]);
    expect(summary()).toMatch(/pushed 2, own 0, conflicts 0/);
    expect(todoist.received.filter((r) => r.syncToken === "*")).toHaveLength(2);
  });

  it("sends the same create again after a run that failed, and Todoist makes one task", async () => {
    todoist.put(todoist.task("seed"));
    const one = personsRow({ title: "One", status: "pending" });
    marfa.refuseNext(`PATCH /items/${one.id}`, 503, "unavailable");
    const failed = await once();
    expect(failed.code).not.toBe(0);
    expect(marfa.byId(one.id).properties["todoist_id"]).toBeUndefined();
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);

    await landed();
    const adds = todoist.commands("item_add");
    expect(adds.map((c) => c.args["content"])).toEqual(["One", "One"]);
    expect(adds[1]?.uuid).toBe(adds[0]?.uuid);
    expect(adds[1]?.temp_id).toBe(adds[0]?.temp_id);
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
    expect(marfa.byId(one.id).properties["todoist_id"]).toBe("made-1");
  });

  it("carries nothing for a row trashed or archived before Todoist knew it", async () => {
    todoist.put(todoist.task("seed"));
    const trashed = personsRow({ title: "Never sent", status: "pending" });
    marfa.trash(trashed.id);
    const archived = personsRow({ title: "Set aside", status: "pending" });
    marfa.transition(archived.id, "archived");
    await landed();
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toMatch(/pushed 0, own 0/);
  });

  it("keeps a create Todoist took without naming the task it made waiting, and says so", async () => {
    todoist.put(todoist.task("seed"));
    const unmapped = personsRow({ title: "Unmapped", status: "pending" });
    todoist.scriptCommand("item_add", "ok");
    await landed();
    expect(marfa.byId(unmapped.id).properties["todoist_id"]).toBeUndefined();
    expect(summary()).toContain(
      `the change to ${unmapped.id} was refused, so it waits until the row changes in Marfa: Todoist took the create without naming the task it made`,
    );
    expect(marfa.agreements.get(unmapped.id)?.waiting).toBe(true);
  });

  it("records a link another row carries, naming both rows, and leaves the task Todoist made", async () => {
    todoist.put(todoist.task("seed"));
    // The stub names its next task made-1, which a row already carries.
    const holder = personsRow({
      title: "Holder",
      status: "pending",
      todoist_id: "made-1",
    });
    const taken = personsRow({ title: "Taken", status: "pending" });
    await landed();
    expect(marfa.byId(taken.id).properties["todoist_id"]).toBeUndefined();
    expect(summary()).toContain(
      `the link made-1 is already carried by ${holder.id}, so it is not written onto ${taken.id}`,
    );
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
  });
});

describe("a row Todoist knows", () => {
  it("sends only the fields that changed, a cleared description as empty and a lost due date as null", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      title: "Task a, renamed",
      description: "Now with details",
      priority: "urgent",
      due_at: "2026-09-30T23:00:00.000Z",
      precision: "day",
    });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      {
        id: "a",
        content: "Task a, renamed",
        description: "Now with details",
        priority: 4,
        due: { date: "2026-10-01" },
      },
    ]);
    expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed");
    expect(todoist.tasks.get("a")?.priority).toBe(4);

    const current = marfa.byId(row.id);
    const { description, due_at, precision, ...rest } = current.properties;
    expect(description).toBe("Now with details");
    expect(due_at).toBe("2026-09-30T23:00:00.000Z");
    expect(precision).toBe("day");
    marfa.rewrite(`${todoist.account}:a`, rest);
    await landed();
    expect(todoist.commands("item_update").at(-1)?.args).toEqual({
      id: "a",
      description: "",
      due: null,
    });
    expect(todoist.tasks.get("a")?.due).toBeNull();
  });

  it("closes a task the row completes, and reopens one the row reopens", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    expect(todoist.commands("item_close").map((c) => c.args)).toEqual([
      { id: "a" },
    ]);
    expect(todoist.tasks.get("a")?.checked).toBe(true);

    // Todoist's task door answers a completed task, checked, so the reopen
    // is sent on the read like any other change.
    const { completed_at, ...reopened } = marfa.byId(row.id).properties;
    expect(completed_at).toBeDefined();
    marfa.rewrite(`${todoist.account}:a`, { ...reopened, status: "pending" });
    await landed();
    expect(todoist.commands("item_uncomplete").map((c) => c.args)).toEqual([
      { id: "a" },
    ]);
    expect(todoist.tasks.get("a")?.checked).toBe(false);
    expect(todoist.commands("item_update")).toEqual([]);
  });

  it("deletes the task when the row is trashed, and carries nothing when it is archived", async () => {
    const a = await synced("a");
    const b = await synced("b");
    marfa.trash(a.id);
    marfa.transition(b.id, "archived");
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_delete", "a"],
    ]);
    expect(todoist.tasks.get("a")?.is_deleted).toBe(true);
    expect(todoist.tasks.get("b")?.is_deleted).toBe(false);
  });

  it("deletes a recurring task when the row is trashed, where closing it would move it to its next occurrence", async () => {
    todoist.put(
      todoist.task("r", {
        due: { date: "2026-09-27", is_recurring: true, string: "every day" },
      }),
    );
    await landed();
    const row = marfa.row(`${todoist.account}:r`);
    marfa.trash(row.id);
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_delete", "r"],
    ]);
    expect(todoist.tasks.get("r")?.is_deleted).toBe(true);
    expect(marfa.byId(row.id).state).toBe("trashed");
  });

  it("sends nothing when the task already matches the row", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a" });
    await landed();
    expect(
      todoist.received.filter((r) => /^\/api\/v1\/tasks\/[^/]+$/.test(r.path)),
    ).toHaveLength(0);
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toMatch(/pushed 0, own 2, conflicts 0/);
  });

  it("names a task Todoist no longer has as a condition, and the run lands", async () => {
    const row = await synced("a");
    todoist.tasks.delete("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    await landed();
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toContain(
      `Todoist no longer has task a for row ${row.id}`,
    );
  });
});

describe("an echo", () => {
  it("is not carried back: a push then a sync moves nothing, and a sync's write is read as the connector's own", async () => {
    todoist.put(todoist.task("seed"));
    const row = personsRow({ title: "Made in Marfa", status: "pending" });
    await landed();
    expect(marfa.byId(row.id).properties["todoist_id"]).toBe("made-1");
    expect(marfa.byId(row.id).properties["url"]).toBe(
      "https://app.todoist.com/app/task/made-1",
    );
    expect(marfa.byId(row.id).properties["title"]).toBe("Made in Marfa");
    expect(marfa.byId(row.id).version).toBe(3);
    expect(summary()).toMatch(
      /^created 1, updated 1, .*pushed 1, own 0, conflicts 0/,
    );

    await landed();
    expect(marfa.byId(row.id).version).toBe(3);
    expect(todoist.commands()).toHaveLength(1);
    expect(summary()).toMatch(/pushed 0, own 2, conflicts 0/);

    await landed();
    expect(marfa.byId(row.id).version).toBe(3);
    expect(todoist.commands()).toHaveLength(1);
    expect(summary()).toMatch(/pushed 0, own 0, conflicts 0/);
  });
});

describe("a conflict", () => {
  it("is won by Marfa when its change is later, and the row's value is carried to Todoist", async () => {
    const row = await synced("a");
    todoist.now = "2026-09-24T12:00:00.000000Z";
    todoist.edit("a", { content: "Task a, from Todoist" });
    marfa.edit(row.id, { title: "Task a, from Marfa" });
    await landed();
    expect(marfa.byId(row.id).properties["title"]).toBe("Task a, from Marfa");
    expect(todoist.tasks.get("a")?.content).toBe("Task a, from Marfa");
    expect(summary()).toMatch(/conflicts 1/);
    expect(summary()).toContain(
      `the change made in Marfa to title on ${row.id} is the later one, so the vendor's is not written and Marfa's is carried back`,
    );
  });

  it("is won by Todoist when its change is later, and nothing is carried back", async () => {
    const row = await synced("a");
    todoist.now = "2026-09-26T12:00:00.000000Z";
    todoist.edit("a", { content: "Task a, from Todoist" });
    marfa.edit(row.id, { title: "Task a, from Marfa" });
    await landed();
    expect(marfa.byId(row.id).properties["title"]).toBe("Task a, from Todoist");
    expect(todoist.tasks.get("a")?.content).toBe("Task a, from Todoist");
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toMatch(/pushed 0, own 1, conflicts 1/);
    expect(summary()).toContain(
      `the vendor's change to title on ${row.id} is the later one, so the change made in Marfa is not carried back`,
    );
  });
});

describe("a restore of a row whose task Todoist still has", () => {
  it("carries nothing over a later change in Todoist", async () => {
    const row = await synced("a");
    marfa.transition(row.id, "archived");
    await landed();
    marfa.transition(row.id, "active");
    todoist.now = "2026-09-26T12:00:00.000000Z";
    todoist.edit("a", { content: "Task a, later in Todoist" });
    await landed();
    expect(todoist.commands()).toEqual([]);
    expect(todoist.tasks.get("a")?.content).toBe("Task a, later in Todoist");
    expect(marfa.byId(row.id).properties["title"]).toBe(
      "Task a, later in Todoist",
    );
    expect(marfa.byId(row.id).state).toBe("active");
  });

  it("is decided by the conflict rule with an edit made with it, so a later change in Todoist wins", async () => {
    const row = await synced("a");
    marfa.transition(row.id, "archived");
    await landed();
    marfa.transition(row.id, "active");
    marfa.edit(row.id, { title: "Task a, back from Marfa" });
    todoist.now = "2026-09-26T12:00:00.000000Z";
    todoist.edit("a", { content: "Task a, later in Todoist" });
    await landed();
    expect(todoist.commands("item_add")).toEqual([]);
    expect(todoist.commands("item_update")).toEqual([]);
    expect(todoist.tasks.get("a")?.content).toBe("Task a, later in Todoist");
    expect(marfa.byId(row.id).properties["title"]).toBe(
      "Task a, later in Todoist",
    );
    expect(marfa.byId(row.id).state).toBe("active");
    expect(summary()).toMatch(/conflicts 1/);
  });
});

describe("Todoist's answers", () => {
  it("waits as a 429 asks and sends the command again", async () => {
    todoist.put(todoist.task("seed"));
    personsRow({ title: "Patient", status: "pending" });
    todoist.refuseNext(429, {
      headers: { "Retry-After": "1" },
      when: (request) => request.commands !== undefined,
    });
    await landed();
    expect(todoist.commands("item_add")).toHaveLength(2);
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
  });

  it("tries again after a server error", async () => {
    todoist.put(todoist.task("seed"));
    personsRow({ title: "Patient", status: "pending" });
    todoist.refuseNext(503, {
      when: (request) => request.commands !== undefined,
    });
    await landed();
    expect(todoist.commands("item_add")).toHaveLength(2);
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
  });

  it("fails the run when the token is refused on a push, and never prints it", async () => {
    todoist.put(todoist.task("seed"));
    personsRow({ title: "Refused", status: "pending" });
    todoist.refuseNext(401, {
      when: (request) => request.commands !== undefined,
    });
    const { code, output } = await once();
    expect(code).not.toBe(0);
    expect(output).toContain("Todoist refused the token: 401");
    expect(output).not.toContain(token);
    expect(marfa.runs.at(-1)?.outcome).toBe("failed");
    expect(JSON.stringify(marfa.runs)).not.toContain(token);
  });

  it("keeps an edit Todoist refused, unsent and not taken back by the next read, until the row changes", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.scriptCommand("item_update", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refused updating task a: Invalid argument value (20)`,
    );
    expect(todoist.tasks.get("a")?.content).toBe("Task a");
    todoist.edit("a", { description: "Edited in Todoist" });
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(1);
    expect(marfa.byId(row.id).properties).toMatchObject({
      title: "Task a, renamed",
      description: "Edited in Todoist",
    });
    expect(summary()).not.toContain("conflicts 1");
    marfa.edit(row.id, { title: "Task a, renamed again" });
    await landed();
    expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed again");
    expect(marfa.states.get("todoist")?.["conditions"]).toEqual({});
  });

  it("keeps a trash Todoist refused, and deletes on the next run one it put off", async () => {
    const row = await synced("a");
    const other = await synced("b");
    marfa.trash(row.id);
    marfa.trash(other.id);
    todoist.scriptCommand(
      "item_delete",
      {
        error_code: 1,
        error: "Too many requests",
        http_code: 429,
        error_extra: { retry_after: 0 },
      },
      6,
    );
    await landed();
    expect(todoist.tasks.get("a")?.is_deleted).toBe(false);
    expect(summary()).toContain(
      "change waits: Todoist is not taking changes for now",
    );
    await landed();
    expect(todoist.tasks.get("a")?.is_deleted).toBe(true);
    expect(todoist.tasks.get("b")?.is_deleted).toBe(true);

    const third = await synced("c");
    marfa.trash(third.id);
    todoist.scriptCommand("item_delete", {
      error_code: 39,
      error: "Insufficient permissions",
      http_code: 403,
    });
    await landed();
    expect(todoist.tasks.get("c")?.is_deleted).toBe(false);
    expect(summary()).toContain(
      `the change to ${third.id} was refused, so it waits until the row changes in Marfa: Todoist refused deleting task c: Insufficient permissions (39)`,
    );
    expect(marfa.agreements.get(third.id)?.waiting).toBe(true);
  });
});

describe("the connector's state", () => {
  it("is kept on the instance beside each row's agreement", async () => {
    const row = await synced("a");
    const kept = (): Record<string, unknown> =>
      marfa.states.get("todoist") ?? {};
    expect(kept()["state"]).toMatchObject({ timezone: "Europe/London" });
    expect(kept()["cursor"]).toBe("0");
    expect(marfa.agreements.get(row.id)).toMatchObject({
      waiting: false,
      record: { state: "active", link: "a" },
    });
    await landed();
    expect(kept()["cursor"]).toBe(String(marfa.head));
  });
});

describe("transitions over runs", () => {
  it("changes nothing more in Todoist when a trashed row is purged", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    marfa.purgeById(row.id);
    await landed();
    const deletes = todoist.commands("item_delete");
    expect(deletes.map((c) => c.args["id"])).toEqual(["a", "a"]);
    expect(deletes[0]?.uuid).toBe(deletes[1]?.uuid);
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_delete",
      "item_delete",
    ]);
    expect(todoist.tasks.get("a")?.is_deleted).toBe(true);
  });

  it("deletes the task when a trash and a purge reach the connector together", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    marfa.purgeById(row.id);
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_delete", "a"],
    ]);
    expect(todoist.tasks.get("a")?.is_deleted).toBe(true);
  });

  it("recreates the task when the row is restored after its trash deleted it, and links the row to it", async () => {
    const row = await synced("a", "Task a to come back");
    marfa.trash(row.id);
    await landed();
    expect(todoist.tasks.get("a")?.is_deleted).toBe(true);
    marfa.restore(row.id);
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_delete", "a"],
      ["item_add", undefined],
    ]);
    expect(todoist.commands("item_add")[0]?.args["content"]).toBe(
      "Task a to come back",
    );
    const madeId = [...todoist.tasks.keys()].find((id) =>
      id.startsWith("made-"),
    );
    expect(madeId).toBeDefined();
    expect(todoist.tasks.get(madeId ?? "")?.is_deleted).toBe(false);
    expect(marfa.byId(row.id).properties["todoist_id"]).toBe(madeId);
    expect(marfa.byId(row.id).state).toBe("active");
    expect(summary()).toMatch(/conflicts 0/);

    await landed();
    expect(todoist.commands()).toHaveLength(2);
    expect(marfa.byId(row.id).state).toBe("active");
    expect(marfa.byId(row.id).properties["todoist_id"]).toBe(madeId);
  });

  it("makes one task and keeps one row when a run fails between making the task again and linking it", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    marfa.refuseNext(`PATCH /items/${row.id}`, 503, "unavailable");
    expect((await once()).code).not.toBe(0);
    await landed();
    const rows = marfa.rows.filter((r) => r.type === "todoist.task");
    expect(rows.map((r) => r.id)).toEqual([row.id]);
    const live = [...todoist.tasks.values()].filter((t) => !t.is_deleted);
    expect(live).toHaveLength(1);
    expect(marfa.byId(row.id).properties["todoist_id"]).toBe(live[0]?.id);
    expect(marfa.byId(row.id).state).toBe("active");
  });

  it("deletes a parent's subtasks with it, as Todoist does, and their rows are archived", async () => {
    todoist.put(todoist.task("p", { content: "Parent" }));
    todoist.put(todoist.task("c", { content: "Child", parent_id: "p" }));
    await landed();
    const parent = marfa.row(`${todoist.account}:p`);
    marfa.trash(parent.id);
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_delete", "p"],
    ]);
    expect(todoist.tasks.get("c")?.is_deleted).toBe(true);
    await landed();
    expect(marfa.row(`${todoist.account}:c`).state).toBe("archived");
    expect(marfa.byId(parent.id).state).toBe("trashed");
  });

  it("takes a task Todoist does not have as deleted, with no condition", async () => {
    const row = await synced("a");
    todoist.tasks.delete("a");
    marfa.trash(row.id);
    await landed();
    expect(todoist.commands("item_delete").map((c) => c.args["id"])).toEqual([
      "a",
    ]);
    expect(summary()).not.toContain("refused");
  });

  it("makes the task again when an archived row is brought back after Todoist deleted it", async () => {
    const row = await synced("a");
    todoist.delete("a");
    await landed();
    expect(marfa.byId(row.id).state).toBe("archived");
    marfa.transition(row.id, "active");
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual(["item_add"]);
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(madeId).not.toBe("a");
    expect(todoist.tasks.get(madeId)?.is_deleted).toBe(false);
  });

  it("never links a restored row to a task Todoist refused to make, and makes it once the row changes", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    todoist.tasks.delete("a");
    marfa.restore(row.id);
    todoist.scriptCommand(
      "item_add",
      {
        error_code: 20,
        error: "Invalid argument value",
        http_code: 400,
      },
      2,
    );
    await landed();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refused creating a task: Invalid argument value (20)`,
    );
    expect(marfa.agreements.get(row.id)?.record["state"]).toBe("trashed");
    await landed();
    expect(todoist.commands("item_add")).toHaveLength(2);
    marfa.edit(row.id, { title: "Task a, back" });
    await landed();
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(madeId).not.toBe("a");
    expect(todoist.tasks.get(madeId)?.content).toBe("Task a, back");
    expect(marfa.agreements.get(row.id)?.record["state"]).toBe("active");
  });

  it("makes the task again in the Inbox when its project is gone", async () => {
    todoist.projects = new Set(["inbox"]);
    todoist.put(todoist.task("a", { content: "Orphaned", project_id: "gone" }));
    await landed();
    const row = marfa.row(`${todoist.account}:a`);
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    const adds = todoist.commands("item_add");
    expect(adds.map((c) => c.args["project_id"])).toEqual(["gone", undefined]);
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(todoist.tasks.get(madeId)?.project_id).toBe("inbox");
    expect(summary()).not.toContain("refused");
  });

  it("makes the task again when the row is restored and then edited before the next run", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    marfa.edit(row.id, { title: "Task a, back and edited" });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_delete",
      "item_add",
    ]);
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(todoist.tasks.get(madeId)?.content).toBe("Task a, back and edited");
    expect(marfa.byId(row.id).state).toBe("active");
    await landed();
    expect(marfa.byId(row.id).state).toBe("active");
  });

  it("makes the task again, closed, when the row is restored and then completed before the next run", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_delete",
      "item_add",
      "item_close",
    ]);
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(todoist.tasks.get(madeId)?.checked).toBe(true);
  });

  it("recreates the task in its project and section, with its labels", async () => {
    todoist.put(
      todoist.task("a", {
        content: "Filed away",
        project_id: "p-work",
        section_id: "s-later",
        labels: ["Home"],
      }),
    );
    await landed();
    const row = marfa.row(`${todoist.account}:a`);
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    const add = todoist.commands("item_add")[0];
    expect(add?.args).toMatchObject({
      content: "Filed away",
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
    });
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(todoist.tasks.get(madeId)).toMatchObject({
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
    });
  });

  it("recreates a completed row's task closed", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_delete",
      "item_add",
      "item_close",
    ]);
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(todoist.tasks.get(madeId)?.checked).toBe(true);
  });

  it("recreates a task again after a second trash and restore, as a create of its own", async () => {
    const row = await synced("a");
    for (let round = 0; round < 2; round += 1) {
      marfa.trash(row.id);
      await landed();
      marfa.restore(row.id);
      await landed();
    }
    const adds = todoist.commands("item_add");
    expect(adds).toHaveLength(2);
    expect(adds[0]?.uuid).not.toBe(adds[1]?.uuid);
    const live = [...todoist.tasks.values()].filter((t) => !t.is_deleted);
    expect(live.map((t) => t.id)).toEqual([
      String(marfa.byId(row.id).properties["todoist_id"]),
    ]);
  });

  it("reopens the task when the row is restored after a completion, not a trash", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    marfa.edit(row.id, { status: "pending", completed_at: null });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_uncomplete",
    ]);
    expect(todoist.tasks.get("a")?.checked).toBe(false);
  });

  it("sends a second trash as a command of its own, since it deletes the task the restore made", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    marfa.trash(row.id);
    await landed();
    const deletes = todoist.commands("item_delete");
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.uuid).not.toBe(deletes[1]?.uuid);
    expect(deletes.map((c) => c.args["id"])).toEqual([
      "a",
      marfa.byId(row.id).properties["todoist_id"],
    ]);
    expect(marfa.byId(row.id).state).toBe("trashed");
  });

  it("carries an edit to a completed row, since Todoist answers the completed task, and names one whose task is gone", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    marfa.edit(row.id, { title: "Task a, edited after completion" });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_update",
    ]);
    expect(todoist.tasks.get("a")?.content).toBe(
      "Task a, edited after completion",
    );
    expect(todoist.tasks.get("a")?.checked).toBe(true);

    todoist.tasks.delete("a");
    marfa.edit(row.id, { title: "Task a, edited again" });
    await landed();
    expect(todoist.commands()).toHaveLength(2);
    expect(summary()).toContain(
      `Todoist no longer has task a for row ${row.id}`,
    );
  });
});

describe("Todoist's answers, continued", () => {
  it("waits as a command's own refusal asks and sends the command again", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.scriptCommand("item_update", {
      error_code: 35,
      error: "Too many requests",
      http_code: 429,
      error_extra: { retry_after: 1 },
    });
    await landed();
    const updates = todoist.commands("item_update");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.uuid).toBe(updates[0]?.uuid);
    const sends = todoist.received.filter((r) =>
      r.commands?.some((c) => c.type === "item_update"),
    );
    expect((sends[1]?.at ?? 0) - (sends[0]?.at ?? 0)).toBeGreaterThanOrEqual(
      950,
    );
    expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed");
    expect(summary()).toMatch(/conflicts 0/);
    expect(summary()).not.toContain("refused");
  });

  it("waits as a 429 naming its wait in the body asks", async () => {
    todoist.put(todoist.task("seed"));
    personsRow({ title: "Patient", status: "pending" });
    todoist.refuseNext(429, {
      body: { error: "Too many requests", error_extra: { retry_after: 1 } },
      when: (request) => request.commands !== undefined,
    });
    await landed();
    expect(todoist.commands("item_add")).toHaveLength(2);
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
  });

  it("keeps a create through a server error past three more tries, and makes it on the next run", async () => {
    todoist.put(todoist.task("seed"));
    const unlucky = personsRow({ title: "Unlucky", status: "pending" });
    for (let i = 0; i < 4; i += 1) {
      todoist.refuseNext(503, {
        when: (request) => request.commands !== undefined,
      });
    }
    await landed();
    expect(summary()).toContain(
      "1 change waits: Todoist is not taking changes for now: Todoist answered 503 to a request tried 4 times",
    );
    expect(todoist.commands("item_add")).toHaveLength(4);
    expect([...todoist.tasks.keys()]).toEqual(["seed"]);
    await landed();
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
    expect(marfa.byId(unlucky.id).properties["todoist_id"]).toBe("made-1");
  }, 20_000);

  it("keeps an edit to a task the token cannot reach, unsent until the row changes, and the run lands", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.refuseNext(403, {
      body: { error: "Forbidden" },
      when: (request) => request.method === "GET",
    });
    await landed();
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refuses access to task a`,
    );
    const asked = todoist.received.length;
    await landed();
    expect(
      todoist.received
        .slice(asked)
        .filter((request) => request.path === "/api/v1/tasks/a"),
    ).toEqual([]);
    expect(marfa.byId(row.id).properties["title"]).toBe("Task a, renamed");
    marfa.edit(row.id, { title: "Task a, renamed again" });
    await landed();
    expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed again");
  });

  it("does not send a refused command again on the wait it names, unless the refusal is a rate limit", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.scriptCommand(
      "item_update",
      {
        error_code: 22,
        error: "Item not found",
        http_code: 400,
        error_extra: { retry_after: 1 },
      },
      10,
    );
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(1);
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refused updating task a: Item not found (22)`,
    );
  });

  it("keeps an edit through a rate limit that holds past every resend, and sends it on the next run", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
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
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(6);
    expect(summary()).toContain(
      "1 change waits: Todoist is not taking changes for now: Too many requests (35)",
    );
    expect(todoist.tasks.get("a")?.content).toBe("Task a");
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(7);
    expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed");
    expect(marfa.byId(row.id).properties["title"]).toBe("Task a, renamed");
  });

  it("waits at least the second a 429 or a server error asks for, and keeps a change whose wait is longer than a run holds", async () => {
    todoist.put(todoist.task("seed"));
    personsRow({ title: "Patient", status: "pending" });
    todoist.refuseNext(429, {
      headers: { "Retry-After": "1" },
      when: (request) => request.commands !== undefined,
    });
    await landed();
    const sends = todoist.received.filter((r) => r.commands !== undefined);
    expect(sends).toHaveLength(2);
    expect((sends[1]?.at ?? 0) - (sends[0]?.at ?? 0)).toBeGreaterThanOrEqual(
      950,
    );

    personsRow({ title: "Patient too", status: "pending" });
    todoist.refuseNext(503, {
      when: (request) => request.commands !== undefined,
    });
    await landed();
    const later = todoist.received.filter((r) => r.commands !== undefined);
    expect(later).toHaveLength(4);
    expect((later[3]?.at ?? 0) - (later[2]?.at ?? 0)).toBeGreaterThanOrEqual(
      950,
    );

    const patient = personsRow({ title: "Too patient", status: "pending" });
    todoist.refuseNext(429, {
      headers: { "Retry-After": "120" },
      when: (request) => request.commands !== undefined,
    });
    await landed();
    expect(summary()).toContain("a wait of 120s, longer than a run holds");
    expect(marfa.byId(patient.id).properties["todoist_id"]).toBeUndefined();
    await landed();
    expect(marfa.byId(patient.id).properties["todoist_id"]).toBe("made-3");
  });

  it("records a create Todoist refused, and a command it did not answer", async () => {
    todoist.put(todoist.task("seed"));
    const refused = personsRow({ title: "Refused", status: "pending" });
    todoist.scriptCommand("item_add", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    expect(marfa.byId(refused.id).properties["todoist_id"]).toBeUndefined();
    expect(summary()).toContain(
      `the change to ${refused.id} was refused, so it waits until the row changes in Marfa: Todoist refused creating a task: Invalid argument value (20)`,
    );

    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.answerNothing("item_update");
    await landed();
    expect(summary()).toContain(
      "1 change waits: Todoist is not taking changes for now: no answer for the command",
    );
    await landed();
    expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed");
    expect(todoist.commands("item_add")).toHaveLength(1);
  });
});

describe("one change, two commands", () => {
  it("sends an edit and a completion made in one change as two commands with their own ids", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      title: "Task a, done and renamed",
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    const sent = todoist.commands();
    expect(sent.map((c) => c.type)).toEqual(["item_update", "item_close"]);
    expect(sent[0]?.uuid).not.toBe(sent[1]?.uuid);
    expect(todoist.tasks.get("a")?.content).toBe("Task a, done and renamed");
    expect(todoist.tasks.get("a")?.checked).toBe(true);
  });

  it("sends a reopen and the edit made with it", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    marfa.edit(row.id, {
      title: "Task a, back and renamed",
      status: "pending",
      completed_at: null,
    });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_update",
      "item_uncomplete",
    ]);
    expect(todoist.tasks.get("a")?.checked).toBe(false);
    expect(todoist.tasks.get("a")?.content).toBe("Task a, back and renamed");
  });

  it("carries an edit made after a failed create when the create is sent again, and makes one task", async () => {
    todoist.put(todoist.task("seed"));
    const one = personsRow({ title: "One", status: "pending" });
    marfa.refuseNext(`PATCH /items/${one.id}`, 503, "unavailable");
    expect((await once()).code).not.toBe(0);
    marfa.edit(one.id, { title: "One, edited before the replay" });
    await landed();
    const adds = todoist.commands("item_add");
    expect(adds).toHaveLength(2);
    expect(adds[1]?.uuid).toBe(adds[0]?.uuid);
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);
    expect(marfa.byId(one.id).properties["todoist_id"]).toBe("made-1");
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      { id: "made-1", content: "One, edited before the replay" },
    ]);
    expect(todoist.tasks.get("made-1")?.content).toBe(
      "One, edited before the replay",
    );
  });
});

describe("the account's zone", () => {
  it("is held from the sync, so a later create asks Todoist for nothing", async () => {
    todoist.put(todoist.task("seed"));
    await landed();
    personsRow({
      title: "Whole day",
      status: "pending",
      due_at: "2026-09-29T23:00:00.000Z",
      precision: "day",
    });
    const before = todoist.received.length;
    await landed();
    const since = todoist.received.slice(before);
    expect(since.filter((r) => r.syncToken === "*")).toEqual([]);
    expect(todoist.commands("item_add").at(-1)?.args["due"]).toEqual({
      date: "2026-09-30",
    });
  });

  it("is not kept by the carry, so the sync still reads every whole-day date anew when it first learns the zone", async () => {
    todoist.timezone = null;
    todoist.put(
      todoist.task("a", { content: "Whole day", due: { date: "2026-09-30" } }),
    );
    await landed();
    const row = marfa.row(`${todoist.account}:a`);
    expect(row.properties["due_at"]).toBe("2026-09-30T00:00:00.000Z");
    expect(summary()).toContain("named no timezone");

    todoist.renameZone("Europe/London");
    personsRow({
      title: "Made",
      status: "pending",
      due_at: "2026-09-29T23:00:00.000Z",
      precision: "day",
    });
    await landed();
    expect(todoist.commands("item_add").at(-1)?.args["due"]).toEqual({
      date: "2026-09-30",
    });
    const tokens = todoist.received
      .filter((r) => r.syncToken !== undefined)
      .map((r) => r.syncToken);
    expect(tokens.slice(-3)).toEqual(["*", "token-1", "*"]);
    expect(marfa.row(`${todoist.account}:a`).properties["due_at"]).toBe(
      "2026-09-29T23:00:00.000Z",
    );
  });

  it("raises the sync's own condition when a create finds no zone named", async () => {
    todoist.timezone = null;
    todoist.put(todoist.task("seed"));
    personsRow({
      title: "Whole day",
      status: "pending",
      due_at: "2026-09-29T23:30:00.000Z",
      precision: "day",
    });
    await landed();
    expect(todoist.commands("item_add")[0]?.args["due"]).toEqual({
      date: "2026-09-29",
    });
    const conditions = summary().split("named no timezone").length - 1;
    expect(conditions).toBe(1);
  });
});

describe("a change made in Marfa between runs", () => {
  it("reaches Todoist within a look, the task fetched alone and no sync sent", async () => {
    const row = await synced("a");
    const child = spawn(
      "node",
      [built, "--every", "1h", "--look-every", "1s"],
      {
        env: {
          PATH: process.env["PATH"],
          MARFA_URL: marfa.url,
          MARFA_KEY: marfa.key,
          TODOIST_API_TOKEN: token,
          TODOIST_API_URL: todoist.url,
        },
        stdio: "ignore",
      },
    );
    const exited = new Promise((done) => child.once("exit", done));
    try {
      const runs = marfa.runs.length;
      await eventually(() => marfa.runs.length === runs + 1);
      const syncs = todoist.received.filter((r) => r.syncToken !== undefined);
      marfa.edit(row.id, { title: "Task a, renamed" });
      await eventually(() => todoist.commands("item_update").length === 1);
      expect(todoist.tasks.get("a")?.content).toBe("Task a, renamed");
      expect(
        todoist.received.filter((r) => r.syncToken !== undefined),
      ).toHaveLength(syncs.length);
      expect(
        todoist.received.some(
          (r) => r.method === "GET" && r.path === "/api/v1/tasks/a",
        ),
      ).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });
});

async function eventually(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
