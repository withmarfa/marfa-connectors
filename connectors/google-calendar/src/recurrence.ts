import { compact, wallClockToInstant } from "./time.js";

/** One occurrence of a series that is not held: a moment for a timed series,
 *  a calendar date for an all-day one. */
export type Cancellation =
  | { readonly kind: "instant"; readonly ms: number }
  | { readonly kind: "day"; readonly day: string };

const line = /^EXDATE((?:;[^:]*)*):(.*)$/is;
const dateOnly = /^(\d{4})(\d{2})(\d{2})$/;
const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** The occurrences a recurrence's `EXDATE` lines already remove, read as
 *  Marfa reads them: an instant as it is, a zoneless time in the series'
 *  zone, and a date as that day. A line that cannot be read removes none. */
export function removed(
  lines: readonly string[],
  zone: string,
): { instants: Set<number>; days: Set<string> } {
  const instants = new Set<number>();
  const days = new Set<string>();
  for (const text of lines) {
    const match = line.exec(text.trim());
    if (match === null) continue;
    const params = new Map<string, string>();
    for (const param of (match[1] ?? "").split(";")) {
      const at = param.indexOf("=");
      if (at > 0) {
        params.set(
          param.slice(0, at).toUpperCase(),
          param.slice(at + 1).replace(/^"|"$/g, ""),
        );
      }
    }
    for (const raw of (match[2] ?? "").split(",")) {
      const value = raw.trim();
      const day = dateOnly.exec(value);
      if (day !== null) {
        days.add(`${day[1] ?? ""}-${day[2] ?? ""}-${day[3] ?? ""}`);
        continue;
      }
      const time = dateTime.exec(value);
      if (time === null) continue;
      const wall = {
        year: Number(time[1]),
        month: Number(time[2]),
        day: Number(time[3]),
        hour: Number(time[4]),
        minute: Number(time[5]),
        second: Number(time[6]),
      };
      if (time[7] === "Z") {
        instants.add(
          Date.UTC(
            wall.year,
            wall.month - 1,
            wall.day,
            wall.hour,
            wall.minute,
            wall.second,
          ),
        );
        continue;
      }
      try {
        instants.add(wallClockToInstant(params.get("TZID") ?? zone, wall));
      } catch {
        // A zone the database does not know: Marfa refuses such a line too.
      }
    }
  }
  return { instants, days };
}

/**
 * Google's own `EXDATE` lines are kept as they came, and the occurrences it
 * cancelled by name, which a series does not list, follow in one line of
 * their own: an `EXDATE` in UTC for a timed series, since an instant is exact
 * across a clock change, and `EXDATE;VALUE=DATE` for an all-day one. Nothing
 * Google's lines already remove is added again, and the added dates are in
 * order, so the same cancellations always give the same lines.
 */
export function withCancellations(
  lines: readonly string[],
  cancelled: readonly Cancellation[],
  zone: string,
): string[] {
  const held = removed(lines, zone);
  const instants = new Set<number>();
  const days = new Set<string>();
  for (const one of cancelled) {
    if (one.kind === "instant" && !held.instants.has(one.ms)) {
      instants.add(one.ms);
    }
    if (one.kind === "day" && !held.days.has(one.day)) days.add(one.day);
  }
  const added: string[] = [];
  if (instants.size > 0) {
    added.push(
      `EXDATE:${[...instants]
        .sort((a, b) => a - b)
        .map(compact)
        .join(",")}`,
    );
  }
  if (days.size > 0) {
    added.push(
      `EXDATE;VALUE=DATE:${[...days]
        .sort()
        .map((day) => day.replaceAll("-", ""))
        .join(",")}`,
    );
  }
  return [...lines, ...added];
}

/**
 * What a series' recurrence removes beyond Google's own lines, which this
 * connector added earlier, so a cancellation outside the window a later read
 * asks Google about is not lost when the lines are made again.
 */
export function carried(
  before: readonly string[],
  own: readonly string[],
  zone: string,
  after: { readonly ms: number; readonly day: string },
): Cancellation[] {
  const was = removed(before, zone);
  const google = removed(own, zone);
  return [
    ...[...was.instants]
      .filter((ms) => !google.instants.has(ms) && ms > after.ms)
      .map((ms): Cancellation => ({ kind: "instant", ms })),
    ...[...was.days]
      .filter((day) => !google.days.has(day) && day > after.day)
      .map((day): Cancellation => ({ kind: "day", day })),
  ];
}

const idSuffix = /_(\d{8}T\d{6}Z|\d{8})$/;

/**
 * The occurrence a cancelled or restored instance stands for: its original
 * start where Google states it, else the moment its id ends with.
 */
export function cancellationOf(event: {
  readonly id: string;
  readonly originalStartTime:
    | {
        readonly dateTime: string | undefined;
        readonly date: string | undefined;
      }
    | undefined;
}): Cancellation | undefined {
  const original = event.originalStartTime;
  if (original?.dateTime !== undefined) {
    const ms = Date.parse(original.dateTime);
    if (Number.isFinite(ms)) return { kind: "instant", ms };
  }
  if (
    original?.date !== undefined &&
    dateOnly.test(original.date.replaceAll("-", ""))
  ) {
    return { kind: "day", day: original.date };
  }
  const tail = idSuffix.exec(event.id)?.[1];
  if (tail === undefined) return undefined;
  const day = dateOnly.exec(tail);
  if (day !== null) {
    return {
      kind: "day",
      day: `${day[1] ?? ""}-${day[2] ?? ""}-${day[3] ?? ""}`,
    };
  }
  const time = dateTime.exec(tail);
  if (time === null) return undefined;
  return {
    kind: "instant",
    ms: Date.UTC(
      Number(time[1]),
      Number(time[2]) - 1,
      Number(time[3]),
      Number(time[4]),
      Number(time[5]),
      Number(time[6]),
    ),
  };
}

/** The key a cancellation is compared and deduplicated by. */
export function keyOf(one: Cancellation): string {
  return one.kind === "instant" ? `t${String(one.ms)}` : `d${one.day}`;
}
