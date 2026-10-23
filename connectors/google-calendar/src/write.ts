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
import { CalendarApi, isGone, isJson, object, text, type Json } from "./api.js";
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
  replacingOf,
  splitLink,
  uneditable,
  zoneOf,
  type CalendarInfo,
  type GoogleEvent,
  type Making,
  type Replacing,
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

/** What a write needs of Google, asked once for each context the kit hands. */
interface Session {
  readonly api: CalendarApi;
  readonly account: string;
  readonly calendars: ReadonlyMap<string, CalendarInfo>;
  readonly primary: CalendarInfo | undefined;
  /** Google's answer for each calendar the listing left out, asked by id:
   *  nothing where it is gone. */
  readonly asked: Map<string, CalendarInfo | undefined>;
}

export interface Writing {
  readonly options: GoogleOptions | undefined;
  readonly base: string;
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
    asked: new Map(),
  };
}

/**
 * A calendar of the account. One listing that leaves a calendar out doesn't
 * prove it removed, so such a calendar is asked about by id, and only
 * Google's answer that it is gone or deleted makes it gone. Where Google
 * can't answer, nothing is decided, and the change waits for a later run.
 */
async function calendarFor(
  session: Session,
  calendarId: string,
): Promise<CalendarInfo | undefined> {
  const listed = session.calendars.get(calendarId);
  if (listed !== undefined) return listed;
  if (session.asked.has(calendarId)) return session.asked.get(calendarId);
  let found: Json | "gone";
  try {
    found = await session.api.calendar(calendarId);
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error;
    throw new Unreachable(
      `The calendar ${calendarId} is missing from the account's calendar list, and Google could not say whether it was removed (${error.message}), so nothing is changed on it until a later run`,
    );
  }
  const calendar =
    found === "gone" || found["deleted"] === true
      ? undefined
      : calendarOf(found);
  session.asked.set(calendarId, calendar);
  return calendar;
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
    // Every create that can make an event under the row's own id is
    // journaled first, so a trash with nothing held has nothing to delete.
    return gone ? undefined : create(change, context, writing);
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

async function calendarIn(
  session: Session,
  calendarId: string,
  item: Item,
): Promise<CalendarInfo> {
  const calendar = await calendarFor(session, calendarId);
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
    chosen === undefined ? session.primary : await calendarFor(session, chosen);
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
 * The change is kept in the outbound journal before anything is sent, with
 * the occurrence's values it replaces as its baseline, so one that fails is
 * settled against them, and the read leaves the occurrence's row alone until
 * it lands.
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
  if (parent.properties["editable"] === false) {
    throw seriesRefused(
      named(parent),
      item,
      textOf(parent, "uneditable_reason") ?? "Google does not let it",
    );
  }
  const calendar = await calendarIn(session, parts.calendarId, item);
  const found = await occurrenceFor(
    item,
    original,
    parts,
    named(parent),
    calendar,
    session,
  );
  // Decided before the journal, so a row the patch refuses keeps nothing.
  const fields = occurrencePatch(item, found.instance, {
    ...calendar,
    zone: found.zone,
  }) as Record<string, JsonValue>;
  const replacing: Replacing = {
    calendarId: calendar.id,
    seriesId: parts.eventId,
    eventId: found.id,
    fields,
    etag: text(found.instance, "etag") ?? null,
  };
  const held = await context.outbound.save(change, {
    request: replacing as unknown as JsonValue,
    baseline: Object.fromEntries(
      Object.keys(fields).map((key) => [key, heldValue(found.instance, key)]),
    ),
  });
  return replace(held, replacing, session, context, found.instance);
}

/**
 * Sends a journaled change of a changed occurrence made in Marfa and keeps
 * it as done. The row is linked first, so an occurrence another row holds is
 * refused before anything is sent.
 *
 * A change sent again finds the occurrence anew, cancelled or not, and
 * settles each field against what Google holds now: a field at the value
 * sent has landed, a field still at the value the change was made against
 * is sent, and a field Google changed since keeps Google's value. What is
 * sent is held to the version compared, and an occurrence cancelled in
 * Google comes back, as the first try would have brought it.
 */
async function replace(
  held: OutboundIntent,
  replacing: Replacing,
  session: Session,
  context: WriteContext,
  first?: Json,
): Promise<Entry | undefined> {
  if (held.acknowledged) return undefined;
  if (held.requestNotApplied === true) {
    await context.outbound.prepareRetry(held.change.item.id, held.token);
  }
  const { item } = held.change;
  const calendar = await calendarIn(session, replacing.calendarId, item);
  const target = linkOf(calendar.id, replacing.eventId);
  let instance = first;
  if (instance === undefined) {
    const found = await occurrenceFor(
      item,
      Date.parse(textOf(item, "original_starts_at") ?? ""),
      { calendarId: replacing.calendarId, eventId: replacing.seriesId },
      linkOf(replacing.calendarId, replacing.seriesId),
      calendar,
      session,
    );
    if (found.id !== replacing.eventId) {
      throw new Refused(
        `Google Calendar no longer has the occurrence ${target}, so ${named(item)} is not carried`,
      );
    }
    instance = found.instance;
  }
  try {
    await context.setLink(item, target);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    throw new Refused(
      `Another row already holds the occurrence ${target}, so ${named(item)} does not replace it`,
    );
  }
  const before = isJson(held.baseline) ? held.baseline : {};
  const fields: Record<string, JsonValue> = {};
  let overruled = false;
  for (const [key, value] of Object.entries(replacing.fields)) {
    if (first !== undefined || holds(instance, key, before[key] ?? null)) {
      fields[key] = value;
    } else if (!holds(instance, key, value)) {
      overruled = true;
    }
  }
  const changed =
    Object.keys(fields).length === 0
      ? instance
      : await session.api.patch(
          calendar.id,
          replacing.eventId,
          fields,
          text(instance, "etag"),
        );
  // A field Google changed since keeps Google's value. Without an answer
  // the kit takes what was sent as Google's, so the read that follows
  // finds Google's value changed and brings it to the row.
  const entry = overruled ? undefined : entryOf(session, calendar, changed);
  await context.outbound.acknowledge(item.id, held.token, entry);
  return entry;
}

/** An occurrence's value of a field its patch sets, as the patch compares
 *  it: no status is confirmed, and no title is empty. */
function heldValue(raw: Json, key: string): JsonValue {
  if (key === "status") return text(raw, "status") ?? "confirmed";
  if (key === "summary") return text(raw, "summary") ?? "";
  const value = raw[key];
  return value === undefined || value === "" ? null : (value as JsonValue);
}

/** Whether an occurrence holds a field at a value, with times compared by
 *  their date or instant, whatever zone Google answers them in. */
function holds(raw: Json, key: string, value: JsonValue): boolean {
  const held = heldValue(raw, key);
  if (key !== "start" && key !== "end") return same(held, value);
  if (!isJson(held) || !isJson(value)) return same(held, value);
  const at = (time: Json): number | undefined => {
    const stamp = text(time, "dateTime");
    return stamp === undefined ? undefined : Date.parse(stamp);
  };
  return text(held, "date") === text(value, "date") && at(held) === at(value);
}

function seriesRefused(series: string, item: Item, reason: string): Refused {
  return new Refused(
    `Marfa does not change the series ${series} in Google Calendar (${reason}), so ${named(item)} is not carried`,
  );
}

/**
 * The occurrence of a series that a changed occurrence made in Marfa
 * replaces, cancelled or not, and the series' zone, in which the row's
 * times are read when it holds no zone of its own.
 */
async function occurrenceFor(
  item: Item,
  original: number,
  parts: { calendarId: string; eventId: string },
  series: string,
  calendar: CalendarInfo,
  session: Session,
): Promise<{ instance: Json; id: string; zone: string }> {
  const found = await session.api.event(parts.calendarId, parts.eventId);
  const event = found === "gone" ? undefined : eventOf(found);
  if (
    found === "gone" ||
    event === undefined ||
    event.status === "cancelled" ||
    event.recurrence.length === 0
  ) {
    throw new Refused(
      `Google Calendar no longer has the series ${series}, so ${named(item)} is not carried`,
    );
  }
  const reason = uneditable(event, calendar);
  if (reason !== undefined) throw seriesRefused(series, item, reason);
  const start = object(found, "start");
  const zone = zoneOf(text(start, "timeZone"), calendar.zone);
  const allDay = text(start, "date") !== undefined;
  const day = localDate(zone, original);
  if (allDay && dayStart(zone, day) !== original) {
    throw new Refused(
      `${named(item)} names ${iso(original)} in original_starts_at, which is not the start of a day in ${zone}, the zone of the all-day series ${series}, so it names no occurrence`,
    );
  }
  const wanted: Cancellation = allDay
    ? { kind: "day", day }
    : { kind: "instant", ms: original };
  const instance = await occurrenceOf(session, parts, wanted);
  const id = instance === undefined ? undefined : text(instance, "id");
  if (instance === undefined || id === undefined) {
    throw new Refused(
      `The series ${series} has no occurrence at ${startParam(wanted)} in Google Calendar, so ${named(item)} replaces none`,
    );
  }
  const occurrence = eventOf(instance);
  const own =
    occurrence === undefined ? undefined : uneditable(occurrence, calendar);
  if (own !== undefined) throw seriesRefused(series, item, own);
  return { instance, id, zone };
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
 *  as done. A write sent again first asks Google whether the first landed.
 *  The change of a changed occurrence is sent by `replace`. */
async function settle(
  held: OutboundIntent,
  context: WriteContext,
  writing: Writing,
): Promise<Entry | undefined> {
  const replacing = replacingOf(held.request);
  if (replacing !== undefined) {
    return replace(
      held,
      replacing,
      await sessionFor(context, writing),
      context,
    );
  }
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
  const calendar = await calendarIn(session, making.calendarId, item);
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
  let calendar = await calendarIn(session, parts.calendarId, item);
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

  const destination = destinationOf(change, parts.calendarId);
  let target: CalendarInfo | undefined;
  if (destination !== undefined) {
    if (event.recurringEventId !== undefined) {
      throw decline(
        item,
        "Google Calendar moves a whole series to another calendar, not one occurrence",
      );
    }
    target = await calendarFor(session, destination);
    if (target === undefined || !owned.has(target.role)) {
      throw decline(
        item,
        target === undefined
          ? `the account has no calendar ${destination}`
          : `the account can only read the calendar ${target.title}`,
      );
    }
  }

  const from = calendar;
  calendar = target ?? calendar;
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
      parts.calendarId,
      zone,
      rowLines,
      session,
    );
    // Decided before anything is sent, so a declined change sends nothing.
    await checkSeries(item, plan, parts, from, session);
    if (plan.lines !== undefined) fields["recurrence"] = plan.lines;
    cancelled = plan.cancelled;
  }

  let current: Json = found;
  let here = parts.calendarId;
  if (target !== undefined) {
    current = await session.api.move(
      parts.calendarId,
      parts.eventId,
      target.id,
      etag,
    );
    await context.setLink(item, linkOf(target.id, parts.eventId));
    here = target.id;
  }
  if (Object.keys(fields).length > 0) {
    current = await session.api.patch(
      here,
      parts.eventId,
      fields,
      text(current, "etag"),
    );
  }
  if (plan !== undefined) {
    await applySeries(plan, here, parts.eventId, calendar, session, context);
  }
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
  // Every cancelled occurrence, in whatever year: the row no longer says
  // which dates it held, so a window would miss one removed beyond it.
  const atGoogle = new Map<string, Cancellation>();
  for (const raw of await session.api.inventory(calendarId)) {
    const one = eventOf(raw);
    if (one?.recurringEventId !== event.id || one.status !== "cancelled") {
      continue;
    }
    const at = cancellationOf(one);
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

/** Each occurrence a plan changes, with the status it gives it. */
function stepsOf(
  plan: SeriesPlan,
): [Cancellation, "cancelled" | "confirmed"][] {
  return [
    ...plan.cancel.map((one) => [one, "cancelled"] as const),
    ...plan.restore.map((one) => [one, "confirmed"] as const),
  ] as [Cancellation, "cancelled" | "confirmed"][];
}

/** Why Marfa may not give an occurrence a status, or nothing where it may
 *  or Google holds it so already. */
function stepRefused(
  found: Json,
  status: string,
  calendar: CalendarInfo,
): string | undefined {
  if (found["status"] === status) return undefined;
  const event = eventOf(found);
  return event === undefined ? undefined : uneditable(event, calendar);
}

/**
 * Declines a change to a series that would cancel or bring back an
 * occurrence Marfa may not change, such as a changed occurrence with other
 * guests, as a change to that occurrence itself is declined.
 */
async function checkSeries(
  item: Item,
  plan: SeriesPlan,
  parts: { calendarId: string; eventId: string },
  calendar: CalendarInfo,
  session: Session,
): Promise<void> {
  const refused: string[] = [];
  for (const [one, status] of stepsOf(plan)) {
    const found = await occurrenceOf(session, parts, one);
    if (found === undefined && status === "confirmed") {
      throw unfound(parts, one);
    }
    const reason =
      found === undefined ? undefined : stepRefused(found, status, calendar);
    if (reason !== undefined) {
      refused.push(
        `the occurrence at ${startParam(one)} is not to be ${status === "cancelled" ? "cancelled" : "brought back"}, since ${reason}`,
      );
    }
  }
  if (refused.length > 0) throw decline(item, refused.join("; "));
}

/** A cancelled occurrence the calendar's listing holds that the lookup by its
 *  start does not find: bringing it back waits, rather than counting as done. */
function unfound(
  parts: { calendarId: string; eventId: string },
  one: Cancellation,
): Unreachable {
  return new Unreachable(
    `Google Calendar lists a cancelled occurrence of ${linkOf(parts.calendarId, parts.eventId)} at ${startParam(one)} but did not find it by its start, so bringing it back waits for a later run`,
  );
}

async function applySeries(
  plan: SeriesPlan,
  calendarId: string,
  seriesId: string,
  calendar: CalendarInfo,
  session: Session,
  context: WriteContext,
): Promise<void> {
  const parts = { calendarId, eventId: seriesId };
  for (const [one, status] of stepsOf(plan)) {
    const found = await occurrenceOf(session, parts, one);
    if (found === undefined) {
      if (status === "confirmed") throw unfound(parts, one);
      context.log.info(
        `Google Calendar holds no occurrence of ${linkOf(calendarId, seriesId)} at ${startParam(one)}, so there is none to cancel`,
      );
      continue;
    }
    if (found["status"] === status) continue;
    const id = text(found, "id");
    if (id === undefined) continue;
    if (stepRefused(found, status, calendar) !== undefined) {
      // Changed in Google since `checkSeries`: the next run reads it and
      // declines the change there.
      throw new Unreachable(
        `Google Calendar changed the occurrence ${linkOf(calendarId, id)} since Marfa checked it, so the change to its series waits for the next read`,
      );
    }
    await session.api.patch(calendarId, id, { status }, text(found, "etag"));
  }
}

// --- Trash, purge and restore -----------------------------------------------

/** Deletes the event in Google, while Marfa may change it. Deleting a series
 *  deletes its changed occurrences with it, so Marfa must be able to change
 *  each of those too. */
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
  const calendar = await calendarFor(session, parts.calendarId);
  if (calendar === undefined) return;
  if (!owned.has(calendar.role)) {
    throw decline(item, "the account can only read this calendar");
  }
  const found = await session.api.event(parts.calendarId, parts.eventId);
  if (found === "gone" || found["status"] === "cancelled") return;
  const event = eventOf(found);
  // The kit sends no delete of its own for a changed occurrence trashed with
  // its series, so the series' delete is the only place to check them.
  const changed =
    event === undefined || event.recurrence.length === 0
      ? []
      : (await session.api.inventory(parts.calendarId)).filter(
          (raw) => raw["recurringEventId"] === parts.eventId,
        );
  const reason =
    event === undefined ? undefined : deleteRefused(event, calendar, changed);
  if (reason !== undefined) throw decline(item, reason);
  await session.api.remove(
    parts.calendarId,
    parts.eventId,
    text(found, "etag"),
  );
}

/**
 * Why Marfa may not delete an event as Google holds it, or nothing where it
 * may: the event's own reason, or, for a series, that of a changed
 * occurrence the delete would take with it. An occurrence Google already
 * holds cancelled loses nothing to the delete.
 */
function deleteRefused(
  event: GoogleEvent,
  calendar: CalendarInfo,
  changed: readonly Json[],
): string | undefined {
  const own = uneditable(event, calendar);
  if (own !== undefined) return own;
  for (const raw of changed) {
    const one = eventOf(raw);
    if (one === undefined || one.status === "cancelled") continue;
    const reason = uneditable(one, calendar);
    if (reason === undefined) continue;
    const at = cancellationOf(one);
    const which =
      at === undefined
        ? `the changed occurrence ${one.id}`
        : `the changed occurrence at ${startParam(at)}`;
    return `deleting the series would delete ${which}, which Marfa may not change, since ${reason}`;
  }
  return undefined;
}

/**
 * The trash or purge of a row whose create, or making again, got no answer
 * and so never linked the row. The event that write made, if it landed, is
 * under the row's own id on the calendar the saved write names, so it is
 * deleted there, and the write is then settled, so it is never sent again.
 * Where the delete's answer is lost too, the next run asks Google again.
 * A changed occurrence's change that never landed made nothing, and Google
 * held the occurrence before the row, so it is settled with nothing sent.
 */
async function overtaken(
  held: OutboundIntent,
  context: WriteContext,
  writing: Writing,
): Promise<undefined> {
  const { item } = held.change;
  if (replacingOf(held.request) !== undefined) {
    if (!held.acknowledged) {
      await context.outbound.acknowledge(item.id, held.token);
    }
    return undefined;
  }
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
  const calendar = await calendarFor(session, parts.calendarId);
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
      if (lostSplit(error, parts.eventId)) {
        return splitAgain(change, parts, calendar, session, context, writing);
      }
      if (!isGone(error)) throw error;
    }
    // The id is gone for good, so the event is made anew under the row's.
    await make(change, makingFor(item, calendar), context, writing);
    return true;
  }
  const event = eventOf(found);
  const reason = event === undefined ? undefined : uneditable(event, calendar);
  if (reason !== undefined) throw decline(item, reason);
  try {
    await session.api.patch(
      parts.calendarId,
      parts.eventId,
      whole(item, calendar),
      text(found, "etag"),
    );
    return true;
  } catch (error) {
    if (!lostSplit(error, parts.eventId)) throw error;
  }
  return splitAgain(change, parts, calendar, session, context, writing);
}

