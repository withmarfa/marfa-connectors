const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, found);
  }
  return found;
}

/** Whether the zone database resolves the name. */
export function validZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at the instant. */
export function offsetMinutes(zone: string, ms: number): number {
  const parts = new Map<string, number>();
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts.set(part.type, Number(part.value));
  }
  const local = Date.UTC(
    parts.get("year") ?? 1970,
    (parts.get("month") ?? 1) - 1,
    parts.get("day") ?? 1,
    parts.get("hour") ?? 0,
    parts.get("minute") ?? 0,
    parts.get("second") ?? 0,
  );
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000);
}

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * The instant a wall-clock reading shows in the zone. A time the clocks show
 * twice is its first reading; a time they skip falls after the gap, as the
 * clock before the change would show it.
 */
export function wallClockToInstant(zone: string, wall: WallClock): number {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const day = 86_400_000;
  const offsets = [
    ...new Set([
      offsetMinutes(zone, naive - day),
      offsetMinutes(zone, naive + day),
    ]),
  ];
  const fits = offsets
    .map((offset) => naive - offset * 60_000)
    .filter(
      (candidate) =>
        naive - offsetMinutes(zone, candidate) * 60_000 === candidate,
    );
  if (fits.length > 0) return Math.min(...fits);
  return naive - Math.min(...offsets) * 60_000;
}

const dateShape = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The instant a calendar date, as `YYYY-MM-DD`, begins in the zone. */
export function dayStart(zone: string, date: string): number | undefined {
  const match = dateShape.exec(date);
  if (match === null) return undefined;
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  if (
    check.getUTCFullYear() !== wall.year ||
    check.getUTCMonth() !== wall.month - 1 ||
    check.getUTCDate() !== wall.day
  ) {
    return undefined;
  }
  return wallClockToInstant(zone, wall);
}

/** The calendar date after `date`, which must be a valid `YYYY-MM-DD`. */
export function nextDay(date: string): string {
  const match = dateShape.exec(date);
  const at = Date.UTC(
    Number(match?.[1]),
    Number(match?.[2]) - 1,
    Number(match?.[3]) + 1,
  );
  return new Date(at).toISOString().slice(0, 10);
}

/** An instant as Marfa takes it: UTC, without fractions of a second. */
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** An instant in the compact UTC form an iCalendar date list takes. */
export function compact(ms: number): string {
  return iso(ms).replace(/[-:]/g, "");
}

/** The calendar date, as `YYYY-MM-DD`, the zone's clocks show at the instant. */
export function localDate(zone: string, ms: number): string {
  const parts = new Map<string, string>();
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    parts.set(part.type, part.value);
  }
  const two = (value: string | undefined) => (value ?? "").padStart(2, "0");
  return `${parts.get("year") ?? ""}-${two(parts.get("month"))}-${two(parts.get("day"))}`;
}
