import type { TodoistItem } from "./todoist.js";

const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const dayNames: ReadonlyMap<string, number> = new Map([
  ["sun", 0],
  ["sunday", 0],
  ["mon", 1],
  ["monday", 1],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["wed", 3],
  ["weds", 3],
  ["wednesday", 3],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["fri", 5],
  ["friday", 5],
  ["sat", 6],
  ["saturday", 6],
]);

const dayList = "(?:[a-z]+)(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)[a-z]+)*";

interface Wall {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
}

function wallIn(at: number, timeZone: string): Wall | undefined {
  try {
    const read: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    }).formatToParts(at)) {
      read[part.type] = part.value;
    }
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      read["weekday"] ?? "",
    );
    return {
      year: Number(read["year"]),
      month: Number(read["month"]),
      day: Number(read["day"]),
      weekday,
      minutes: Number(read["hour"]) * 60 + Number(read["minute"]),
    };
  } catch {
    return undefined;
  }
}

/** Whether the zone keeps one offset from UTC across the year of the instant
 *  and the next, so a rule that advances in UTC keeps the wall time. */
function steady(at: number, timeZone: string): boolean {
  const year = new Date(at).getUTCFullYear();
  const offsets = new Set<number>();
  for (const when of [
    Date.UTC(year, 0, 1),
    Date.UTC(year, 6, 1),
    Date.UTC(year + 1, 0, 1),
    Date.UTC(year + 1, 6, 1),
  ]) {
    const wall = wallIn(when, timeZone);
    if (wall === undefined) return false;
    const [h, m] = [Math.floor(wall.minutes / 60), wall.minutes % 60];
    offsets.add(Date.UTC(wall.year, wall.month - 1, wall.day, h, m) - when);
  }
  return offsets.size === 1;
}

/** The minutes after midnight a trailing `at 2pm` or `at 14:00` names. */
function clock(
  hour: string,
  minute: string | undefined,
  meridiem: string | undefined,
): number | undefined {
  let h = Number(hour);
  const m = minute === undefined ? 0 : Number(minute);
  if (m > 59) return undefined;
  if (meridiem === undefined) {
    if (h > 23) return undefined;
  } else {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (meridiem === "pm" ? 12 : 0);
  }
  return h * 60 + m;
}

function weekdays(list: string): number[] | undefined {
  const found: number[] = [];
  for (const name of list.split(/\s*,\s*|\s+and\s+|\s*&\s*/)) {
    const day = dayNames.get(name.trim());
    if (day === undefined) return undefined;
    found.push(day);
  }
  return new Set(found).size === found.length ? found : undefined;
}

/**
 * A recurring due as the RFC 5545 lines of a task's `recurrence`, where they
 * state the repeat exactly, and `undefined` where they cannot.
 *
 * A task's rule starts at its `due_at` and advances in UTC, so a repeat is
 * stated only when the due's wall-clock time and day hold in UTC: the zone it
 * is said in keeps one offset from UTC, and a rule naming a weekday or a day
 * of the month falls on that day in UTC as it does there. Todoist words the
 * repeat in the account's language, and only English is read, in the forms
 * Todoist writes most: every day, N days, weekday, week, N weeks, named
 * weekdays, month, N months, the Nth or last day of the month, year, N years,
 * each with an optional `at` time. A repeat counted from completion (`every!`),
 * one with a start or an end, and any other wording is not stated.
 */
export function recurrenceRules(
  due: TodoistItem["due"],
  dueAt: string | undefined,
  timeZone: string,
): string[] | undefined {
  if (
    due?.is_recurring !== true ||
    typeof due.string !== "string" ||
    dueAt === undefined ||
    (due.lang != null && due.lang !== "en")
  ) {
    return undefined;
  }
  const at = Date.parse(dueAt);
  const zone =
    typeof due.timezone === "string" && due.timezone !== ""
      ? due.timezone
      : (due.date ?? "").endsWith("Z")
        ? "UTC"
        : timeZone;
  const wall = wallIn(at, zone);
  const utc = wallIn(at, "UTC");
  if (wall === undefined || utc === undefined || !steady(at, zone)) {
    return undefined;
  }
  let words = due.string.trim().toLowerCase().replace(/\s+/g, " ");
  const timed = /\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(words);
  if (timed !== null) {
    const named = clock(timed[1] ?? "", timed[2], timed[3]);
    if (named === undefined || named !== wall.minutes) return undefined;
    words = words.slice(0, timed.index);
  }
  // The day a wall-clock day falls on in UTC: -1, 0 or 1 days earlier or later.
  const shift = Math.round(
    (Date.UTC(utc.year, utc.month - 1, utc.day) -
      Date.UTC(wall.year, wall.month - 1, wall.day)) /
      86_400_000,
  );
  const line = (rule: string): string[] => [`RRULE:${rule}`];
  const every = (interval: number): string =>
    interval === 1 ? "" : `;INTERVAL=${String(interval)}`;
  const interval = (text: string | undefined, other: boolean): number =>
    other ? 2 : text === undefined ? 1 : Number(text);
  let match: RegExpExecArray | null;

  if (words === "daily") return line("FREQ=DAILY");
  if ((match = /^every (?:(\d+) |(other) )?days?$/.exec(words))) {
    const step = interval(match[1], match[2] !== undefined);
    return step < 1 ? undefined : line(`FREQ=DAILY${every(step)}`);
  }
  if ((match = /^every (?:(\d+) |(other) )?(?:week|weeks)$/.exec(words))) {
    const step = interval(match[1], match[2] !== undefined);
    return step < 1 ? undefined : line(`FREQ=WEEKLY${every(step)}`);
  }
  if (/^every (?:weekday|workday)s?$/.test(words)) {
    return wall.weekday >= 1 && wall.weekday <= 5 && shift === 0
      ? line("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")
      : undefined;
  }
  if ((match = new RegExp(`^every (${dayList})$`).exec(words))) {
    const listed = weekdays(match[1] ?? "");
    if (listed !== undefined) {
      if (!listed.includes(wall.weekday)) return undefined;
      const inUtc = listed.map((day) => (day + shift + 7) % 7);
      return line(
        `FREQ=WEEKLY;BYDAY=${inUtc
          .sort((a, b) => a - b)
          .map((day) => days[day])
          .join(",")}`,
      );
    }
  }
  if (shift !== 0) return undefined;
  if ((match = /^every (?:(\d+) |(other) )?months?$/.exec(words))) {
    const step = interval(match[1], match[2] !== undefined);
    return step < 1 || wall.day > 28
      ? undefined
      : line(`FREQ=MONTHLY${every(step)}`);
  }
  if ((match = /^every (\d{1,2})(?:st|nd|rd|th)$/.exec(words))) {
    const day = Number(match[1]);
    return day >= 1 && day <= 28 && day === wall.day
      ? line(`FREQ=MONTHLY;BYMONTHDAY=${String(day)}`)
      : undefined;
  }
  if (words === "every last day") {
    const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
    return next.getUTCDate() === 1
      ? line("FREQ=MONTHLY;BYMONTHDAY=-1")
      : undefined;
  }
  if ((match = /^every (?:(\d+) |(other) )?(?:year|years|yr)$/.exec(words))) {
    const step = interval(match[1], match[2] !== undefined);
    return step < 1 || (wall.month === 2 && wall.day === 29)
      ? undefined
      : line(`FREQ=YEARLY${every(step)}`);
  }
  return undefined;
}
