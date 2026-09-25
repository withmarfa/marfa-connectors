import { createHash } from "node:crypto";
import type { Entry } from "@withmarfa/connector";

/**
 * A task as the Sync API answers it. The API sends every item whole, a
 * delta included, so a field an item leaves out is one the task does not
 * have, and is cleared.
 */
export interface TodoistItem {
  id: string;
  content: string;
  description?: string;
  project_id?: string | null;
  section_id?: string | null;
  parent_id?: string | null;
  labels?: string[] | null;
  priority?: number;
  due?: { date?: string | null } | null;
  child_order?: number;
  checked?: boolean;
  completed_at?: string | null;
  is_deleted?: boolean;
  note_count?: number;
  added_at?: string;
  updated_at?: string;
}

export interface SyncAnswer {
  sync_token: string;
  items: TodoistItem[];
  user?: { id?: unknown; tz_info?: { timezone?: unknown } };
}

export const firstSync = "*";
export const defaultBase = "https://api.todoist.com";
const requestTimeoutMs = 60_000;
/** The longest wait a `Retry-After` is honored for; a longer one fails the run instead. */
const longestWaitMs = 60_000;
const serverErrorRetries = 3;

/** Resolves after `ms`, or rejects the moment the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The wait a 429 or a command's `retry_after` names, in milliseconds. */
function waitOf(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * One request to Todoist, with what every door shares: the token, the
 * timeout, a wait on a 429 as told, three more tries on a server error,
 * and a refused token failing the run by name so a token that cannot
 * write is a failed run rather than a quiet one.
 */
async function request(
  base: string,
  token: string,
  path: string,
  init: { method: "GET" | "POST"; body?: URLSearchParams },
  signal: AbortSignal,
): Promise<Response> {
  let serverErrors = 0;
  for (;;) {
    const response = await fetch(new URL(path, base), {
      ...init,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Todoist refused the token: ${String(response.status)}`);
    }
    if (response.status === 429) {
      const wait = waitOf(response.headers.get("Retry-After"));
      if (wait === undefined || wait > longestWaitMs) {
        throw new Error(
          `Todoist asked for a wait of ${wait === undefined ? "unknown length" : `${String(wait / 1000)}s`}, longer than a run holds`,
        );
      }
      await pause(wait, signal);
      continue;
    }
    if (response.status >= 500 && serverErrors < serverErrorRetries) {
      serverErrors += 1;
      await pause(1000 * 2 ** (serverErrors - 1), signal);
      continue;
    }
    return response;
  }
}

export async function sync(
  base: string,
  token: string,
  syncToken: string,
  signal: AbortSignal,
): Promise<SyncAnswer> {
  const response = await request(
    base,
    token,
    "/api/v1/sync",
    {
      method: "POST",
      body: new URLSearchParams({
        sync_token: syncToken,
        resource_types: JSON.stringify(["items", "user"]),
      }),
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`Todoist's Sync API answered ${String(response.status)}`);
  }
  return (await response.json()) as SyncAnswer;
}

/** The account's `user` alone, for a run that needs its timezone before it has synced. */
export async function user(
  base: string,
  token: string,
  signal: AbortSignal,
): Promise<SyncAnswer["user"]> {
  const response = await request(
    base,
    token,
    "/api/v1/sync",
    {
      method: "POST",
      body: new URLSearchParams({
        sync_token: firstSync,
        resource_types: JSON.stringify(["user"]),
      }),
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`Todoist's Sync API answered ${String(response.status)}`);
  }
  return ((await response.json()) as SyncAnswer).user;
}

/** A command as the Sync API takes it. */
export interface Command {
  type: string;
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

/** How the Sync API refuses one command; `error_extra` may name a wait. */
export interface CommandError {
  error_code?: number;
  error?: string;
  error_tag?: string;
  http_code?: number;
  error_extra?: { retry_after?: number } & Record<string, unknown>;
}

export interface CommandAnswer {
  sync_status: Record<string, "ok" | CommandError>;
  temp_id_mapping?: Record<string, string>;
}

/** A refusal's text, for a condition to carry. */
export function describeError(error: CommandError): string {
  const code =
    error.error_code === undefined ? "" : ` (${String(error.error_code)})`;
  return `${error.error ?? "an error without a message"}${code}`;
}

/**
 * Sends commands, waiting as a command's own `retry_after` asks and
 * sending the batch again; every command carries a `uuid`, so a resend
 * is the same command to Todoist.
 */
export async function send(
  base: string,
  token: string,
  commands: readonly Command[],
  signal: AbortSignal,
): Promise<CommandAnswer> {
  for (;;) {
    const response = await request(
      base,
      token,
      "/api/v1/sync",
      {
        method: "POST",
        body: new URLSearchParams({ commands: JSON.stringify(commands) }),
      },
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `Todoist's Sync API answered ${String(response.status)} to a command`,
      );
    }
    const answer = (await response.json()) as CommandAnswer;
    const waits = Object.values(answer.sync_status)
      .map((status) =>
        status === "ok" ? undefined : waitOf(status.error_extra?.retry_after),
      )
      .filter((wait): wait is number => wait !== undefined);
    if (waits.length === 0) return answer;
    const wait = Math.max(...waits);
    if (wait > longestWaitMs) {
      throw new Error(
        `Todoist asked for a wait of ${String(wait / 1000)}s on a command, longer than a run holds`,
      );
    }
    await pause(wait, signal);
  }
}

/** A task as the REST door answers it: an open task, or none for one completed or deleted. */
export async function getTask(
  base: string,
  token: string,
  id: string,
  signal: AbortSignal,
): Promise<TodoistItem | undefined> {
  const response = await request(
    base,
    token,
    `/api/v1/tasks/${encodeURIComponent(id)}`,
    { method: "GET" },
    signal,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Todoist answered ${String(response.status)} for task ${id}`,
    );
  }
  return (await response.json()) as TodoistItem;
}

/**
 * A command's id from what it does, so a replayed run sends Todoist the
 * same command rather than a second one. Laid out as a UUID, which is
 * what the Sync API expects the field to look like.
 */
export function uuidFor(...parts: readonly string[]): string {
  const digest = createHash("sha1").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The core's priority as Todoist's 1 to 4; a row naming none is Todoist's 1. */
export function priorityFor(priority: unknown): number {
  const found = Object.entries(priorities).find(
    ([, name]) => name === priority,
  );
  return found === undefined ? 1 : Number(found[0]);
}

/**
 * A row's due date as Todoist takes it: a whole day as the date it is in
 * the account's timezone, a timed one fixed in UTC, and none as null so a
 * due date the row lost is cleared. A floating time Todoist held becomes
 * fixed once the row is written back, which is the one shape the core
 * task can name.
 */
export function dueFor(
  dueAt: unknown,
  precision: unknown,
  timeZone: string,
): { date: string } | null {
  if (typeof dueAt !== "string") return null;
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return null;
  if (precision === "time") {
    return { date: at.toISOString().replace(/\.\d{3}Z$/, "Z") };
  }
  const read: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at)) {
    read[part.type] = part.value;
  }
  return {
    date: `${read["year"] ?? ""}-${read["month"] ?? ""}-${read["day"] ?? ""}`,
  };
}

/**
 * The account a token belongs to, from the Sync API's own `user`. Not an
 * item's `user_id`, which names the task's owner, who in a shared project
 * need not be this account.
 */
export function accountOf(user: SyncAnswer["user"]): string | undefined {
  const id = user?.id;
  if (typeof id !== "string") return undefined;
  const account = id.trim();
  // A colon would make `<account>:<task>` read two ways.
  return account === "" || account.includes(":") ? undefined : account;
}

/** The timezone the Sync API's `user` names, known to this platform or not. */
export function namedZoneOf(user: SyncAnswer["user"]): string | undefined {
  const zone = user?.tz_info?.timezone;
  return typeof zone === "string" && zone !== "" ? zone : undefined;
}

/** The account's IANA timezone, from the Sync API's `user`, if it names one this platform knows. */
export function timezoneOf(user: SyncAnswer["user"]): string | undefined {
  const zone = namedZoneOf(user);
  if (zone === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

export function sourceId(account: string, taskId: string): string {
  return `${account}:${taskId}`;
}

function present<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** Todoist's priority, 1 to 4, as the core task's, as ruled. */
const priorities: Readonly<Record<number, string>> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "urgent",
};

type Wall = [
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
];

const dayMs = 86_400_000;

/**
 * The UTC instant a wall-clock time in a zone names, by the rule Temporal
 * calls "compatible": a time the clocks skipped moves later by the length
 * of the skip, and a time they showed twice is its first showing. So a
 * whole day whose midnight is skipped begins at its first real instant,
 * still on that day.
 */
function inZone(
  [year, month, day, hour, minute, second]: Wall,
  timeZone: string,
): Date {
  const wall = utcOf([year, month, day, hour, minute, second]);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offset = (at: number): number => {
    const read: Record<string, number> = {};
    for (const part of parts.formatToParts(at)) {
      read[part.type] = Number(part.value);
    }
    return (
      utcOf([
        read["year"] ?? 0,
        read["month"] ?? 1,
        read["day"] ?? 1,
        read["hour"] ?? 0,
        read["minute"] ?? 0,
        read["second"] ?? 0,
      ]) - at
    );
  };
  // The offsets either side of the wall time; a change of offset inside
  // the day is a daylight-saving change or a zone moving its clocks.
  const before = offset(wall - dayMs);
  const after = offset(wall + dayMs);
  const shown = [before, after]
    .map((candidate) => wall - candidate)
    .filter((at) => at + offset(at) === wall)
    .sort((a, b) => a - b);
  return new Date(shown[0] ?? wall - before);
}

/**
 * A Todoist due date as the core task's `due_at` and `precision`. Todoist
 * writes three kinds: a whole day (`2026-09-30`), a floating time in the
 * account's timezone (`2026-09-30T12:00:00`), and a fixed time in UTC,
 * ending in `Z`. The core task has no whole-day form, so a whole day is the
 * instant it begins in the account's timezone, at `day` precision. A date
 * or time the calendar does not have, such as 30 February or 24:00, is no
 * due date, in any of the three kinds.
 */
export function dueOf(
  due: TodoistItem["due"],
  timeZone: string,
): { due_at: string; precision: "day" | "time" } | undefined {
  const read = timeOf(due?.date);
  if (read === undefined) return undefined;
  const at =
    (read.utc ? utcOf(read.wall) : inZone(read.wall, timeZone).getTime()) +
    read.millis;
  return {
    due_at: new Date(at).toISOString(),
    precision: read.timed ? "time" : "day",
  };
}

function utcOf([year, month, day, hour, minute, second]: Wall): number {
  const at = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  // Date.UTC reads a year below 100 as 19xx; the year is set apart.
  at.setUTCFullYear(year, month - 1, day);
  return at.getTime();
}

/**
 * A Todoist date or time, read strictly: `YYYY-MM-DD`, optionally with
 * `THH:MM:SS`, a fraction and a `Z`. `Date.parse` would roll 30 February
 * into March and read far looser text, so it is not used.
 */
function timeOf(
  text: unknown,
): { wall: Wall; millis: number; timed: boolean; utc: boolean } | undefined {
  if (typeof text !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z)?)?$/.exec(
      text,
    );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction, zulu] = match;
  const wall: Wall = [
    Number(year),
    Number(month),
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  ];
  const [y, mo, d, h, mi, s] = wall;
  const read = new Date(utcOf(wall));
  if (
    read.getUTCFullYear() !== y ||
    read.getUTCMonth() !== mo - 1 ||
    read.getUTCDate() !== d ||
    read.getUTCHours() !== h ||
    read.getUTCMinutes() !== mi ||
    read.getUTCSeconds() !== s
  ) {
    return undefined;
  }
  return {
    wall,
    millis: Number(`${fraction ?? ""}000`.slice(0, 3)),
    timed: hour !== undefined,
    utc: zulu !== undefined,
  };
}

/** A completion time, which Todoist writes in UTC. */
function instantOf(value: string | null | undefined): string | undefined {
  const read = timeOf(value);
  return read?.utc === true
    ? new Date(utcOf(read.wall) + read.millis).toISOString()
    : undefined;
}

export function entryOf(
  account: string,
  timeZone: string,
  item: TodoistItem,
): Entry {
  const due = dueOf(item.due, timeZone);
  const completed = item.checked === true;
  return {
    source_id: sourceId(account, item.id),
    properties: {
      todoist_id: item.id,
      title: item.content,
      description: item.description === "" ? undefined : item.description,
      priority:
        item.priority === undefined ? undefined : priorities[item.priority],
      due_at: due?.due_at,
      precision: due?.precision,
      status: completed ? "completed" : "pending",
      completed_at: completed ? instantOf(item.completed_at) : undefined,
      url: `https://app.todoist.com/app/task/${encodeURIComponent(item.id)}`,
      project_id: present(item.project_id),
      section_id: present(item.section_id),
      parent_id: present(item.parent_id),
      labels:
        Array.isArray(item.labels) && item.labels.length > 0
          ? item.labels
          : undefined,
      child_order: item.child_order,
      comment_count: item.note_count,
    },
    occurred_at: item.added_at,
    changed_at: instantOf(item.updated_at),
  };
}