/** Makes a split piece Google refused to bring back anew under the row's
 *  id, so the row's link moves to it. A refusal does not prove the restore
 *  never landed, so the piece is made only while Google still holds it
 *  deleted, and the two are never both live. */
async function splitAgain(
  change: Change,
  parts: { calendarId: string; eventId: string },
  calendar: CalendarInfo,
  session: Session,
  context: WriteContext,
  writing: Writing,
): Promise<boolean> {
  const held = await session.api.event(parts.calendarId, parts.eventId);
  if (held !== "gone" && held["status"] !== "cancelled") return false;
  await make(change, makingFor(change.item, calendar), context, writing);
  return true;
}

/** Google's id for the later part of a series it split at a "this and
 *  following" change: the first part's id, `_R` and when the split begins.
 *  An id given at a create takes only lowercase letters and digits, and an
 *  occurrence's ends in its start alone, so no other event has one. */
const splitPiece = /_R\d{8}(?:T\d{6}Z?)?$/;

/** Whether Google refused to bring back a deleted split piece. Google keeps
 *  one only as a stub, cancelled, and answers 400 to every write that would
 *  restore it, so it is gone for good. A 400 for any other event stays a
 *  refusal: making that event anew would drop what Google holds of it and
 *  Marfa does not. */
function lostSplit(error: unknown, eventId: string): boolean {
  return (
    error instanceof GoogleError &&
    error.status === 400 &&
    splitPiece.test(eventId)
  );
}

