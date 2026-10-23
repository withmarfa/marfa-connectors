import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The built kit, the same one the connector imports, so the errors it throws
// are the classes the run checks for.
import { start } from "../../../kit/dist/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer, type Row } from "../../../kit/test/scripted-server.js";
import {
  clientEnv,
  freshToken,
  GoogleStub,
} from "../../../shared/google/test/stub.js";
import {
  calendarListScope,
  calendarType,
  eventsScope,
  eventType,
  inCalendar,
} from "../src/config.js";
import { createConnector } from "../src/connector.js";
import { eventIdFor } from "../src/write.js";
import { CalendarStub, type Call } from "./calendar-stub.js";

const me = "me@example.com";
const team = "team-calendar@example.com";
const holidays = "holidays@example.com";
const london = "Europe/London";
const la = "America/Los_Angeles";
const sub = "sub-1111111111";

let server: ScriptedServer;
let harness: Harness;
let google: GoogleStub;
let calendar: CalendarStub;

beforeEach(async () => {
  server = await new ScriptedServer("google-calendar", {
    types: [calendarType, eventType],
    edges: [inCalendar, "parent-of"],
  }).start();
  server.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  harness = new Harness(server);
  google = await new GoogleStub().start();
  google.scope = `openid ${eventsScope} ${calendarListScope}`;
  calendar = await new CalendarStub().start();
  calendar.calendars = [
    {
      id: me,
      summary: "Me",
      timeZone: london,
      accessRole: "owner",
      primary: true,
    },
    { id: team, summary: "Team", timeZone: la, accessRole: "writer" },
    {
      id: holidays,
      summary: "Holidays",
      timeZone: london,
      accessRole: "reader",
    },
  ];
});

afterEach(async () => {
  // Whatever a test does, Google never emails anyone and no guest is sent.
  for (const call of calendar.writes()) {
    expect(call.query["sendUpdates"], `${call.method} ${call.path}`).toBe(
      "none",
    );
    expect(JSON.stringify(call.body ?? {})).not.toContain("attendees");
  }
  await server.stop();
  await google.stop();
  await calendar.stop();
});

async function once(settings: Record<string, string> = {}): Promise<number> {
  return start(
    createConnector({ endpoints: { ...google.endpoints, api: calendar.url } }),
    harness.runtime(["--once"], {
      ...clientEnv,
      GOOGLE_REFRESH_TOKEN: freshToken(),
      GOOGLE_CALENDAR_READ_ONLY_CALENDARS: holidays,
      ...settings,
    }),
  );
}

async function landed(settings: Record<string, string> = {}): Promise<void> {
  const code = await once(settings);
  expect(code, JSON.stringify(harness.lastRun())).toBe(0);
}

function timed(
  id: string,
  summary: string,
  from: string,
  to: string,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    summary,
    start: { dateTime: from, timeZone: london },
    end: { dateTime: to, timeZone: london },
    organizer: { email: me, self: true },
    ...rest,
  };
}

function row(link: string): Row {
  const found = server.rows.find(
    (one) => one.type === eventType && one.properties["google_id"] === link,
  );
  if (found === undefined) throw new Error(`no event row ${link}`);
  return found;
}

function calendarRow(id: string): Row {
  const found = server.rows.find(
    (one) => one.type === calendarType && one.properties["calendar_id"] === id,
  );
  if (found === undefined) throw new Error(`no calendar row ${id}`);
  return found;
}

function placesOf(id: string): string[] {
  return server
    .targetsOf(id, inCalendar)
    .map((one) => String(server.byId(one).properties["calendar_id"]));
}

function made(properties: Record<string, unknown>, on?: string): Row {
  const one = server.insert(undefined, properties, eventType, "person");
  if (on !== undefined) server.drawEdge(one.id, calendarRow(on).id, inCalendar);
  return one;
}

function eventRows(): string[] {
  return server.rows
    .filter((one) => one.type === eventType && one.state === "active")
    .map((one) => one.id);
}

function writes(method?: string): Call[] {
  return calendar
    .writes()
    .filter((call) => method === undefined || call.method === method);
}

function eventPath(calendarId: string, id?: string): string {
  const events = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return id === undefined ? events : `${events}/${encodeURIComponent(id)}`;
}

function conditions(): Record<string, string> {
  return harness.problems();
}

