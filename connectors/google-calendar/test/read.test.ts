import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  clientEnv,
  freshToken,
  GoogleStub,
} from "../../../shared/google/test/stub.js";
import {
  birthdays,
  calendarListScope,
  calendarType,
  eventsScope,
  eventType,
  inCalendar,
} from "../src/config.js";
import { createConnector } from "../src/connector.js";
import { CalendarStub, type Call } from "./calendar-stub.js";

const me = "me@example.com";
const team = "team-calendar@example.com";
const london = "Europe/London";
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
  calendar.calendars = [primary(), writable()];
});

afterEach(async () => {
  await server.stop();
  await google.stop();
  await calendar.stop();
});

function primary(): Record<string, unknown> {
  return {
    id: me,
    summary: "Me",
    timeZone: london,
    accessRole: "owner",
    primary: true,
    backgroundColor: "#9fe1e7",
  };
}

function writable(): Record<string, unknown> {
  return {
    id: team,
    summary: "Team",
    summaryOverride: "Team (mine)",
    timeZone: "America/Los_Angeles",
    accessRole: "writer",
  };
}

function reader(): Record<string, unknown> {
  return {
    id: "holidays@example.com",
    summary: "Holidays",
    timeZone: london,
    accessRole: "reader",
  };
}

async function once(
  settings: Record<string, string> = {},
  token = freshToken(),
): Promise<number> {
  return start(
    createConnector({
      endpoints: { ...google.endpoints, api: calendar.url },
    }),
    harness.runtime(["--once"], {
      ...clientEnv,
      GOOGLE_REFRESH_TOKEN: token,
      ...settings,
    }),
  );
}

function timed(
  id: string,
  summary: string,
  start: string,
  end: string,
  zone = london,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    summary,
    start: { dateTime: start, timeZone: zone },
    end: { dateTime: end, timeZone: zone },
    ...rest,
  };
}

function allDay(
  id: string,
  first: string,
  after: string,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    summary: id,
    start: { date: first },
    end: { date: after },
    ...rest,
  };
}

function row(link: string) {
  const found = server.rows.find(
    (one) => one.type === eventType && one.properties["google_id"] === link,
  );
  if (found === undefined) throw new Error(`no event row ${link}`);
  return found;
}

function events() {
  return server.rows.filter((one) => one.type === eventType);
}

function active(): string[] {
  return events()
    .filter((one) => one.state === "active")
    .map((one) => String(one.properties["google_id"]))
    .sort();
}

function seriesOf(link: string): string[] {
  const id = row(link).id;
  return server.edges
    .filter((edge) => edge.edge_type === "parent-of" && edge.target_id === id)
    .map((edge) => String(server.byId(edge.source_id).properties["google_id"]));
}

function placesOf(link: string): string[] {
  return server
    .targetsOf(row(link).id, inCalendar)
    .map((id) => String(server.byId(id).properties["calendar_id"]));
}

function tokens(): Record<string, { token?: string }> {
  const state = (harness.kept()["state"] ?? {}) as Record<string, unknown>;
  return (state["calendars"] ?? {}) as Record<string, { token?: string }>;
}

function conditions(): string[] {
  return Object.keys(harness.problems());
}

function eventCalls(): Call[] {
  return calendar.calls.filter((call) => call.path.includes("/events"));
}

/** The reads of every event row Marfa holds. */
function heldReads(): number {
  return server.requests.filter(
    (request) =>
      request.method === "GET" &&
      request.path === "/items" &&
      request.query.get("type") === eventType,
  ).length;
}

function asked(path: string): boolean {
  return calendar.calls.some((call) => call.path === `/calendar/v3${path}`);
}

function weekly(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return timed(
    "weekly",
    "Planning",
    "2026-10-19T10:00:00+01:00",
    "2026-10-19T11:00:00+01:00",
    london,
    { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], ...extra },
  );
}

function occurrence(
  at: string,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  const key = at.replace(/[-:]/g, "");
  return {
    id: `weekly_${key}`,
    recurringEventId: "weekly",
    originalStartTime: { dateTime: at, timeZone: london },
    ...rest,
  };
}

function cancelledOccurrence(at: string) {
  const { id, ...rest } = occurrence(at);
  calendar.cancel(me, String(id), rest);
}

