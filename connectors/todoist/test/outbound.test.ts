import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer, type Row } from "../../../kit/test/scripted-server.js";
import { TodoistStub } from "../../../scripts/proof/todoist-stub.js";
import {
  argsOf,
  destination,
  differing,
  onlyChanged,
} from "../src/outbound.js";
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
    recurrence: { type: "string" },
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

async function once(
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stderr } = await run("node", [built, "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        TODOIST_API_TOKEN: token,
        TODOIST_API_URL: todoist.url,
        ...env,
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

async function placed(
  id: string,
  overrides: Partial<ReturnType<TodoistStub["task"]>>,
): Promise<Row> {
  todoist.put(todoist.task(id, overrides));
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

  it("compares labels as sets, reads a row without labels as none, and sends the whole list when it differs", () => {
    const rowWith = (labels?: unknown): Parameters<typeof argsOf>[0] =>
      ({
        id: "r",
        type: "todoist.task",
        version: 1,
        state: "active",
        properties: {
          title: "Buy milk",
          ...(labels !== undefined && { labels }),
        },
      }) as unknown as Parameters<typeof argsOf>[0];
    const held = todoist.task("t", {
      content: "Buy milk",
      labels: ["Home", "Errands"],
    });
    const diffOf = (row: Parameters<typeof argsOf>[0]): unknown =>
      differing(argsOf(row, "UTC"), held, "UTC");
    expect(diffOf(rowWith(["Errands", "Home"]))).toEqual({});
    expect(diffOf(rowWith(["Home"]))).toEqual({ labels: ["Home"] });
    expect(diffOf(rowWith(["Home", "Errands", "New"]))).toEqual({
      labels: ["Home", "Errands", "New"],
    });
    expect(diffOf(rowWith())).toEqual({ labels: [] });
    expect(
      differing(
        argsOf(rowWith(), "UTC"),
        todoist.task("u", { content: "Buy milk" }),
        "UTC",
      ),
    ).toEqual({});
  });

  it("leaves a field the row did not change out of what is sent, so a task keeps what Todoist holds", () => {
    const diff = { content: "Renamed", labels: ["Home"], recurrence: null };
    expect(
      onlyChanged(diff, new Set(["title", "labels", "recurrence"])),
    ).toEqual(diff);
    expect(onlyChanged(diff, new Set(["title"]))).toEqual({
      content: "Renamed",
    });
  });

  it("compares a recurrence with Todoist's own words for a recurring due, and reads a row without one as none", () => {
    const rowWith = (recurrence?: unknown): Parameters<typeof argsOf>[0] =>
      ({
        id: "r",
        type: "todoist.task",
        version: 1,
        state: "active",
        properties: {
          title: "Water the plants",
          due_at: "2026-10-05T00:00:00.000Z",
          precision: "day",
          ...(recurrence !== undefined && { recurrence }),
        },
      }) as unknown as Parameters<typeof argsOf>[0];
    const repeating = todoist.task("t", {
      content: "Water the plants",
      due: {
        date: "2026-10-05",
        string: "every day",
        lang: "en",
        is_recurring: true,
      },
    });
    const once = todoist.task("u", {
      content: "Water the plants",
      due: {
        date: "2026-10-05",
        string: "every day",
        lang: "en",
        is_recurring: false,
      },
    });
    const diffOf = (
      row: Parameters<typeof argsOf>[0],
      task: ReturnType<TodoistStub["task"]>,
    ): unknown => differing(argsOf(row, "UTC"), task, "UTC");
    expect(argsOf(rowWith("every day"), "UTC").recurrence).toBe("every day");
    expect(argsOf(rowWith(""), "UTC")).not.toHaveProperty("recurrence");
    expect(diffOf(rowWith("every day"), repeating)).toEqual({});
    expect(diffOf(rowWith("every week"), repeating)).toEqual({
      recurrence: "every week",
    });
    expect(diffOf(rowWith(), repeating)).toEqual({ recurrence: null });
    expect(diffOf(rowWith("every day"), once)).toEqual({
      recurrence: "every day",
    });
    expect(diffOf(rowWith(), once)).toEqual({});
  });

  it("names one destination for a move: the section when it changed and is set, else the project, and the project's root for a cleared section", () => {
    const row = (
      properties: Record<string, unknown>,
    ): Parameters<typeof argsOf>[0] =>
      ({
        id: "r",
        type: "todoist.task",
        version: 1,
        state: "active",
        properties: { title: "T", ...properties },
      }) as unknown as Parameters<typeof argsOf>[0];
    const task = todoist.task("t", {
      project_id: "p-work",
      section_id: "s-later",
    });
    const move = (
      properties: Record<string, unknown>,
      ...changed: string[]
    ): unknown => destination(row(properties), task, new Set(changed));

    expect(
      move(
        { project_id: "p-home", section_id: "s-home" },
        "project_id",
        "section_id",
      ),
    ).toEqual({ section_id: "s-home" });
    expect(
      move({ project_id: "p-home", section_id: "s-later" }, "project_id"),
    ).toEqual({
      project_id: "p-home",
    });
    expect(move({ project_id: "p-work" }, "section_id")).toEqual({
      project_id: "p-work",
    });
    expect(move({ project_id: "p-other" }, "section_id")).toEqual({
      project_id: "p-work",
    });
    expect(move({}, "section_id")).toEqual({ project_id: "p-work" });
    // A project changed to none and a section cleared agree with a section
    // cleared alone: the task goes to the root of the project it is in.
    expect(move({}, "project_id", "section_id")).toEqual({
      project_id: "p-work",
    });
    expect(move({ project_id: "p-work" }, "project_id", "section_id")).toEqual({
      project_id: "p-work",
    });
    // Already where the row says, or the row names no project, or nothing
    // about the placing changed: no command.
    expect(
      move(
        { project_id: "p-work", section_id: "s-later" },
        "section_id",
        "project_id",
      ),
    ).toBeUndefined();
    expect(move({ section_id: "s-later" }, "project_id")).toBeUndefined();
    expect(move({}, "project_id")).toBeUndefined();
    expect(
      move({ project_id: "p-other", section_id: "s-other" }, "title"),
    ).toBeUndefined();
    expect(
      destination(
        row({ project_id: "p-work" }),
        todoist.task("u"),
        new Set(["section_id"]),
      ),
    ).toBeUndefined();
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

  it("refuses an edit to a task Todoist answers 404 for, leaves the row active, and the run lands", async () => {
    const row = await synced("a");
    todoist.tasks.delete("a");
    marfa.edit(row.id, { title: "Task a, renamed" });
    await landed();
    expect(todoist.commands()).toEqual([]);
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist does not answer task a for this token`,
    );
    expect(marfa.byId(row.id).state).toBe("active");
  });

  it("moves a recurring task's due date by its recurrence and the new date, so it stays recurring", async () => {
    todoist.put(
      todoist.task("r", {
        due: {
          date: "2026-10-01",
          string: "every day",
          lang: "en",
          is_recurring: true,
          timezone: null,
        },
      }),
      todoist.task("t", {
        due: {
          date: "2026-10-01T10:00:00",
          string: "every day at 10:00",
          lang: "en",
          is_recurring: true,
          timezone: null,
        },
      }),
    );
    await landed();
    const daily = marfa.row(`${todoist.account}:r`);
    const timed = marfa.row(`${todoist.account}:t`);
    marfa.edit(daily.id, {
      due_at: "2026-10-04T23:00:00.000Z",
      precision: "day",
    });
    marfa.edit(timed.id, {
      due_at: "2026-10-05T09:00:00.000Z",
      precision: "time",
    });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      { id: "r", due: { string: "every day", lang: "en", date: "2026-10-05" } },
      {
        id: "t",
        due: {
          string: "every day at 10:00",
          lang: "en",
          date: "2026-10-05T10:00:00",
        },
      },
    ]);
    expect(todoist.tasks.get("r")?.due).toMatchObject({
      date: "2026-10-05",
      string: "every day",
      is_recurring: true,
    });
    expect(todoist.tasks.get("t")?.due).toMatchObject({
      date: "2026-10-05T10:00:00",
      is_recurring: true,
      timezone: null,
    });
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(2);
  });
});

describe("a due date moved in Marfa", () => {
  it("keeps a fixed time in the task's own zone, recurring or not", async () => {
    const inZone = {
      date: "2026-10-01T14:00:00Z",
      lang: "en",
      timezone: "America/New_York",
    };
    todoist.put(
      todoist.task("r", {
        due: { ...inZone, string: "every day at 10:00", is_recurring: true },
      }),
      todoist.task("o", {
        due: { ...inZone, string: "Oct 1 10:00", is_recurring: false },
      }),
    );
    await landed();
    for (const id of ["r", "o"]) {
      marfa.edit(marfa.row(`${todoist.account}:${id}`).id, {
        due_at: "2026-10-12T14:00:00.000Z",
        precision: "time",
      });
    }
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      {
        id: "r",
        due: {
          string: "every day at 10:00",
          lang: "en",
          date: "2026-10-12T14:00:00Z",
          timezone: "America/New_York",
        },
      },
      {
        id: "o",
        due: { date: "2026-10-12T14:00:00Z", timezone: "America/New_York" },
      },
    ]);
    for (const id of ["r", "o"]) {
      expect(todoist.tasks.get(id)?.due).toMatchObject({
        date: "2026-10-12T14:00:00Z",
        timezone: "America/New_York",
      });
    }
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(2);
  });

  it("moves a recurring task between a whole day and a time, as Todoist keeps the date sent", async () => {
    todoist.put(
      todoist.task("d", {
        due: {
          date: "2026-10-01",
          string: "every day",
          lang: "en",
          is_recurring: true,
          timezone: null,
        },
      }),
      todoist.task("t", {
        due: {
          date: "2026-10-01T10:00:00",
          string: "every day at 10:00",
          lang: "en",
          is_recurring: true,
          timezone: null,
        },
      }),
    );
    await landed();
    marfa.edit(marfa.row(`${todoist.account}:d`).id, {
      due_at: "2026-10-12T08:00:00.000Z",
      precision: "time",
    });
    marfa.edit(marfa.row(`${todoist.account}:t`).id, {
      due_at: "2026-10-11T23:00:00.000Z",
      precision: "day",
    });
    await landed();
    expect(todoist.tasks.get("d")?.due).toMatchObject({
      date: "2026-10-12T08:00:00Z",
      string: "every day",
      is_recurring: true,
    });
    expect(todoist.tasks.get("t")?.due).toMatchObject({
      date: "2026-10-12",
      string: "every day at 10:00",
      is_recurring: true,
    });
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(2);
    expect(marfa.row(`${todoist.account}:d`).properties).toMatchObject({
      due_at: "2026-10-12T08:00:00.000Z",
      precision: "time",
    });
    expect(marfa.row(`${todoist.account}:t`).properties).toMatchObject({
      due_at: "2026-10-11T23:00:00.000Z",
      precision: "day",
    });
  });
});

describe("a floating time moved across a change of the clocks", () => {
  it("is fixed in the account's zone in the hour the clocks repeat, and floats in the hour after they skip one", async () => {
    const floating = {
      date: "2026-10-01T10:00:00",
      string: "every day at 10:00",
      lang: "en",
      is_recurring: true,
      timezone: null,
    };
    todoist.put(
      todoist.task("back", { due: floating }),
      todoist.task("forward", { due: floating }),
    );
    await landed();
    marfa.edit(marfa.row(`${todoist.account}:back`).id, {
      due_at: "2026-10-25T01:30:00.000Z",
      precision: "time",
    });
    marfa.edit(marfa.row(`${todoist.account}:forward`).id, {
      due_at: "2026-03-29T01:30:00.000Z",
      precision: "time",
    });
    await landed();
    expect(
      todoist.commands("item_update").map((c) => [c.args["id"], c.args["due"]]),
    ).toEqual([
      [
        "back",
        {
          string: "every day at 10:00",
          lang: "en",
          date: "2026-10-25T01:30:00Z",
          timezone: "Europe/London",
        },
      ],
      [
        "forward",
        {
          string: "every day at 10:00",
          lang: "en",
          date: "2026-03-29T02:30:00",
        },
      ],
    ]);
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(2);
    expect(marfa.row(`${todoist.account}:back`).properties["due_at"]).toBe(
      "2026-10-25T01:30:00.000Z",
    );
    expect(marfa.row(`${todoist.account}:forward`).properties["due_at"]).toBe(
      "2026-03-29T01:30:00.000Z",
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
      `the trash of ${third.id} was refused, so it waits until the row is restored in Marfa: Todoist refused deleting task c: Insufficient permissions (39)`,
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
    marfa.restore(row.id);
    todoist.scriptCommand("item_add", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refused creating a task: Invalid argument value (20)`,
    );
    expect(marfa.agreements.get(row.id)?.record["state"]).toBe("trashed");
    await landed();
    expect(todoist.commands("item_add")).toHaveLength(1);
    marfa.edit(row.id, { title: "Task a, back" });
    await landed();
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(madeId).not.toBe("a");
    expect(todoist.tasks.get(madeId)?.content).toBe("Task a, back");
    expect(marfa.agreements.get(row.id)?.record["state"]).toBe("active");
  });

  it("makes the task again at its project's root when its section is gone, as Todoist does", async () => {
    todoist.sections = new Map();
    todoist.put(
      todoist.task("a", { project_id: "p-work", section_id: "s-gone" }),
    );
    await landed();
    const row = marfa.row(`${todoist.account}:a`);
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    expect(
      todoist.commands("item_add").map((c) => c.args["section_id"]),
    ).toEqual(["s-gone"]);
    const madeId = String(marfa.byId(row.id).properties["todoist_id"]);
    expect(todoist.tasks.get(madeId)).toMatchObject({
      project_id: "p-work",
      section_id: null,
    });
    expect(summary()).not.toContain("refused");
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
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist does not answer task a for this token`,
    );
  });
});

describe("Todoist's answers, continued", () => {
  it("stops waiting on a 429 after five waits, and the run fails saying so", async () => {
    for (let wait = 0; wait < 6; wait += 1) {
      todoist.refuseNext(429, { headers: { "Retry-After": "0" } });
    }
    const { code, output } = await once();
    expect(code).not.toBe(0);
    expect(output).toContain("Todoist asked for a wait 6 times in a row");
    expect(todoist.received).toHaveLength(6);
  });

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

describe("a create Todoist refused", () => {
  it("is sent again under ids of its own once the row changes", async () => {
    todoist.put(todoist.task("seed"));
    const refused = personsRow({ title: "Refused", status: "pending" });
    todoist.scriptCommand("item_add", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    marfa.edit(refused.id, { title: "Taken" });
    await landed();
    const adds = todoist.commands("item_add");
    expect(adds).toHaveLength(2);
    expect(adds[1]?.uuid).not.toBe(adds[0]?.uuid);
    expect(adds[1]?.temp_id).not.toBe(adds[0]?.temp_id);
    expect(marfa.byId(refused.id).properties["todoist_id"]).toBe("made-1");
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

describe("labels, project and section changed in Marfa", () => {
  beforeEach(() => {
    todoist.sections = new Map([
      ["s-later", "p-work"],
      ["s-home", "p-home"],
    ]);
  });

  it("sets the task's labels by name, empties them when the row clears them, and sends nothing for an order alone", async () => {
    const row = await placed("a", { labels: ["Home"] });
    marfa.edit(row.id, { labels: ["Work", "Home"] });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      { id: "a", labels: ["Work", "Home"] },
    ]);
    expect(todoist.tasks.get("a")?.labels).toEqual(["Home", "Work"]);
    expect(todoist.commands("item_move")).toEqual([]);

    // Todoist keeps its labels in order, so the row now holds them so.
    await landed();
    expect(marfa.byId(row.id).properties["labels"]).toEqual(["Home", "Work"]);
    marfa.edit(row.id, { labels: ["Work", "Home"] });
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(1);

    const { labels, ...cleared } = marfa.byId(row.id).properties;
    expect(labels).toBeDefined();
    marfa.rewrite(`${todoist.account}:a`, cleared);
    await landed();
    expect(todoist.commands("item_update").at(-1)?.args).toEqual({
      id: "a",
      labels: [],
    });
    expect(todoist.tasks.get("a")?.labels).toEqual([]);
    expect(summary()).not.toContain("put back");
  });

  it("moves the task into the section the row names, whose project it takes", async () => {
    const row = await placed("a", { project_id: "p-home" });
    marfa.edit(row.id, { project_id: "p-work", section_id: "s-later" });
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args])).toEqual([
      ["item_move", { id: "a", section_id: "s-later" }],
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-work",
      section_id: "s-later",
    });
    await landed();
    expect(todoist.commands()).toHaveLength(1);
    expect(marfa.byId(row.id).properties).toMatchObject({
      project_id: "p-work",
      section_id: "s-later",
    });
    expect(summary()).not.toContain("put back");
  });

  it("moves the task to the project the row names, outside any section", async () => {
    const row = await placed("a", {
      project_id: "p-work",
      section_id: "s-later",
    });
    // The row keeps naming the section it held, which is not in the new
    // project, so the task goes to the project's root.
    marfa.edit(row.id, { project_id: "p-home" });
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args])).toEqual([
      ["item_move", { id: "a", project_id: "p-home" }],
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-home",
      section_id: null,
    });
    await landed();
    expect(marfa.byId(row.id).properties["section_id"]).toBeUndefined();
    expect(marfa.byId(row.id).properties["project_id"]).toBe("p-home");
    expect(todoist.commands()).toHaveLength(1);
  });

  it("takes the task out of its section into its project's root when the row clears the section", async () => {
    const row = await placed("a", {
      project_id: "p-work",
      section_id: "s-later",
    });
    const { section_id, ...cleared } = marfa.byId(row.id).properties;
    expect(section_id).toBe("s-later");
    marfa.rewrite(`${todoist.account}:a`, cleared);
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args])).toEqual([
      ["item_move", { id: "a", project_id: "p-work" }],
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-work",
      section_id: null,
    });
  });

  it("sends the section, the more specific place, when a row changes its project and its section", async () => {
    const row = await placed("a", { project_id: "p-work" });
    marfa.edit(row.id, { project_id: "p-home", section_id: "s-home" });
    await landed();
    expect(todoist.commands().map((c) => [c.type, c.args])).toEqual([
      ["item_move", { id: "a", section_id: "s-home" }],
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-home",
      section_id: "s-home",
    });
  });

  it("sends an edit and a move made in one change as two commands with their own ids, the edit first", async () => {
    const row = await placed("a", { project_id: "p-work", labels: [] });
    marfa.edit(row.id, {
      title: "Task a, filed",
      labels: ["Home"],
      project_id: "p-home",
    });
    await landed();
    const sent = todoist.commands();
    expect(sent.map((c) => [c.type, c.args])).toEqual([
      ["item_update", { id: "a", content: "Task a, filed", labels: ["Home"] }],
      ["item_move", { id: "a", project_id: "p-home" }],
    ]);
    expect(sent[0]?.uuid).not.toBe(sent[1]?.uuid);
  });

  it("leaves the task where it is when the row names no project, and when only another field changed", async () => {
    const row = await placed("a", {
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
    });
    marfa.edit(row.id, { title: "Task a, renamed" });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual(["item_update"]);
    expect(todoist.commands("item_update")[0]?.args).toEqual({
      id: "a",
      content: "Task a, renamed",
    });

    const { project_id, ...unplaced } = marfa.byId(row.id).properties;
    expect(project_id).toBe("p-work");
    marfa.rewrite(`${todoist.account}:a`, unplaced);
    await landed();
    expect(todoist.commands()).toHaveLength(1);
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-work",
      section_id: "s-later",
    });
  });

  it("does not undo a move made in Todoist after the connector last read the task, when the row changed something else", async () => {
    const row = await placed("a", {
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
    });
    marfa.edit(row.id, { title: "Task a, renamed" });
    let moved = false;
    todoist.before = (request) => {
      if (moved || request.path !== "/api/v1/tasks/a") return;
      moved = true;
      todoist.edit("a", {
        project_id: "p-home",
        section_id: "s-home",
        labels: ["Work"],
      });
    };
    await landed();
    expect(moved).toBe(true);
    expect(todoist.commands().map((c) => [c.type, c.args])).toEqual([
      ["item_update", { id: "a", content: "Task a, renamed" }],
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      content: "Task a, renamed",
      project_id: "p-home",
      section_id: "s-home",
      labels: ["Work"],
    });
    todoist.before = undefined;
    await landed();
    expect(marfa.byId(row.id).properties).toMatchObject({
      project_id: "p-home",
      section_id: "s-home",
      labels: ["Work"],
    });
    expect(todoist.commands()).toHaveLength(1);
  });

  it("makes a moved subtask a task of its own, and the next read leaves its row holding what Todoist holds", async () => {
    todoist.put(todoist.task("p", { project_id: "p-work" }));
    const child = await placed("c", {
      project_id: "p-work",
      parent_id: "p",
    });
    expect(marfa.byId(child.id).properties["parent_id"]).toBe("p");
    marfa.edit(child.id, { project_id: "p-home", section_id: "s-home" });
    await landed();
    expect(todoist.commands("item_move").map((c) => c.args)).toEqual([
      { id: "c", section_id: "s-home" },
    ]);
    expect(todoist.tasks.get("c")?.parent_id).toBeNull();
    await landed();
    expect(marfa.byId(child.id).properties["parent_id"]).toBeUndefined();
    expect(marfa.byId(child.id).properties).toMatchObject({
      project_id: "p-home",
      section_id: "s-home",
    });
    expect(summary()).not.toContain("put back");
    expect(todoist.commands()).toHaveLength(1);
  });

  it("is decided by the later change when a project is changed on both sides, and names the field that lost", async () => {
    const won = await placed("a", { project_id: "p-work" });
    todoist.now = "2026-09-24T12:00:00.000000Z";
    todoist.edit("a", { project_id: "p-other" });
    marfa.edit(won.id, { project_id: "p-home" });
    await landed();
    expect(todoist.commands("item_move").map((c) => c.args)).toEqual([
      { id: "a", project_id: "p-home" },
    ]);
    expect(todoist.tasks.get("a")?.project_id).toBe("p-home");
    expect(summary()).toContain(
      `the change made in Marfa to project_id on ${won.id} is the later one, so the vendor's is not written and Marfa's is carried back`,
    );

    const lost = await placed("b", { project_id: "p-work" });
    todoist.now = "2026-09-26T12:00:00.000000Z";
    todoist.edit("b", { project_id: "p-other" });
    marfa.edit(lost.id, { project_id: "p-home" });
    await landed();
    expect(todoist.commands("item_move")).toHaveLength(1);
    expect(todoist.tasks.get("b")?.project_id).toBe("p-other");
    expect(marfa.byId(lost.id).properties["project_id"]).toBe("p-other");
    expect(summary()).toContain(
      `the vendor's change to project_id on ${lost.id} is the later one, so the change made in Marfa is not carried back`,
    );
  });

  it("is decided by the later change when labels are changed on both sides, and names the field that lost", async () => {
    const won = await placed("a", { labels: ["Home"] });
    todoist.now = "2026-09-24T12:00:00.000000Z";
    todoist.edit("a", { labels: ["Work"] });
    marfa.edit(won.id, { labels: ["Errand"] });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      { id: "a", labels: ["Errand"] },
    ]);
    expect(todoist.tasks.get("a")?.labels).toEqual(["Errand"]);
    expect(summary()).toContain(
      `the change made in Marfa to labels on ${won.id} is the later one, so the vendor's is not written and Marfa's is carried back`,
    );

    const lost = await placed("b", { labels: ["Home"] });
    todoist.now = "2026-09-26T12:00:00.000000Z";
    todoist.edit("b", { labels: ["Work"] });
    marfa.edit(lost.id, { labels: ["Errand"] });
    await landed();
    expect(todoist.commands("item_update")).toHaveLength(1);
    expect(todoist.tasks.get("b")?.labels).toEqual(["Work"]);
    expect(marfa.byId(lost.id).properties["labels"]).toEqual(["Work"]);
    expect(summary()).toContain(
      `the vendor's change to labels on ${lost.id} is the later one, so the change made in Marfa is not carried back`,
    );
  });

  it("is decided by the later change when a section is changed on both sides, and names the field that lost", async () => {
    todoist.sections?.set("s-other", "p-work");
    const won = await placed("a", {
      project_id: "p-work",
      section_id: "s-later",
    });
    todoist.now = "2026-09-24T12:00:00.000000Z";
    todoist.edit("a", { section_id: "s-other" });
    marfa.edit(won.id, { section_id: "s-home" });
    await landed();
    expect(todoist.commands("item_move").map((c) => c.args)).toEqual([
      { id: "a", section_id: "s-home" },
    ]);
    expect(todoist.tasks.get("a")?.section_id).toBe("s-home");
    expect(summary()).toContain(
      `the change made in Marfa to section_id on ${won.id} is the later one, so the vendor's is not written and Marfa's is carried back`,
    );

    const lost = await placed("b", {
      project_id: "p-work",
      section_id: "s-later",
    });
    todoist.now = "2026-09-26T12:00:00.000000Z";
    todoist.edit("b", { section_id: "s-other" });
    marfa.edit(lost.id, { section_id: "s-home" });
    await landed();
    expect(todoist.commands("item_move")).toHaveLength(1);
    expect(todoist.tasks.get("b")?.section_id).toBe("s-other");
    expect(marfa.byId(lost.id).properties["section_id"]).toBe("s-other");
    expect(summary()).toContain(
      `the vendor's change to section_id on ${lost.id} is the later one, so the change made in Marfa is not carried back`,
    );
  });

  it("sends the same move again, under the same id, after a run Todoist did not answer for", async () => {
    const row = await placed("a", { project_id: "p-work" });
    marfa.edit(row.id, { project_id: "p-home", labels: ["Home"] });
    todoist.answerNothing("item_move");
    await landed();
    expect(summary()).toContain(
      "1 change waits: Todoist is not taking changes for now: no answer for the command",
    );
    expect(todoist.tasks.get("a")?.labels).toEqual(["Home"]);
    expect(todoist.tasks.get("a")?.project_id).toBe("p-work");
    await landed();
    const moves = todoist.commands("item_move");
    expect(moves).toHaveLength(2);
    expect(moves[1]?.uuid).toBe(moves[0]?.uuid);
    expect(todoist.commands("item_update")).toHaveLength(1);
    expect(todoist.tasks.get("a")?.project_id).toBe("p-home");
  });

  it("names the row when Todoist has no project or section to move the task into, keeps the labels it set, and moves on the next change", async () => {
    todoist.projects = new Set(["p-work", "p-home"]);
    const row = await placed("a", { project_id: "p-work" });
    marfa.edit(row.id, { project_id: "p-gone", labels: ["Home"] });
    await landed();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist has no project p-gone to move task a into`,
    );
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-work",
      labels: ["Home"],
    });
    // The labels are settled by now, so the change that remains is the move
    // alone, tried once more; the refusal then stands.
    await landed();
    await landed();
    expect(todoist.commands("item_move")).toHaveLength(2);
    expect(todoist.commands("item_update")).toHaveLength(1);

    marfa.edit(row.id, { project_id: "p-work", section_id: "s-gone" });
    await landed();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist has no section s-gone to move task a into`,
    );

    marfa.edit(row.id, { project_id: "p-home", section_id: "s-home" });
    await landed();
    expect(todoist.tasks.get("a")).toMatchObject({
      project_id: "p-home",
      section_id: "s-home",
    });
    expect(marfa.states.get("todoist")?.["conditions"]).toEqual({});
  });

  it("closes or reopens the task before it moves it", async () => {
    const closing = await placed("a", { project_id: "p-work" });
    marfa.edit(closing.id, {
      project_id: "p-home",
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_move",
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      checked: true,
      project_id: "p-home",
    });

    marfa.edit(closing.id, {
      project_id: "p-work",
      status: "pending",
      completed_at: null,
    });
    await landed();
    expect(
      todoist
        .commands()
        .slice(2)
        .map((c) => c.type),
    ).toEqual(["item_uncomplete", "item_move"]);
    expect(todoist.tasks.get("a")).toMatchObject({
      checked: false,
      project_id: "p-work",
    });
  });

  it("closes the task when Todoist refuses the move made with it, and names the move", async () => {
    todoist.projects = new Set(["p-work", "p-home"]);
    const row = await placed("a", { project_id: "p-work" });
    marfa.edit(row.id, {
      project_id: "p-gone",
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    await landed();
    expect(todoist.commands().map((c) => c.type)).toEqual([
      "item_close",
      "item_move",
    ]);
    expect(todoist.tasks.get("a")).toMatchObject({
      checked: true,
      project_id: "p-work",
    });
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist has no project p-gone to move task a into`,
    );
  });

  it("reopens the task when Todoist refuses the move made with it", async () => {
    todoist.projects = new Set(["p-work", "p-home"]);
    const row = await placed("a", {
      project_id: "p-work",
      checked: true,
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    marfa.edit(row.id, {
      project_id: "p-gone",
      status: "pending",
      completed_at: null,
    });
    await landed();
    expect(todoist.tasks.get("a")?.checked).toBe(false);
    expect(summary()).toContain("Todoist has no project p-gone to move task a");
  });

  it("closes a task made in the Inbox on the run after a close nobody answered, without asking for the project that is gone", async () => {
    todoist.projects = new Set(["inbox"]);
    const row = personsRow({
      title: "Filed away, done",
      project_id: "p-gone",
      section_id: "s-gone",
      labels: ["Home"],
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    todoist.answerNothing("item_close");
    await landed();
    expect(summary()).toContain("no answer for the command");
    expect(todoist.tasks.get("made-1")).toMatchObject({
      project_id: "inbox",
      checked: false,
    });

    await landed();
    expect(todoist.commands("item_close")).toHaveLength(2);
    expect(todoist.tasks.get("made-1")).toMatchObject({
      project_id: "inbox",
      labels: ["Home"],
      checked: true,
    });
    expect(summary()).not.toContain("refused");
    expect(marfa.states.get("todoist")?.["conditions"]).toEqual({});
    expect(marfa.byId(row.id).properties["status"]).toBe("completed");
  });

  it("closes a task made at its project's root on the run after a close nobody answered, whose section is gone", async () => {
    todoist.projects = new Set(["inbox", "p-work"]);
    personsRow({
      title: "Sectioned, done",
      project_id: "p-work",
      section_id: "s-gone",
      status: "completed",
      completed_at: "2026-09-25T10:00:00.000Z",
    });
    todoist.answerNothing("item_close");
    await landed();
    await landed();
    expect(todoist.tasks.get("made-1")).toMatchObject({
      project_id: "p-work",
      section_id: null,
      checked: true,
    });
  });

  it("still names a project that is gone when the task sits in another project", async () => {
    todoist.projects = new Set(["inbox", "p-work"]);
    const row = await placed("a", { project_id: "p-work" });
    marfa.edit(row.id, { project_id: "p-gone" });
    await landed();
    expect(summary()).toContain("Todoist has no project p-gone to move task a");
  });

  it("names the row when Todoist refuses a label change, and sends no move after it", async () => {
    const row = await placed("a", { project_id: "p-work" });
    marfa.edit(row.id, { project_id: "p-home", labels: ["Bad label"] });
    todoist.scriptCommand("item_update", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refused updating task a: Invalid argument value (20)`,
    );
    expect(todoist.commands("item_move")).toEqual([]);
    expect(todoist.tasks.get("a")?.project_id).toBe("p-work");
  });

  it("makes a row's task in the Inbox when its project is gone, and does not then try to move it", async () => {
    todoist.projects = new Set(["inbox"]);
    const row = personsRow({
      title: "Filed away",
      project_id: "p-gone",
      section_id: "s-later",
      labels: ["Home"],
      status: "pending",
    });
    await landed();
    expect(todoist.commands("item_move")).toEqual([]);
    expect(todoist.commands("item_update")).toEqual([]);
    expect(
      todoist.tasks.get(String(marfa.byId(row.id).properties["todoist_id"])),
    ).toMatchObject({ project_id: "inbox", labels: ["Home"] });
    expect(summary()).not.toContain("refused");
  });
});

