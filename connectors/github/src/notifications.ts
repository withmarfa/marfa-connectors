import { createHash } from "node:crypto";
import type { Entry, EnvDeclaration, RunContext } from "@withmarfa/connector";
import { issueType, pullRequestType } from "./entries.js";
import {
  asPersonalToken,
  PermissionRequired,
  rateLimited,
  status,
  type Client,
} from "./github.js";
import type { Scope } from "./scope.js";

export const notificationType = "github.notification";
export const notificationOf = "github.notification-of";

export const tokenName = "GITHUB_NOTIFICATIONS_TOKEN";

/** The conditions a read of notifications raises, each cleared by a scheduled
 *  run that asks GitHub and finds it gone. */
export const refused = "notifications-refused";
export const limited = "notifications-rate-limit";
export const failed = "notifications-failed";
export const conditionKeys = [refused, limited, failed];

const stateKey = "notifications";

/** A day on, the listing is read whole whatever `Last-Modified` last said,
 *  which also connects a thread to an issue synced since it was read. */
const checkEvery = 24 * 60 * 60 * 1000;

/** GitHub's page size for this listing is at most 50. */
const perPage = 50;

/** No listing GitHub keeps is this long; a `Link` that never ends is. */
const pagesAtMost = 2000;

/** What the next run needs of this one: the moment GitHub last said the
 *  listing changed, when it was last asked and how long GitHub asked to wait,
 *  when it was last read whole, and whom and what it was read for. */
interface Progress {
  modified?: string;
  polled: string;
  interval: number;
  checked: string;
  key: string;
}

export interface RestThread {
  id: string | number;
  reason?: string;
  unread?: boolean;
  updated_at?: string;
  last_read_at?: string | null;
  subject?: { title?: string; url?: string | null; type?: string } | null;
  repository?: {
    full_name?: string;
    html_url?: string;
    private?: boolean;
  } | null;
}

type RootContext = RunContext<EnvDeclaration>;

export interface Options {
  /** Absent, nothing is read and nothing is reported. */
  readonly token: string | undefined;
  readonly base: string;
  readonly scope: Scope | undefined;
  /** `GITHUB_REPOSITORIES` as set; a change to it forces a whole read. */
  readonly scopeText: string | undefined;
}

function progressOf(value: unknown): Progress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const one = value as Record<string, unknown>;
  const polled = one["polled"];
  const checked = one["checked"];
  const interval = one["interval"];
  const key = one["key"];
  const modified = one["modified"];
  if (
    typeof polled !== "string" ||
    typeof checked !== "string" ||
    typeof key !== "string" ||
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval < 0
  )
    return undefined;
  return {
    polled,
    checked,
    key,
    interval,
    ...(typeof modified === "string" && { modified }),
  };
}

/** The address of what a thread concerns, from the repository's own and the
 *  last two parts of the subject's API address. GitHub names no page for
 *  other subjects, such as a release or a check suite. */
