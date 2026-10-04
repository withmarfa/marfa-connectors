import { afterEach, beforeEach, expect, it } from "vitest";
import { TodoistStub } from "../proof/todoist-stub.js";

const token = "todoist-stub-test-token";
let stub: TodoistStub;

beforeEach(async () => {
  stub = await new TodoistStub(token).start();
});

afterEach(async () => {
  await stub.close();
});

async function made(due: Record<string, unknown>): Promise<unknown> {
  const uuid = crypto.randomUUID();
  const tempId = crypto.randomUUID();
  const response = await fetch(`${stub.url}/api/v1/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams({
      commands: JSON.stringify([
        {
          type: "item_add",
          uuid,
          temp_id: tempId,
          args: { content: "Water the plants", due },
        },
      ]),
    }),
  });
  const answer = (await response.json()) as {
    sync_status: Record<string, unknown>;
    temp_id_mapping: Record<string, string>;
  };
  expect(answer.sync_status[uuid]).toBe("ok");
  const id = answer.temp_id_mapping[tempId] ?? "";
  return stub.tasks.get(id)?.due;
}

function today(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

it("dates a recurrence sent without a date today in the account's zone, as Todoist does for every day", async () => {
  expect(await made({ string: "every day" })).toEqual({
    date: today("Europe/London"),
    timezone: null,
    string: "every day",
    lang: "en",
    is_recurring: true,
  });
  stub.timezone = null;
  expect(await made({ string: "every day", lang: "de" })).toMatchObject({
    date: today("UTC"),
    lang: "de",
    is_recurring: true,
  });
});

it("keeps a recurrence's date when one is sent, and words a date alone by the date", async () => {
  expect(await made({ string: "every day", date: "2026-10-10" })).toEqual({
    date: "2026-10-10",
    timezone: null,
    string: "every day",
    lang: "en",
    is_recurring: true,
  });
  expect(await made({ date: "2026-10-12" })).toEqual({
    date: "2026-10-12",
    timezone: null,
    string: "2026-10-12",
    lang: "en",
    is_recurring: false,
  });
});
