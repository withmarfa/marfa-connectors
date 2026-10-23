import { createHash } from "node:crypto";
import type {
  Entry,
  Item,
  RunContext,
  ScopedRunContext,
} from "@withmarfa/connector";
import { GoogleError, type Access } from "@withmarfa/google";
import {
  CalendarApi,
  isJson,
  tokenExpired,
  type Json,
  type Listing,
} from "./api.js";
import {
  birthdays,
  calendarType,
  env,
  eventsScope,
  eventType,
} from "./config.js";
import {
  calendarEntry,
  calendarOf,
  eventEntry,
  eventOf,
  linkOf,
  owned,
  splitLink,
  type CalendarInfo,
  type GoogleEvent,
} from "./events.js";
import {
  carried,
  cancellationOf,
  keyOf,
  withCancellations,
  type Cancellation,
} from "./recurrence.js";
import { iso } from "./time.js";

export type Context = RunContext<typeof env>;
type Scoped = ScopedRunContext<typeof env>;

/** Bumped when the way events are read changes, so that every calendar is
 *  read whole once more. */
const reading = 1;
const day = 86_400_000;
const horizonYears = 5;

interface Progress {
  token?: string;
  shape: string;
}

type Calendars = Record<string, Progress>;

function progressOf(value: unknown): Calendars {
  const out: Calendars = {};
  if (!isJson(value)) return out;
  for (const [id, one] of Object.entries(value)) {
    if (!isJson(one) || typeof one["shape"] !== "string") continue;
    out[id] =
      typeof one["token"] === "string"
        ? { token: one["token"], shape: one["shape"] }
        : { shape: one["shape"] };
  }
  return out;
}

/** What Marfa holds of the account's events when the run begins. */
interface Held {
  readonly links: Set<string>;
  readonly byCalendar: Map<string, Item[]>;
  readonly byEvent: Map<string, Set<string>>;
  /** Links a row was moved from during this run, so one move is not used twice. */
  readonly claimed: Set<string>;
}

function linkIn(item: Item): string | undefined {
  const link = item.properties["google_id"];
  return typeof link === "string" ? link : undefined;
}

function holding(items: readonly Item[]): Held {
  const held: Held = {
    links: new Set(),
    byCalendar: new Map(),
    byEvent: new Map(),
    claimed: new Set(),
  };
  for (const item of items) {
    const link = linkIn(item);
    const parts = link === undefined ? undefined : splitLink(link);
    if (link === undefined || parts === undefined) continue;
    held.links.add(link);
    const rows = held.byCalendar.get(parts.calendarId) ?? [];
    rows.push(item);
    held.byCalendar.set(parts.calendarId, rows);
    const where = held.byEvent.get(parts.eventId) ?? new Set<string>();
    where.add(parts.calendarId);
    held.byEvent.set(parts.eventId, where);
  }
  return held;
}

/** The calendars to read: those the account owns or writes to, and the
 *  read-only ones the connector is told to read. */
function selection(
  items: readonly Json[],
  named: ReadonlySet<string>,
  context: Pick<Context, "log">,
): Map<string, CalendarInfo> {
  const chosen = new Map<string, CalendarInfo>();
  const found = new Set<string>();
  let left = 0;
  for (const item of items) {
    const calendar = calendarOf(item);
    if (calendar === undefined || item["deleted"] === true) continue;
    found.add(calendar.id);
    if (calendar.id === birthdays) continue;
    if (calendar.id.includes("/")) {
      context.log.condition(
        `calendar-id:${calendar.id}`,
        `The calendar ${calendar.title} has an id with a slash in it, which a row cannot be named by, so it is not read.`,
      );
      continue;
    }
    if (owned.has(calendar.role) || named.has(calendar.id)) {
      chosen.set(calendar.id, calendar);
    } else left += 1;
  }
  for (const id of named) {
    if (!found.has(id)) {
      context.log.condition(
        `read-only-calendar-unknown:${id}`,
        `GOOGLE_CALENDAR_READ_ONLY_CALENDARS names ${id}, which is not in the account's calendar list, so nothing is read for it.`,
      );
    }
  }
  if (left > 0) {
    context.log.info(
      `${String(left)} calendar${left === 1 ? " is" : "s are"} read only for this account and not named in GOOGLE_CALENDAR_READ_ONLY_CALENDARS, so ${left === 1 ? "it is" : "they are"} not read`,
    );
  }
  return chosen;
}

