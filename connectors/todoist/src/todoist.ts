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
  due?: Record<string, unknown> | null;
  child_order?: number;
  checked?: boolean;
  is_deleted?: boolean;
  note_count?: number;
  added_at?: string;
}

export interface SyncAnswer {
  sync_token: string;
  items: TodoistItem[];
  user?: { id?: unknown };
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
 * item's `user_id`, which names whoever the task is assigned to.
 */
export function accountOf(user: SyncAnswer["user"]): string | undefined {
  const id = user?.id;
  if (typeof id !== "string") return undefined;
  const account = id.trim();
  // A colon would make `<account>:<task>` read two ways.
  return account === "" || account.includes(":") ? undefined : account;
}

export function sourceId(account: string, taskId: string): string {
  return `${account}:${taskId}`;
}

function present<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function entryOf(account: string, item: TodoistItem): Entry {
  return {
    source_id: sourceId(account, item.id),
    properties: {
      title: item.content,
      description: item.description === "" ? undefined : item.description,
      project_id: present(item.project_id),
      section_id: present(item.section_id),
      parent_id: present(item.parent_id),
      labels:
        item.labels !== undefined && item.labels.length > 0
          ? item.labels
          : undefined,
      priority: item.priority,
      due: present(item.due),
      child_order: item.child_order,
      completed: item.checked === true,
      url: `https://app.todoist.com/app/task/${encodeURIComponent(item.id)}`,
      comment_count: item.note_count,
    },
    occurred_at: item.added_at,
  };
}
