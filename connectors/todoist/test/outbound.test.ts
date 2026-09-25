import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** `todoist.task` as the connector carries it, which the scripted server answers as it was registered. */
const served = {
  id: "todoist.task",
  label: "Todoist Task",
  parent: "core.task",
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
let stateDir: string;

beforeEach(async () => {
  marfa = await new ScriptedServer("todoist").start();
  marfa.types.set("todoist.task", served);
  todoist = await new TodoistStub(token).start();
  stateDir = await mkdtemp(join(tmpdir(), "connector-todoist-outbound-"));
});

afterEach(async () => {
  // Whatever the case sent, every command carried a uuid laid out as one,
  // and no two different commands shared it.
  const sent = todoist.commands();
  for (const command of sent) expect(command.uuid).toMatch(uuidShape);
  const byUuid = new Map(sent.map((c) => [c.uuid, JSON.stringify(c)]));
  for (const command of sent) {
    expect(byUuid.get(command.uuid)).toBe(JSON.stringify(command));
  }
  await marfa.stop();
  await todoist.close();
  await rm(stateDir, { recursive: true, force: true });
});

async function once(): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        MARFA_STATE_DIR: stateDir,
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

/** A person makes a todoist.task in Marfa, under their own source. */
function personsRow(properties: Record<string, unknown>): Row {
  return marfa.insert(undefined, properties, "todoist.task", "person");
}

/** The account's task `id` synced into Marfa, and the row it made. */
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
    // Midnight of 30 September in London, at day precision, is 30 September.
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
    // The task holds the same due date as a floating noon in London.
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
  it("is created there with every travelling field, linked to the task it made, and closed if completed", async () => {
    // The account and its zone come from the first sync, before the push.
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
    // The zone was asked for once for both rows, then the run's own first
    // sync: two full syncs, not one per row.
    expect(todoist.received.filter((r) => r.syncToken === "*")).toHaveLength(2);
  });

  it("sends the same create again after a run that failed, and Todoist makes one task", async () => {
    todoist.put(todoist.task("seed"));
    const one = personsRow({ title: "One", status: "pending" });
    // Todoist makes the task, then the write of its id onto the row is
    // refused, so the run fails before the push is remembered and the
    // create is offered again next run.
    marfa.refuseNext(`PATCH /items/${one.id}`, 503, "unavailable");
    const failed = await once();
    expect(failed.code).not.toBe(0);
    expect(marfa.byId(one.id).properties["todoist_id"]).toBeUndefined();
    expect([...todoist.tasks.keys()]).toEqual(["seed", "made-1"]);

    await landed();
    const adds = todoist.commands("item_add");
    expect(adds.map((c) => c.args["content"])).toEqual(["One", "One"]);
    // The replayed create carries the uuid and temp_id of the first, and
    // Todoist answers it as it did rather than making another task.
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
    expect(summary()).toMatch(/pushed 2, own 0/);
  });

  it("records a create Todoist took without naming the task, and a link another row carries", async () => {
    todoist.put(todoist.task("seed"));
    const unmapped = personsRow({ title: "Unmapped", status: "pending" });
    todoist.scriptCommand("item_add", "ok");
    await landed();
    expect(marfa.byId(unmapped.id).properties["todoist_id"]).toBeUndefined();
    expect(summary()).toContain(`without naming the task it made`);
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
    // A whole day as its date in the account's zone: London midnight on
    // 1 October is 23:00 UTC the day before.
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

    // The row as the person leaves it, whole: no description, no due date.
    const current = marfa.byId(row.id);
    const { description, due_at, precision, ...rest } = current.properties;
    expect([description, due_at, precision]).toBeDefined();
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

    // Todoist's task door answers 404 for a completed task, so the reopen
    // is sent on that answer, and the task is read once it is open again.
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

  it("closes the task when the row is trashed, and carries nothing when it is archived", async () => {
    const a = await synced("a");
    const b = await synced("b");
    marfa.trash(a.id);
    marfa.transition(b.id, "archived");
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_close", "a"],
    ]);
    expect(todoist.tasks.get("b")?.checked).toBe(false);
  });

  it("sends nothing when the task already matches the row", async () => {
    const row = await synced("a");
    // A write that changes no value still moves the version.
    marfa.edit(row.id, { title: "Task a" });
    await landed();
    expect(todoist.received.filter((r) => r.method === "GET")).toHaveLength(1);
    expect(todoist.commands()).toEqual([]);
    // The create of the first run is read back as the connector's own.
    expect(summary()).toMatch(/pushed 1, own 1, conflicts 0/);
  });

  it("names a task Todoist no longer has as a condition, and the run lands", async () => {
    const row = await synced("a");
    // Gone from the account without a delta saying so.
    todoist.tasks.delete("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual(["item_uncomplete"]);
    expect(summary()).toContain(
      `Todoist no longer has task a for row ${row.id}`,
    );
  });
});

describe("an echo", () => {
  it("is not carried back: a push then a sync moves nothing, and a sync's write is read as the connector's own", async () => {
    todoist.put(todoist.task("seed"));
    const row = personsRow({ title: "Made in Marfa", status: "pending" });
    // The row is carried before the sync, so the same run's sync already
    // carries the task the push made, with Todoist's own fields: the row
    // is linked, then gains them.
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

    // The next run reads the seed's create and the row's two writes as
    // the connector's own, Todoist sends nothing new, and nothing goes
    // back.
    await landed();
    expect(marfa.byId(row.id).version).toBe(3);
    expect(todoist.commands()).toHaveLength(1);
    expect(summary()).toMatch(/pushed 0, own 3, conflicts 0/);

    // And the run after moves nothing either way.
    await landed();
    expect(marfa.byId(row.id).version).toBe(3);
    expect(todoist.commands()).toHaveLength(1);
    expect(summary()).toMatch(/pushed 0, own 0, conflicts 0/);
  });
});

