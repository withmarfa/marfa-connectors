import type { Entry } from "@withmarfa/connector";

/** A task as the Sync API answers it, in the fields this connector reads. */
export interface TodoistItem {
  id: string;
  content: string;
  description?: string;
  project_id?: string | null;
  section_id?: string | null;
  parent_id?: string | null;
  labels?: string[];
  priority?: number;
  due?: {
    date?: string;
    timezone?: string | null;
    string?: string;
    is_recurring?: boolean;
    lang?: string;
  } | null;
  child_order?: number;
  checked?: boolean;
  completed_at?: string | null;
  is_deleted?: boolean;
  note_count?: number;
  added_at?: string;
}

export interface SyncAnswer {
  sync_token: string;
  items: TodoistItem[];
  user?: { id?: unknown; tz_info?: { timezone?: unknown } };
}

export const firstSync = "*";
const syncTimeoutMs = 60_000;

export async function sync(
  base: string,
  token: string,
  syncToken: string,
  signal: AbortSignal,
): Promise<SyncAnswer> {
  const response = await fetch(new URL("/api/v1/sync", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams({
      sync_token: syncToken,
      resource_types: JSON.stringify(["items", "user"]),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(syncTimeoutMs)]),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Todoist refused the token: ${String(response.status)}`);
  }
  if (!response.ok) {
    throw new Error(`Todoist's Sync API answered ${String(response.status)}`);
  }
  return (await response.json()) as SyncAnswer;
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

/** The account's IANA timezone, from the Sync API's `user`, if it names one this platform knows. */
export function timezoneOf(user: SyncAnswer["user"]): string | undefined {
  const zone = user?.tz_info?.timezone;
  if (typeof zone !== "string" || zone === "") return undefined;
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

/** The UTC instant a wall-clock time in a zone names. */
function inZone(
  [year, month, day, hour, minute, second]: Wall,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
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
      Date.UTC(
        read["year"] ?? 0,
        (read["month"] ?? 1) - 1,
        read["day"] ?? 1,
        read["hour"] ?? 0,
        read["minute"] ?? 0,
        read["second"] ?? 0,
      ) - at
    );
  };
  // Twice, since the offset at the first guess can sit across a
  // daylight-saving change from the offset at the answer.
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess));
}

/**
 * A Todoist due date as the core task's `due_at` and `precision`. Todoist
 * writes three kinds: a whole day (`2026-09-30`), a floating time in the
 * account's timezone (`2026-09-30T12:00:00`), and a fixed time in UTC,
 * ending in `Z`. The core task has no whole-day form, so a whole day is the
 * instant it begins in the account's timezone, at `day` precision.
 */
export function dueOf(
  due: TodoistItem["due"],
  timeZone: string,
): { due_at: string; precision: "day" | "time" } | undefined {
  const date = due?.date;
  if (date === undefined) return undefined;
  if (date.endsWith("Z")) {
    const at = Date.parse(date);
    return Number.isNaN(at)
      ? undefined
      : { due_at: new Date(at).toISOString(), precision: "time" };
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/.exec(
      date,
    );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const at = inZone(
    [
      Number(year),
      Number(month),
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
    ],
    timeZone,
  );
  return Number.isNaN(at.getTime())
    ? undefined
    : {
        due_at: at.toISOString(),
        precision: hour === undefined ? "day" : "time",
      };
}

function instantOf(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
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
        item.labels !== undefined && item.labels.length > 0
          ? item.labels
          : undefined,
      child_order: item.child_order,
      comment_count: item.note_count,
    },
    occurred_at: item.added_at,
  };
}