function addressOf(thread: RestThread): string | undefined {
  const html = thread.repository?.html_url;
  const tail = /\/(issues|pulls|discussions|commits)\/([^/?#]+)$/.exec(
    thread.subject?.url ?? "",
  );
  if (typeof html !== "string" || tail === null) return undefined;
  const page = {
    issues: "issues",
    pulls: "pull",
    discussions: "discussions",
    commits: "commit",
  }[tail[1] ?? ""];
  return page === undefined ? undefined : `${html}/${page}/${tail[2] ?? ""}`;
}

/** The kinds of subject a thread can be connected to, by the type that holds
 *  them and the part of the subject's address that names its number. */
const concerned: Record<string, { type: string; path: string } | undefined> = {
  Issue: { type: issueType, path: "issues" },
  PullRequest: { type: pullRequestType, path: "pulls" },
};

function numberOf(thread: RestThread, path: string): number | undefined {
  const found = new RegExp(`/${path}/(\\d+)$`).exec(thread.subject?.url ?? "");
  return found === null ? undefined : Number(found[1]);
}

function placeOf(fullName: string, number: number): string {
  return `${fullName.toLowerCase()}#${String(number)}`;
}

function entryOf(
  thread: RestThread,
  nodes: ReadonlyMap<string, string>,
): Entry | undefined {
  const { subject, repository } = thread;
  if (
    typeof subject?.title !== "string" ||
    typeof repository?.full_name !== "string" ||
    typeof thread.updated_at !== "string"
  )
    return undefined;
  const id = String(thread.id);
  const url = addressOf(thread);
  const kind = concerned[subject.type ?? ""];
  const number = kind === undefined ? undefined : numberOf(thread, kind.path);
  const node =
    kind === undefined || number === undefined
      ? undefined
      : nodes.get(`${kind.type} ${placeOf(repository.full_name, number)}`);
  return {
    source_id: id,
    properties: {
      github_id: id,
      body: subject.title,
      from: repository.full_name,
      reason: thread.reason,
      unread: thread.unread,
      github_updated_at: thread.updated_at,
      last_read_at: thread.last_read_at ?? null,
      subject_type: subject.type,
      url: url ?? null,
      private: repository.private,
    },
    occurred_at: thread.updated_at,
    changed_at: thread.updated_at,
    connections: {
      [notificationOf]:
        node === undefined || kind === undefined
          ? []
          : [{ type: kind.type, id: node }],
    },
  };
}

function header(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function secondsOf(headers: Record<string, unknown> | undefined) {
  const said = header(headers, "x-poll-interval");
  const seconds = said === undefined || said.trim() === "" ? NaN : Number(said);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

type Listing =
  | { unchanged: true; interval: number | undefined }
  | {
      unchanged: false;
      threads: RestThread[];
      modified: string | undefined;
      interval: number | undefined;
    };

/** The first page asks with `If-Modified-Since`, and GitHub answers every
 *  page of an unchanged listing 304, so the rest are asked without it. A
 *  failure on any page leaves nothing of the listing. */
async function list(
  octokit: Client,
  since: string | undefined,
): Promise<Listing> {
  const threads: RestThread[] = [];
  let modified: string | undefined;
  let interval: number | undefined;
  for (let page = 1; page <= pagesAtMost; page += 1) {
    let answer;
    try {
      answer = await octokit.request("GET /notifications", {
        all: true,
        per_page: perPage,
        page,
        ...(page === 1 &&
          since !== undefined && { headers: { "if-modified-since": since } }),
      });
    } catch (error) {
      if (page === 1 && since !== undefined && status(error) === 304) {
        return {
          unchanged: true,
          interval: secondsOf(
            (error as { response?: { headers?: Record<string, unknown> } })
              .response?.headers,
          ),
        };
      }
      throw error;
    }
    const headers = answer.headers as Record<string, unknown>;
    if (page === 1) {
      modified = header(headers, "last-modified");
      interval = secondsOf(headers);
    }
    threads.push(...(answer.data as RestThread[]));
    if (!/<[^>]*>;\s*rel="next"/.test(header(headers, "link") ?? "")) {
      return { unchanged: false, threads, modified, interval };
    }
  }
  throw new Error(
    `GitHub's listing of notifications went past ${String(pagesAtMost)} pages`,
  );
}

function refusal(error: unknown): string | undefined {
  if (error instanceof PermissionRequired) return error.message;
  const code = status(error);
  if (code !== 401 && code !== 403 && code !== 404) return undefined;
  const scopes = header(
    (error as { response?: { headers?: Record<string, unknown> } }).response
      ?.headers,
    "x-oauth-scopes",
  );
  return code === 401
    ? `${tokenName} was rejected by GitHub (401), so notifications are not read; the threads already read are kept. Create a classic token with only the notifications scope`
    : `${tokenName} cannot read notifications (${String(code)}); GitHub reads them only for a classic token or an OAuth token with the notifications scope, never for an App or a fine-grained token${scopes === undefined ? "" : `, and this token's scopes are ${scopes === "" ? "none" : scopes}`}. The threads already read are kept`;
}

/** Reads the person's notifications as `github.notification` rows, on a
 *  scheduled run. A failure is a condition and never fails the run, since
 *  every other kind is read apart from it. */
export async function readNotifications(
  context: RootContext,
  options: Options,
  reached: (...keys: string[]) => void,
): Promise<void> {
  const { log, secret, signal } = context;
  const { token } = options;
  if (token === undefined) {
    reached(...conditionKeys);
    return;
  }
  const scoped = context.forScope("notifications");
  const now = Date.now();
  const kept = progressOf(scoped.state.get(stateKey));
  // GitHub asks to be polled no faster than it says; a clock set back since
  // is not waited on.
  if (kept !== undefined) {
    const polled = Date.parse(kept.polled);
    if (polled <= now && now < polled + kept.interval * 1000) return;
  }
  reached(...conditionKeys);
  const key = `${createHash("sha256").update(token).digest("hex").slice(0, 16)} ${options.scopeText?.trim().toLowerCase() ?? ""}`;
  const checked = kept === undefined ? NaN : Date.parse(kept.checked);
  const since =
    kept?.modified !== undefined &&
    kept.key === key &&
    checked <= now &&
    now - checked < checkEvery
      ? kept.modified
      : undefined;
  const octokit = asPersonalToken(
    token,
    options.base,
    secret,
    signal,
    tokenName,
  );
  const polled = new Date(now).toISOString();
  try {
    const listing = await list(octokit, since);
    const interval = listing.interval ?? kept?.interval ?? 60;
    if (listing.unchanged) {
      if (kept === undefined) throw new Error("a 304 answered no request");
      await save(scoped, log, { ...kept, polled, interval });
      return;
    }
    const returned = new Set<string>();
    const admitted = new Map<string, RestThread>();
    for (const thread of listing.threads) {
      const full = thread.repository?.full_name;
      returned.add(String(thread.id));
      if (
        typeof full === "string" &&
        options.scope !== undefined &&
        !options.scope.admits(full)
      )
        continue;
      admitted.set(String(thread.id), thread);
    }
    const nodes = new Map<string, string>();
    if (
      [...admitted.values()].some(
        (one) => concerned[one.subject?.type ?? ""] !== undefined,
      )
    ) {
      for (const type of [issueType, pullRequestType]) {
        for (const row of await scoped.held(type, { state: "active" })) {
          const id = row.properties["github_id"];
          const repository = row.properties["repository"];
          const number = row.properties["number"];
          if (
            typeof id === "string" &&
            typeof repository === "string" &&
            typeof number === "number"
          )
            nodes.set(`${type} ${placeOf(repository, number)}`, id);
        }
      }
    }
    const entries: Entry[] = [];
    let unusable = 0;
    for (const thread of admitted.values()) {
      const entry = entryOf(thread, nodes);
      if (entry === undefined) unusable += 1;
      else entries.push(entry);
    }
    if (unusable > 0)
      log.warn(
        `${String(unusable)} notification threads named no subject, repository or time, so they were left out`,
      );
    await scoped.upsert(notificationType, entries);
    // The listing is whole, so a held thread it does not name is gone from it.
    const gone = (
      await scoped.held(notificationType, { state: "active" })
    ).flatMap((row) => {
      const id = row.properties["github_id"];
      return typeof id === "string" && !returned.has(id) ? [id] : [];
    });
    if (gone.length > 0) await scoped.archive(notificationType, gone);
    await save(scoped, log, {
      ...(listing.modified !== undefined && { modified: listing.modified }),
      polled,
      interval,
      checked: polled,
      key,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (rateLimited(error)) {
      log.condition(
        limited,
        "GitHub's rate limit for the notifications token is spent, so notifications wait for the next run",
      );
      return;
    }
    const said = refusal(error);
    if (said !== undefined) {
      log.condition(refused, said);
      return;
    }
    const code = status(error);
    log.condition(
      failed,
      `notifications could not be read (${code === undefined ? "no answer" : String(code)}: ${error instanceof Error ? error.message : String(error)}), so they are tried again next run; the threads already read are kept`,
    );
  }
}

async function save(
  scoped: ReturnType<RootContext["forScope"]>,
  log: RootContext["log"],
  progress: Progress,
): Promise<void> {
  const result = await scoped.state.checkpoint(stateKey, progress);
  if (!result.committed)
    log.condition(
      failed,
      `notifications were read but their progress could not be saved (${result.reason}), so they will be read again`,
    );
}