const planning = {
  title: "Planning",
  starts_at: "2026-11-02T09:00:00Z",
  ends_at: "2026-11-02T10:00:00Z",
  timezone: london,
};

describe("an event made in Marfa", () => {
  it("is made on the primary calendar under the row's own id, and the row is linked to it", async () => {
    await landed();
    const one = made(planning);

    await landed();

    const id = eventIdFor(one.id);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const [insert, ...others] = writes();
    expect(others).toEqual([]);
    expect(insert).toMatchObject({
      method: "POST",
      path: eventPath(me),
      body: {
        id,
        summary: "Planning",
        status: "confirmed",
        start: { dateTime: "2026-11-02T09:00:00Z", timeZone: london },
        end: { dateTime: "2026-11-02T10:00:00Z", timeZone: london },
      },
    });
    expect(server.byId(one.id).properties).toMatchObject({
      google_id: `${me}/${id}`,
      calendar_id: me,
      etag: calendar.event(me, id)?.["etag"],
      editable: true,
    });
    expect(placesOf(one.id)).toEqual([me]);

    await landed();
    expect(writes()).toHaveLength(1);
    expect(server.byId(one.id).state).toBe("active");
  });

  it("is made on the calendar it is drawn to", async () => {
    await landed();
    const one = made(planning, team);

    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({ method: "POST", path: eventPath(team) }),
    ]);
    expect(server.byId(one.id).properties["google_id"]).toBe(
      `${team}/${eventIdFor(one.id)}`,
    );
    expect(placesOf(one.id)).toEqual([team]);
  });

  it("is not made on a calendar the account can only read", async () => {
    await landed();
    const one = made(planning, holidays);

    await landed();

    expect(writes()).toEqual([]);
    expect(server.byId(one.id).properties["google_id"]).toBeUndefined();
    expect(Object.values(conditions()).join(" ")).toContain(
      "can only read the calendar Holidays",
    );
  });

  it("is made once when the answer to the create is lost, and no second row is read for it", async () => {
    await landed();
    const one = made(planning);
    const id = eventIdFor(one.id);
    calendar.loseAnswer((call) => call.method === "POST");

    await landed();
    expect(calendar.event(me, id)?.["summary"]).toBe("Planning");
    expect(server.byId(one.id).properties["google_id"]).toBeUndefined();
    expect(eventRows()).toEqual([one.id]);

    server.edit(one.id, { title: "Planning, renamed" });
    await landed();
    expect(server.byId(one.id).properties["google_id"]).toBe(`${me}/${id}`);
    expect(writes()).toHaveLength(2);
    expect(eventRows()).toEqual([one.id]);

    // The kit settles the create as it was sent before it carries the edit.
    await landed();
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${eventPath(me)}`,
      `POST ${eventPath(me)}`,
      `PATCH ${eventPath(me, id)}`,
    ]);
    // The stub answers 412 to an etag that is not the event's.
    expect(writes("PATCH")[0]?.ifMatch).toMatch(/^"\d+"$/);
    expect(writes("PATCH")[0]?.body).toEqual({ summary: "Planning, renamed" });
    expect(calendar.event(me, id)?.["summary"]).toBe("Planning, renamed");
    expect(server.byId(one.id).properties["google_id"]).toBe(`${me}/${id}`);
    expect(eventRows()).toEqual([one.id]);

    await landed();
    expect(eventRows()).toEqual([one.id]);
    expect(writes()).toHaveLength(3);
  });

  it("brings back a deleted event that holds the row's id, with the row's values", async () => {
    await landed();
    const one = made(planning);
    const id = eventIdFor(one.id);
    calendar.cancel(me, id, {
      summary: "Old",
      start: { dateTime: "2026-10-01T09:00:00Z" },
      end: { dateTime: "2026-10-01T10:00:00Z" },
    });

    await landed();

    expect(calendar.event(me, id)).toMatchObject({
      status: "confirmed",
      summary: "Planning",
      start: { dateTime: "2026-11-02T09:00:00Z", timeZone: london },
    });
    expect(server.byId(one.id).properties["google_id"]).toBe(`${me}/${id}`);
  });

  it("writes an all-day event as its dates in its own zone, across a clock change", async () => {
    await landed();
    const pacific = made(
      {
        title: "Offsite",
        all_day: true,
        timezone: la,
        starts_at: "2026-10-26T07:00:00Z",
        ends_at: "2026-10-27T07:00:00Z",
      },
      team,
    );
    const changeover = made({
      title: "Clocks go back",
      all_day: true,
      timezone: london,
      starts_at: "2026-10-24T23:00:00Z",
      ends_at: "2026-10-26T00:00:00Z",
    });

    await landed();

    const body = (id: string) =>
      writes("POST").find((call) => call.body?.["id"] === eventIdFor(id))?.body;
    expect(body(pacific.id)).toMatchObject({
      start: { date: "2026-10-26", timeZone: la },
      end: { date: "2026-10-27", timeZone: la },
    });
    expect(body(changeover.id)).toMatchObject({
      start: { date: "2026-10-25", timeZone: london },
      end: { date: "2026-10-26", timeZone: london },
    });
    expect(server.byId(changeover.id).properties).toMatchObject({
      starts_at: "2026-10-24T23:00:00Z",
      ends_at: "2026-10-26T00:00:00Z",
    });
  });
});

describe("an edit made in Marfa", () => {
  async function read(
    event: Record<string, unknown> = timed(
      "e1",
      "Lunch",
      "2026-11-02T12:00:00Z",
      "2026-11-02T13:00:00Z",
      { description: "Upstairs", location: "Canteen" },
    ),
    on = me,
  ): Promise<Row> {
    calendar.put(on, event);
    await landed();
    return row(`${on}/${String(event["id"])}`);
  }

  it("sends only the changed field, held to the etag Marfa last read", async () => {
    const one = await read();
    const etag = String(one.properties["etag"]);

    server.edit(one.id, { title: "Long lunch" });
    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, "e1"),
        ifMatch: etag,
        body: { summary: "Long lunch" },
      }),
    ]);
    expect(calendar.event(me, "e1")).toMatchObject({
      summary: "Long lunch",
      description: "Upstairs",
    });
    expect(server.byId(one.id).properties["etag"]).toBe(
      calendar.event(me, "e1")?.["etag"],
    );
  });

  it("clears a field cleared in Marfa", async () => {
    const one = await read();

    server.edit(one.id, { description: undefined });
    await landed();

    expect(writes("PATCH")[0]?.body).toEqual({ description: null });
    expect(calendar.event(me, "e1")?.["description"]).toBeUndefined();
  });

  it("keeps both sides' changes field by field when Google changed the event too", async () => {
    const one = await read();
    server.edit(one.id, { title: "Long lunch" });
    calendar.put(me, {
      ...calendar.event(me, "e1"),
      description: "Downstairs",
    });

    await landed();

    expect(writes("PATCH")).toHaveLength(1);
    expect(writes("PATCH")[0]?.body).toEqual({ summary: "Long lunch" });
    expect(calendar.event(me, "e1")).toMatchObject({
      summary: "Long lunch",
      description: "Downstairs",
    });
    expect(server.byId(one.id).properties).toMatchObject({
      title: "Long lunch",
      description: "Downstairs",
    });
  });

  it("waits for the next read when Google answers that the event changed since", async () => {
    const one = await read();
    server.edit(one.id, { title: "Long lunch" });
    calendar.failNext((call) => call.method === "PATCH", 412, {
      error: { code: 412, message: "Precondition Failed" },
    });

    await landed();
    expect(calendar.event(me, "e1")?.["summary"]).toBe("Lunch");
    expect(server.byId(one.id).properties["title"]).toBe("Long lunch");
    expect(Object.values(conditions()).join(" ")).toContain(
      'changed "Long lunch"',
    );

    await landed();
    expect(calendar.event(me, "e1")?.["summary"]).toBe("Long lunch");
    expect(writes("PATCH")).toHaveLength(2);
  });

  it("switches an event between timed and all day, clearing the key Google held", async () => {
    const one = await read();

    server.edit(one.id, {
      all_day: true,
      starts_at: "2026-11-02T00:00:00Z",
      ends_at: "2026-11-03T00:00:00Z",
    });
    await landed();
    expect(writes("PATCH")[0]?.body).toEqual({
      start: { date: "2026-11-02", timeZone: london, dateTime: null },
      end: { date: "2026-11-03", timeZone: london, dateTime: null },
    });
    expect(calendar.event(me, "e1")?.["start"]).toEqual({
      date: "2026-11-02",
      timeZone: london,
    });

    await landed();
    server.edit(one.id, {
      all_day: undefined,
      starts_at: "2026-11-02T15:00:00Z",
      ends_at: "2026-11-02T16:00:00Z",
    });
    await landed();
    expect(writes("PATCH").at(-1)?.body).toEqual({
      start: { dateTime: "2026-11-02T15:00:00Z", timeZone: london, date: null },
      end: { dateTime: "2026-11-02T16:00:00Z", timeZone: london, date: null },
    });
    expect(calendar.event(me, "e1")?.["start"]).toEqual({
      dateTime: "2026-11-02T15:00:00Z",
      timeZone: london,
    });
  });

  it("moves the event to the calendar it is drawn to, and keeps the row", async () => {
    const one = await read();
    const edge = server.edges.find(
      (e) => e.source_id === one.id && e.edge_type === inCalendar,
    );
    if (edge === undefined) throw new Error("no edge");

    server.removeEdge(edge.id);
    server.drawEdge(one.id, calendarRow(team).id, inCalendar);
    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `${eventPath(me, "e1")}/move`,
        query: { destination: team, sendUpdates: "none" },
      }),
    ]);
    expect(server.byId(one.id).properties).toMatchObject({
      google_id: `${team}/e1`,
      calendar_id: team,
    });
    expect(placesOf(one.id)).toEqual([team]);

    await landed();
    expect(server.byId(one.id).state).toBe("active");
    expect(
      server.rows.filter((r) => r.type === eventType && r.state === "active"),
    ).toHaveLength(1);
  });

  it("is carried again after Google limits the rate or fails", async () => {
    const one = await read();
    server.edit(one.id, { title: "Long lunch" });
    const failures: [number, Record<string, unknown> | undefined][] = [
      [429, undefined],
      [500, undefined],
      [
        403,
        {
          error: {
            code: 403,
            message: "Rate Limit Exceeded",
            errors: [{ reason: "rateLimitExceeded" }],
          },
        },
      ],
    ];
    for (const [status, body] of failures) {
      calendar.failNext((call) => call.method === "PATCH", status, body);
      await landed();
      expect(calendar.event(me, "e1")?.["summary"]).toBe("Lunch");
      expect(server.byId(one.id).properties["title"]).toBe("Long lunch");
      expect(Object.keys(conditions()).length).toBeGreaterThan(0);
    }
    await landed();
    expect(calendar.event(me, "e1")?.["summary"]).toBe("Long lunch");
  });
});

describe("an event Marfa may not change", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ["reader", holidays, {}, "the account can only read this calendar"],
    [
      "theirs",
      me,
      { organizer: { email: "kim@example.com" }, guestsCanModify: true },
      "someone else organizes the event",
    ],
    [
      "guests",
      me,
      {
        attendees: [
          { email: me, self: true, organizer: true },
          { email: "kim@example.com" },
        ],
      },
      "the event has guests",
    ],
    ["locked", me, { locked: true }, "the event is locked"],
    [
      "focus",
      me,
      { eventType: "focusTime" },
      "Google reserves focusTime events",
    ],
  ];

  for (const [id, on, rest, reason] of cases) {
    it(`is left alone, and the edit put back: ${reason}`, async () => {
      calendar.put(
        on,
        timed(
          id,
          "Fixed",
          "2026-11-02T12:00:00Z",
          "2026-11-02T13:00:00Z",
          rest,
        ),
      );
      await landed();
      const one = row(`${on}/${id}`);
      const before = calendar.calls.length;

      server.edit(one.id, { title: "Changed" });
      await landed();

      expect(writes()).toEqual([]);
      expect(
        calendar.calls
          .slice(before)
          .filter((call) => call.path === eventPath(on, id)),
      ).toEqual([]);
      expect(server.byId(one.id).properties["title"]).toBe("Fixed");
      expect(conditions()[`declined:${one.id}`]).toContain(reason);
    });
  }

  it("is not deleted when its row is trashed", async () => {
    calendar.put(
      me,
      timed("locked", "Fixed", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z", {
        locked: true,
      }),
    );
    await landed();
    const one = row(`${me}/locked`);

    server.trash(one.id);
    await landed();

    expect(writes()).toEqual([]);
    expect(calendar.event(me, "locked")?.["status"]).toBe("confirmed");
    expect(conditions()[`declined:${one.id}`]).toContain("locked");
  });
});

describe("a trash, restore and purge", () => {
  it("deletes on trash, brings back on restore, and sends nothing on the purge after", async () => {
    calendar.put(
      me,
      timed("e1", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
    );
    await landed();
    const one = row(`${me}/e1`);
    const etag = String(one.properties["etag"]);

    server.trash(one.id);
    await landed();
    expect(writes()).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: eventPath(me, "e1"),
        ifMatch: etag,
      }),
    ]);
    expect(calendar.event(me, "e1")?.["status"]).toBe("cancelled");

    server.restore(one.id);
    await landed();
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      path: eventPath(me, "e1"),
      body: { status: "confirmed", summary: "Lunch" },
    });
    expect(calendar.event(me, "e1")?.["status"]).toBe("confirmed");
    expect(server.byId(one.id).state).toBe("active");

    server.trash(one.id);
    await landed();
    const sent = writes().length;
    server.purgeById(one.id);
    await landed();
    expect(writes()).toHaveLength(sent);
  });

  it("makes the event again under the row's own id when Google has forgotten it", async () => {
    calendar.put(
      me,
      timed("e1", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
    );
    await landed();
    const one = row(`${me}/e1`);
    server.trash(one.id);
    await landed();
    calendar.forget(me, "e1");

    server.restore(one.id);
    await landed();

    const id = eventIdFor(one.id);
    expect(writes().slice(1)).toEqual([
      expect.objectContaining({ method: "PATCH", path: eventPath(me, "e1") }),
      expect.objectContaining({ method: "POST", path: eventPath(me) }),
    ]);
    expect(calendar.event(me, id)).toMatchObject({
      summary: "Lunch",
      status: "confirmed",
    });
    expect(server.byId(one.id)).toMatchObject({
      state: "active",
      properties: { google_id: `${me}/${id}` },
    });

    await landed();
    expect(eventRows()).toEqual([one.id]);
    expect(writes()).toHaveLength(3);
  });

  it("deletes on a purge the trash before it never carried", async () => {
    calendar.put(
      me,
      timed("e1", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
    );
    await landed();

    server.purge(`${sub}:${me}/e1`);
    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({ method: "DELETE", path: eventPath(me, "e1") }),
    ]);
  });
});

describe("a series", () => {
  const series = {
    id: "weekly",
    summary: "Planning",
    start: { dateTime: "2026-10-19T09:00:00Z", timeZone: london },
    end: { dateTime: "2026-10-19T10:00:00Z", timeZone: london },
    organizer: { email: me, self: true },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
  };

  function occurrence(at: string, rest: Record<string, unknown> = {}) {
    return {
      id: `weekly_${at.replace(/[-:]/g, "")}`,
      recurringEventId: "weekly",
      originalStartTime: { dateTime: at, timeZone: london },
      ...rest,
    };
  }

  it("sends a changed rule with Google's own lines, never the line Marfa adds for a cancelled occurrence", async () => {
    calendar.put(me, series);
    const { id, ...rest } = occurrence("2026-11-02T10:00:00Z");
    calendar.cancel(me, id, rest);
    await landed();
    const one = row(`${me}/weekly`);
    expect(one.properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20261102T100000Z",
    ]);

    server.edit(one.id, {
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE:20261102T100000Z"],
    });
    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, "weekly"),
        body: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] },
      }),
    ]);
  });

  it("cancels an occurrence whose date is added in Marfa, and brings it back when the date goes", async () => {
    calendar.put(me, series);
    await landed();
    const one = row(`${me}/weekly`);

    server.edit(one.id, {
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261026T100000Z"],
    });
    await landed();
    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, "weekly_20261026T100000Z"),
        body: { status: "cancelled" },
      }),
    ]);
    expect(
      calendar.calls.find((call) => call.query["originalStart"] !== undefined)
        ?.query["originalStart"],
    ).toBe("2026-10-26T10:00:00Z");

    await landed();
    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20261026T100000Z",
    ]);

    server.edit(one.id, { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] });
    await landed();
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      path: eventPath(me, "weekly_20261026T100000Z"),
      body: { status: "confirmed" },
    });
    expect(calendar.event(me, "weekly_20261026T100000Z")?.["status"]).toBe(
      "confirmed",
    );
    expect(
      writes().filter((call) => call.path === eventPath(me, "weekly")),
    ).toEqual([]);
  });

  it("edits a changed occurrence on its own", async () => {
    calendar.put(me, series);
    calendar.put(me, {
      ...occurrence("2026-10-26T10:00:00Z"),
      summary: "Planning, later",
      start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
      end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
      organizer: { email: me, self: true },
    });
    await landed();
    const exception = row(`${me}/weekly_20261026T100000Z`);

    server.edit(exception.id, { title: "Planning, much later" });
    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, "weekly_20261026T100000Z"),
        body: { summary: "Planning, much later" },
      }),
    ]);
  });

  it("deletes the series once when it is trashed, and not the changed occurrences the trash took with it", async () => {
    calendar.put(me, series);
    for (const at of ["2026-10-26T10:00:00Z", "2026-11-02T10:00:00Z"]) {
      calendar.put(me, {
        ...occurrence(at),
        summary: "Planning, changed",
        start: { dateTime: at, timeZone: london },
        end: { dateTime: at.replace("T10", "T11"), timeZone: london },
        organizer: { email: me, self: true },
      });
    }
    await landed();
    const parent = row(`${me}/weekly`);

    server.trash(parent.id);
    expect(
      server.rows.filter((r) => r.type === eventType && r.state === "trashed"),
    ).toHaveLength(3);
    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: eventPath(me, "weekly"),
      }),
    ]);
  });
});

describe("the safety stop", () => {
  async function many(
    count: number,
    on = me,
    rest: Record<string, unknown> = {},
  ): Promise<void> {
    for (let n = 0; n < count; n += 1) {
      calendar.put(
        on,
        timed(
          `e${String(n)}`,
          `E${String(n)}`,
          "2026-11-02T12:00:00Z",
          "2026-11-02T13:00:00Z",
          rest,
        ),
      );
    }
    await landed();
  }

  function purgeFirst(count: number, on = me): void {
    for (let n = 0; n < count; n += 1) {
      server.purge(`${sub}:${on}/e${String(n)}`);
    }
  }

  it("does not count the events of a calendar that left the account's list", async () => {
    await many(12, team);
    calendar.calendars = calendar.calendars.filter((one) => one["id"] !== team);
    await landed();
    purgeFirst(12, team);

    await landed();

    expect(writes()).toEqual([]);
    expect(conditions()["purges-held"]).toBeUndefined();
    expect(calendar.event(team, "e0")?.["status"]).toBe("confirmed");
  });

  it("does not count the events of a calendar the account can now only read", async () => {
    await many(12, team);
    calendar.calendars = calendar.calendars.map((one) =>
      one["id"] === team ? { ...one, accessRole: "reader" } : one,
    );
    purgeFirst(12, team);

    await landed({
      GOOGLE_CALENDAR_READ_ONLY_CALENDARS: `${holidays},${team}`,
    });

    expect(writes()).toEqual([]);
    expect(conditions()["purges-held"]).toBeUndefined();
  });

  it("does not count events Marfa may not change", async () => {
    await many(12, me, { locked: true });
    purgeFirst(12);

    await landed();

    expect(writes()).toEqual([]);
    expect(conditions()["purges-held"]).toBeUndefined();
  });

  it("takes a calendar Google no longer has as holding nothing to delete", async () => {
    await many(12);
    purgeFirst(12);
    calendar.failNext(
      (call) =>
        call.method === "GET" &&
        call.path === eventPath(me) &&
        call.query["fields"] !== undefined,
      404,
      { error: { code: 404, message: "Not Found" } },
    );

    await landed();

    expect(conditions()["purges-held"]).toBeUndefined();
  });

  it("holds a purge that would delete most of a calendar until a person confirms its size", async () => {
    await many(20);
    for (let n = 0; n < 11; n += 1) server.purge(`${sub}:${me}/e${String(n)}`);

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["purges-held"]).toContain("11 of the 20 events on Me");

    expect(await once({ GOOGLE_CALENDAR_CONFIRM_PURGES: "12" })).toBe(1);
    expect(writes()).toEqual([]);

    await landed({ GOOGLE_CALENDAR_CONFIRM_PURGES: "11" });
    expect(writes("DELETE")).toHaveLength(11);
  });

  it("lets a smaller purge through", async () => {
    await many(60);
    for (let n = 0; n < 11; n += 1) server.purge(`${sub}:${me}/e${String(n)}`);

    await landed();
    expect(writes("DELETE")).toHaveLength(11);
  });
});
