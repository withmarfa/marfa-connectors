import type { Entry, JsonValue } from "@withmarfa/connector";
import { flag, isJson, list, object, text, type Json } from "./api.js";
import { calendarType, childOf, eventType, inCalendar } from "./config.js";
import { dayStart, iso, nextDay, validZone } from "./time.js";

/** What a read knows of a calendar it syncs. */
export interface CalendarInfo {
  readonly id: string;
  readonly title: string;
  readonly zone: string;
  readonly role: string;
  readonly description: string | undefined;
  readonly primary: boolean;
  readonly color: string | undefined;
}

/** The access roles that may change the events of a calendar. */
export const owned = new Set(["owner", "writer"]);

export function zoneOf(...names: (string | undefined)[]): string {
  for (const name of names) {
    if (name !== undefined && validZone(name)) return name;
  }
  return "UTC";
}

/** A calendar as the list gives it, or nothing for one without an id. */
export function calendarOf(item: Json): CalendarInfo | undefined {
  const id = text(item, "id");
  if (id === undefined) return undefined;
  const title = text(item, "summaryOverride") ?? text(item, "summary") ?? id;
  return {
    id,
    title,
    zone: zoneOf(text(item, "timeZone")),
    role: text(item, "accessRole") ?? "reader",
    description: text(item, "description"),
    primary: flag(item, "primary") === true,
    color: text(item, "backgroundColor"),
  };
}

export function calendarEntry(account: string, calendar: CalendarInfo): Entry {
  return {
    source_id: `${account}:${calendar.id}`,
    properties: {
      title: calendar.title,
      description: calendar.description,
      calendar_id: calendar.id,
      timezone: calendar.zone,
      access_role: calendar.role,
      primary: calendar.primary,
      color: calendar.color,
    },
  };
}

/** The link of an event row: the calendar is part of it, since one event id
 *  can sit on two calendars. */
export function linkOf(calendarId: string, eventId: string): string {
  return `${calendarId}/${eventId}`;
}

/**
 * A write that makes an event under the row's own id, kept in the outbound
 * journal until it is answered. Until then the read leaves that event
 * alone, since the write links it and a row read for it would be a second
 * one.
 */
export interface Making {
  readonly calendarId: string;
  readonly eventId: string;
  readonly body: Readonly<Record<string, JsonValue>>;
}

export function makingOf(request: JsonValue): Making | undefined {
  if (!isJson(request)) return undefined;
  const { calendarId, eventId, body } = request;
  if (
    typeof calendarId !== "string" ||
    typeof eventId !== "string" ||
    !isJson(body)
  ) {
    return undefined;
  }
  return request as unknown as Making;
}

/**
 * The change a changed occurrence made in Marfa sends to the occurrence it
 * replaces, kept in the outbound journal until it lands. Until then the read
 * leaves the occurrence's row alone, since Google still holds the occurrence
 * as it was, which may be cancelled.
 */
export interface Replacing {
  readonly calendarId: string;
  readonly seriesId: string;
  /** The occurrence's own id. */
  readonly eventId: string;
}

export function replacingOf(request: JsonValue): Replacing | undefined {
  if (!isJson(request)) return undefined;
  const { calendarId, seriesId, eventId } = request;
  if (
    typeof calendarId !== "string" ||
    typeof seriesId !== "string" ||
    typeof eventId !== "string"
  ) {
    return undefined;
  }
  return request as unknown as Replacing;
}

/** The id an event row's link holds after the calendar's. */
export function eventIdOf(calendarId: string, link: string): string {
  return link.slice(calendarId.length + 1);
}

/** The calendar a link names, and the event after it. */
export function splitLink(
  link: string,
): { calendarId: string; eventId: string } | undefined {
  const at = link.lastIndexOf("/");
  if (at <= 0 || at === link.length - 1) return undefined;
  return { calendarId: link.slice(0, at), eventId: link.slice(at + 1) };
}

export interface Moment {
  readonly date: string | undefined;
  readonly dateTime: string | undefined;
  readonly timeZone: string | undefined;
}

export function momentOf(value: Json | undefined): Moment | undefined {
  if (value === undefined) return undefined;
  const date = text(value, "date");
  const dateTime = text(value, "dateTime");
  if (date === undefined && dateTime === undefined) return undefined;
  return { date, dateTime, timeZone: text(value, "timeZone") };
}

/** An event Google lists, kept as it came with its few fields read. */
export interface GoogleEvent {
  readonly raw: Json;
  readonly id: string;
  readonly status: string;
  readonly recurringEventId: string | undefined;
  readonly kind: string;
  readonly recurrence: readonly string[];
  readonly originalStartTime: Moment | undefined;
}

export function eventOf(raw: Json): GoogleEvent | undefined {
  const id = text(raw, "id");
  if (id === undefined) return undefined;
  return {
    raw,
    id,
    status: text(raw, "status") ?? "confirmed",
    recurringEventId: text(raw, "recurringEventId"),
    kind: text(raw, "eventType") ?? "default",
    recurrence: list(raw, "recurrence").filter(
      (one): one is string => typeof one === "string",
    ),
    originalStartTime: momentOf(object(raw, "originalStartTime")),
  };
}

/**
 * Why Marfa may not change an event, or nothing where it may. An event with
 * a guest other than the account is someone else's to agree to, so Marfa
 * leaves it alone even where Google would let the account change it.
 */