export interface Reading {
  readonly context: Context;
  readonly api: CalendarApi;
  readonly access: Access;
  readonly named: ReadonlySet<string>;
  readonly now: () => number;
}

async function save(
  scoped: Scoped,
  context: Context,
  id: string,
  title: string,
  next: Progress | undefined,
): Promise<void> {
  const acknowledged = progressOf(scoped.state.get("calendars"));
  if (next === undefined) Reflect.deleteProperty(acknowledged, id);
  else acknowledged[id] = next;
  const result = await scoped.state.checkpoint("calendars", acknowledged);
  if (!result.committed) {
    context.log.condition(
      `calendar-progress:${id}`,
      `${title} was read but its progress could not be saved (${result.reason}), so it is read again on the next run.`,
    );
  }
}

/** Reads the account's calendars and their events into Marfa. */
export async function readCalendars(reading: Reading): Promise<void> {
  const { context, api, access } = reading;
  const { log } = context;
  const listed = await api.calendars();
  const chosen = selection(listed.items, reading.named, context);
  const [calendarRows, eventRows] = await Promise.all([
    context.held(calendarType, { state: "active" }),
    context.held(eventType, { state: "active" }),
  ]);
  const held = holding(eventRows);
  const progress = progressOf(context.state.get("calendars"));
  if (!access.has(eventsScope)) {
    // Without the events permission only the calendars themselves are read.
    await context.upsert(
      calendarType,
      [...chosen.values()].map((one) => calendarEntry(access.account, one)),
    );
    return;
  }

  const known = new Set<string>([
    ...calendarRows.flatMap((row) => {
      const id = row.properties["calendar_id"];
      return typeof id === "string" ? [id] : [];
    }),
    ...held.byCalendar.keys(),
    ...Object.keys(progress),
  ]);
  for (const id of known) {
    if (chosen.has(id)) continue;
    const scoped = context.forScope(`calendar:${id}`);
    const links = (held.byCalendar.get(id) ?? []).flatMap((row) => {
      const link = linkIn(row);
      return link === undefined ? [] : [link];
    });
    await scoped.archive(eventType, links);
    await scoped.archive(calendarType, [id]);
    await save(scoped, context, id, id, undefined);
    log.info(
      `${id} is no longer a calendar this connector reads, so it and its events are archived`,
    );
  }

  for (const calendar of chosen.values()) {
    try {
      await syncCalendar(reading, calendar, held, progress[calendar.id]);
    } catch (error) {
      if (!(error instanceof GoogleError) || error.kind !== "refused") {
        throw error;
      }
      log.condition(
        `calendar-refused:${calendar.id}`,
        `${calendar.title} could not be read (${error.message}), so its rows are left as they are and the other calendars were read.`,
      );
    }
  }
}

function shapeOf(context: Context, calendar: CalendarInfo): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        reading,
        context.written(eventType),
        calendar.zone,
        calendar.role,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

interface Plan {
  readonly entries: Entry[];
  readonly archive: Set<string>;
  readonly skipped: string[];
}

