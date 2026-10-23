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

/** The value the held condition asks GOOGLE_CALENDAR_CONFIRM_DELETES to
 *  take. */
function confirmation(): string {
  const held = conditions()["deletes-held"] ?? "";
  const value = /GOOGLE_CALENDAR_CONFIRM_DELETES=(\S+) for one run/.exec(
    held,
  )?.[1];
  if (value === undefined) throw new Error(`no confirmation in: ${held}`);
  return value;
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
    const etag = one.properties["etag"];
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
        ifMatch: etag,
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

  it("does not move an event that Google changed after the connector checked it", async () => {
    const one = await read();
    const etag = one.properties["etag"];
    const edge = server.edges.find(
      (e) => e.source_id === one.id && e.edge_type === inCalendar,
    );
    if (edge === undefined) throw new Error("no edge");
    server.removeEdge(edge.id);
    server.drawEdge(one.id, calendarRow(team).id, inCalendar);
    // A guest is added between the connector's check and its move.
    calendar.failNext((call) => {
      if (call.method !== "POST" || !call.path.endsWith("/move")) {
        return false;
      }
      calendar.put(me, {
        ...calendar.event(me, "e1"),
        attendees: [
          { email: me, self: true, organizer: true },
          { email: "kim@example.com" },
        ],
      });
      return false;
    }, 500);

    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `${eventPath(me, "e1")}/move`,
        ifMatch: etag,
      }),
    ]);
    expect(calendar.event(me, "e1")?.["status"]).toBe("confirmed");
    expect(calendar.event(team, "e1")).toBeUndefined();
    expect(server.byId(one.id).properties["google_id"]).toBe(`${me}/e1`);
    expect(Object.values(conditions()).join(" ")).toContain('changed "Lunch"');

    await landed();
    expect(writes()).toHaveLength(1);
    expect(calendar.event(team, "e1")).toBeUndefined();
    expect(conditions()[`declined:${one.id}`]).toContain("guests");
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

  /** One listing of the account's calendars leaves out the team calendar,
   *  which Google still has. */
  function unlistTeam(): void {
    const entry = calendar.calendars.find((one) => one["id"] === team);
    if (entry === undefined) throw new Error("no team calendar");
    calendar.calendars = calendar.calendars.filter((one) => one !== entry);
    calendar.unlisted = [entry];
  }

  function calendarEntryPath(id: string): string {
    return `/calendar/v3/users/me/calendarList/${encodeURIComponent(id)}`;
  }

  it.each(["trash", "purge"] as const)(
    "deletes on a %s the event of a calendar one listing leaves out while Google still has it",
    async (how) => {
      calendar.put(
        team,
        timed("e1", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
      );
      await landed();
      const one = row(`${team}/e1`);
      unlistTeam();

      if (how === "trash") server.trash(one.id);
      else server.purge(`${sub}:${team}/e1`);
      await landed();

      expect(writes()).toEqual([
        expect.objectContaining({
          method: "DELETE",
          path: eventPath(team, "e1"),
        }),
      ]);
      expect(calendar.event(team, "e1")?.["status"]).toBe("cancelled");
    },
  );

  it.each(["trash", "purge"] as const)(
    "keeps a %s for a later run while Google can't say whether a calendar one listing leaves out is still there",
    async (how) => {
      calendar.put(
        team,
        timed("e1", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
      );
      await landed();
      const one = row(`${team}/e1`);
      unlistTeam();
      const asked = (call: Call) =>
        call.method === "GET" && call.path === calendarEntryPath(team);
      // Both the read and the delete ask about the calendar.
      calendar.failNext(asked, 503);
      calendar.failNext(asked, 503);

      if (how === "trash") server.trash(one.id);
      else server.purge(`${sub}:${team}/e1`);
      await landed();

      expect(writes()).toEqual([]);
      expect(
        calendar.calls.filter(asked).length,
        "the delete asked Google about the calendar",
      ).toBe(2);
      expect(Object.values(conditions()).join(" ")).toContain(team);

      await landed();
      expect(writes()).toEqual([
        expect.objectContaining({
          method: "DELETE",
          path: eventPath(team, "e1"),
        }),
      ]);
    },
  );
});