export function uneditable(
  event: GoogleEvent,
  calendar: Pick<CalendarInfo, "role">,
): string | undefined {
  if (!owned.has(calendar.role))
    return "the account can only read this calendar";
  if (event.kind !== "default") return `Google reserves ${event.kind} events`;
  if (flag(event.raw, "locked") === true) return "the event is locked";
  const organizer = object(event.raw, "organizer");
  if (organizer !== undefined && flag(organizer, "self") !== true) {
    return "someone else organizes the event";
  }
  // A change would reach the guests' calendars, which Marfa does not touch.
  const others = list(event.raw, "attendees").some(
    (one) => !isJson(one) || flag(one, "self") !== true,
  );
  if (others) return "the event has guests other than the account";
  return undefined;
}

function person(value: unknown): Json | undefined {
  if (!isJson(value)) return undefined;
  const email = text(value, "email");
  const name = text(value, "displayName");
  const flags = ["self", "organizer", "optional", "resource"] as const;
  const out: Record<string, unknown> = {};
  if (email !== undefined) out["email"] = email;
  if (name !== undefined) out["name"] = name;
  for (const one of flags) if (flag(value, one) === true) out[one] = true;
  return Object.keys(out).length === 0 ? undefined : out;
}

function guest(value: unknown): Json | undefined {
  const base = person(value);
  if (base === undefined || !isJson(value)) return undefined;
  const response = text(value, "responseStatus");
  return response === undefined ? base : { ...base, response };
}

/** The times of an event, in Marfa's terms; `undefined` where Google gave
 *  none that can be read. */
function timesOf(event: GoogleEvent, calendar: CalendarInfo) {
  const start = momentOf(object(event.raw, "start"));
  const end = momentOf(object(event.raw, "end"));
  if (start === undefined) return undefined;
  if (start.date !== undefined) {
    const zone = zoneOf(start.timeZone, calendar.zone);
    const first = dayStart(zone, start.date);
    const lastDate =
      end?.date !== undefined && end.date > start.date
        ? end.date
        : nextDay(start.date);
    const last = dayStart(zone, lastDate);
    if (first === undefined || last === undefined) return undefined;
    return {
      allDay: true,
      zone,
      endZone: undefined,
      first,
      last,
    } as const;
  }
  if (start.dateTime === undefined) return undefined;
  const first = Date.parse(start.dateTime);
  if (!Number.isFinite(first)) return undefined;
  const zone = zoneOf(start.timeZone, calendar.zone);
  const parsed = end?.dateTime === undefined ? first : Date.parse(end.dateTime);
  const last = Number.isFinite(parsed) && parsed >= first ? parsed : first;
  const endsIn = zoneOf(end?.timeZone, zone);
  return {
    allDay: false,
    zone,
    endZone:
      end?.timeZone !== undefined && endsIn !== zone ? endsIn : undefined,
    first,
    last,
  } as const;
}

/**
 * The original start of a changed occurrence. A date-only one, of an all-day
 * series, is the midnight of that date in the zone it names, or else in
 * `zone`, which is the zone the series is read in: the calendar's.
 */
export function originalStartOf(
  event: GoogleEvent,
  zone: string,
): number | undefined {
  const original = event.originalStartTime;
  if (original === undefined) return undefined;
  if (original.dateTime !== undefined) {
    const ms = Date.parse(original.dateTime);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (original.date === undefined) return undefined;
  return dayStart(zoneOf(original.timeZone, zone), original.date);
}

export interface Mapped {
  readonly entry: Entry;
  /** Where the event begins, for ordering a series' cancellations. */
  readonly startMs: number;
  readonly zone: string;
}

/**
 * An event as an entry of `google.calendar.event`. The times follow the
 * event's own zone, or the calendar's, and an all-day event is the local
 * midnights of its dates in that zone, never the zone of this process.
 * Returns `undefined` for an event whose times cannot be read.
 */
export function eventEntry(
  account: string,
  calendar: CalendarInfo,
  event: GoogleEvent,
  recurrence?: readonly string[],
): Mapped | undefined {
  const times = timesOf(event, calendar);
  if (times === undefined) return undefined;
  const link = linkOf(calendar.id, event.id);
  const raw = event.raw;
  const reason = uneditable(event, calendar);
  const original =
    event.recurringEventId === undefined
      ? undefined
      : originalStartOf(event, calendar.zone);
  const guests = list(raw, "attendees")
    .map(guest)
    .filter((one): one is Json => one !== undefined);
  const status =
    text(raw, "status") === "tentative" ? "tentative" : "confirmed";
  const connections: Record<string, { type: string; id: string }[]> = {
    [inCalendar]: [{ type: calendarType, id: calendar.id }],
  };
  if (event.recurringEventId !== undefined) {
    connections[childOf] = [
      { type: eventType, id: linkOf(calendar.id, event.recurringEventId) },
    ];
  }
  return {
    startMs: times.first,
    zone: times.zone,
    entry: {
      source_id: `${account}:${link}`,
      properties: {
        title: text(raw, "summary") ?? "(No title)",
        description: text(raw, "description"),
        starts_at: iso(times.first),
        ends_at: iso(times.last),
        all_day: times.allDay ? true : undefined,
        timezone: times.zone,
        end_timezone: times.endZone,
        recurrence:
          recurrence !== undefined && recurrence.length > 0
            ? [...recurrence]
            : undefined,
        original_starts_at: original === undefined ? undefined : iso(original),
        status,
        place: text(raw, "location"),
        url: text(raw, "htmlLink"),
        google_id: link,
        calendar_id: calendar.id,
        recurring_event_id: event.recurringEventId,
        organizer: person(object(raw, "organizer")),
        guests: guests.length === 0 ? undefined : guests,
        event_kind: event.kind,
        visibility: text(raw, "visibility"),
        ical_uid: text(raw, "iCalUID"),
        etag: text(raw, "etag"),
        editable: reason === undefined,
        uneditable_reason: reason,
      },
      occurred_at: iso(times.first),
      changed_at: text(raw, "updated"),
      connections,
    },
  };
}
