import { createHash } from "node:crypto";
import {
  Declined,
  LinkTaken,
  Refused,
  Unreachable,
  type Change,
  type Entry,
  type Item,
  type JsonValue,
  type OutboundIntent,
  type WatchContext,
} from "@withmarfa/connector";
import {
  connectGoogle,
  GoogleError,
  toChangeError,
  type GoogleOptions,
} from "@withmarfa/google";
import { CalendarApi, isGone, object, text, type Json } from "./api.js";
import {
  calendarListScope,
  childOf,
  env,
  eventsScope,
  inCalendar,
  needs,
  deleteLimit,
  deleteShare,
} from "./config.js";
import {
  calendarOf,
  eventEntry,
  eventOf,
  linkOf,
  makingOf,
  owned,
  splitLink,
  uneditable,
  zoneOf,
  type CalendarInfo,
  type GoogleEvent,
  type Making,
} from "./events.js";
import {
  cancellationOf,
  carried as beyond,
  keyOf,
  removed,
  withCancellations,
  type Cancellation,
} from "./recurrence.js";
import { dayStart, iso, localDate, nextDay, validZone } from "./time.js";

export type WriteContext = WatchContext<typeof env>;

const day = 86_400_000;
const horizonYears = 5;

/** What a write needs of Google, asked once for each context the kit hands. */
interface Session {
  readonly api: CalendarApi;
  readonly account: string;
  readonly calendars: ReadonlyMap<string, CalendarInfo>;
  readonly primary: CalendarInfo | undefined;
}

export interface Writing {
  readonly options: GoogleOptions | undefined;
  readonly base: string;
  readonly now: () => number;
}

const sessions = new WeakMap<object, Promise<Session>>();

function sessionFor(context: WriteContext, writing: Writing): Promise<Session> {
  let found = sessions.get(context);
  if (found === undefined) {
    found = open(context, writing);
    sessions.set(context, found);
    found.catch(() => sessions.delete(context));
  }
  return found;
}

async function open(context: WriteContext, writing: Writing): Promise<Session> {
  const google = connectGoogle(context, needs, writing.options);
  const access = await google.ready();
  for (const scope of [eventsScope, calendarListScope]) {
    if (!access.has(scope)) {
      throw new Unreachable(
        `The Google grant lacks ${scope}, so nothing is changed in Google Calendar until setup is run again`,
        { scope: "google-calendar:scope" },
      );
    }
  }
  const api = new CalendarApi(google, writing.base);
  const calendars = new Map<string, CalendarInfo>();
  for (const item of (await api.calendars()).items) {
    const calendar = calendarOf(item);
    if (calendar !== undefined && item["deleted"] !== true) {
      calendars.set(calendar.id, calendar);
    }
  }
  return {
    api,
    account: access.account,
    calendars,
    primary: [...calendars.values()].find((one) => one.primary),
  };
}

function textOf(item: Item, key: string): string | undefined {
  const value = item.properties[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function linesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === "string")
    : [];
}

/** How a condition names the row: by its title, and its Google id where it
 *  has one. */
function named(item: Item): string {
  const title = textOf(item, "title") ?? "(No title)";
  const link = textOf(item, "google_id");
  return link === undefined ? `"${title}"` : `"${title}" (${link})`;
}

/**
 * The Google id an event made from a row takes: the same for every try, so
 * a create sent again after a lost answer finds what the first one made.
 * Hex digits are among the base32hex ones Google takes.
 */
export function eventIdFor(itemId: string): string {
  return createHash("sha256")
    .update(`marfa google-calendar event\u0000${itemId}`)
    .digest("hex");
}

const reserved = new Set(["forbiddenForNonOrganizer", "requiredAccessLevel"]);

/** What a change throws for what went wrong at Google. */
function answerFor(error: unknown, item: Item): unknown {
  if (error instanceof LinkTaken) return new Refused(error.message);
  if (!(error instanceof GoogleError)) return error;
  if (error.status === 412) {
    return new Unreachable(
      `Google Calendar changed ${named(item)} since Marfa last read it, so the change waits for the next read, which decides field by field`,
    );
  }
  if (
    error.status === 403 &&
    error.reason !== undefined &&
    reserved.has(error.reason)
  ) {
    return new Declined(
      `Google Calendar does not let the account change ${named(item)} (${error.reason}), so the change is not carried`,
    );
  }
  return toChangeError(error) ?? error;
}

async function guarded<T>(item: Item, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw answerFor(error, item);
  }
}

function decline(item: Item, reason: string): Declined {
  return new Declined(
    `Marfa does not change ${named(item)} in Google Calendar: ${reason}`,
  );
}

/** Carries a change made in Marfa to Google Calendar. */
export function carry(
  change: Change,
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  return guarded(change.item, () => carried(change, context, writing));
}