describe("a conflict", () => {
  it("is won by Marfa when its change is later, and the row's value is carried to Todoist", async () => {
    const row = await synced("a");
    // The scripted server's clock stands on 25 September; Todoist's
    // change is stamped the day before.
    todoist.now = "2026-09-24T12:00:00.000000Z";
    todoist.edit("a", { content: "Task a, from Todoist" });
    marfa.edit(row.id, { title: "Task a, from Marfa" });
    await landed();
    expect(marfa.byId(row.id).properties["title"]).toBe("Task a, from Marfa");
    expect(todoist.tasks.get("a")?.content).toBe("Task a, from Marfa");
    expect(summary()).toMatch(/conflicts 1/);
    expect(summary()).toContain(
      `the change made in Marfa to ${row.id} is the later one, so the vendor's is not written and the row's state is carried back`,
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
      `the vendor's change to ${row.id} is the later one, so the change made in Marfa is not carried back`,
    );
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

  it("records a command Todoist refused as a condition naming the row, and the run lands", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.scriptCommand("item_update", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    expect(summary()).toContain(
      `Todoist refused updating task a for row ${row.id}: Invalid argument value (20)`,
    );
    expect(todoist.tasks.get("a")?.content).toBe("Task a");
  });
});

describe("the state file", () => {
  it("keeps the watch's cursor and memory beside the connector's state", async () => {
    const row = await synced("a");
    const stored = async (): Promise<{
      state: Record<string, unknown>;
      watch: { cursor?: string; written: Record<string, unknown> };
    }> =>
      JSON.parse(await readFile(join(stateDir, "todoist.json"), "utf8")) as {
        state: Record<string, unknown>;
        watch: { cursor?: string; written: Record<string, unknown> };
      };
    // The log is read before the run writes, so the first run's cursor
    // stands before its own create; the create is remembered as its own.
    const first = await stored();
    expect(first.state["timezone"]).toBe("Europe/London");
    expect(first.watch.cursor).toBe("0");
    expect(first.watch.written[row.id]).toEqual({
      version: 1,
      state: "active",
    });
    await landed();
    expect((await stored()).watch.cursor).toBe(String(marfa.head));
  });
});

describe("transitions over runs", () => {
  it("closes the task when the row is purged", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    marfa.purgeById(row.id);
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args["id"]])).toEqual([
      ["item_close", "a"],
    ]);
    expect(todoist.tasks.get("a")?.checked).toBe(true);
  });

  it("reopens the task when the row is restored, and the row stays open", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    expect(todoist.tasks.get("a")?.checked).toBe(true);
    // The next sync carries the task closed by the trash, stamped before
    // the restore: the echo is not written over the restored row.
    marfa.restore(row.id);
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_uncomplete",
    ]);
    expect(todoist.tasks.get("a")?.checked).toBe(false);
    expect(marfa.byId(row.id).properties["status"]).toBe("pending");
    expect(marfa.byId(row.id).state).toBe("active");
    expect(summary()).toMatch(/conflicts 0/);

    // And the run after moves nothing either way.
    await landed();
    expect(todoist.commands()).toHaveLength(2);
    expect(marfa.byId(row.id).properties["status"]).toBe("pending");
  });

  it("sends a second trash as a command of its own, since a transition moves no version", async () => {
    const row = await synced("a");
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    marfa.trash(row.id);
    await landed();
    const closes = todoist.commands("item_close");
    expect(closes).toHaveLength(2);
    expect(closes[0]?.uuid).not.toBe(closes[1]?.uuid);
    expect(todoist.tasks.get("a")?.checked).toBe(true);
    expect(marfa.byId(row.id).state).toBe("trashed");
  });

  it("names an edit to a completed row as one Todoist cannot show it", async () => {
    const row = await synced("a");
    marfa.edit(row.id, {
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    marfa.edit(row.id, { title: "Task a, edited after completion" });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual(["item_close"]);
    expect(summary()).toContain(
      `Todoist does not answer the completed task a, so a change to row ${row.id} beyond its completion is not carried`,
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

  it("gives up on a server error after three more tries, and the run fails", async () => {
    todoist.put(todoist.task("seed"));
    personsRow({ title: "Unlucky", status: "pending" });
    for (let i = 0; i < 4; i += 1) {
      todoist.refuseNext(503, {
        when: (request) => request.commands !== undefined,
      });
    }
    const { code, output } = await once();
    expect(code).not.toBe(0);
    expect(output).toContain("answered 503");
    expect(todoist.commands("item_add")).toHaveLength(4);
    expect([...todoist.tasks.keys()]).toEqual(["seed"]);
  }, 20_000);

  it("names a task the token cannot reach as a condition, and the run lands", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    todoist.refuseNext(403, {
      body: { error: "Forbidden" },
      when: (request) => request.method === "GET",
    });
    await landed();
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toContain(
      `Todoist refuses access to task a for row ${row.id}, so its changes are not carried`,
    );
  });
});