// --- The safety stop ----------------------------------------------------------

/** The events of one calendar a batch would delete, among those it holds. */
interface Deleting {
  readonly title: string;
  /** The events deleted, each as `<calendar id>/<event id>`. */
  readonly doomed: readonly string[];
  readonly live: number;
  /** Whether a trash is among the deletes, which restoring its row undoes. */
  readonly trashed: boolean;
}

/**
 * The events a batch of changes would delete in Google, by calendar, for
 * each calendar where that is more than `deleteLimit`. Only a delete Marfa
 * would send counts: a row Marfa may not change, or one on a calendar Google
 * answers the account no longer has, or one it can only read, sends none,
 * and neither does an event Google no longer holds, such as one a create
 * that got no answer never made, nor one `deleteEvent` would decline as
 * Google holds it now, such as one that gained a guest since Marfa read it.
 * A calendar one listing left out is counted
 * while Google still has it, since the delete is sent then. An event named
 * by both a trash and a purge is one delete.
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
    const calendar = await calendarFor(session, calendarId);
    if (calendar === undefined || !owned.has(calendar.role)) continue;
    const live = new Map<string, GoogleEvent>();
    const changed = new Map<string, Json[]>();
    for (const raw of await session.api.inventory(calendarId)) {
      const event = eventOf(raw);
      if (event === undefined) continue;
      if (event.status !== "cancelled") live.set(event.id, event);
      if (event.recurringEventId !== undefined) {
        const of = changed.get(event.recurringEventId) ?? [];
        of.push(raw);
        changed.set(event.recurringEventId, of);
      }
    }
    const doomed = [...ids].filter(([id]) => {
      const event = live.get(id);
      return (
        event !== undefined &&
        deleteRefused(event, calendar, changed.get(id) ?? []) === undefined
      );
    });
    if (doomed.length > deleteLimit) {
      found.push({
        title: calendar.title,
        doomed: doomed.map(([id]) => linkOf(calendarId, id)),
        live: live.size,
        trashed: doomed.some(([, trashed]) => trashed),
      });
    }
  }
  return found;
}

/** The event a row's trash or purge deletes: the one an unanswered create
 *  made under the row's own id, or the one the row is linked to. A changed
 *  occurrence whose change has not landed deletes none. */
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
 * What `GOOGLE_CALENDAR_CONFIRM_DELETES` takes to let a held batch through:
 * how many events it deletes, and a short hash of which, so a confirmation
 * lets that batch through and no other, of the same size or not.
 */