describe("a trash or purge before a lost create is settled", () => {
  /** A row made in Marfa whose create Google made, with the answer lost. */
  async function lost(): Promise<{ one: Row; id: string }> {
    await landed();
    const one = made(planning);
    const id = eventIdFor(one.id);
    calendar.loseAnswer((call) => call.method === "POST");
    await landed();
    expect(calendar.event(me, id)?.["status"]).toBe("confirmed");
    expect(server.connectorState?.["outbound"]).toHaveLength(1);
    return { one, id };
  }

  /** A row made in Marfa whose create never reached Google. */
  async function failed(): Promise<{ one: Row; id: string }> {
    await landed();
    const one = made(planning);
    const id = eventIdFor(one.id);
    calendar.failNext((call) => call.method === "POST", 500);
    await landed();
    expect(calendar.event(me, id)).toBeUndefined();
    expect(server.connectorState?.["outbound"]).toHaveLength(1);
    return { one, id };
  }

  it("deletes the event the create made, once, when the row is trashed", async () => {
    const { one, id } = await lost();
    const etag = calendar.event(me, id)?.["etag"];

    server.trash(one.id);
    await landed();

    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${eventPath(me)}`,
      `DELETE ${eventPath(me, id)}`,
    ]);
    expect(writes("DELETE")[0]?.ifMatch).toBe(etag);
    expect(calendar.event(me, id)?.["status"]).toBe("cancelled");
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    expect(server.byId(one.id).state).toBe("trashed");
    expect(server.byId(one.id).properties["google_id"]).toBeUndefined();
    expect(conditions()).toEqual({});

    await landed();
    expect(writes()).toHaveLength(2);
    expect(eventRows()).toEqual([]);
  });

  it("sends nothing when the row is trashed and the create never reached Google", async () => {
    const { one } = await failed();

    server.trash(one.id);
    await landed();

    expect(writes().map((call) => call.method)).toEqual(["POST"]);
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    expect(conditions()).toEqual({});
    await landed();
    expect(writes()).toHaveLength(1);
    expect(eventRows()).toEqual([]);
  });

  it("deletes the event the create made, once, when the row is purged, and stops holding its id", async () => {
    const { one, id } = await lost();

    server.purgeById(one.id);
    await landed();

    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${eventPath(me)}`,
      `DELETE ${eventPath(me, id)}`,
    ]);
    expect(calendar.event(me, id)?.["status"]).toBe("cancelled");
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    await landed();
    expect(writes()).toHaveLength(2);
    expect(eventRows()).toEqual([]);
  });

  it("sends nothing when the row is purged and the create never reached Google, and stops holding its id", async () => {
    const { one, id } = await failed();

    server.purgeById(one.id);
    await landed();

    expect(writes().map((call) => call.method)).toEqual(["POST"]);
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    expect(conditions()).toEqual({});

    // The read takes an event under that id as any other once nothing is
    // making it.
    calendar.put(
      me,
      timed(
        id,
        "Made in Google",
        "2026-11-03T09:00:00Z",
        "2026-11-03T10:00:00Z",
      ),
    );
    await landed();
    expect(row(`${me}/${id}`).properties["title"]).toBe("Made in Google");
    expect(writes()).toHaveLength(1);
  });

  it("links the restored row to the event the create made, with no twin", async () => {
    const { one, id } = await lost();
    server.trash(one.id);
    server.restore(one.id);

    await landed();

    expect(writes("DELETE")).toEqual([]);
    expect(calendar.event(me, id)?.["status"]).toBe("confirmed");
    expect(server.byId(one.id)).toMatchObject({
      state: "active",
      properties: { google_id: `${me}/${id}` },
    });
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    await landed();
    expect(eventRows()).toEqual([one.id]);
  });

  it("brings the event back, linked, when the row is restored after a delete whose answer was lost", async () => {
    const { one, id } = await lost();
    server.trash(one.id);
    calendar.loseAnswer((call) => call.method === "DELETE");
    await landed();
    expect(calendar.event(me, id)?.["status"]).toBe("cancelled");
    expect(server.connectorState?.["outbound"]).toHaveLength(1);
    expect(eventRows()).toEqual([]);

    server.restore(one.id);
    await landed();

    expect(writes("DELETE")).toHaveLength(1);
    expect(calendar.event(me, id)).toMatchObject({
      status: "confirmed",
      summary: "Planning",
    });
    expect(server.byId(one.id)).toMatchObject({
      state: "active",
      properties: { google_id: `${me}/${id}` },
    });
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    await landed();
    expect(eventRows()).toEqual([one.id]);
  });

  it("settles a trash whose delete's answer was lost without deleting again", async () => {
    const { one, id } = await lost();
    server.trash(one.id);
    calendar.loseAnswer((call) => call.method === "DELETE");
    await landed();
    expect(server.connectorState?.["outbound"]).toHaveLength(1);

    await landed();

    expect(writes("DELETE")).toHaveLength(1);
    expect(calendar.event(me, id)?.["status"]).toBe("cancelled");
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    expect(server.byId(one.id).state).toBe("trashed");
    await landed();
    expect(eventRows()).toEqual([]);
  });

  it("sends nothing when a row whose create was refused before it was sent is trashed", async () => {
    await landed();
    const one = made(planning, holidays);
    await landed();
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    // Nothing can hold the row's id, as no create was sent; one put there
    // shows that the trash does not look for it.
    const id = eventIdFor(one.id);
    calendar.put(
      me,
      timed(id, "Planning", planning.starts_at, planning.ends_at),
    );

    server.trash(one.id);
    await landed();

    expect(writes()).toEqual([]);
    expect(calendar.event(me, id)?.["status"]).toBe("confirmed");
  });

  it("settles the trash of a row whose create Google refused, and makes the event when the row is restored", async () => {
    await landed();
    const one = made(planning);
    const id = eventIdFor(one.id);
    calendar.failNext((call) => call.method === "POST", 400);
    await landed();
    expect(server.connectorState?.["outbound"]).toHaveLength(1);

    server.trash(one.id);
    await landed();

    expect(writes().map((call) => call.method)).toEqual(["POST"]);
    expect(server.connectorState?.["outbound"]).toBeUndefined();
    expect(conditions()).toEqual({});

    server.restore(one.id);
    await landed();
    expect(writes().map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calendar.event(me, id)?.["status"]).toBe("confirmed");
    expect(server.byId(one.id).properties["google_id"]).toBe(`${me}/${id}`);
    await landed();
    expect(eventRows()).toEqual([one.id]);
  });

  it("counts the events those trashes would delete in the safety stop, and only those", async () => {
    await landed();
    const rows = Array.from({ length: 11 }, (_, n) =>
      made({ ...planning, title: `Planning ${String(n)}` }),
    );
    rows.forEach(() => {
      calendar.loseAnswer((call) => call.method === "POST");
    });
    await landed();
    expect(server.connectorState?.["outbound"]).toHaveLength(11);
    for (const one of rows) server.trash(one.id);

    expect(await once()).toBe(1);
    expect(writes("DELETE")).toEqual([]);
    expect(conditions()["deletes-held"]).toContain("11 of the 11 events on Me");

    await landed({ GOOGLE_CALENDAR_CONFIRM_DELETES: confirmation() });
    expect(writes("DELETE")).toHaveLength(11);
    expect(server.connectorState?.["outbound"]).toBeUndefined();
  });

  it("does not count trashes whose creates never reached Google", async () => {
    await landed();
    const rows = Array.from({ length: 11 }, (_, n) =>
      made({ ...planning, title: `Planning ${String(n)}` }),
    );
    rows.forEach(() => {
      calendar.failNext((call) => call.method === "POST", 500);
    });
    await landed();
    expect(server.connectorState?.["outbound"]).toHaveLength(11);
    for (const one of rows) server.trash(one.id);

    await landed();

    expect(writes("DELETE")).toEqual([]);
    expect(conditions()["deletes-held"]).toBeUndefined();
    expect(server.connectorState?.["outbound"]).toBeUndefined();
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

  const guests = {
    attendees: [
      { email: me, self: true, organizer: true },
      { email: "kim@example.com" },
    ],
  };

  it("declines to cancel an occurrence Marfa may not change, and puts its date back", async () => {
    calendar.put(me, series);
    calendar.put(me, {
      ...occurrence("2026-10-26T10:00:00Z"),
      summary: "Planning with Kim",
      start: { dateTime: "2026-10-26T10:00:00Z", timeZone: london },
      end: { dateTime: "2026-10-26T11:00:00Z", timeZone: london },
      organizer: { email: me, self: true },
      ...guests,
    });
    await landed();
    const one = row(`${me}/weekly`);

    server.edit(one.id, {
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261026T100000Z"],
    });
    await landed();

    expect(writes()).toEqual([]);
    expect(calendar.event(me, "weekly_20261026T100000Z")?.["status"]).toBe(
      "confirmed",
    );
    const said = conditions()[`declined:${one.id}`];
    expect(said).toContain("2026-10-26T10:00:00Z");
    expect(said).toContain("guests other than the account");
    expect(server.byId(one.id).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);
  });

  it("declines to bring back a cancelled occurrence Marfa may not change, and keeps its date", async () => {
    calendar.put(me, series);
    const { id, ...rest } = occurrence("2026-10-26T10:00:00Z");
    calendar.cancel(me, id, {
      ...rest,
      organizer: { email: me, self: true },
      ...guests,
    });
    await landed();
    const one = row(`${me}/weekly`);
    const lines = ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261026T100000Z"];
    expect(one.properties["recurrence"]).toEqual(lines);

    server.edit(one.id, { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] });
    await landed();

    expect(writes()).toEqual([]);
    expect(calendar.event(me, id)?.["status"]).toBe("cancelled");
    expect(conditions()[`declined:${one.id}`]).toContain(
      "guests other than the account",
    );
    expect(server.byId(one.id).properties["recurrence"]).toEqual(lines);
  });

  it("makes a series Google forgot again with every date it skips, Google's own and those it cancelled by name", async () => {
    calendar.put(me, {
      ...series,
      recurrence: [
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=Europe/London:20261026T100000",
      ],
    });
    const { id, ...rest } = occurrence("2026-11-02T10:00:00Z");
    calendar.cancel(me, id, rest);
    await landed();
    const one = row(`${me}/weekly`);
    const lines = [
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE;TZID=Europe/London:20261026T100000",
      "EXDATE:20261102T100000Z",
    ];
    expect(one.properties["recurrence"]).toEqual(lines);
    server.trash(one.id);
    await landed();
    calendar.forget(me, "weekly");

    server.restore(one.id);
    await landed();

    const made = writes("POST").at(-1);
    expect(made?.body?.["id"]).toBe(eventIdFor(one.id));
    expect(made?.body?.["recurrence"]).toEqual(lines);
    expect(server.byId(one.id).properties["recurrence"]).toEqual(lines);
  });

  it("makes an all-day series Google forgot again with the dates it cancelled by name", async () => {
    calendar.put(me, {
      ...series,
      id: "daily",
      start: { date: "2026-10-19" },
      end: { date: "2026-10-20" },
      recurrence: ["RRULE:FREQ=DAILY;COUNT=30"],
    });
    calendar.cancel(me, "daily_20261102", {
      recurringEventId: "daily",
      originalStartTime: { date: "2026-11-02" },
    });
    await landed();
    const one = row(`${me}/daily`);
    const lines = ["RRULE:FREQ=DAILY;COUNT=30", "EXDATE;VALUE=DATE:20261102"];
    expect(one.properties["recurrence"]).toEqual(lines);
    server.trash(one.id);
    await landed();
    calendar.forget(me, "daily");

    server.restore(one.id);
    await landed();

    expect(writes("POST").at(-1)?.body).toMatchObject({
      id: eventIdFor(one.id),
      start: { date: "2026-10-19" },
      recurrence: lines,
    });
  });

  function madeUnder(parent: Row, properties: Record<string, unknown>): Row {
    const one = server.insert(undefined, properties, eventType, "person");
    server.drawEdge(parent.id, one.id, "parent-of");
    return one;
  }

  const moved = {
    title: "Planning, later",
    starts_at: "2026-10-26T14:00:00Z",
    ends_at: "2026-10-26T15:00:00Z",
    timezone: london,
    original_starts_at: "2026-10-26T10:00:00Z",
  };

  it("changes the occurrence it replaces when a changed occurrence is made in Marfa", async () => {
    calendar.put(me, series);
    await landed();
    const parent = row(`${me}/weekly`);
    const one = madeUnder(parent, moved);

    await landed();

    const instance = "weekly_20261026T100000Z";
    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, instance),
        body: expect.objectContaining({
          summary: "Planning, later",
          start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
          end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
        }) as unknown,
      }),
    ]);
    expect(writes()[0]?.ifMatch).toMatch(/^"\d+"$/);
    expect(calendar.event(me, instance)).toMatchObject({
      summary: "Planning, later",
      recurringEventId: "weekly",
    });
    expect(server.byId(one.id).properties).toMatchObject({
      google_id: `${me}/${instance}`,
      original_starts_at: "2026-10-26T10:00:00Z",
      recurring_event_id: "weekly",
    });

    await landed();
    expect(writes()).toHaveLength(1);
    expect(eventRows().sort()).toEqual([parent.id, one.id].sort());
  });

  it("changes the occurrence on the next run when Google fails the first change", async () => {
    calendar.put(me, series);
    await landed();
    const one = madeUnder(row(`${me}/weekly`), moved);
    calendar.failNext((call) => call.method === "PATCH", 503, {
      error: { code: 503, message: "Backend Error" },
    });

    await landed();
    const instance = "weekly_20261026T100000Z";
    expect(calendar.event(me, instance)?.["summary"]).not.toBe(
      "Planning, later",
    );
    expect(Object.keys(conditions()).length).toBeGreaterThan(0);

    await landed();
    expect(calendar.event(me, instance)).toMatchObject({
      summary: "Planning, later",
      start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
    });
    expect(server.byId(one.id).properties).toMatchObject({
      google_id: `${me}/${instance}`,
      title: "Planning, later",
    });
    expect(writes("POST")).toEqual([]);
  });

  function failPatch(): void {
    calendar.failNext((call) => call.method === "PATCH", 503, {
      error: { code: 503, message: "Backend Error" },
    });
  }

  it.each([
    ["gone", false],
    ["cancelled", true],
  ])(
    "brings back a cancelled occurrence on the next run when Google fails the first change, then carries an edit made since, with the occurrence answered as %s",
    async (_, getsCancelled) => {
      calendar.getsCancelled = getsCancelled;
      calendar.put(me, series);
      const instance = "weekly_20261026T100000Z";
      const { id, ...rest } = occurrence("2026-10-26T10:00:00Z");
      calendar.cancel(me, id, rest);
      await landed();
      const one = madeUnder(row(`${me}/weekly`), moved);
      failPatch();

      await landed();
      expect(calendar.event(me, instance)?.["status"]).toBe("cancelled");
      expect(server.byId(one.id).properties["google_id"]).toBe(
        `${me}/${instance}`,
      );

      server.edit(one.id, { title: "Planning, much later" });
      await landed();
      expect(calendar.event(me, instance)).toMatchObject({
        status: "confirmed",
        summary: "Planning, later",
        start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
        end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
      });
      expect(conditions()).toEqual({});
      expect(server.byId(one.id).state).toBe("active");
      expect(server.byId(one.id).properties["title"]).toBe(
        "Planning, much later",
      );

      await landed();
      expect(writes().at(-1)).toMatchObject({
        method: "PATCH",
        path: eventPath(me, instance),
        body: { summary: "Planning, much later" },
      });
      expect(calendar.event(me, instance)).toMatchObject({
        status: "confirmed",
        summary: "Planning, much later",
      });
      expect(conditions()).toEqual({});
      expect(server.byId(one.id).properties["etag"]).toBe(
        calendar.event(me, instance)?.["etag"],
      );

      const sent = writes().length;
      await landed();
      expect(writes()).toHaveLength(sent);
    },
  );

  function wholeReads(): number {
    return calendar.calls.filter(
      (call) =>
        call.method === "GET" &&
        call.path === eventPath(me) &&
        call.query["syncToken"] === undefined &&
        call.query["pageToken"] === undefined,
    ).length;
  }

  it.each([
    ["gone", false],
    ["cancelled", true],
  ])(
    "keeps a changed occurrence made in Marfa through a whole read before its change to a cancelled occurrence lands, with the occurrence answered as %s",
    async (_, getsCancelled) => {
      calendar.getsCancelled = getsCancelled;
      calendar.put(me, series);
      const instance = "weekly_20261026T100000Z";
      const exdate = "EXDATE:20261026T100000Z";
      const { id, ...rest } = occurrence("2026-10-26T10:00:00Z");
      calendar.cancel(me, id, rest);
      await landed();
      const parent = row(`${me}/weekly`);
      expect(parent.properties["recurrence"]).toContain(exdate);
      const one = madeUnder(parent, moved);

      failPatch();
      await landed();
      expect(calendar.event(me, instance)?.["status"]).toBe("cancelled");
      expect(server.byId(one.id).properties["google_id"]).toBe(
        `${me}/${instance}`,
      );

      failPatch();
      calendar.expire(me);
      const before = wholeReads();
      await landed();
      expect(wholeReads()).toBe(before + 1);
      expect(calendar.event(me, instance)?.["status"]).toBe("cancelled");
      expect(server.byId(one.id).state).toBe("active");
      expect(server.byId(one.id).properties).toMatchObject({
        google_id: `${me}/${instance}`,
        title: "Planning, later",
      });
      // Google still holds the occurrence cancelled, so the series says so.
      expect(row(`${me}/weekly`).properties["recurrence"]).toContain(exdate);

      await landed();
      expect(calendar.event(me, instance)).toMatchObject({
        status: "confirmed",
        summary: "Planning, later",
      });
      expect(server.byId(one.id).state).toBe("active");
      expect(conditions()).toEqual({});
      expect(row(`${me}/weekly`).properties["recurrence"]).not.toContain(
        exdate,
      );
      expect(eventRows().sort()).toEqual([parent.id, one.id].sort());
    },
  );

  it("archives a changed occurrence made in Marfa on a whole read once its change landed and Google then cancelled it", async () => {
    calendar.put(me, series);
    await landed();
    const one = madeUnder(row(`${me}/weekly`), moved);
    await landed();
    const instance = "weekly_20261026T100000Z";
    expect(calendar.event(me, instance)?.["summary"]).toBe("Planning, later");

    const { id, ...rest } = occurrence("2026-10-26T10:00:00Z");
    calendar.cancel(me, id, rest);
    calendar.expire(me);
    const before = wholeReads();
    await landed();

    expect(wholeReads()).toBe(before + 1);
    expect(server.byId(one.id).state).toBe("archived");
    expect(row(`${me}/weekly`).properties["recurrence"]).toContain(
      "EXDATE:20261026T100000Z",
    );
  });

  it("sends nothing when a changed occurrence made in Marfa is trashed before its change lands", async () => {
    calendar.put(me, series);
    await landed();
    const one = madeUnder(row(`${me}/weekly`), moved);
    failPatch();
    await landed();
    const instance = "weekly_20261026T100000Z";
    const sent = writes().length;

    server.trash(one.id);
    await landed();

    expect(writes()).toHaveLength(sent);
    expect(writes().map((call) => call.method)).toEqual(["PATCH"]);
    expect(calendar.event(me, instance)).toBeUndefined();
    expect(conditions()).toEqual({});
    expect(server.byId(one.id).state).toBe("trashed");
  });

  it("does not bring back an occurrence read from Google and then cancelled there", async () => {
    calendar.put(me, series);
    const instance = "weekly_20261026T100000Z";
    calendar.put(me, {
      ...occurrence("2026-10-26T10:00:00Z"),
      summary: "Planning, later",
      start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
      end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
      organizer: { email: me, self: true },
    });
    await landed();
    const exception = row(`${me}/${instance}`);
    expect(exception.properties["etag"]).toBeDefined();

    const { id, ...rest } = occurrence("2026-10-26T10:00:00Z");
    calendar.cancel(me, id, rest);
    server.edit(exception.id, { title: "Planning, much later" });
    await landed();

    expect(writes()).toEqual([]);
    expect(calendar.event(me, instance)?.["status"]).toBe("cancelled");
  });

  it("does not bring back an occurrence made in Marfa once it landed and Google then cancelled it", async () => {
    calendar.put(me, series);
    await landed();
    const one = madeUnder(row(`${me}/weekly`), moved);
    await landed();
    const instance = "weekly_20261026T100000Z";
    expect(server.byId(one.id).properties["etag"]).toBeDefined();

    const { id, ...rest } = occurrence("2026-10-26T10:00:00Z");
    calendar.cancel(me, id, rest);
    server.edit(one.id, { title: "Planning, much later" });
    await landed();

    expect(writes()).toHaveLength(1);
    expect(calendar.event(me, instance)?.["status"]).toBe("cancelled");
  });

  const agenda = {
    description: "Agenda: the roadmap",
    location: "https://meet.example.com/planning",
  };

  it("keeps the occurrence's fields that a changed occurrence made in Marfa does not hold", async () => {
    calendar.put(me, { ...series, ...agenda });
    await landed();
    madeUnder(row(`${me}/weekly`), moved);

    await landed();

    const instance = "weekly_20261026T100000Z";
    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, instance),
        body: {
          summary: "Planning, later",
          start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
          end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
        },
      }),
    ]);
    expect(calendar.event(me, instance)).toMatchObject({
      ...agenda,
      summary: "Planning, later",
    });
  });

  it("keeps the occurrence's title when a changed occurrence made in Marfa has none", async () => {
    calendar.put(me, { ...series, ...agenda });
    await landed();
    const untitled: Record<string, unknown> = { ...moved };
    delete untitled["title"];
    madeUnder(row(`${me}/weekly`), untitled);

    await landed();

    const instance = "weekly_20261026T100000Z";
    expect(writes()[0]?.body).toEqual({
      start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
      end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
    });
    expect(calendar.event(me, instance)).toMatchObject({
      ...agenda,
      summary: "Planning",
    });
  });

  it("sends the fields a changed occurrence made in Marfa sets that differ from the occurrence", async () => {
    calendar.put(me, { ...series, ...agenda });
    await landed();
    madeUnder(row(`${me}/weekly`), {
      ...moved,
      title: "Planning",
      description: "Agenda: hiring",
      place: agenda.location,
    });

    await landed();

    const instance = "weekly_20261026T100000Z";
    expect(writes()[0]?.body).toEqual({
      description: "Agenda: hiring",
      start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
      end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
    });
    expect(calendar.event(me, instance)).toMatchObject({
      summary: "Planning",
      description: "Agenda: hiring",
      location: agenda.location,
    });
  });

  const daily = {
    ...series,
    id: "daily",
    start: { date: "2026-10-26", timeZone: la },
    end: { date: "2026-10-27", timeZone: la },
    recurrence: ["RRULE:FREQ=DAILY;COUNT=30"],
  };

  it("refuses a changed occurrence of an all-day series whose original start is not midnight in the series' zone", async () => {
    calendar.put(team, daily);
    await landed();
    // Midnight in UTC is 4 or 5 p.m. the day before in Los Angeles.
    const one = madeUnder(row(`${team}/daily`), {
      title: "Offsite",
      starts_at: "2026-11-02T08:00:00Z",
      ends_at: "2026-11-03T08:00:00Z",
      all_day: true,
      timezone: la,
      original_starts_at: "2026-11-02T00:00:00Z",
    });

    await landed();

    expect(writes()).toEqual([]);
    expect(server.byId(one.id).properties["google_id"]).toBeUndefined();
    const said = Object.values(conditions()).join(" ");
    expect(said).toContain('"Offsite"');
    expect(said).toContain("2026-11-02T00:00:00Z");
    expect(said).toContain(la);
  });

  it("changes the occurrence of an all-day series whose original start is midnight in the series' zone", async () => {
    calendar.put(team, daily);
    await landed();
    const one = madeUnder(row(`${team}/daily`), {
      title: "Offsite",
      starts_at: "2026-11-02T08:00:00Z",
      ends_at: "2026-11-03T08:00:00Z",
      all_day: true,
      timezone: la,
      original_starts_at: "2026-11-02T08:00:00Z",
    });

    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(team, "daily_20261102"),
      }),
    ]);
    expect(server.byId(one.id).properties["google_id"]).toBe(
      `${team}/daily_20261102`,
    );
  });

  it("writes a changed occurrence with no zone of its own in its all-day series' zone, not the calendar's", async () => {
    const tokyo = "Asia/Tokyo";
    calendar.put(me, {
      ...daily,
      start: { date: "2026-10-26", timeZone: tokyo },
      end: { date: "2026-10-27", timeZone: tokyo },
    });
    await landed();
    // Midnight of 2 November in Tokyo, which is still 1 November in London.
    madeUnder(row(`${me}/daily`), {
      title: "Offsite",
      starts_at: "2026-11-01T15:00:00Z",
      ends_at: "2026-11-02T15:00:00Z",
      all_day: true,
      original_starts_at: "2026-11-01T15:00:00Z",
    });

    await landed();

    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: eventPath(me, "daily_20261102"),
        body: {
          summary: "Offsite",
          start: { date: "2026-11-02", timeZone: tokyo },
          end: { date: "2026-11-03", timeZone: tokyo },
        },
      }),
    ]);
  });

  it("refuses a changed occurrence of a series Marfa may not change", async () => {
    calendar.put(me, { ...series, locked: true });
    await landed();
    const one = madeUnder(row(`${me}/weekly`), moved);

    await landed();

    expect(writes()).toEqual([]);
    expect(server.byId(one.id).properties["google_id"]).toBeUndefined();
    expect(Object.values(conditions()).join(" ")).toContain("locked");
  });

  it("refuses a changed occurrence for a slot another row already holds, and leaves that occurrence alone", async () => {
    calendar.put(me, series);
    calendar.put(me, {
      ...occurrence("2026-10-26T10:00:00Z"),
      summary: "Planning, earlier",
      start: { dateTime: "2026-10-26T08:00:00Z", timeZone: london },
      end: { dateTime: "2026-10-26T09:00:00Z", timeZone: london },
      organizer: { email: me, self: true },
    });
    await landed();
    const one = madeUnder(row(`${me}/weekly`), moved);

    await landed();

    expect(writes()).toEqual([]);
    expect(calendar.event(me, "weekly_20261026T100000Z")?.["summary"]).toBe(
      "Planning, earlier",
    );
    expect(server.byId(one.id).properties["google_id"]).toBeUndefined();
    expect(Object.values(conditions()).join(" ")).toContain(
      "weekly_20261026T100000Z",
    );
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
    expect(conditions()["deletes-held"]).toBeUndefined();
    expect(calendar.event(team, "e0")?.["status"]).toBe("confirmed");
  });

  it("counts the events of a calendar one listing leaves out while Google still has it", async () => {
    await many(12, team);
    const entry = calendar.calendars.find((one) => one["id"] === team);
    if (entry === undefined) throw new Error("no team calendar");
    calendar.calendars = calendar.calendars.filter((one) => one !== entry);
    calendar.unlisted = [entry];
    purgeFirst(12, team);
    calendar.failNext(
      (call) =>
        call.method === "GET" &&
        call.path ===
          `/calendar/v3/users/me/calendarList/${encodeURIComponent(team)}`,
      503,
    );

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toBeUndefined();

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toContain(
      "12 of the 12 events on Team",
    );
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
    expect(conditions()["deletes-held"]).toBeUndefined();
  });

  it("does not count events Marfa may not change", async () => {
    await many(12, me, { locked: true });
    purgeFirst(12);

    await landed();

    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toBeUndefined();
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

    expect(conditions()["deletes-held"]).toBeUndefined();
  });

  it("holds a purge that would delete most of a calendar until a person confirms that batch", async () => {
    await many(20);
    for (let n = 0; n < 11; n += 1) server.purge(`${sub}:${me}/e${String(n)}`);

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toContain("11 of the 20 events on Me");
    const value = confirmation();
    expect(value).toMatch(/^11:[0-9a-f]{12}$/);

    for (const wrong of ["11", "12", value.replace(/^11/, "12")]) {
      expect(await once({ GOOGLE_CALENDAR_CONFIRM_DELETES: wrong })).toBe(1);
      expect(writes()).toEqual([]);
      expect(conditions()["deletes-held"]).toContain(
        `GOOGLE_CALENDAR_CONFIRM_DELETES is ${wrong}, which names another batch`,
      );
    }

    await landed({ GOOGLE_CALENDAR_CONFIRM_DELETES: value });
    expect(writes("DELETE")).toHaveLength(11);
  });

  it("lets a smaller purge through", async () => {
    await many(60);
    for (let n = 0; n < 11; n += 1) server.purge(`${sub}:${me}/e${String(n)}`);

    await landed();
    expect(writes("DELETE")).toHaveLength(11);
  });

  function trash(from: number, to: number, on = me): void {
    for (let n = from; n < to; n += 1) {
      server.trash(row(`${on}/e${String(n)}`).id);
    }
  }

  it("holds a trash that would delete most of a calendar, sending nothing", async () => {
    await many(20);
    trash(0, 11);

    expect(await once()).toBe(1);

    expect(writes()).toEqual([]);
    expect(calendar.event(me, "e0")?.["status"]).toBe("confirmed");
    const held = conditions()["deletes-held"];
    expect(held).toContain("11 of the 20 events on Me");
    expect(held).toContain("restore the trashed rows in Marfa");
    expect(held).toContain("GOOGLE_CALENDAR_CONFIRM_DELETES=11:");

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
  });

  it("lets a few trashes through", async () => {
    await many(20);
    trash(0, 3);

    await landed();

    expect(writes("DELETE")).toHaveLength(3);
    expect(conditions()["deletes-held"]).toBeUndefined();
  });

  it("does not count trashes of events Marfa may not change", async () => {
    await many(12, me, { locked: true });
    trash(0, 12);

    await once();

    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toBeUndefined();
  });

  it("counts trashes and purges together, and a row trashed then purged once", async () => {
    await many(20);
    trash(0, 6);
    for (let n = 6; n < 11; n += 1) server.purge(`${sub}:${me}/e${String(n)}`);

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toContain("11 of the 20 events on Me");

    for (let n = 0; n < 3; n += 1) server.purge(`${sub}:${me}/e${String(n)}`);

    expect(await once()).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toContain("11 of the 20 events on Me");
  });

  it("lets through exactly the batch a confirmation names", async () => {
    await many(40);
    trash(0, 11);

    expect(await once()).toBe(1);
    const value = confirmation();
    await landed({ GOOGLE_CALENDAR_CONFIRM_DELETES: value });
    expect(writes("DELETE")).toHaveLength(11);
    expect(conditions()["deletes-held"]).toBeUndefined();

    trash(11, 23);
    calendar.calls.length = 0;
    expect(await once({ GOOGLE_CALENDAR_CONFIRM_DELETES: value })).toBe(1);
    expect(writes()).toEqual([]);
    expect(conditions()["deletes-held"]).toContain("12 of the 29 events on Me");
  });

  it("holds a batch of the same size as the one a confirmation names", async () => {
    await many(40);
    trash(0, 11);
    expect(await once()).toBe(1);
    const value = confirmation();

    for (let n = 0; n < 11; n += 1)
      server.restore(row(`${me}/e${String(n)}`).id);
    trash(11, 22);

    expect(await once({ GOOGLE_CALENDAR_CONFIRM_DELETES: value })).toBe(1);
    expect(writes()).toEqual([]);
    const held = conditions()["deletes-held"];
    expect(held).toContain("11 of the 40 events on Me");
    expect(held).toContain(
      `GOOGLE_CALENDAR_CONFIRM_DELETES is ${value}, which names another batch`,
    );
    const next = confirmation();
    expect(next).not.toBe(value);

    await landed({ GOOGLE_CALENDAR_CONFIRM_DELETES: next });
    expect(
      writes("DELETE")
        .map((call) => call.path)
        .sort(),
    ).toEqual(
      Array.from({ length: 11 }, (_, n) =>
        eventPath(me, `e${String(n + 11)}`),
      ).sort(),
    );
    expect(calendar.event(me, "e0")?.["status"]).toBe("confirmed");
  });
});