/** Makes a restored row's event live again in Google Calendar. */
export function remake(
  change: Change,
  context: WriteContext,
  writing: Writing,
): Promise<boolean> {
  return guarded(change.item, () => remade(change, context, writing));
}

async function carried(
  change: Change,
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  const { item, kind } = change;
  const gone = kind === "trashed" || kind === "purged";
  const held = context.outbound.get(item.id);
  if (held !== undefined) {
    return gone
      ? overtaken(held, context, writing)
      : settle(held, context, writing);
  }
  const link = textOf(item, "google_id");
  if (link === undefined) {
    if (!gone) return create(change, context, writing);
    if (change.attempted !== undefined) {
      await unmake(item, await sessionFor(context, writing));
    }
    return undefined;
  }
  const parts = splitLink(link);
  if (parts === undefined) {
    throw new Refused(`${named(item)} has a Google id that names no event`);
  }
  if (gone) {
    await remove(item, parts, await sessionFor(context, writing));
    return undefined;
  }
  if (
    change.changed.size === 0 &&
    change.connections?.[inCalendar] === undefined
  ) {
    return undefined;
  }
  return update(change, parts, context, writing);
}

function calendarIn(
  session: Session,
  calendarId: string,
  item: Item,
): CalendarInfo {
  const calendar = session.calendars.get(calendarId);
  if (calendar === undefined) {
    throw new Refused(
      `The account no longer has the calendar ${calendarId}, so ${named(item)} is not changed`,
    );
  }
  return calendar;
}