describe("a first read", () => {
  it("reads two calendars, keeping one event id that sits on both as two rows", async () => {
    calendar.put(
      me,
      timed("shared", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
    );
    calendar.put(
      team,
      timed("shared", "Lunch", "2026-11-02T12:00:00Z", "2026-11-02T13:00:00Z"),
    );
    calendar.put(
      team,
      timed("only", "Demo", "2026-11-03T12:00:00Z", "2026-11-03T13:00:00Z"),
    );

    expect(await once()).toBe(0);

    const calendars = server.rows.filter((one) => one.type === calendarType);
    expect(
      calendars.map((one) => one.properties["calendar_id"]).sort(),
    ).toEqual([me, team]);
    expect(
      calendars.find((one) => one.properties["calendar_id"] === team)
        ?.properties,
    ).toMatchObject({
      title: "Team (mine)",
      timezone: "America/Los_Angeles",
      access_role: "writer",
    });
    expect(active()).toEqual(
      [`${me}/shared`, `${team}/only`, `${team}/shared`].sort(),
    );
    expect(row(`${me}/shared`).source_id).toBe(`${sub}:${me}/shared`);
    expect(row(`${team}/shared`).source_id).toBe(`${sub}:${team}/shared`);
    expect(row(`${me}/shared`).id).not.toBe(row(`${team}/shared`).id);
    expect(placesOf(`${me}/shared`)).toEqual([me]);
    expect(placesOf(`${team}/shared`)).toEqual([team]);
    expect(Object.keys(tokens()).sort()).toEqual([me, team]);
    expect(tokens()[me]?.token).toBeDefined();
    const listings = eventCalls().filter((call) =>
      call.path.endsWith("/events"),
    );
    for (const call of listings) {
      expect(call.query).toMatchObject({
        singleEvents: "false",
        showDeleted: "true",
        maxResults: "2500",
      });
    }
  });

  it("reads timed events as instants in the event's own zone, the calendar's where it names none, and an end zone only where it differs", async () => {
    calendar.put(me, {
      id: "flight",
      summary: "Flight",
      start: { dateTime: "2026-11-02T08:00:00Z", timeZone: london },
      end: {
        dateTime: "2026-11-02T15:30:00-05:00",
        timeZone: "America/New_York",
      },
      location: "LHR to JFK",
      description: "Gate 4",
    });
    calendar.put(me, {
      id: "bare",
      summary: "Bare",
      start: { dateTime: "2026-11-02T09:00:00+00:00" },
      end: { dateTime: "2026-11-02T10:00:00+00:00" },
    });
    calendar.put(me, {
      id: "titleless",
      start: { dateTime: "2026-11-02T09:00:00Z" },
      end: { dateTime: "2026-11-02T10:00:00Z" },
    });

    expect(await once()).toBe(0);

    expect(row(`${me}/flight`).properties).toMatchObject({
      title: "Flight",
      starts_at: "2026-11-02T08:00:00Z",
      ends_at: "2026-11-02T20:30:00Z",
      timezone: london,
      end_timezone: "America/New_York",
      place: "LHR to JFK",
      description: "Gate 4",
      status: "confirmed",
    });
    expect(row(`${me}/bare`).properties["timezone"]).toBe(london);
    expect(row(`${me}/bare`).properties["end_timezone"]).toBeUndefined();
    expect(row(`${me}/titleless`).properties["title"]).toBe("(No title)");
  });

  it("puts an all-day event on its own days in the zone of its calendar, across a clock change, whatever zone this process is in", async () => {
    calendar.put(team, allDay("la", "2026-10-26", "2026-10-27"));
    calendar.put(me, allDay("changeover", "2026-10-25", "2026-10-26"));
    calendar.put(me, allDay("across", "2026-10-24", "2026-10-27"));
    calendar.put(
      me,
      allDay("own-zone", "2026-10-25", "2026-10-26", {
        start: { date: "2026-10-25", timeZone: "Asia/Tokyo" },
      }),
    );

    expect(await once()).toBe(0);

    expect(row(`${team}/la`).properties).toMatchObject({
      all_day: true,
      timezone: "America/Los_Angeles",
      starts_at: "2026-10-26T07:00:00Z",
      ends_at: "2026-10-27T07:00:00Z",
    });
    expect(row(`${me}/changeover`).properties).toMatchObject({
      all_day: true,
      timezone: london,
      starts_at: "2026-10-24T23:00:00Z",
      ends_at: "2026-10-26T00:00:00Z",
    });
    expect(row(`${me}/across`).properties).toMatchObject({
      starts_at: "2026-10-23T23:00:00Z",
      ends_at: "2026-10-27T00:00:00Z",
    });
    expect(row(`${me}/own-zone`).properties).toMatchObject({
      timezone: "Asia/Tokyo",
      starts_at: "2026-10-24T15:00:00Z",
    });
  });

  it("skips the birthdays calendar and working-location entries, and keeps other kinds of event", async () => {
    calendar.calendars.push({
      id: birthdays,
      summary: "Birthdays",
      timeZone: london,
      accessRole: "reader",
    });
    calendar.put(
      me,
      timed(
        "home",
        "Home",
        "2026-11-02T08:00:00Z",
        "2026-11-02T17:00:00Z",
        london,
        { eventType: "workingLocation" },
      ),
    );
    calendar.put(
      me,
      timed(
        "focus",
        "Focus",
        "2026-11-02T09:00:00Z",
        "2026-11-02T11:00:00Z",
        london,
        { eventType: "focusTime" },
      ),
    );

    expect(
      await once({
        GOOGLE_CALENDAR_READ_ONLY_CALENDARS: birthdays,
      }),
    ).toBe(0);

    expect(active()).toEqual([`${me}/focus`]);
    expect(row(`${me}/focus`).properties).toMatchObject({
      event_kind: "focusTime",
      editable: false,
    });
    expect(
      server.rows
        .filter((one) => one.type === calendarType)
        .map((one) => one.properties["calendar_id"])
        .sort(),
    ).toEqual([me, team]);
    expect(
      calendar.calls.some((call) => call.path.includes("addressbook")),
    ).toBe(false);
  });

  it("states who organizes an event, who is invited, and that Marfa may change only an event the account organizes alone", async () => {
    calendar.put(
      me,
      timed(
        "mine",
        "Mine",
        "2026-11-02T09:00:00Z",
        "2026-11-02T10:00:00Z",
        london,
        {
          organizer: { email: me, self: true },
          attendees: [
            {
              email: me,
              self: true,
              responseStatus: "accepted",
              organizer: true,
            },
            {
              email: "kim@example.com",
              displayName: "Kim",
              responseStatus: "needsAction",
              optional: true,
            },
          ],
          visibility: "private",
          iCalUID: "mine@example.com",
          etag: '"1"',
          htmlLink: "https://calendar.example.test/mine",
        },
      ),
    );
    calendar.put(
      me,
      timed(
        "theirs",
        "Theirs",
        "2026-11-02T09:00:00Z",
        "2026-11-02T10:00:00Z",
        london,
        {
          organizer: { email: "kim@example.com" },
        },
      ),
    );
    calendar.put(
      me,
      timed(
        "theirs-open",
        "Theirs, open to guests",
        "2026-11-02T09:00:00Z",
        "2026-11-02T10:00:00Z",
        london,
        {
          organizer: { email: "kim@example.com" },
          guestsCanModify: true,
          attendees: [{ email: me, self: true }],
        },
      ),
    );
    calendar.put(
      me,
      timed(
        "alone",
        "Alone",
        "2026-11-02T09:00:00Z",
        "2026-11-02T10:00:00Z",
        london,
        {
          organizer: { email: me, self: true },
          attendees: [{ email: me, self: true, organizer: true }],
        },
      ),
    );
    calendar.put(
      me,
      timed(
        "locked",
        "Locked",
        "2026-11-02T09:00:00Z",
        "2026-11-02T10:00:00Z",
        london,
        {
          organizer: { email: me, self: true },
          locked: true,
        },
      ),
    );

    expect(await once()).toBe(0);

    expect(row(`${me}/mine`).properties).toMatchObject({
      organizer: { email: me, self: true },
      guests: [
        { email: me, self: true, organizer: true, response: "accepted" },
        {
          email: "kim@example.com",
          name: "Kim",
          optional: true,
          response: "needsAction",
        },
      ],
      visibility: "private",
      ical_uid: "mine@example.com",
      etag: '"1"',
      url: "https://calendar.example.test/mine",
      editable: false,
      uneditable_reason: "the event has guests other than the account",
    });
    expect(row(`${me}/alone`).properties).toMatchObject({
      editable: true,
    });
    expect(row(`${me}/alone`).properties["uneditable_reason"]).toBeUndefined();
    expect(row(`${me}/theirs`).properties).toMatchObject({
      editable: false,
      uneditable_reason: "someone else organizes the event",
    });
    expect(row(`${me}/theirs-open`).properties).toMatchObject({
      editable: false,
      uneditable_reason: "someone else organizes the event",
    });
    expect(row(`${me}/locked`).properties).toMatchObject({
      editable: false,
      uneditable_reason: "the event is locked",
    });
  });

  it("reads every page, and saves the token only once the last page is written", async () => {
    calendar.pageSize = 2;
    for (const n of [1, 2, 3, 4, 5]) {
      calendar.put(
        me,
        timed(
          `e${String(n)}`,
          `E${String(n)}`,
          "2026-11-02T09:00:00Z",
          "2026-11-02T10:00:00Z",
        ),
      );
    }

    expect(await once()).toBe(0);

    expect(active()).toHaveLength(5);
    const pages = eventCalls().filter(
      (call) =>
        call.path === `/calendar/v3/calendars/${encodeURIComponent(me)}/events`,
    );
    expect(pages.map((call) => call.query["pageToken"])).toEqual([
      undefined,
      "page-2",
      "page-4",
    ]);
    expect(tokens()[me]?.token).toMatch(/^sync-/);
  });
});

describe("a series", () => {
  async function seeded(): Promise<void> {
    calendar.put(me, weekly());
    calendar.put(
      me,
      occurrence("2026-10-26T10:00:00Z", {
        summary: "Planning (moved)",
        start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
        end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
      }),
    );
    cancelledOccurrence("2026-11-02T10:00:00Z");
    expect(await once()).toBe(0);
  }

  it("is one row carrying its rule with a cancelled occurrence removed, and a moved occurrence is its own row beneath it", async () => {
    await seeded();

    expect(row(`${me}/weekly`).properties).toMatchObject({
      timezone: london,
      starts_at: "2026-10-19T09:00:00Z",
      ends_at: "2026-10-19T10:00:00Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261102T100000Z"],
    });
    const moved = row(`${me}/weekly_20261026T100000Z`);
    expect(moved.properties).toMatchObject({
      title: "Planning (moved)",
      starts_at: "2026-10-26T14:00:00Z",
      original_starts_at: "2026-10-26T10:00:00Z",
      recurring_event_id: "weekly",
    });
    expect(seriesOf(`${me}/weekly_20261026T100000Z`)).toEqual([`${me}/weekly`]);
    expect(seriesOf(`${me}/weekly`)).toEqual([]);
    expect(active()).toEqual([`${me}/weekly`, `${me}/weekly_20261026T100000Z`]);
  });

  it("takes an occurrence cancelled in a later delta that does not carry its series, keeping Google's own lines and the cancellations read before", async () => {
    await seeded();
    calendar.calls.length = 0;
    cancelledOccurrence("2026-11-09T10:00:00Z");

    expect(await once()).toBe(0);

    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20261102T100000Z,20261109T100000Z",
    ]);
    expect(row(`${me}/weekly`).state).toBe("active");
    const paths = eventCalls().map((call) => decodeURIComponent(call.path));
    expect(paths).toContain(`/calendar/v3/calendars/${me}/events/weekly`);
    expect(paths).toContain(
      `/calendar/v3/calendars/${me}/events/weekly/instances`,
    );
  });

  it("does not add a date Google's own EXDATE already removes", async () => {
    calendar.put(
      me,
      weekly({
        recurrence: [
          "RRULE:FREQ=WEEKLY;BYDAY=MO",
          "EXDATE;TZID=Europe/London:20261102T100000",
        ],
      }),
    );
    cancelledOccurrence("2026-11-02T10:00:00Z");
    cancelledOccurrence("2026-11-09T10:00:00Z");

    expect(await once()).toBe(0);

    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE;TZID=Europe/London:20261102T100000",
      "EXDATE:20261109T100000Z",
    ]);
  });

  it("keeps a cancellation beyond the window it asks Google about, and drops it when the occurrence comes back", async () => {
    await seeded();
    cancelledOccurrence("2040-11-05T10:00:00Z");
    expect(await once()).toBe(0);
    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20261102T100000Z,20401105T100000Z",
    ]);
    cancelledOccurrence("2026-11-09T10:00:00Z");
    expect(await once()).toBe(0);
    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20261102T100000Z,20261109T100000Z,20401105T100000Z",
    ]);
    calendar.put(
      me,
      occurrence("2040-11-05T10:00:00Z", {
        start: { dateTime: "2040-11-05T10:00:00Z", timeZone: london },
        end: { dateTime: "2040-11-05T11:00:00Z", timeZone: london },
      }),
    );
    expect(await once()).toBe(0);
    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE:20261102T100000Z,20261109T100000Z",
    ]);
  });

  it("brings back an occurrence that was cancelled and restored", async () => {
    await seeded();
    calendar.put(
      me,
      occurrence("2026-11-02T10:00:00Z", {
        start: { dateTime: "2026-11-02T10:00:00Z", timeZone: london },
        end: { dateTime: "2026-11-02T11:00:00Z", timeZone: london },
      }),
    );

    expect(await once()).toBe(0);

    expect(row(`${me}/weekly`).properties["recurrence"]).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);
  });

  it("connects an exception that arrives before its series once the series arrives", async () => {
    calendar.put(
      me,
      occurrence("2026-10-26T10:00:00Z", {
        summary: "Early",
        start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
        end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
      }),
    );
    expect(await once()).toBe(0);
    expect(active()).toEqual([`${me}/weekly_20261026T100000Z`]);
    expect(seriesOf(`${me}/weekly_20261026T100000Z`)).toEqual([]);

    calendar.put(me, weekly());
    expect(await once()).toBe(0);

    expect(seriesOf(`${me}/weekly_20261026T100000Z`)).toEqual([`${me}/weekly`]);
  });

  it("archives the series' changed occurrences with the series when it is deleted", async () => {
    await seeded();
    calendar.cancel(me, "weekly");

    expect(await once()).toBe(0);

    expect(active()).toEqual([]);
  });

  it.each(["archived", "trashed", "purged"] as const)(
    "archives the changed occurrences of a series deleted in Google after it was %s in Marfa",
    async (state) => {
      await seeded();
      const series = row(`${me}/weekly`).id;
      if (state === "purged") server.purgeById(series);
      else server.transition(series, state);
      calendar.cancel(me, "weekly");

      expect(await once()).toBe(0);

      expect(active()).toEqual([]);
      expect(row(`${me}/weekly_20261026T100000Z`).state).toBe("archived");
      if (state !== "purged") expect(row(`${me}/weekly`).state).toBe(state);
    },
  );

  it("leaves out a working-location series and entry that a later cancellation names", async () => {
    calendar.put(
      me,
      timed(
        "office",
        "Office",
        "2026-10-19T08:00:00Z",
        "2026-10-19T17:00:00Z",
        london,
        { eventType: "workingLocation", recurrence: ["RRULE:FREQ=WEEKLY"] },
      ),
    );
    calendar.put(
      me,
      timed(
        "home",
        "Home",
        "2026-10-20T08:00:00Z",
        "2026-10-20T17:00:00Z",
        london,
        { eventType: "workingLocation" },
      ),
    );
    expect(await once()).toBe(0);
    expect(active()).toEqual([]);
    // Neither cancellation carries an event type, so only the event it names
    // says what kind it is.
    calendar.cancel(me, "office_20261026T080000Z", {
      recurringEventId: "office",
      originalStartTime: { dateTime: "2026-10-26T08:00:00Z", timeZone: london },
    });
    calendar.cancel(me, "home_20261020T080000Z", {
      recurringEventId: "home",
      originalStartTime: { dateTime: "2026-10-20T08:00:00Z", timeZone: london },
    });

    expect(await once()).toBe(0);

    expect(active()).toEqual([]);
    expect(conditions()).not.toContain(`events-skipped:${me}`);
    const paths = eventCalls().map((call) => decodeURIComponent(call.path));
    expect(paths).toContain(`/calendar/v3/calendars/${me}/events/office`);
    expect(paths).toContain(`/calendar/v3/calendars/${me}/events/home`);
  });

  it("reads an all-day series with its cancelled days as dates", async () => {
    calendar.put(
      me,
      allDay("holiday", "2026-12-24", "2026-12-25", {
        recurrence: ["RRULE:FREQ=YEARLY"],
      }),
    );
    calendar.cancel(me, "holiday_20271224", {
      recurringEventId: "holiday",
      originalStartTime: { date: "2027-12-24" },
    });

    expect(await once()).toBe(0);

    expect(row(`${me}/holiday`).properties).toMatchObject({
      all_day: true,
      starts_at: "2026-12-24T00:00:00Z",
      ends_at: "2026-12-25T00:00:00Z",
      recurrence: ["RRULE:FREQ=YEARLY", "EXDATE;VALUE=DATE:20271224"],
    });
  });
  it("reads the original start of a changed all-day occurrence in the calendar's zone, not the zone it moved to", async () => {
    calendar.put(
      me,
      allDay("daily", "2026-10-20", "2026-10-21", {
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
    );
    calendar.put(me, {
      id: "daily_20261025",
      summary: "Call from New York",
      recurringEventId: "daily",
      originalStartTime: { date: "2026-10-25" },
      start: {
        dateTime: "2026-10-25T09:00:00-04:00",
        timeZone: "America/New_York",
      },
      end: {
        dateTime: "2026-10-25T10:00:00-04:00",
        timeZone: "America/New_York",
      },
    });

    expect(await once()).toBe(0);

    expect(row(`${me}/daily_20261025`).properties).toMatchObject({
      original_starts_at: "2026-10-24T23:00:00Z",
      starts_at: "2026-10-25T13:00:00Z",
      timezone: "America/New_York",
    });
  });
});

