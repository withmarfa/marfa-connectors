import { createHash } from "node:crypto";
import type {
  Entry,
  Item,
  PendingInbound,
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
  appointment,
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
const version = 1;
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

function linkIn(item: Item): string | undefined {
  const link = item.properties["google_id"];
  return typeof link === "string" ? link : undefined;
}

/**
 * The account's events as Marfa holds them, by calendar, read once in a run
 * and only where a step needs every row of a calendar: a whole read, a
 * series that is gone and a calendar that leaves the list. A read since a
 * sync token that meets none of those reads no rows.
 */
class Holdings {
  private rows: Promise<Map<string, Item[]>> | undefined;

  constructor(private readonly context: Context) {}

  async of(calendarId: string): Promise<readonly Item[]> {
    this.rows ??= this.context
      .held(eventType, { state: "active" })
      .then((items) => {
        const byCalendar = new Map<string, Item[]>();
        for (const item of items) {
          const link = linkIn(item);
          const parts = link === undefined ? undefined : splitLink(link);
          if (parts === undefined) continue;
          const rows = byCalendar.get(parts.calendarId) ?? [];
          rows.push(item);
          byCalendar.set(parts.calendarId, rows);
        }
        return byCalendar;
      });
    return (await this.rows).get(calendarId) ?? [];
  }
}

/** The prefixes of the conditions a read raises. */
export const calendarChecks = [
  "calendar-refused:",
  "calendar-unconfirmed:",
  "calendar-progress:",
  "events-skipped:",
  "read-only-calendar-unknown:",
] as const;

/** Keeps the conditions of a calendar whose events this run did not read. */
function unreachedCalendar(context: Pick<Context, "log">, id: string): void {
  context.log.unreached({
    keys: [
      `calendar-refused:${id}`,
      `events-skipped:${id}`,
      `calendar-progress:${id}`,
    ],
  });
}

interface Listed {
  /** The calendars to read: those the account owns or writes to, and the
   *  read-only ones the connector is told to read. */
  readonly chosen: Map<string, CalendarInfo>;
  /** Every calendar the list holds, whether read or not. */
  readonly onList: Set<string>;
}

function selection(
  items: readonly Json[],
  named: ReadonlySet<string>,
  context: Pick<Context, "log">,
): Listed {
  const listed: Listed = {
    chosen: new Map(),
    onList: new Set(),
  };
  let left = 0;
  for (const item of items) {
    const calendar = calendarOf(item);
    if (calendar === undefined) continue;
    if (item["deleted"] === true) continue;
    listed.onList.add(calendar.id);
    if (calendar.id === birthdays) continue;
    if (owned.has(calendar.role) || named.has(calendar.id)) {
      listed.chosen.set(calendar.id, calendar);
    } else left += 1;
  }
  for (const id of named) {
    if (!listed.onList.has(id)) {
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
  return listed;
}

export interface Reading {
  readonly context: Context;
  readonly api: CalendarApi;
  readonly access: Access;
  readonly named: ReadonlySet<string>;
  readonly now: () => number;
}

/** What one run shares between its calendars. */
interface Run extends Reading {
  readonly holdings: Holdings;
  /** The calendars Marfa held rows or progress for when the run began: the
   *  only ones an event can have moved from. */
  readonly before: ReadonlySet<string>;
  /** Links a row was moved from during this run, so one move is not used
   *  twice. */
  readonly claimed: Set<string>;
  /** A row Marfa refuses is kept for a retry, and the calendar's token still
   *  advances; the retry asks Google for the event again once it is due. */
  readonly retry: { retry: { mode: "refetch"; context: string } };
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

/** The link a retry record names, from its link or its `source_id`. */
function refusedLink(record: PendingInbound): string {
  const { link, sourceId } = record.identity;
  if (link !== undefined) return link;
  const at = sourceId.indexOf(":");
  return at === -1 ? sourceId : sourceId.slice(at + 1);
}

/** Reads the account's calendars and their events into Marfa. */
export async function readCalendars(reading: Reading): Promise<void> {
  const { context, api, access } = reading;
  const { log } = context;
  const listed = await api.calendars();
  const { chosen, onList } = selection(listed.items, reading.named, context);
  if (!access.has(eventsScope)) {
    // Without the events permission only the calendars themselves are read.
    log.unreached({
      prefixes: calendarChecks.filter(
        (one) => one !== "read-only-calendar-unknown:",
      ),
    });
    await context.upsert(
      calendarType,
      [...chosen.values()].map((one) => calendarEntry(access.account, one)),
    );
    return;
  }

  const calendarRows = await context.held(calendarType, { state: "active" });
  const progress = progressOf(context.state.get("calendars"));
  const before = new Set<string>([
    ...calendarRows.flatMap((row) => {
      const id = row.properties["calendar_id"];
      return typeof id === "string" ? [id] : [];
    }),
    ...Object.keys(progress),
  ]);
  const run: Run = {
    ...reading,
    holdings: new Holdings(context),
    before,
    claimed: new Set(),
    retry: {
      retry: {
        mode: "refetch",
        context: createHash("sha256")
          .update(
            JSON.stringify([
              version,
              access.account,
              [...context.written(calendarType)].sort(),
              [...context.written(eventType)].sort(),
            ]),
          )
          .digest("hex"),
      },
    },
  };

  for (const id of before) {
    if (chosen.has(id)) continue;
    if (!onList.has(id)) {
      // One listing that leaves a calendar out is not Google removing it.
      let found: Json | "gone";
      try {
        found = await api.calendar(id);
      } catch (error) {
        if (
          !(error instanceof GoogleError) ||
          !["refused", "passing", "quota"].includes(error.kind)
        ) {
          throw error;
        }
        log.condition(
          `calendar-unconfirmed:${id}`,
          `${id} is missing from the account's calendar list, and Google could not say whether it was removed (${error.message}), so it and its events are kept.`,
        );
        unreachedCalendar(context, id);
        continue;
      }
      if (found !== "gone" && found["deleted"] !== true) {
        log.info(
          `${id} is missing from the account's calendar list, but Google still has it there, so it and its events are kept`,
        );
        unreachedCalendar(context, id);
        continue;
      }
    }
    await leave(run, id);
  }

  for (const calendar of chosen.values()) {
    try {
      await syncCalendar(run, calendar, progress[calendar.id]);
    } catch (error) {
      if (!(error instanceof GoogleError) || error.kind !== "refused") {
        throw error;
      }
      log.condition(
        `calendar-refused:${calendar.id}`,
        `${calendar.title} could not be read (${error.message}), so its rows are left as they are and the other calendars were read.`,
      );
      unreachedCalendar(context, calendar.id);
    }
  }
}

/** Archives a calendar the connector no longer reads, with its events. */
async function leave(run: Run, id: string): Promise<void> {
  const { context } = run;
  const scoped = context.forScope(`calendar:${id}`, run.retry);
  const links = new Set(
    (await run.holdings.of(id)).flatMap((row) => {
      const link = linkIn(row);
      return link === undefined ? [] : [link];
    }),
  );
  // A row kept for a retry settles with the archive.
  for (const { record } of scoped.refusals.pending()) {
    if (record.identity.type === eventType) links.add(refusedLink(record));
  }
  await scoped.archive(eventType, [...links]);
  await scoped.archive(calendarType, [id]);
  await save(scoped, context, id, id, undefined);
  context.log.info(
    `${id} is no longer a calendar this connector reads, so it and its events are archived`,
  );
}

function shapeOf(context: Context, calendar: CalendarInfo): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        version,
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
  /** The event id of each entry, by its link. */
  readonly ids: Map<string, string>;
  readonly archive: Set<string>;
  readonly skipped: string[];
}

async function syncCalendar(
  run: Run,
  calendar: CalendarInfo,
  kept: Progress | undefined,
): Promise<void> {
  const { context, api, access } = run;
  const scoped = context.forScope(`calendar:${calendar.id}`, run.retry);
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
  const asked = new Set(
    items.flatMap((item) =>
      typeof item["id"] === "string" ? [item["id"]] : [],
    ),
  );
  const gone = new Set<string>();
  const vanished = new Set<string>();
  if (whole) {
    // A whole read lists what Google still holds: a row it does not list is
    // asked about, since only a deleted event may be archived.
    for (const row of await run.holdings.of(calendar.id)) {
      const link = linkIn(row);
      const parts = link === undefined ? undefined : splitLink(link);
      if (link === undefined || parts === undefined) continue;
      if (asked.has(parts.eventId)) continue;
      asked.add(parts.eventId);
      const found = await api.event(calendar.id, parts.eventId);
      if (found === "gone") {
        gone.add(link);
        const series = row.properties["recurring_event_id"];
        if (typeof series === "string") vanished.add(series);
      } else items.push(found);
    }
  }
  // A sync token never lists again an event whose row Marfa refused, so once
  // its retry is due, the event is asked for.
  for (const { record, due } of scoped.refusals.pending()) {
    if (!due || record.identity.type !== eventType) continue;
    const link = refusedLink(record);
    const parts = splitLink(link);
    if (parts?.calendarId !== calendar.id) continue;
    if (asked.has(parts.eventId)) continue;
    asked.add(parts.eventId);
    try {
      const found = await api.event(calendar.id, parts.eventId);
      if (found === "gone") gone.add(link);
      else items.push(found);
    } catch (error) {
      // The retry stays kept, and is asked for again on the next run.
      if (!(error instanceof GoogleError) || error.kind !== "refused") {
        throw error;
      }
    }
  }
  const plan = await planEvents(
    run,
    scoped,
    calendar,
    items,
    whole,
    gone,
    vanished,
  );
  await withMoves(run, scoped, calendar.id, plan);
  if (plan.entries.length > 0) await scoped.upsert(eventType, plan.entries);
  if (plan.archive.size > 0) await scoped.archive(eventType, [...plan.archive]);
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

/** The active rows Marfa holds under these links, by link. */
async function rowsOf(
  scoped: Scoped,
  links: readonly string[],
): Promise<Map<string, Item>> {
  if (links.length === 0) return new Map();
  const { items } = await scoped.inspect(eventType, { links });
  return new Map(
    items.flatMap((item) => {
      const link = linkIn(item);
      return item.state === "active" && link !== undefined
        ? [[link, item] as const]
        : [];
    }),
  );
}

function recurrenceOf(row: Item | undefined): string[] {
  const lines = row?.properties["recurrence"];
  return Array.isArray(lines)
    ? lines.filter((one): one is string => typeof one === "string")
    : [];
}

async function planEvents(
  run: Run,
  scoped: Scoped,
  calendar: CalendarInfo,
  items: readonly Json[],
  whole: boolean,
  gone: ReadonlySet<string>,
  vanished: ReadonlySet<string>,
): Promise<Plan> {
  const { api, access } = run;
  const account = access.account;
  const plan: Plan = {
    entries: [],
    ids: new Map(),
    archive: new Set(gone),
    skipped: [],
  };
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
  const dropped = new Set<string>();
  const add = (
    into: Map<string, Cancellation[]>,
    series: string,
    event: GoogleEvent,
  ): void => {
    const one = cancellationOf(event);
    if (one !== undefined) into.set(series, [...(into.get(series) ?? []), one]);
    touched.add(series);
  };

  for (const event of byId.values()) {
    if (!appointment(event)) {
      plan.archive.add(linkOf(calendar.id, event.id));
      continue;
    }
    if (event.status === "cancelled") {
      plan.archive.add(linkOf(calendar.id, event.id));
      if (event.recurringEventId !== undefined) {
        add(cancelled, event.recurringEventId, event);
      } else dropped.add(event.id);
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

  const push = (event: GoogleEvent, recurrence?: readonly string[]): void => {
    const mapped = eventEntry(account, calendar, event, recurrence);
    if (mapped === undefined) {
      plan.skipped.push(event.id);
      return;
    }
    plan.entries.push(mapped.entry);
    plan.ids.set(linkOf(calendar.id, event.id), event.id);
  };

  const seriesRows = await rowsOf(
    scoped,
    whole
      ? [...vanished].map((id) => linkOf(calendar.id, id))
      : [...touched].map((id) => linkOf(calendar.id, id)),
  );
  for (const id of touched) {
    let master = masters.get(id);
    if (master === undefined) {
      if (byId.get(id)?.status === "cancelled") continue;
      const found = await api.event(calendar.id, id);
      const event = found === "gone" ? undefined : eventOf(found);
      if (event === undefined || event.status === "cancelled") {
        dropped.add(id);
        continue;
      }
      if (!appointment(event)) {
        plan.archive.add(linkOf(calendar.id, id));
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
        Math.max(run.now(), first.startMs) + horizonYears * 365 * day,
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
        recurrenceOf(seriesRows.get(linkOf(calendar.id, id))),
        master.recurrence,
        first.zone,
        { ms: horizon, day: new Date(horizon).toISOString().slice(0, 10) },
      ).filter((one) => !back.has(keyOf(one)));
      all = [...seen, ...fromGoogle, ...before];
    }
    const unique = new Map(all.map((one) => [keyOf(one), one]));
    push(
      master,
      withCancellations(master.recurrence, [...unique.values()], first.zone),
    );
  }
  for (const event of others) push(event);
  for (const id of dropped) plan.archive.add(linkOf(calendar.id, id));
  // A series that is gone takes its changed occurrences with it. Google's
  // cancellation carries no rule, so the row says which was a series, or the
  // retry of a series Marfa refused, which has none.
  const droppedLinks = [...dropped].map((id) => linkOf(calendar.id, id));
  const droppedRows = await rowsOf(scoped, droppedLinks);
  const refused = new Set(
    scoped.refusals.pending().map(({ record }) => refusedLink(record)),
  );
  if (
    [...droppedRows.values()].some((row) => recurrenceOf(row).length > 0) ||
    droppedLinks.some((link) => refused.has(link))
  ) {
    for (const row of await run.holdings.of(calendar.id)) {
      const series = row.properties["recurring_event_id"];
      const link = linkIn(row);
      if (typeof series === "string" && dropped.has(series) && link) {
        plan.archive.add(link);
      }
    }
  }
  return plan;
}

/**
 * Marks each new entry that Google moved from another calendar with the link
 * it was known by there, so the row keeps its identity: Marfa holds a row for
 * the same event id on a calendar read before this run, and Google no longer
 * has the event there. A calendar that refuses the question is not a move.
 */
async function withMoves(
  run: Run,
  scoped: Scoped,
  calendarId: string,
  plan: Plan,
): Promise<void> {
  const others = [...run.before].filter((one) => one !== calendarId);
  if (others.length === 0 || plan.entries.length === 0) return;
  const links = [...plan.ids.keys()];
  const own = await scoped.known(eventType, links);
  const fresh = links.filter((link) => !own.has(link));
  if (fresh.length === 0) return;
  const candidates = fresh.flatMap((link) =>
    others.map((other) => linkOf(other, plan.ids.get(link) ?? "")),
  );
  const held = await scoped.known(eventType, candidates);
  const moved = new Map<string, string>();
  for (const link of fresh) {
    const eventId = plan.ids.get(link) ?? "";
    for (const other of others) {
      const from = linkOf(other, eventId);
      if (!held.has(from) || run.claimed.has(from)) continue;
      let found: Json | "gone";
      try {
        found = await run.api.event(other, eventId);
      } catch (error) {
        if (error instanceof GoogleError && error.kind === "refused") continue;
        throw error;
      }
      if (found === "gone" || found["status"] === "cancelled") {
        run.claimed.add(from);
        moved.set(link, from);
        break;
      }
    }
  }
  if (moved.size === 0) return;
  plan.entries.splice(
    0,
    plan.entries.length,
    ...plan.entries.map((entry) => {
      const link = entry.properties["google_id"];
      const from = typeof link === "string" ? moved.get(link) : undefined;
      return from === undefined ? entry : { ...entry, movedFrom: [from] };
    }),
  );
}