function calendarIdOf(row: Item): string | undefined {
  const id = row.properties["calendar_id"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

// --- Fields -----------------------------------------------------------------

type Fields = Readonly<Record<string, JsonValue>>;

interface Times {
  readonly start: Fields;
  readonly end: Fields;
  readonly allDay: boolean;
}

/** The row's times as Google takes them: an all-day event as its dates in
 *  the event's own zone, never this process's, and a timed one as instants
 *  with the zone beside them, which a series needs to expand. */
function timesOf(item: Item, calendar: CalendarInfo): Times {
  const starts = Date.parse(textOf(item, "starts_at") ?? "");
  if (!Number.isFinite(starts)) {
    throw new Refused(`${named(item)} has no start time Google can take`);
  }
  const parsed = Date.parse(textOf(item, "ends_at") ?? "");
  const ends = Number.isFinite(parsed) ? parsed : starts;
  if (ends < starts) {
    throw new Refused(`${named(item)} ends before it starts`);
  }
  const zone = zoneOf(textOf(item, "timezone"), calendar.zone);
  if (item.properties["all_day"] === true) {
    const first = localDate(zone, starts);
    // The end is the day after the last: a day the event only reaches into
    // is one of its days.
    const last = ends > starts ? localDate(zone, ends - 1) : first;
    const after = nextDay(last > first ? last : first);
    return {
      allDay: true,
      start: { date: first, timeZone: zone },
      end: { date: after, timeZone: zone },
    };
  }
  const endZone = textOf(item, "end_timezone");
  return {
    allDay: false,
    start: { dateTime: iso(starts), timeZone: zone },
    end: {
      dateTime: iso(ends),
      timeZone: endZone !== undefined && validZone(endZone) ? endZone : zone,
    },
  };
}

const timeFields = [
  "starts_at",
  "ends_at",
  "all_day",
  "timezone",
  "end_timezone",
] as const;

function statusOf(item: Item): string {
  const status = textOf(item, "status");
  if (status === undefined || status === "confirmed") return "confirmed";
  if (status === "tentative") return "tentative";
  throw new Refused(
    `Google Calendar takes a status of tentative or confirmed, so ${named(item)}'s status ${status} is not carried; trash the row to delete the event`,
  );
}

/** Every field Marfa sets on an event it makes or brings back. Guests are
 *  never among them: Marfa never invites anyone. */
function whole(item: Item, calendar: CalendarInfo): Fields {
  const times = timesOf(item, calendar);
  return {
    summary: textOf(item, "title") ?? "",
    description: textOf(item, "description") ?? null,
    location: textOf(item, "place") ?? null,
    status: statusOf(item),
    start: times.start,
    end: times.end,
  };
}

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** The fields a change sends: only those changed in Marfa, and of them only
 *  what differs from the event as Google holds it, with a cleared field
 *  sent as `null`, which clears it in Google. */
function patchOf(
  changed: ReadonlySet<string>,
  item: Item,
  event: GoogleEvent,
  calendar: CalendarInfo,
): Record<string, unknown> {
  const raw = event.raw;
  const out: Record<string, unknown> = {};
  if (changed.has("title")) {
    const title = textOf(item, "title") ?? "";
    if (!same(title, text(raw, "summary") ?? "")) out["summary"] = title;
  }
  if (changed.has("description")) {
    const value = textOf(item, "description");
    if (!same(value, text(raw, "description")))
      out["description"] = value ?? null;
  }
  if (changed.has("place")) {
    const value = textOf(item, "place");
    if (!same(value, text(raw, "location"))) out["location"] = value ?? null;
  }
  if (changed.has("status")) {
    const status = statusOf(item);
    if (status !== (text(raw, "status") ?? "confirmed")) out["status"] = status;
  }
  if (timeFields.some((field) => changed.has(field))) {
    Object.assign(out, timesPatch(item, raw, calendar));
  }
  return out;
}

/** The row's times as a patch to the event Google holds: a switch between
 *  all day and timed clears the key Google held. */
function timesPatch(
  item: Item,
  raw: Json,
  calendar: CalendarInfo,
): { start: Fields; end: Fields } {
  const times = timesOf(item, calendar);
  const wasAllDay = text(object(raw, "start"), "date") !== undefined;
  if (wasAllDay === times.allDay) return { start: times.start, end: times.end };
  const other = times.allDay ? "dateTime" : "date";
  return {
    start: { ...times.start, [other]: null },
    end: { ...times.end, [other]: null },
  };
}

/**
 * What a changed occurrence made in Marfa sends to the occurrence it
 * replaces: its times, and each other field the row holds where it differs.
 * A field the row does not hold keeps what the occurrence has from its
 * series, and an occurrence cancelled in Google comes back.
 */
function occurrencePatch(
  item: Item,
  raw: Json,
  calendar: CalendarInfo,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = textOf(item, "title");
  if (title !== undefined && title !== (text(raw, "summary") ?? "")) {
    out["summary"] = title;
  }
  const description = textOf(item, "description");
  if (description !== undefined && description !== text(raw, "description")) {
    out["description"] = description;
  }
  const place = textOf(item, "place");
  if (place !== undefined && place !== text(raw, "location")) {
    out["location"] = place;
  }
  const held = text(raw, "status") ?? "confirmed";
  const status =
    textOf(item, "status") !== undefined
      ? statusOf(item)
      : held === "cancelled"
        ? "confirmed"
        : held;
  if (status !== held) out["status"] = status;
  return { ...out, ...timesPatch(item, raw, calendar) };
}

// --- Answers ----------------------------------------------------------------

/** The row as Google left it. A series keeps the dates this connector adds
 *  for occurrences Google cancelled by name. */
function entryOf(
  session: Session,
  calendar: CalendarInfo,
  raw: Json,
  cancelled?: readonly Cancellation[],
): Entry | undefined {
  const event = eventOf(raw);
  if (event === undefined) return undefined;
  const series = event.recurrence.length > 0;
  const zone = zoneOf(text(object(raw, "start"), "timeZone"), calendar.zone);
  const lines = series
    ? withCancellations(event.recurrence, cancelled ?? [], zone)
    : undefined;
  return eventEntry(session.account, calendar, event, lines)?.entry;
}

/** The cancellations a series row holds beyond Google's own lines. */
function heldCancellations(
  rowLines: readonly string[],
  googleLines: readonly string[],
  zone: string,
): Cancellation[] {
  return beyond(rowLines, googleLines, zone, {
    ms: Number.NEGATIVE_INFINITY,
    day: "",
  });
}

// --- Create -----------------------------------------------------------------

async function create(
  change: Change,
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  const { item } = change;
  const session = await sessionFor(context, writing);
  const targets = calendarsNamed(change);
  const series = change.connections?.[childOf]?.added ?? [];
  if (series.length > 0) {
    return replaceOccurrence(change, series, targets, session, context);
  }
  if (targets.size > 1) {
    throw new Refused(
      `${named(item)} is on ${String(targets.size)} calendars; a Google Calendar event sits on one`,
    );
  }
  const [chosen] = targets;
  const calendar =
    chosen === undefined ? session.primary : session.calendars.get(chosen);
  if (calendar === undefined) {
    throw new Refused(
      chosen === undefined
        ? `The account has no primary calendar to make ${named(item)} on`
        : `The account has no calendar ${chosen} to make ${named(item)} on`,
    );
  }
  if (!owned.has(calendar.role)) {
    throw new Refused(
      `The account can only read the calendar ${calendar.title}, so ${named(item)} is not made there`,
    );
  }
  return make(change, makingFor(item, calendar), context, writing);
}

/** The calendars a change draws the row to. */
function calendarsNamed(change: Change): Set<string> {
  return new Set(
    (change.connections?.[inCalendar]?.added ?? []).flatMap((row) => {
      const id = calendarIdOf(row);
      return id === undefined ? [] : [id];
    }),
  );
}

/**
 * A changed occurrence made in Marfa: a row beneath a series, naming the
 * start it replaces. Google holds every occurrence of a series already, so
 * the row changes that occurrence rather than making an event of its own.
 * The row is linked before the occurrence is changed, so an occurrence
 * another row holds is refused before anything is sent.
 */
async function replaceOccurrence(
  change: Change,
  parents: readonly Item[],
  targets: ReadonlySet<string>,
  session: Session,
  context: WriteContext,
): Promise<Entry | undefined> {
  const { item } = change;
  const [parent] = parents;
  if (parent === undefined || parents.length > 1) {
    throw new Refused(
      `${named(item)} is beneath ${String(parents.length)} series; a changed occurrence belongs to one`,
    );
  }
  const link = textOf(parent, "google_id");
  const parts = link === undefined ? undefined : splitLink(link);
  if (parts === undefined) {
    throw new Refused(
      `The series ${named(item)} is beneath has no Google id, so the occurrence it changes cannot be found`,
    );
  }
  const original = Date.parse(textOf(item, "original_starts_at") ?? "");
  if (!Number.isFinite(original)) {
    throw new Refused(
      `${named(item)} is beneath a series but names no start it replaces in original_starts_at`,
    );
  }
  if ([...targets].some((id) => id !== parts.calendarId)) {
    throw new Refused(
      `${named(item)} is drawn to another calendar than its series; an occurrence sits on its series' calendar`,
    );
  }
  const refuse = (reason: string): Refused =>
    new Refused(
      `Marfa does not change the series ${named(parent)} in Google Calendar (${reason}), so ${named(item)} is not carried`,
    );
  if (parent.properties["editable"] === false) {
    throw refuse(
      textOf(parent, "uneditable_reason") ?? "Google does not let it",
    );
  }
  const calendar = calendarIn(session, parts.calendarId, item);
  const found = await session.api.event(parts.calendarId, parts.eventId);
  const event = found === "gone" ? undefined : eventOf(found);
  if (
    found === "gone" ||
    event === undefined ||
    event.status === "cancelled" ||
    event.recurrence.length === 0
  ) {
    throw new Refused(
      `Google Calendar no longer has the series ${named(parent)}, so ${named(item)} is not carried`,
    );
  }
  const reason = uneditable(event, calendar);
  if (reason !== undefined) throw refuse(reason);
  const start = object(found, "start");
  const zone = zoneOf(text(start, "timeZone"), calendar.zone);
  const allDay = text(start, "date") !== undefined;
  const day = localDate(zone, original);
  if (allDay && dayStart(zone, day) !== original) {
    throw new Refused(
      `${named(item)} names ${iso(original)} in original_starts_at, which is not the start of a day in ${zone}, the zone of the all-day series ${named(parent)}, so it names no occurrence`,
    );
  }
  const wanted: Cancellation = allDay
    ? { kind: "day", day }
    : { kind: "instant", ms: original };
  const instance = await occurrenceOf(session, parts, wanted);
  const instanceId = instance === undefined ? undefined : text(instance, "id");
  if (instance === undefined || instanceId === undefined) {
    throw new Refused(
      `The series ${named(parent)} has no occurrence at ${startParam(wanted)} in Google Calendar, so ${named(item)} replaces none`,
    );
  }
  const occurrence = eventOf(instance);
  const own =
    occurrence === undefined ? undefined : uneditable(occurrence, calendar);
  if (own !== undefined) throw refuse(own);
  // Decided before the link, so a row the patch refuses stays unlinked.
  const fields = occurrencePatch(item, instance, calendar);
  const target = linkOf(calendar.id, instanceId);
  try {
    await context.setLink(item, target);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    throw new Refused(
      `Another row already holds the occurrence ${target}, so ${named(item)} does not replace it`,
    );
  }
  const changed = await session.api.patch(
    calendar.id,
    instanceId,
    fields,
    text(instance, "etag"),
  );
  return entryOf(session, calendar, changed);
}

/**
 * The write that makes the row's event under its own id. A new event has no
 * occurrences to cancel one by one, so a series takes every line the row
 * holds: its rules, and the dates it skips, both Google's own lines and the
 * ones this connector added for occurrences Google cancelled by name.
 */
function makingFor(item: Item, calendar: CalendarInfo): Making {
  const lines = linesOf(item.properties["recurrence"]);
  return {
    calendarId: calendar.id,
    eventId: eventIdFor(item.id),
    body: {
      ...whole(item, calendar),
      ...(lines.length > 0 && { recurrence: lines }),
    },
  };
}

/**
 * Keeps the write in the outbound journal before sending it, so a write
 * whose answer is lost is sent again as it was, and the read leaves the
 * event it makes alone until the row is linked to it.
 */
async function make(
  change: Change,
  making: Making,
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  const held = await context.outbound.save(change, {
    request: making as unknown as JsonValue,
    baseline: null,
  });
  return settle(held, context, writing);
}

/** Sends a journaled write, links the row to what it made, and keeps that
 *  as done. A write sent again first asks Google whether the first landed. */
async function settle(
  held: OutboundIntent,
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  const making = makingOf(held.request);
  if (making === undefined) {
    throw new Refused(
      `The write kept for ${named(held.change.item)} is not one this connector makes`,
    );
  }
  if (held.acknowledged) return undefined;
  if (held.requestNotApplied === true) {
    await context.outbound.prepareRetry(held.change.item.id, held.token);
  }
  const { item } = held.change;
  const session = await sessionFor(context, writing);
  const calendar = calendarIn(session, making.calendarId, item);
  const made = await insertOnce(item, calendar, making, session);
  await context.setLink(item, linkOf(calendar.id, making.eventId));
  const entry = entryOf(session, calendar, made);
  await context.outbound.acknowledge(item.id, held.token, entry);
  return entry;
}

/**
 * Makes the event under the row's own id. Google already holding that id
 * means an earlier try landed and its answer was lost, so that event is
 * the row's and is not changed, or the event was deleted since, and comes
 * back with the row's values.
 */
async function insertOnce(
  item: Item,
  calendar: CalendarInfo,
  making: Making,
  session: Session,
): Promise<Json> {
  try {
    return await session.api.insert(calendar.id, {
      id: making.eventId,
      ...making.body,
    });
  } catch (error) {
    if (!(error instanceof GoogleError) || error.status !== 409) throw error;
  }
  const found = await session.api.event(calendar.id, making.eventId);
  if (found === "gone") {
    return session.api.patch(
      calendar.id,
      making.eventId,
      making.body,
      undefined,
    );
  }
  if (found["status"] !== "cancelled") return found;
  const event = eventOf(found);
  const reason = event === undefined ? undefined : uneditable(event, calendar);
  if (reason !== undefined) throw decline(item, reason);
  return session.api.patch(
    calendar.id,
    making.eventId,
    making.body,
    text(found, "etag"),
  );
}

function startParam(one: Cancellation): string {
  return one.kind === "instant" ? iso(one.ms) : one.day;
}

/** Google's occurrence of a series that began at the moment given,
 *  cancelled or not. */
async function occurrenceOf(
  session: Session,
  parts: { calendarId: string; eventId: string },
  wanted: Cancellation,
): Promise<Json | undefined> {
  const found = await session.api.occurrence(
    parts.calendarId,
    parts.eventId,
    startParam(wanted),
  );
  return found.find((raw) => {
    const event = eventOf(raw);
    const one = event === undefined ? undefined : cancellationOf(event);
    return one !== undefined && keyOf(one) === keyOf(wanted);
  });
}

// --- Update -----------------------------------------------------------------

async function update(
  change: Change,
  parts: { calendarId: string; eventId: string },
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  const { item } = change;
  // The row's own word first, so an event Marfa may not change is never
  // asked about.
  if (item.properties["editable"] === false) {
    throw decline(
      item,
      textOf(item, "uneditable_reason") ?? "Google does not let it",
    );
  }
  const session = await sessionFor(context, writing);
  let calendar = calendarIn(session, parts.calendarId, item);
  const found = await session.api.event(parts.calendarId, parts.eventId);
  if (found === "gone" || found["status"] === "cancelled") {
    throw new Refused(
      `Google Calendar no longer has ${named(item)}, so the change is not carried`,
    );
  }
  const event = eventOf(found);
  if (event === undefined) {
    throw new Refused(`Google Calendar answered no event for ${named(item)}`);
  }
  const reason = uneditable(event, calendar);
  if (reason !== undefined) throw decline(item, reason);
  const read = textOf(item, "etag");
  const etag = text(found, "etag");
  if (read !== undefined && read !== etag) {
    // Google changed the event since Marfa read it: the next read brings
    // that change, and decides field by field against this one.
    throw new Unreachable(
      `Google Calendar changed ${named(item)} since Marfa last read it, so the change waits for the next read, which decides field by field`,
    );
  }

  let current: Json = found;
  let here = parts.calendarId;
  const destination = destinationOf(change, parts.calendarId);
  if (destination !== undefined) {
    if (event.recurringEventId !== undefined) {
      throw decline(
        item,
        "Google Calendar moves a whole series to another calendar, not one occurrence",
      );
    }
    const target = session.calendars.get(destination);
    if (target === undefined || !owned.has(target.role)) {
      throw decline(
        item,
        target === undefined
          ? `the account has no calendar ${destination}`
          : `the account can only read the calendar ${target.title}`,
      );
    }
    current = await session.api.move(
      parts.calendarId,
      parts.eventId,
      destination,
    );
    await context.setLink(item, linkOf(destination, parts.eventId));
    here = destination;
    calendar = target;
  }

  const fields = patchOf(change.changed, item, event, calendar);
  const zone = zoneOf(text(object(found, "start"), "timeZone"), calendar.zone);
  const rowLines = linesOf(item.properties["recurrence"]);
  let cancelled = heldCancellations(rowLines, event.recurrence, zone);
  let plan: SeriesPlan | undefined;
  if (
    change.changed.has("recurrence") &&
    event.recurringEventId === undefined
  ) {
    plan = await planSeries(
      item,
      event,
      here,
      zone,
      rowLines,
      session,
      writing,
    );
    if (plan.lines !== undefined) fields["recurrence"] = plan.lines;
    cancelled = plan.cancelled;
  }
  if (Object.keys(fields).length > 0) {
    current = await session.api.patch(
      here,
      parts.eventId,
      fields,
      text(current, "etag"),
    );
  }
  if (plan !== undefined)
    await applySeries(plan, here, parts.eventId, session, context);
  return entryOf(session, calendar, current, cancelled);
}

/** The calendar a change moves the event to, or nothing where it stays. */
function destinationOf(change: Change, from: string): string | undefined {
  const ids = calendarsNamed(change);
  if (ids.size > 1) {
    throw decline(
      change.item,
      "a Google Calendar event sits on one calendar, and the row names several",
    );
  }
  const [to] = ids;
  return to === undefined || to === from ? undefined : to;
}

// --- Series -----------------------------------------------------------------

interface SeriesPlan {
  /** The recurrence to send, where it differs from Google's. */
  readonly lines: string[] | undefined;
  readonly cancel: Cancellation[];
  readonly restore: Cancellation[];
  /** What the row holds beyond the lines sent, once the plan has landed. */
  readonly cancelled: Cancellation[];
}

function isExdate(line: string): boolean {
  return /^EXDATE[;:]/i.test(line.trim());
}

/**
 * What a change to a series' recurrence asks of Google. Google's own lines
 * that the row still holds are kept, and the lines this connector adds for
 * occurrences Google cancelled by name are never sent. A date the row
 * removes beyond the lines sent cancels that occurrence, and a cancelled
 * occurrence whose date the row no longer removes comes back.
 */
async function planSeries(
  item: Item,
  event: GoogleEvent,
  calendarId: string,
  zone: string,
  rowLines: readonly string[],
  session: Session,
  writing: Writing,
): Promise<SeriesPlan> {
  const own = event.recurrence;
  const rules = rowLines.filter((line) => !isExdate(line));
  if (rules.length === 0 && own.length > 0) {
    throw new Refused(
      `${named(item)} would stop repeating; end a series in Google Calendar itself`,
    );
  }
  const lines = [
    ...rules,
    ...own.filter((line) => isExdate(line) && rowLines.includes(line)),
  ];
  const allDay = text(object(event.raw, "start"), "date") !== undefined;
  const wanted = removed(rowLines, zone);
  const sent = removed(lines, zone);
  const want: Cancellation[] = allDay
    ? [...wanted.days]
        .filter((one) => !sent.days.has(one))
        .map((one) => ({ kind: "day", day: one }))
    : [...wanted.instants]
        .filter((one) => !sent.instants.has(one))
        .map((one) => ({ kind: "instant", ms: one }));
  const starts = Date.parse(
    text(object(event.raw, "start"), "dateTime") ??
      text(object(event.raw, "start"), "date") ??
      "",
  );
  const first = Number.isFinite(starts) ? starts : writing.now();
  const horizon = Math.max(writing.now(), first) + horizonYears * 365 * day;
  const asked = await session.api.cancelled(
    calendarId,
    event.id,
    iso(first - day),
    iso(horizon),
  );
  const atGoogle = new Map<string, Cancellation>();
  for (const raw of asked) {
    const one = eventOf(raw);
    const at = one === undefined ? undefined : cancellationOf(one);
    if (at !== undefined) atGoogle.set(keyOf(at), at);
  }
  const wantedKeys = new Set(want.map(keyOf));
  return {
    lines: JSON.stringify(lines) === JSON.stringify(own) ? undefined : lines,
    cancel: want.filter((one) => !atGoogle.has(keyOf(one))),
    restore: [...atGoogle.values()].filter(
      (one) => !wantedKeys.has(keyOf(one)) && !removedBy(sent, one),
    ),
    cancelled: want,
  };
}

function removedBy(
  sent: { instants: Set<number>; days: Set<string> },
  one: Cancellation,
): boolean {
  return one.kind === "instant"
    ? sent.instants.has(one.ms)
    : sent.days.has(one.day);
}

async function applySeries(
  plan: SeriesPlan,
  calendarId: string,
  seriesId: string,
  session: Session,
  context: WriteContext,
): Promise<void> {
  const parts = { calendarId, eventId: seriesId };
  for (const [ones, status] of [
    [plan.cancel, "cancelled"],
    [plan.restore, "confirmed"],
  ] as const) {
    for (const one of ones) {
      const found = await occurrenceOf(session, parts, one);
      if (found === undefined) {
        context.log.info(
          `Google Calendar holds no occurrence of ${linkOf(calendarId, seriesId)} at ${startParam(one)}, so there is none to ${status === "cancelled" ? "cancel" : "bring back"}`,
        );
        continue;
      }
      if (found["status"] === status) continue;
      const id = text(found, "id");
      if (id === undefined) continue;
      await session.api.patch(calendarId, id, { status }, text(found, "etag"));
    }
  }
}

// --- Trash, purge and restore -----------------------------------------------

/** Deletes the event in Google, while Marfa may change it. Deleting a series
 *  deletes its occurrences with it. */
async function remove(
  item: Item,
  parts: { calendarId: string; eventId: string },
  session: Session,
): Promise<void> {
  if (item.properties["editable"] === false) {
    throw decline(
      item,
      textOf(item, "uneditable_reason") ?? "Google does not let it",
    );
  }
  await deleteEvent(item, parts, session);
}

async function deleteEvent(
  item: Item,
  parts: { calendarId: string; eventId: string },
  session: Session,
): Promise<void> {
  const calendar = session.calendars.get(parts.calendarId);
  if (calendar === undefined) return;
  if (!owned.has(calendar.role)) {
    throw decline(item, "the account can only read this calendar");
  }
  const found = await session.api.event(parts.calendarId, parts.eventId);
  if (found === "gone" || found["status"] === "cancelled") return;
  const event = eventOf(found);
  const reason = event === undefined ? undefined : uneditable(event, calendar);
  if (reason !== undefined) throw decline(item, reason);
  await session.api.remove(
    parts.calendarId,
    parts.eventId,
    text(found, "etag"),
  );
}

/**
 * The trash or purge of a row whose create, or making again, got no answer
 * and so never linked the row. The event that write made, if it landed, is
 * under the row's own id on the calendar the saved write names, so it is
 * deleted there, and the write is then settled, so it is never sent again.
 * Where the delete's answer is lost too, the next run asks Google again.
 */
async function overtaken(
  held: OutboundIntent,
  context: WriteContext,
  writing: Writing,
): Promise<undefined> {
  const { item } = held.change;
  const making = makingOf(held.request);
  if (making?.eventId !== eventIdFor(item.id)) {
    throw new Refused(
      `The write kept for ${named(item)} is not one this connector makes`,
    );
  }
  if (held.acknowledged) return undefined;
  await deleteEvent(item, making, await sessionFor(context, writing));
  await context.outbound.acknowledge(item.id, held.token);
  return undefined;
}

/** The trash of a row whose create got no link: whatever that create made,
 *  under the row's own id, is deleted. */
async function unmake(item: Item, session: Session): Promise<void> {
  const id = eventIdFor(item.id);
  for (const calendar of session.calendars.values()) {
    if (!owned.has(calendar.role)) continue;
    const found = await session.api.event(calendar.id, id);
    if (found === "gone" || found["status"] === "cancelled") continue;
    await session.api.remove(calendar.id, id, text(found, "etag"));
  }
}

async function remade(
  change: Change,
  context: WriteContext,
  writing: Writing,
): Promise<boolean> {
  const { item } = change;
  const held = context.outbound.get(item.id);
  if (held !== undefined) {
    await settle(held, context, writing);
    return true;
  }
  const link = textOf(item, "google_id");
  const parts = link === undefined ? undefined : splitLink(link);
  if (parts === undefined) return false;
  if (item.properties["editable"] === false) {
    throw decline(
      item,
      textOf(item, "uneditable_reason") ?? "Google does not let it",
    );
  }
  const session = await sessionFor(context, writing);
  const calendar = session.calendars.get(parts.calendarId);
  if (calendar === undefined || !owned.has(calendar.role)) {
    throw decline(
      item,
      calendar === undefined
        ? `the account no longer has the calendar ${parts.calendarId}`
        : "the account can only read this calendar",
    );
  }
  const found = await session.api.event(parts.calendarId, parts.eventId);
  if (found !== "gone" && found["status"] !== "cancelled") return false;
  if (found === "gone") {
    if (textOf(item, "recurring_event_id") !== undefined) {
      throw decline(item, "Google Calendar no longer has the occurrence");
    }
    // Google may answer a deleted event as gone while it can still bring it
    // back under its own id, which keeps its link and history.
    try {
      await session.api.patch(
        parts.calendarId,
        parts.eventId,
        whole(item, calendar),
        undefined,
      );
      return true;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
    // The id is gone for good, so the event is made anew under the row's.
    await make(change, makingFor(item, calendar), context, writing);
    return true;
  }
  const event = eventOf(found);
  const reason = event === undefined ? undefined : uneditable(event, calendar);
  if (reason !== undefined) throw decline(item, reason);
  await session.api.patch(
    parts.calendarId,
    parts.eventId,
    whole(item, calendar),
    text(found, "etag"),
  );
  return true;
}

// --- The safety stop ----------------------------------------------------------

/** The events of one calendar a batch would delete, among those it holds. */
interface Deleting {
  readonly title: string;
  readonly doomed: number;
  readonly live: number;
  /** Whether a trash is among the deletes, which restoring its row undoes. */
  readonly trashed: boolean;
}

/**
 * The events a batch of changes would delete in Google, by calendar, for
 * each calendar where that is more than `deleteLimit`. Only a delete Marfa
 * would send counts: a row Marfa may not change, or one on a calendar the
 * account no longer has or can only read, sends none, and neither does an
 * event Google no longer holds, such as one a create that got no answer
 * never made. An event named by both a trash and a purge is one delete.
 */
async function deleting(
  changes: readonly Change[],
  context: WriteContext,
  writing: Writing,
): Promise<Deleting[]> {
  const byCalendar = new Map<string, Map<string, boolean>>();
  for (const { kind, item } of changes) {
    const parts = deletedBy(item, context);
    if (parts === undefined) continue;
    const ids = byCalendar.get(parts.calendarId) ?? new Map<string, boolean>();
    ids.set(
      parts.eventId,
      (ids.get(parts.eventId) ?? false) || kind === "trashed",
    );
    byCalendar.set(parts.calendarId, ids);
  }
  const large = [...byCalendar].filter(([, ids]) => ids.size > deleteLimit);
  if (large.length === 0) return [];
  const session = await sessionFor(context, writing);
  const found: Deleting[] = [];
  for (const [calendarId, ids] of large) {
    const calendar = session.calendars.get(calendarId);
    if (calendar === undefined || !owned.has(calendar.role)) continue;
    const live = await session.api.live(calendarId);
    const doomed = [...ids].filter(([id]) => live.has(id));
    if (doomed.length > deleteLimit) {
      found.push({
        title: calendar.title,
        doomed: doomed.length,
        live: live.size,
        trashed: doomed.some(([, trashed]) => trashed),
      });
    }
  }
  return found;
}

/** The event a row's trash or purge deletes: the one an unanswered create
 *  made under the row's own id, or the one the row is linked to. */
function deletedBy(
  item: Item,
  context: WriteContext,
): { calendarId: string; eventId: string } | undefined {
  const held = context.outbound.get(item.id);
  if (held !== undefined) {
    return held.acknowledged ? undefined : makingOf(held.request);
  }
  if (item.properties["editable"] === false) return undefined;
  const link = textOf(item, "google_id");
  return link === undefined ? undefined : splitLink(link);
}

/**
 * Holds a batch of trashes and purges that would delete more than
 * `deleteLimit` events of one calendar and more than `deleteShare` of the
 * events it holds, unless `GOOGLE_CALENDAR_CONFIRM_DELETES` names the number
 * the batch deletes.
 */
export async function preflight(
  changes: readonly Change[],
  context: WriteContext,
  writing: Writing,
): Promise<void> {
  const held = (await deleting(changes, context, writing)).filter(
    (one) => one.doomed > one.live * deleteShare,
  );
  if (held.length === 0) return;
  const total = held.reduce((sum, one) => sum + one.doomed, 0);
  if (context.env.GOOGLE_CALENDAR_CONFIRM_DELETES === String(total)) {
    context.log.info(
      `GOOGLE_CALENDAR_CONFIRM_DELETES confirms deleting ${String(total)} events from Google Calendar`,
    );
    return;
  }
  const listed = held.map(
    (one) =>
      `${String(one.doomed)} of the ${String(one.live)} events on ${one.title}`,
  );
  const undo = held.some((one) => one.trashed)
    ? " To keep the events, restore the trashed rows in Marfa."
    : "";
  const message = `Rows trashed or purged in Marfa would delete ${listed.join(" and ")} in Google Calendar, more than ${String(deleteLimit)} events and a quarter of a calendar at once, so nothing is carried to Google and the connector stops.${undo} To delete them, set GOOGLE_CALENDAR_CONFIRM_DELETES=${String(total)} for one run, then remove it.`;
  context.log.condition("deletes-held", message);
  throw new Error(message);
}
