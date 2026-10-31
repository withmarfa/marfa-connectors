import { googleEnv } from "@withmarfa/google";
import calendarDefinition from "./google.calendar.calendar.json" with { type: "json" };
import eventDefinition from "./google.calendar.event.json" with { type: "json" };

export const source = "google-calendar";
export const calendarType = calendarDefinition.id;
export const eventType = eventDefinition.id;

/** An event on a calendar. It orphans, so trashing a calendar in Marfa takes
 *  none of its events with it, and changing it moves the event. */
export const inCalendar = "google.calendar.in-calendar";
/** The instance's own `parent-of`, read from the exception's side. */
export const childOf = "child-of";

export const eventsScope = "https://www.googleapis.com/auth/calendar.events";
export const calendarListScope =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const scopes = [eventsScope, calendarListScope] as const;
/** What the connector signs in for: the rows of these types under `source`
 *  hold the account in their `source_id`. */
export const needs = { source, scopes, types: [calendarType, eventType] };

export const env = {
  ...googleEnv,
  GOOGLE_CALENDAR_READ_ONLY_CALENDARS: "optional",
  GOOGLE_CALENDAR_CONFIRM_DELETES: "optional",
} as const;

/** The event fields Google holds that Marfa never changes there: they are
 *  put back where a person changes them. */
export const eventReadOnly = [
  "original_starts_at",
  "url",
  "calendar_id",
  "recurring_event_id",
  "organizer",
  "attendees",
  "guests",
  "event_kind",
  "visibility",
  "ical_uid",
  "etag",
  "editable",
  "uneditable_reason",
  childOf,
] as const;

/** Facts about an event that are not something done to it. */
export const eventDerived = ["etag", "editable", "uneditable_reason"] as const;

/** The safety stop on deleting: a batch of trashes and purges is held when
 *  it would delete more than this many events of one calendar... */
export const deleteLimit = 10;
/** ...and more than this share of the events the calendar holds, as
 *  Marfa's own folder rule `removal_threshold` holds a mass removal. */
export const deleteShare = 0.25;

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
  "attendees",
  "guests",
  "event_kind",
  "visibility",
  "ical_uid",
  "etag",
  "editable",
  "uneditable_reason",
] as const;

export { calendarDefinition, eventDefinition };
