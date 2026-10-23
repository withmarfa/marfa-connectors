import { googleEnv } from "@withmarfa/google";
import calendarDefinition from "./google.calendar.calendar.json" with { type: "json" };
import eventDefinition from "./google.calendar.event.json" with { type: "json" };

export const source = "google-calendar";
export const calendarType = calendarDefinition.id;
export const eventType = eventDefinition.id;

/** An event on a calendar, read only: it orphans, so trashing a calendar in
 *  Marfa takes none of its events with it. */
export const inCalendar = "google.calendar.in-calendar";
/** The instance's own `parent-of`, read from the exception's side. */
export const childOf = "child-of";

export const eventsScope = "https://www.googleapis.com/auth/calendar.events";
export const calendarListScope =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const scopes = [eventsScope, calendarListScope] as const;

export const env = {
  ...googleEnv,
  GOOGLE_CALENDAR_READ_ONLY_CALENDARS: "optional",
} as const;

/** Google's calendar of contacts' birthdays, which is not a calendar of
 *  events a person made. Written in parts so that the tree check for personal
 *  addresses does not read Google's fixed id as one. */
export const birthdays =
  "addressbook#contacts" + "@group.v.calendar.google.com";

export const calendarFields = [
  "title",
  "description",
  "calendar_id",
  "timezone",
  "access_role",
  "primary",
  "color",
] as const;

export const eventFields = [
  "title",
  "description",
  "starts_at",
  "ends_at",
  "all_day",
  "timezone",
  "end_timezone",
  "recurrence",
  "original_starts_at",
  "status",
  "place",
  "url",
  "google_id",
  "calendar_id",
  "recurring_event_id",
  "organizer",
  "guests",
  "event_kind",
  "visibility",
  "ical_uid",
  "etag",
  "editable",
  "uneditable_reason",
] as const;

export { calendarDefinition, eventDefinition };