describe("a later run", () => {
  it("reads only what changed, and archives an event Google cancelled", async () => {
    calendar.put(
      me,
      timed("a", "A", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      me,
      timed("b", "B", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    calendar.calls.length = 0;
    calendar.put(
      me,
      timed("a", "A, renamed", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.cancel(me, "b");

    expect(await once()).toBe(0);

    expect(row(`${me}/a`).properties["title"]).toBe("A, renamed");
    expect(row(`${me}/b`).state).toBe("archived");
    expect(eventCalls().map((call) => call.query["syncToken"])).toEqual([
      expect.stringMatching(/^sync-/),
      expect.stringMatching(/^sync-/),
    ]);
  });

  it("reads a calendar whole again when its token is gone, asks about a row that Google does not list, and archives only one it says is deleted", async () => {
    calendar.put(
      me,
      timed("kept", "Kept", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      me,
      timed("doomed", "Doomed", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      me,
      timed("hidden", "Hidden", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    const before = tokens()[me]?.token;
    calendar.forget(me, "doomed");
    calendar.expire(me);
    calendar.calls.length = 0;

    expect(await once()).toBe(0);

    expect(row(`${me}/doomed`).state).toBe("archived");
    expect(row(`${me}/kept`).state).toBe("active");
    expect(row(`${me}/hidden`).state).toBe("active");
    expect(tokens()[me]?.token).not.toBe(before);
    const lists = eventCalls().filter(
      (call) =>
        call.path === `/calendar/v3/calendars/${encodeURIComponent(me)}/events`,
    );
    expect(lists.map((call) => call.query["syncToken"] !== undefined)).toEqual([
      true,
      false,
    ]);
    const asked = eventCalls().filter((call) => !call.path.endsWith("/events"));
    expect(asked.map((call) => decodeURIComponent(call.path))).toEqual([
      `/calendar/v3/calendars/${me}/events/doomed`,
    ]);
  });

  it("leaves a row alone when Google cannot say that it was deleted", async () => {
    calendar.put(
      me,
      timed("doomed", "Doomed", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    calendar.forget(me, "doomed");
    calendar.expire(me);
    calendar.failNext((call) => call.path.endsWith("/events/doomed"), 503);

    expect(await once()).not.toBe(0);

    expect(row(`${me}/doomed`).state).toBe("active");
  });

  it("archives a calendar that leaves the list, with its events, and no longer follows it", async () => {
    calendar.put(
      team,
      timed("t", "T", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    calendar.calendars = [primary()];

    expect(await once()).toBe(0);

    expect(row(`${team}/t`).state).toBe("archived");
    expect(row(`${me}/m`).state).toBe("active");
    const rows = server.rows.filter((one) => one.type === calendarType);
    expect(
      rows
        .map((one) => `${String(one.properties["calendar_id"])} ${one.state}`)
        .sort(),
    ).toEqual([`${me} active`, `${team} archived`]);
    expect(Object.keys(tokens())).toEqual([me]);
  });

  it("keeps the first calendar's progress when Google limits the rate on the second, and reads the second on the next run", async () => {
    calendar.put(
      me,
      timed("m1", "M1", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      team,
      timed("t1", "T1", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    const first = tokens();
    calendar.put(
      me,
      timed("m2", "M2", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      team,
      timed("t2", "T2", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.failNext(
      (call) =>
        call.path.includes(encodeURIComponent(team)) &&
        call.query["syncToken"] !== undefined,
      429,
    );

    expect(await once()).not.toBe(0);

    expect(active()).toContain(`${me}/m2`);
    expect(active()).not.toContain(`${team}/t2`);
    expect(tokens()[me]?.token).not.toBe(first[me]?.token);
    expect(tokens()[team]?.token).toBe(first[team]?.token);

    expect(await once()).toBe(0);
    expect(active()).toContain(`${team}/t2`);
  });

  it("names a calendar Google refuses, and still reads the others", async () => {
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      team,
      timed("t", "T", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.failNext(
      (call) =>
        call.path.includes(encodeURIComponent(me)) &&
        call.path.endsWith("/events"),
      403,
      {
        error: {
          code: 403,
          message: "Forbidden",
          errors: [{ reason: "forbidden" }],
        },
      },
    );

    expect(await once()).toBe(0);

    expect(active()).toEqual([`${team}/t`]);
    expect(conditions()).toContain(`calendar-refused:${me}`);
    expect(tokens()[me]).toBeUndefined();
    expect(await once()).toBe(0);
    expect(active()).toEqual([`${me}/m`, `${team}/t`]);
    expect(conditions()).not.toContain(`calendar-refused:${me}`);
  });

  it("keeps the calendar's token back while an event cannot be read, and says which", async () => {
    calendar.put(me, { id: "broken", summary: "Broken" });
    calendar.put(
      me,
      timed("fine", "Fine", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);

    expect(active()).toEqual([`${me}/fine`]);
    expect(conditions()).toContain(`events-skipped:${me}`);
    expect(tokens()[me]?.token).toBeUndefined();
  });

  it.each([
    ["no end", {}],
    ["an end that cannot be read", { end: { date: "never" } }],
    ["a timed end", { end: { dateTime: "2026-11-03T10:00:00Z" } }],
  ])(
    "skips an all-day event whose start date cannot be read, with %s, and still reads the other calendars",
    async (_, end) => {
      calendar.put(me, { id: "broken", start: { date: "invalid" }, ...end });
      calendar.put(
        me,
        timed("fine", "Fine", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
      );
      calendar.put(
        team,
        timed("t", "T", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
      );

      expect(await once()).toBe(0);

      expect(active()).toEqual([`${me}/fine`, `${team}/t`]);
      expect(conditions()).toContain(`events-skipped:${me}`);
      expect(conditions()).not.toContain(`events-skipped:${team}`);
      expect(tokens()[me]?.token).toBeUndefined();
      expect(tokens()[team]?.token).toBeDefined();
    },
  );

  it("reads an event whose end cannot be read as ending where it starts, or a day later for an all-day one", async () => {
    calendar.put(me, {
      id: "day",
      summary: "Day",
      start: { date: "2026-11-02" },
      end: { date: "never" },
    });
    calendar.put(me, {
      id: "slot",
      summary: "Slot",
      start: { dateTime: "2026-11-02T09:00:00Z" },
      end: { dateTime: "never" },
    });

    expect(await once()).toBe(0);

    expect(row(`${me}/day`).properties).toMatchObject({
      starts_at: "2026-11-02T00:00:00Z",
      ends_at: "2026-11-03T00:00:00Z",
    });
    expect(row(`${me}/slot`).properties).toMatchObject({
      starts_at: "2026-11-02T09:00:00Z",
      ends_at: "2026-11-02T09:00:00Z",
    });
    expect(conditions()).not.toContain(`events-skipped:${me}`);
  });
});

describe("read only calendars", () => {
  const holidays = "holidays@example.com";

  it("reads a reader calendar only where it is named, and archives it when it is not named again", async () => {
    calendar.calendars.push(reader());
    calendar.put(holidays, allDay("bank", "2026-12-25", "2026-12-26"));
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);
    expect(active()).toEqual([`${me}/m`]);
    expect(calendar.calls.some((call) => call.path.includes(holidays))).toBe(
      false,
    );

    expect(
      await once({
        GOOGLE_CALENDAR_READ_ONLY_CALENDARS: `${holidays}, ${team}`,
      }),
    ).toBe(0);
    expect(active()).toEqual([`${holidays}/bank`, `${me}/m`]);
    expect(row(`${holidays}/bank`).properties).toMatchObject({
      editable: false,
      uneditable_reason: "the account can only read this calendar",
    });

    expect(await once()).toBe(0);
    expect(active()).toEqual([`${me}/m`]);
  });

  it("names a calendar in the setting that the account does not have", async () => {
    expect(
      await once({
        GOOGLE_CALENDAR_READ_ONLY_CALENDARS: "nobody@example.com",
      }),
    ).toBe(0);
    expect(conditions()).toContain(
      "read-only-calendar-unknown:nobody@example.com",
    );
  });
});

describe("an event moved between calendars", () => {
  async function moved(order: string[]): Promise<void> {
    calendar.put(
      me,
      timed("trip", "Trip", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    const id = row(`${me}/trip`).id;
    calendar.calendars = order.map((one) =>
      one === me ? primary() : writable(),
    );
    calendar.cancel(me, "trip");
    calendar.put(
      team,
      timed("trip", "Trip", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);

    expect(events().map((one) => one.id)).toEqual([id]);
    expect(row(`${team}/trip`).state).toBe("active");
    expect(placesOf(`${team}/trip`)).toEqual([team]);
  }

  it("keeps its row when the old calendar is read first", async () => {
    await moved([me, team]);
  });

  it("keeps its row when the new calendar is read first", async () => {
    await moved([team, me]);
  });

  it("is a new row, not a move, while the event is still on the old calendar", async () => {
    calendar.put(
      me,
      timed("copy", "Copy", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    calendar.put(
      team,
      timed("copy", "Copy", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);

    expect(active()).toEqual([`${me}/copy`, `${team}/copy`]);
  });

  it("is a new row, and the new calendar still syncs, when the old calendar refuses the question", async () => {
    calendar.put(
      me,
      timed("trip", "Trip", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    calendar.put(
      team,
      timed("trip", "Trip", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      team,
      timed("other", "Other", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
    );
    calendar.failNext(
      (call) =>
        call.path ===
        `/calendar/v3/calendars/${encodeURIComponent(me)}/events/trip`,
      403,
      {
        error: {
          code: 403,
          message: "Forbidden",
          errors: [{ reason: "forbidden" }],
        },
      },
    );

    expect(await once()).toBe(0);

    expect(asked(`/calendars/${encodeURIComponent(me)}/events/trip`)).toBe(
      true,
    );
    expect(active()).toEqual([`${me}/trip`, `${team}/other`, `${team}/trip`]);
    expect(row(`${me}/trip`).id).not.toBe(row(`${team}/trip`).id);
    expect(conditions().filter((one) => one.startsWith("calendar-"))).toEqual(
      [],
    );
  });
});

describe("the grant", () => {
  it("does nothing, and says so, when the account is not the one the rows came from", async () => {
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    google.sub = "sub-2222222222";
    calendar.put(
      me,
      timed("m", "Changed", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.calls.length = 0;

    expect(await once()).not.toBe(0);

    expect(conditions()).toContain("google:account");
    expect(calendar.calls).toEqual([]);
    expect(row(`${me}/m`).properties["title"]).toBe("M");
  });

  it("reads nothing, and says so, when the calendar list permission was not ticked", async () => {
    google.scope = `openid ${eventsScope}`;
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);

    expect(conditions()).toContain(`google:scope:${calendarListScope}`);
    expect(calendar.calls).toEqual([]);
    expect(server.rows).toEqual([]);
  });

  it("reads the calendars but no events when the events permission was not ticked", async () => {
    google.scope = `openid ${calendarListScope}`;
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);

    expect(conditions()).toContain(`google:scope:${eventsScope}`);
    expect(server.rows.filter((one) => one.type === calendarType)).toHaveLength(
      2,
    );
    expect(events()).toEqual([]);
    expect(eventCalls()).toEqual([]);
  });
});

describe("the grant, kept", () => {
  it("keeps the account before any row is written, so a run whose rows Marfa refused still turns away another account's grant", async () => {
    for (const id of [me, team, `${me}/m`]) {
      server.entryRefusals.set(`${sub}:${id}`, {
        status: 400,
        code: "invalid_properties",
        message: "refused",
      });
    }
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);
    expect(server.rows).toEqual([]);
    expect(
      (harness.kept()["state"] as Record<string, unknown>)["google_account"],
    ).toBe(sub);

    server.entryRefusals.clear();
    google.sub = "sub-2222222222";
    calendar.calls.length = 0;

    expect(await once()).not.toBe(0);

    expect(conditions()).toContain("google:account");
    expect(calendar.calls).toEqual([]);
    expect(server.rows).toEqual([]);
  });
});

describe("a row Marfa refuses", () => {
  const key = `inbound:${JSON.stringify([eventType, `${sub}:${me}/weekly`])}`;

  it("is kept for a retry while the calendar's token advances, and is asked for again once due", async () => {
    calendar.put(
      me,
      weekly({
        recurrence: [
          "RRULE:FREQ=WEEKLY;BYDAY=MO",
          "RDATE;VALUE=PERIOD:20261030T100000Z/20261030T110000Z",
        ],
      }),
    );
    calendar.put(
      me,
      occurrence("2026-10-26T10:00:00Z", {
        summary: "Planning (moved)",
        start: { dateTime: "2026-10-26T14:00:00Z", timeZone: london },
        end: { dateTime: "2026-10-26T15:00:00Z", timeZone: london },
      }),
    );
    calendar.put(
      me,
      timed("plain", "Plain", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    server.entryRefusals.set(`${sub}:${me}/weekly`, {
      status: 400,
      code: "invalid_properties",
      message: "recurrence holds an RDATE period",
    });

    expect(await once()).toBe(0);

    const moved = `${me}/weekly_20261026T100000Z`;
    expect(active()).toEqual([`${me}/plain`, moved]);
    expect(tokens()[me]?.token).toMatch(/^sync-/);
    expect(conditions()).toContain(key);
    expect(harness.problems()[key]).toMatch(/RDATE period/);
    expect(
      conditions().filter((one) => one.startsWith("row-refused:")),
    ).toEqual([]);
    const firstToken = tokens()[me]?.token;

    calendar.put(
      me,
      timed("later", "Later", "2026-11-04T09:00:00Z", "2026-11-04T10:00:00Z"),
    );
    calendar.calls.length = 0;
    expect(await once()).toBe(0);

    expect(active()).toEqual([`${me}/later`, `${me}/plain`, moved]);
    expect(tokens()[me]?.token).not.toBe(firstToken);
    expect(asked(`/calendars/${encodeURIComponent(me)}/events/weekly`)).toBe(
      false,
    );
    expect(conditions()).toContain(key);

    server.entryRefusals.clear();
    harness.clock.advance(25 * 60 * 60 * 1000);
    calendar.calls.length = 0;
    expect(await once()).toBe(0);

    expect(asked(`/calendars/${encodeURIComponent(me)}/events/weekly`)).toBe(
      true,
    );
    expect(active()).toEqual([
      `${me}/later`,
      `${me}/plain`,
      `${me}/weekly`,
      moved,
    ]);
    expect(row(`${me}/weekly`).properties["recurrence"]).toContain(
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    );
    expect(seriesOf(moved)).toEqual([`${me}/weekly`]);
    expect(conditions()).not.toContain(key);
    expect(harness.kept()["inbound"]).toBeUndefined();
  });

  it("still advances the calendar when every event in its delta is refused", async () => {
    const refusal = {
      status: 400,
      code: "invalid_properties",
      message: "recurrence holds an RDATE period",
    };
    calendar.put(
      me,
      timed("plain", "Plain", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
    const firstToken = tokens()[me]?.token;

    for (const id of ["a", "b"]) {
      calendar.put(
        me,
        timed(id, id, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z", london, {
          recurrence: [
            "RRULE:FREQ=WEEKLY;BYDAY=TU",
            "RDATE;VALUE=PERIOD:20261105T100000Z/20261105T110000Z",
          ],
        }),
      );
      server.entryRefusals.set(`${sub}:${me}/${id}`, refusal);
    }

    expect(await once()).toBe(0);

    expect(active()).toEqual([`${me}/plain`]);
    expect(tokens()[me]?.token).not.toBe(firstToken);
    for (const id of ["a", "b"]) {
      expect(conditions()).toContain(
        `inbound:${JSON.stringify([eventType, `${sub}:${me}/${id}`])}`,
      );
    }
  });
});

describe("a check a run skips", () => {
  it("keeps a refused calendar's condition through runs that do not read it", async () => {
    calendar.failNext(
      (call) =>
        call.path.includes(encodeURIComponent(me)) &&
        call.path.endsWith("/events"),
      403,
      {
        error: {
          code: 403,
          message: "Forbidden",
          errors: [{ reason: "forbidden" }],
        },
      },
    );
    expect(await once()).toBe(0);
    expect(conditions()).toContain(`calendar-refused:${me}`);

    google.scope = `openid ${eventsScope}`;
    expect(await once()).toBe(0);
    expect(conditions()).toContain(`calendar-refused:${me}`);

    google.scope = `openid ${calendarListScope}`;
    expect(await once()).toBe(0);
    expect(conditions()).toContain(`calendar-refused:${me}`);

    google.scope = `openid ${eventsScope} ${calendarListScope}`;
    expect(await once()).toBe(0);
    expect(conditions()).not.toContain(`calendar-refused:${me}`);
  });

  it("keeps a calendar's skipped events condition while Google refuses the calendar", async () => {
    calendar.put(me, { id: "broken", summary: "Broken" });
    expect(await once()).toBe(0);
    expect(conditions()).toContain(`events-skipped:${me}`);
    calendar.failNext(
      (call) =>
        call.path.includes(encodeURIComponent(me)) &&
        call.path.endsWith("/events"),
      403,
      {
        error: {
          code: 403,
          message: "Forbidden",
          errors: [{ reason: "forbidden" }],
        },
      },
    );

    expect(await once()).toBe(0);

    expect(conditions()).toContain(`calendar-refused:${me}`);
    expect(conditions()).toContain(`events-skipped:${me}`);
  });
});

describe("a calendar missing from one listing", () => {
  beforeEach(async () => {
    calendar.put(
      team,
      timed("t", "T", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);
  });

  const entry = `/users/me/calendarList/${encodeURIComponent(team)}`;

  it("is kept while Google still has it on the account's list", async () => {
    calendar.calendars = [primary()];
    calendar.unlisted = [writable()];

    expect(await once()).toBe(0);

    expect(asked(entry)).toBe(true);
    expect(row(`${team}/t`).state).toBe("active");
    expect(Object.keys(tokens()).sort()).toEqual([me, team]);
  });

  it("is kept, and named, when Google cannot say whether it left; and archived once Google says it did", async () => {
    calendar.calendars = [primary()];
    calendar.failNext((call) => call.path === `/calendar/v3${entry}`, 503);

    expect(await once()).toBe(0);

    expect(row(`${team}/t`).state).toBe("active");
    expect(conditions()).toContain(`calendar-unconfirmed:${team}`);

    expect(await once()).toBe(0);

    expect(row(`${team}/t`).state).toBe("archived");
    expect(conditions()).not.toContain(`calendar-unconfirmed:${team}`);
  });

  it("keeps a refused calendar's condition while a run cannot read the calendar", async () => {
    calendar.failNext(
      (call) =>
        call.path.includes(encodeURIComponent(team)) &&
        call.path.endsWith("/events"),
      403,
      {
        error: {
          code: 403,
          message: "Forbidden",
          errors: [{ reason: "forbidden" }],
        },
      },
    );
    calendar.expire(team);
    expect(await once()).toBe(0);
    expect(conditions()).toContain(`calendar-refused:${team}`);

    calendar.calendars = [primary()];
    calendar.failNext((call) => call.path === `/calendar/v3${entry}`, 503);
    expect(await once()).toBe(0);
    expect(conditions()).toContain(`calendar-unconfirmed:${team}`);
    expect(conditions()).toContain(`calendar-refused:${team}`);

    calendar.unlisted = [writable()];
    expect(await once()).toBe(0);
    expect(asked(entry)).toBe(true);
    expect(conditions()).toContain(`calendar-refused:${team}`);
  });

  it("is archived without asking when it is still listed but the account can only read it", async () => {
    calendar.calendars = [primary(), { ...writable(), accessRole: "reader" }];

    expect(await once()).toBe(0);

    expect(asked(entry)).toBe(false);
    expect(row(`${team}/t`).state).toBe("archived");
  });
});

describe("the cost of a run", () => {
  it("reads no held rows when nothing changed or only a plain event did, and reads them for a whole read", async () => {
    calendar.put(
      me,
      timed("m", "M", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(me, weekly());
    calendar.put(
      team,
      timed("t", "T", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    expect(await once()).toBe(0);

    server.requests.length = 0;
    expect(await once()).toBe(0);
    expect(heldReads()).toBe(0);

    calendar.put(
      me,
      timed("m", "Changed", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      me,
      timed("n", "New", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
    );
    calendar.cancel(team, "t");
    expect(await once()).toBe(0);
    expect(heldReads()).toBe(0);
    expect(row(`${me}/m`).properties["title"]).toBe("Changed");
    expect(row(`${team}/t`).state).toBe("archived");

    calendar.expire(me);
    expect(await once()).toBe(0);
    expect(heldReads()).toBeGreaterThan(0);
  });
});

describe("a calendar id with a slash", () => {
  const odd = "group/shared@example.com";

  it("is read, and a row Google no longer has is found and archived in a whole read", async () => {
    calendar.calendars.push({
      id: odd,
      summary: "Odd",
      timeZone: london,
      accessRole: "owner",
    });
    calendar.put(
      odd,
      timed("a", "A", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );
    calendar.put(
      odd,
      timed("b", "B", "2026-11-02T09:00:00Z", "2026-11-02T10:00:00Z"),
    );

    expect(await once()).toBe(0);

    expect(active()).toEqual([`${odd}/a`, `${odd}/b`]);
    expect(placesOf(`${odd}/a`)).toEqual([odd]);
    expect(conditions().filter((one) => one.includes(odd))).toEqual([]);

    calendar.forget(odd, "b");
    calendar.expire(odd);
    expect(await once()).toBe(0);

    expect(row(`${odd}/b`).state).toBe("archived");
    expect(row(`${odd}/a`).state).toBe("active");
  });
});