async function syncCalendar(
  reading: Reading,
  calendar: CalendarInfo,
  held: Held,
  kept: Progress | undefined,
): Promise<void> {
  const { context, api, access } = reading;
  const scoped = context.forScope(`calendar:${calendar.id}`);
  await scoped.upsert(calendarType, [calendarEntry(access.account, calendar)]);
  const shape = shapeOf(context, calendar);
  let token = kept?.shape === shape ? kept.token : undefined;
  let answer: Listing | undefined;
  if (token !== undefined) {
    try {
      answer = await api.events(calendar.id, token);
    } catch (error) {
      if (!tokenExpired(error)) throw error;
      token = undefined;
    }
  }
  if (answer === undefined) {
    try {
      answer = await api.events(calendar.id);
    } catch (error) {
      // A page token that lapsed in the middle of a read: once more.
      if (!tokenExpired(error)) throw error;
      answer = await api.events(calendar.id);
    }
  }
  const whole = token === undefined;
  const items = [...answer.items];
  const gone = new Set<string>();
  const vanished = new Set<string>();
  if (whole) {
    // A whole read lists what Google still holds: a row it does not list is
    // asked about, since only a deleted event may be archived.
    const listedIds = new Set(
      items.flatMap((item) =>
        typeof item["id"] === "string" ? [item["id"]] : [],
      ),
    );
    for (const row of held.byCalendar.get(calendar.id) ?? []) {
      const link = linkIn(row);
      const parts = link === undefined ? undefined : splitLink(link);
      if (link === undefined || parts === undefined) continue;
      if (listedIds.has(parts.eventId)) continue;
      const found = await api.event(calendar.id, parts.eventId);
      if (found === "gone") {
        gone.add(link);
        const series = row.properties["recurring_event_id"];
        if (typeof series === "string") vanished.add(series);
      } else items.push(found);
    }
  }
  const plan = await planEvents(
    reading,
    calendar,
    held,
    items,
    whole,
    gone,
    vanished,
  );
  if (plan.entries.length > 0) await scoped.upsert(eventType, plan.entries);
  const archive = [...plan.archive].filter((link) => held.links.has(link));
  if (archive.length > 0) await scoped.archive(eventType, archive);
  if (plan.skipped.length > 0) {
    context.log.condition(
      `events-skipped:${calendar.id}`,
      `${String(plan.skipped.length)} event${plan.skipped.length === 1 ? "" : "s"} of ${calendar.title} could not be read, such as ${plan.skipped.slice(0, 3).join(", ")}, so the calendar is read whole again on the next run.`,
    );
  }
  const complete = plan.skipped.length === 0 && answer.syncToken !== undefined;
  await save(
    scoped,
    context,
    calendar.id,
    calendar.title,
    complete && answer.syncToken !== undefined
      ? { token: answer.syncToken, shape }
      : { shape },
  );
}

function recurrenceOf(held: Held, calendarId: string, id: string): string[] {
  const row = (held.byCalendar.get(calendarId) ?? []).find(
    (one) => linkIn(one) === linkOf(calendarId, id),
  );
  const lines = row?.properties["recurrence"];
  return Array.isArray(lines)
    ? lines.filter((one): one is string => typeof one === "string")
    : [];
}