function confirmationOf(doomed: readonly string[]): string {
  const hash = createHash("sha256")
    .update([...doomed].sort().join("\n"))
    .digest("hex")
    .slice(0, 12);
  return `${String(doomed.length)}:${hash}`;
}

/**
 * Holds a batch of trashes and purges that would delete more than
 * `deleteLimit` events of one calendar and more than `deleteShare` of the
 * events it holds, unless `GOOGLE_CALENDAR_CONFIRM_DELETES` names that
 * batch.
 */
export async function preflight(
  changes: readonly Change[],
  context: WriteContext,
  writing: Writing,
): Promise<void> {
  const held = (await deleting(changes, context, writing)).filter(
    (one) => one.doomed.length > one.live * deleteShare,
  );
  if (held.length === 0) return;
  const doomed = held.flatMap((one) => one.doomed);
  const confirmation = confirmationOf(doomed);
  const given = context.env.GOOGLE_CALENDAR_CONFIRM_DELETES;
  if (given === confirmation) {
    context.log.info(
      `GOOGLE_CALENDAR_CONFIRM_DELETES confirms deleting ${String(doomed.length)} events from Google Calendar`,
    );
    return;
  }
  const listed = held.map(
    (one) =>
      `${String(one.doomed.length)} of the ${String(one.live)} events on ${one.title}`,
  );
  const undo = held.some((one) => one.trashed)
    ? " To keep the events, restore the trashed rows in Marfa."
    : "";
  const stale =
    given === undefined || given === ""
      ? ""
      : ` GOOGLE_CALENDAR_CONFIRM_DELETES is ${given}, which names another batch, so it lets none through.`;
  const message = `Rows trashed or purged in Marfa would delete ${listed.join(" and ")} in Google Calendar, more than ${String(deleteLimit)} events and a quarter of a calendar at once, so nothing is carried to Google and the connector stops.${stale}${undo} To delete them, set GOOGLE_CALENDAR_CONFIRM_DELETES=${confirmation} for one run, then remove it.`;
  context.log.condition("deletes-held", message);
  throw new Error(message);
}