describe("a recurrence", () => {
  const daily = {
    date: "2026-10-05",
    timezone: null,
    string: "every day",
    lang: "en",
    is_recurring: true,
  };

  it("is read onto the row as Todoist words it, and cleared when the task stops repeating", async () => {
    const row = await placed("r", { due: daily });
    expect(marfa.byId(row.id).properties["recurrence"]).toBe("every day");
    todoist.edit("r", {
      due: { ...daily, string: "2026-10-05", is_recurring: false },
    });
    await landed();
    expect(marfa.byId(row.id).properties).not.toHaveProperty("recurrence");
    expect(todoist.commands()).toEqual([]);
  });

  it("comes back on a task made again after a trash and a restore, due on the row's date", async () => {
    const row = await placed("r", { content: "Water the plants", due: daily });
    marfa.trash(row.id);
    await landed();
    marfa.restore(row.id);
    await landed();
    expect(todoist.commands("item_add")[0]?.args["due"]).toEqual({
      string: "every day",
      lang: "en",
      date: "2026-10-05",
    });
    const made = todoist.tasks.get(
      String(marfa.byId(row.id).properties["todoist_id"]),
    );
    expect(made?.due).toMatchObject({
      date: "2026-10-05",
      string: "every day",
      is_recurring: true,
    });
    await landed();
    expect(marfa.byId(row.id).properties["recurrence"]).toBe("every day");
    expect(summary()).toMatch(/conflicts 0/);
  });

  it("is made with a row made in Marfa, dated by Todoist where the row names no date", async () => {
    todoist.put(todoist.task("seed"));
    await landed();
    const row = personsRow({
      title: "Stretch",
      status: "pending",
      recurrence: "every day",
    });
    await landed();
    expect(todoist.commands("item_add").at(-1)?.args["due"]).toEqual({
      string: "every day",
      lang: "en",
    });
    const made = todoist.tasks.get(
      String(marfa.byId(row.id).properties["todoist_id"]),
    );
    expect(made?.due).toMatchObject({
      string: "every day",
      is_recurring: true,
    });
    expect(made?.due?.["date"]).toEqual(expect.any(String));
  });

  it("is set by the row in the account's language, on the date the task holds", async () => {
    todoist.lang = "de";
    const row = await placed("r", {
      due: { ...daily, string: "Oct 5", is_recurring: false },
    });
    marfa.edit(row.id, { recurrence: "every week" });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      {
        id: "r",
        due: { string: "every week", lang: "de", date: "2026-10-05" },
      },
    ]);
    expect(todoist.tasks.get("r")?.due).toMatchObject({
      date: "2026-10-05",
      string: "every week",
      is_recurring: true,
    });
  });

  it("is changed with the date when the row changes both, keeping a floating time", async () => {
    const row = await placed("r", {
      due: { ...daily, date: "2026-10-05T10:00:00", string: "every day at 10" },
    });
    marfa.edit(row.id, {
      recurrence: "every weekday at 10",
      due_at: "2026-10-07T09:00:00.000Z",
      precision: "time",
    });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      {
        id: "r",
        due: {
          string: "every weekday at 10",
          lang: "en",
          date: "2026-10-07T10:00:00",
        },
      },
    ]);
  });

  it("ends when the row clears it, leaving a task due once on its current date", async () => {
    const row = await placed("r", { due: daily });
    const { recurrence, ...cleared } = marfa.byId(row.id).properties;
    expect(recurrence).toBe("every day");
    marfa.rewrite(`${todoist.account}:r`, cleared);
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      { id: "r", due: { date: "2026-10-05" } },
    ]);
    expect(todoist.tasks.get("r")?.due).toMatchObject({
      date: "2026-10-05",
      is_recurring: false,
    });
    await landed();
    expect(marfa.byId(row.id).properties).not.toHaveProperty("recurrence");
    expect(todoist.commands("item_update")).toHaveLength(1);
  });

  it("is kept on a row that does not hold it yet when another field changes", async () => {
    // As a row read before the field existed: Todoist's task repeats, the row
    // has never held it, and only its title changes.
    const row = await placed("r", {
      due: { ...daily, string: "Oct 5", is_recurring: false },
    });
    const task = todoist.tasks.get("r");
    if (task !== undefined) task.due = { ...daily };
    marfa.edit(row.id, { title: "Water the ferns" });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      { id: "r", content: "Water the ferns" },
    ]);
    expect(todoist.tasks.get("r")?.due).toMatchObject({
      string: "every day",
      is_recurring: true,
    });
  });

  it("names the row when Todoist cannot read it, and still carries the other fields", async () => {
    const row = await placed("r", {
      due: { ...daily, string: "Oct 5", is_recurring: false },
    });
    marfa.edit(row.id, { title: "Water the ferns", recurrence: "zzqx blorp" });
    await landed();
    expect(todoist.commands("item_update").map((c) => c.args)).toEqual([
      {
        id: "r",
        content: "Water the ferns",
        due: { string: "zzqx blorp", lang: "en", date: "2026-10-05" },
      },
    ]);
    expect(todoist.tasks.get("r")).toMatchObject({
      content: "Water the ferns",
      due: { date: "2026-10-05", is_recurring: false },
    });
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist could not read the recurrence "zzqx blorp", so task r is due once`,
    );
    // The next read brings the title it carried, which sends what still
    // differs once more under the same command id, which Todoist runs once.
    await landed();
    await landed();
    const updates = todoist.commands("item_update");
    expect(updates.map((c) => c.args)).toEqual([
      expect.objectContaining({ content: "Water the ferns" }),
      {
        id: "r",
        due: { string: "zzqx blorp", lang: "en", date: "2026-10-05" },
      },
    ]);
    expect(updates[1]?.uuid).toBe(updates[0]?.uuid);
    expect(summary()).toContain('could not read the recurrence "zzqx blorp"');
    expect(marfa.byId(row.id).properties["recurrence"]).toBe("zzqx blorp");
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

describe("a row made in Marfa", () => {
  it("is made in the project and section it names, with its labels, and keeps them", async () => {
    todoist.put(todoist.task("seed"));
    const row = personsRow({
      title: "Filed from Marfa",
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
      status: "pending",
    });
    await landed();
    expect(todoist.commands("item_add")[0]?.args).toMatchObject({
      content: "Filed from Marfa",
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
    });
    await landed();
    expect(marfa.byId(row.id).properties).toMatchObject({
      project_id: "p-work",
      section_id: "s-later",
      labels: ["Home"],
    });
  });

  it("is not made in the Inbox when Todoist refuses it for anything but a project gone", async () => {
    todoist.put(todoist.task("seed"));
    const row = personsRow({
      title: "Refused",
      project_id: "p-work",
      status: "pending",
    });
    todoist.scriptCommand("item_add", {
      error_code: 20,
      error: "Invalid argument value",
      http_code: 400,
    });
    await landed();
    expect(todoist.commands("item_add")).toHaveLength(1);
    expect(marfa.byId(row.id).properties["todoist_id"]).toBeUndefined();
    expect(summary()).toContain(
      `the change to ${row.id} was refused, so it waits until the row changes in Marfa: Todoist refused creating a task: Invalid argument value (20)`,
    );
  });
});

describe("a full sync", () => {
  it("archives a row whose task was deleted while the connector held no sync token, and reads one completed long ago", async () => {
    const gone = await synced("a");
    const old = await synced("b");
    const kept = await synced("c");
    todoist.delete("a");
    todoist.edit("b", {
      checked: true,
      completed_at: "2026-01-05T10:00:00.000000Z",
    });
    marfa.states.delete("todoist");
    await landed();
    expect(marfa.byId(gone.id).state).toBe("archived");
    expect(marfa.byId(old.id).properties).toMatchObject({
      status: "completed",
      completed_at: "2026-01-05T10:00:00.000Z",
    });
    expect(marfa.byId(old.id).state).toBe("active");
    expect(marfa.byId(kept.id).state).toBe("active");
    const looked = todoist.received
      .filter(
        (r) =>
          r.method === "GET" &&
          r.path.startsWith("/api/v1/tasks/") &&
          !r.path.includes("completed"),
      )
      .map((r) => r.path);
    expect(looked.sort()).toEqual(["/api/v1/tasks/a", "/api/v1/tasks/b"]);
  });

  it("leaves a row whose task Todoist answers 404 for, and says so", async () => {
    const row = await synced("a");
    todoist.tasks.delete("a");
    marfa.states.delete("todoist");
    await landed();
    expect(marfa.byId(row.id).state).toBe("active");
    expect(summary()).toContain(
      "Todoist does not answer task a for this token, so its row is left as it is",
    );
  });

  it("names a task Todoist does not answer on every run until it answers, and forgets one whose row is no longer open", async () => {
    const row = await synced("a");
    const other = await synced("b");
    todoist.tasks.delete("a");
    todoist.tasks.delete("b");
    marfa.states.delete("todoist");
    const named = (id: string): string =>
      `Todoist does not answer task ${id} for this token, so its row is left as it is`;
    const held = (): Record<string, string> =>
      (marfa.states.get("todoist")?.["conditions"] ?? {}) as Record<
        string,
        string
      >;
    await landed();
    expect(summary()).toContain(named("a"));
    expect(summary()).toContain(named("b"));
    await landed();
    await landed();
    expect(held()).toMatchObject({
      "task-unanswered:a": named("a"),
      "task-unanswered:b": named("b"),
    });
    marfa.transition(other.id, "archived");
    todoist.put(todoist.task("a", { content: "Answered again" }));
    await landed();
    expect(Object.keys(held())).not.toContain("task-unanswered:a");
    expect(Object.keys(held())).not.toContain("task-unanswered:b");
    expect(marfa.byId(row.id).properties["title"]).toBe("Answered again");
    expect(marfa.states.get("todoist")?.["state"]).not.toHaveProperty(
      "unanswered",
    );
  });

  it("holds at most two thousand rows to ask about, and names how many wait for the next full sync", async () => {
    const ids = Array.from({ length: 2205 }, (_, at) => `t${String(at)}`);
    todoist.put(...ids.map((id) => todoist.task(id)));
    await landed();
    for (const id of ids) todoist.delete(id);
    marfa.states.delete("todoist");
    await landed();
    const held = marfa.states.get("todoist")?.["state"] as Record<
      string,
      unknown
    >;
    expect(held["unasked"]).toHaveLength(2000);
    expect(summary()).toContain(
      "5 rows the full sync left out are not held to ask about, and wait for the next full sync",
    );
  });

  it("asks about at most two hundred rows a run, writing as it goes, and the rest on the runs after", async () => {
    const ids = Array.from({ length: 205 }, (_, at) => `t${String(at)}`);
    todoist.put(...ids.map((id) => todoist.task(id)));
    await landed();
    for (const id of ids) todoist.delete(id);
    marfa.states.delete("todoist");
    const before = todoist.received.length;
    await landed();
    const asked = (from: number): number =>
      todoist.received
        .slice(from)
        .filter(
          (r) => r.method === "GET" && r.path.startsWith("/api/v1/tasks/t"),
        ).length;
    expect(asked(before)).toBe(200);
    const archived = (): number =>
      ids.filter(
        (id) => marfa.row(`${todoist.account}:${id}`).state === "archived",
      ).length;
    expect(archived()).toBe(200);
    const next = todoist.received.length;
    await landed();
    expect(asked(next)).toBe(5);
    expect(archived()).toBe(205);
    const last = todoist.received.length;
    await landed();
    expect(asked(last)).toBe(0);
  });

  it("keeps what it has asked about when Todoist rate-limits the rest, and asks about the rest next run", async () => {
    const one = await synced("a");
    const two = await synced("b");
    todoist.delete("a");
    todoist.delete("b");
    marfa.states.delete("todoist");
    for (let wait = 0; wait < 6; wait += 1) {
      todoist.refuseNext(429, {
        headers: { "Retry-After": "0" },
        when: (r) => r.path === "/api/v1/tasks/b",
      });
    }
    await landed();
    expect(marfa.byId(one.id).state).toBe("archived");
    expect(marfa.byId(two.id).state).toBe("active");
    expect(summary()).toContain("Todoist asked for a wait 6 times in a row");
    await landed();
    expect(marfa.byId(two.id).state).toBe("archived");
  });
});

describe("read only", () => {
  it("carries nothing to Todoist, and puts back an edit made in Marfa", async () => {
    const row = await synced("a");
    marfa.edit(row.id, { title: "From Marfa" });
    personsRow({ title: "Made in Marfa", status: "pending" });
    const { code, output } = await once({ TODOIST_READ_ONLY: "true" });
    expect(code, output).toBe(0);
    expect(todoist.commands()).toEqual([]);
    expect(marfa.byId(row.id).properties["title"]).toBe("Task a");
    expect(summary()).toContain("put back");
  });
});

async function looking(during: () => Promise<void>): Promise<void> {
  const child = spawn("node", [built, "--every", "1h", "--look-every", "1s"], {
    env: {
      PATH: process.env["PATH"],
      MARFA_URL: marfa.url,
      MARFA_KEY: marfa.key,
      TODOIST_API_TOKEN: token,
      TODOIST_API_URL: todoist.url,
    },
    stdio: "ignore",
  });
  const exited = new Promise((done) => child.once("exit", done));
  try {
    await during();
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

describe("a run a change in Marfa starts", () => {
  it("keeps no sync token when the state was lost, so the next scheduled run syncs in full and archives what was deleted", async () => {
    const gone = await synced("a");
    const edited = await synced("b");
    await looking(async () => {
      const runs = marfa.runs.length;
      await eventually(() => marfa.runs.length === runs + 1);
      todoist.delete("a");
      marfa.states.delete("todoist");
      marfa.edit(edited.id, { title: "Task b, renamed" });
      await eventually(() => marfa.runs.length === runs + 2);
    });
    expect(todoist.tasks.get("b")?.content).toBe("Task b, renamed");
    expect(marfa.states.get("todoist")?.["state"]).not.toHaveProperty(
      "sync_token",
    );
    await landed();
    expect(marfa.byId(gone.id).state).toBe("archived");
  });

  it("leaves a row whose task Todoist answers 404 for, and says so", async () => {
    const row = await synced("a");
    await looking(async () => {
      const runs = marfa.runs.length;
      await eventually(() => marfa.runs.length === runs + 1);
      todoist.tasks.delete("a");
      marfa.edit(row.id, { title: "Task a, renamed" });
      await eventually(() => marfa.runs.length === runs + 2);
    });
    expect(marfa.byId(row.id).state).toBe("active");
    expect(marfa.runs.at(-1)?.summary ?? "").toContain(
      "Todoist does not answer task a for this token, so its row is left as it is",
    );
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