async function planEvents(
  reading: Reading,
  calendar: CalendarInfo,
  held: Held,
  items: readonly Json[],
  whole: boolean,
  gone: ReadonlySet<string>,
  vanished: ReadonlySet<string>,
): Promise<Plan> {
  const { api, access } = reading;
  const account = access.account;
  const plan: Plan = { entries: [], archive: new Set(gone), skipped: [] };
  const byId = new Map<string, GoogleEvent>();
  for (const item of items) {
    const event = eventOf(item);
    if (event !== undefined) byId.set(event.id, event);
  }
  const masters = new Map<string, GoogleEvent>();
  const others: GoogleEvent[] = [];
  const cancelled = new Map<string, Cancellation[]>();
  const restored = new Map<string, Cancellation[]>();
  const touched = new Set<string>(vanished);
  const add = (
    into: Map<string, Cancellation[]>,
    series: string,
    event: GoogleEvent,
  ): void => {
    const one = cancellationOf(event);
    if (one !== undefined) into.set(series, [...(into.get(series) ?? []), one]);
    touched.add(series);
  };
  const dropSeries = (id: string): void => {
    plan.archive.add(linkOf(calendar.id, id));
    for (const row of held.byCalendar.get(calendar.id) ?? []) {
      if (row.properties["recurring_event_id"] === id) {
        const link = linkIn(row);
        if (link !== undefined) plan.archive.add(link);
      }
    }
  };

  for (const event of byId.values()) {
    if (event.kind === "workingLocation") {
      plan.archive.add(linkOf(calendar.id, event.id));
      continue;
    }
    if (event.status === "cancelled") {
      plan.archive.add(linkOf(calendar.id, event.id));
      if (event.recurringEventId !== undefined) {
        add(cancelled, event.recurringEventId, event);
      } else dropSeries(event.id);
      continue;
    }
    if (event.recurringEventId !== undefined) {
      add(restored, event.recurringEventId, event);
      others.push(event);
    } else if (event.recurrence.length > 0) {
      masters.set(event.id, event);
      touched.add(event.id);
    } else others.push(event);
  }

  const push = async (
    event: GoogleEvent,
    recurrence?: readonly string[],
  ): Promise<void> => {
    const mapped = eventEntry(account, calendar, event, recurrence);
    if (mapped === undefined) {
      plan.skipped.push(event.id);
      return;
    }
    const movedFrom = await movedFromOf(api, calendar.id, event.id, held);
    plan.entries.push(
      movedFrom === undefined
        ? mapped.entry
        : { ...mapped.entry, movedFrom: [movedFrom] },
    );
  };

  for (const id of touched) {
    let master = masters.get(id);
    if (master === undefined) {
      if (byId.get(id)?.status === "cancelled") continue;
      const found = await api.event(calendar.id, id);
      const event = found === "gone" ? undefined : eventOf(found);
      if (event === undefined || event.status === "cancelled") {
        dropSeries(id);
        continue;
      }
      if (event.recurrence.length === 0) {
        others.push(event);
        continue;
      }
      master = event;
    }
    const first = eventEntry(account, calendar, master);
    if (first === undefined) {
      plan.skipped.push(master.id);
      continue;
    }
    const seen = cancelled.get(id) ?? [];
    let all: Cancellation[] = seen;
    if (!whole || vanished.has(id)) {
      const latest = Math.max(
        ...seen.flatMap((one) => (one.kind === "instant" ? [one.ms] : [])),
        0,
      );
      const horizon = Math.max(
        Math.max(reading.now(), first.startMs) + horizonYears * 365 * day,
        latest + day,
      );
      const asked = await api.cancelled(
        calendar.id,
        id,
        iso(first.startMs - day),
        iso(horizon),
      );
      const fromGoogle = asked.flatMap((raw) => {
        const event = eventOf(raw);
        const one = event === undefined ? undefined : cancellationOf(event);
        return one === undefined ? [] : [one];
      });
      const back = new Set((restored.get(id) ?? []).map(keyOf));
      const before = carried(
        recurrenceOf(held, calendar.id, id),
        master.recurrence,
        first.zone,
        { ms: horizon, day: new Date(horizon).toISOString().slice(0, 10) },
      ).filter((one) => !back.has(keyOf(one)));
      all = [...seen, ...fromGoogle, ...before];
    }
    const unique = new Map(all.map((one) => [keyOf(one), one]));
    await push(
      master,
      withCancellations(master.recurrence, [...unique.values()], first.zone),
    );
  }
  for (const event of others) await push(event);
  return plan;
}

/**
 * The link an event was known by on another calendar, where Google moved it:
 * the old calendar holds a row for the same event id, and Google no longer
 * has the event there. Passing it lets the row keep its identity.
 */
async function movedFromOf(
  api: CalendarApi,
  calendarId: string,
  eventId: string,
  held: Held,
): Promise<string | undefined> {
  if (held.links.has(linkOf(calendarId, eventId))) return undefined;
  for (const other of held.byEvent.get(eventId) ?? []) {
    const link = linkOf(other, eventId);
    if (other === calendarId || held.claimed.has(link)) continue;
    const found = await api.event(other, eventId);
    if (found === "gone" || found["status"] === "cancelled") {
      held.claimed.add(link);
      return link;
    }
  }
  return undefined;
}
