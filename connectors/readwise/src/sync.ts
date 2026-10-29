import { createHash } from "node:crypto";
import type {
  EnvValues,
  RunContext,
  ScopedRunContext,
} from "@withmarfa/connector";
import {
  Client,
  endpoint,
  InvalidCursor,
  RateLimited,
  ReadwiseThrottleError,
  ReadwiseAuthorizationError,
  type ExportClient,
  type Query,
  drainContent,
  enqueueContent,
  isAccountedContent,
  readerFileType,
  contentMaxBytes,
} from "@withmarfa/readwise";
import type { ExportPage } from "@withmarfa/readwise";
import { identity, ReaderClient, type ReaderReader } from "@withmarfa/readwise";
import {
  PreservationQueueFull,
  SharedRows,
  type SharedContext,
} from "./coexistence.js";
import { sourceType, highlightType } from "@withmarfa/readwise";

export const env = {
  READWISE_ACCOUNT: "required",
  READWISE_ACCESS_TOKEN: "secret",
  READWISE_API_URL: "optional",
  READWISE_CONTENT_MAX_BYTES: "optional",
  READWISE_READER_API_URL: "optional",
} as const;
export type ReadScope = Pick<
  ScopedRunContext<typeof env>,
  "state" | "upsert" | "archive" | "refusals"
>;
export interface ReadContext extends SharedContext {
  env: EnvValues<typeof env>;
  signal: AbortSignal;
  waitUntil: RunContext<typeof env>["waitUntil"];
  hints: RunContext<typeof env>["hints"];
  log: RunContext<typeof env>["log"];
  written: RunContext<typeof env>["written"];
  known?: RunContext<typeof env>["known"];
  linked?: RunContext<typeof env>["linked"];
  forScope: (
    name: string,
    options?: { retry: { mode: "refetch"; context: string } },
  ) => ReadScope;
}
interface Walk {
  lower: string | null;
  start: string;
  cursor: string | null;
  seen: string[];
  full: boolean;
}
interface Progress {
  account: string;
  endpoint: string;
  shape: string;
  completed?: string;
  fullAt?: string;
  retryUntil?: string;
  walk?: Walk;
  pendingSources?: number[];
}
const stateKey = "export";
const fullEvery = 24 * 60 * 60 * 1000;
const overlap = 5 * 60 * 1000;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function progress(
  value: unknown,
  account: string,
  base: string,
  shape: string,
): Progress {
  if (value === undefined) return { account, endpoint: base, shape };
  if (typeof value !== "object" || value === null)
    throw new Error("Readwise saved progress is invalid");
  const saved = value as Partial<Progress>;
  if (saved.account !== account || saved.endpoint !== base)
    throw new Error(
      "Readwise account or endpoint changed against saved progress; restore the original configuration",
    );
  if (
    typeof saved.shape !== "string" ||
    [saved.completed, saved.fullAt, saved.retryUntil].some(
      (value) => value !== undefined && !timestamp(value),
    )
  )
    throw new Error("Readwise saved progress is invalid");
  if (
    saved.pendingSources !== undefined &&
    (!Array.isArray(saved.pendingSources) ||
      saved.pendingSources.some((id) => !Number.isSafeInteger(id) || id <= 0))
  )
    throw new Error("Readwise saved pending sources are invalid");
  const walk = saved.walk as unknown;
  if (walk !== undefined) {
    if (typeof walk !== "object" || walk === null)
      throw new Error("Readwise saved export walk is invalid");
    const row = walk as Record<string, unknown>;
    if (
      !timestamp(row["start"]) ||
      (row["lower"] !== null && !timestamp(row["lower"])) ||
      (row["cursor"] !== null &&
        (typeof row["cursor"] !== "string" || row["cursor"].length === 0)) ||
      typeof row["full"] !== "boolean" ||
      !Array.isArray(row["seen"]) ||
      row["seen"].some(
        (value: unknown) =>
          typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
      )
    )
      throw new Error("Readwise saved export walk is invalid");
  }
  return saved as Progress;
}
async function checkpoint(scope: ReadScope, value: Progress): Promise<void> {
  const result = await scope.state.checkpoint(stateKey, value);
  if (!result.committed)
    throw new Error(`Readwise export progress was not saved: ${result.reason}`);
}
async function write(
  scope: ReadScope,
  page: ExportPage,
  account: string,
  shared: SharedRows,
  saved: Progress,
  context: ReadContext,
): Promise<void> {
  const pending = new Set(saved.pendingSources ?? []);
  for (const source of page.results) {
    const failures: unknown[] = [];
    async function prepare<T>(
      operation: () => Promise<T>,
    ): Promise<T | undefined> {
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof ReadwiseThrottleError ||
          error instanceof ReadwiseAuthorizationError
        )
          throw error;
        context.signal.throwIfAborted();
        failures.push(error);
        context.log.condition(
          `readwise:coexistence:${String(source.user_book_id)}`,
          error instanceof Error
            ? error.message
            : "Readwise identity reconciliation failed",
        );
        return undefined;
      }
    }
    if (source.is_deleted === true) {
      const key = await prepare(() =>
        shared.deletion(
          sourceType.id,
          identity(account, "source", source.user_book_id),
        ),
      );
      if (key !== undefined) await scope.archive(sourceType.id, [key]);
    } else {
      const entry = await prepare(() => shared.source(source));
      if (entry !== undefined) await scope.upsert(sourceType.id, [entry]);
    }
    for (const highlight of source.highlights) {
      if (highlight.is_deleted === true) {
        const key = await prepare(() =>
          shared.deletion(
            highlightType.id,
            identity(account, "highlight", highlight.id),
          ),
        );
        if (key !== undefined) await scope.archive(highlightType.id, [key]);
      } else {
        const entry = await prepare(() => shared.highlight(source, highlight));
        if (entry !== undefined) await scope.upsert(highlightType.id, [entry]);
      }
    }
    if (failures.length > 0) pending.add(source.user_book_id);
    else pending.delete(source.user_book_id);
  }
  if (pending.size > 1000)
    throw new Error(
      "Readwise pending identity reconciliation is full; page progress is retained",
    );
  saved.pendingSources = [...pending];
}
function nextSeen(seen: string[], cursor: string | null): string[] {
  if (cursor === null) return seen;
  const digest = hash(cursor);
  if (seen.includes(digest))
    throw new Error("Readwise repeated an export cursor");
  if (seen.length >= 4096)
    throw new Error(
      "Readwise export exceeds the bounded cursor history; progress is retained",
    );
  return [...seen, digest];
}
function vendorId(
  account: string,
  kind: "source" | "highlight",
  key: string,
): number {
  const prefix = `${account}:${kind}:`;
  const raw = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0)
    throw new Error("Readwise retry identity does not match this account");
  return id;
}
async function refetch(
  scope: ReadScope,
  client: ExportClient,
  saved: Progress,
  context: ReadContext,
  shared: SharedRows,
): Promise<void> {
  const sources = new Set<number>(saved.pendingSources ?? []);
  for (const { record, due } of scope.refusals.pending()) {
    if (!due) {
      context.log.unreached({
        keys: [`readwise:retry-missing:${record.identity.sourceId}`],
      });
      continue;
    }
    if (record.identity.sourceId.startsWith(`${saved.account}:reader-`)) {
      await shared.retry(scope, record.identity.type, record.identity.sourceId);
      continue;
    }
    if (record.identity.type === sourceType.id)
      sources.add(vendorId(saved.account, "source", record.identity.sourceId));
    else if (record.identity.type === highlightType.id) {
      const sourceId = await client.sourceForHighlight(
        vendorId(saved.account, "highlight", record.identity.sourceId),
      );
      if (sourceId === undefined) {
        context.log.condition(
          `readwise:retry-missing:${record.identity.sourceId}`,
          "Readwise did not answer a pending highlight; only an explicit export tombstone can settle its deletion",
        );
      } else sources.add(sourceId);
    } else throw new Error("Readwise retry record has an unknown type");
  }
  for (const sourceId of sources) {
    let cursor: string | undefined;
    let seen: string[] = [];
    do {
      const page = await client.page({
        sourceId,
        ...(cursor !== undefined && { cursor }),
      });
      if (page.results.some((source) => source.user_book_id !== sourceId))
        throw new Error("Readwise source refetch returned an unrelated source");
      seen = nextSeen(seen, page.nextPageCursor);
      await write(scope, page, saved.account, shared, saved, context);
      await checkpoint(scope, saved);
      cursor = page.nextPageCursor ?? undefined;
    } while (cursor !== undefined);
  }
}
export async function sync(
  context: ReadContext,
  options: {
    client?: ExportClient;
    reader?: ReaderReader;
    now?: () => number;
    maxPages?: number;
  } = {},
): Promise<void> {
  if (context.hints !== undefined) {
    context.log.unreached({ prefixes: ["readwise:"] });
    return;
  }
  const now = options.now ?? Date.now;
  const account = context.env.READWISE_ACCOUNT;
  const maximumContentBytes = contentMaxBytes(
    context.env.READWISE_CONTENT_MAX_BYTES,
  );
  identity(account, "source", 1);
  const base = endpoint(context.env.READWISE_API_URL);
  const readerBase = endpoint(
    context.env.READWISE_READER_API_URL ?? "https://readwise.io/api/v3/",
  );
  const reader =
    options.reader ??
    new ReaderClient(
      readerBase,
      context.env.READWISE_ACCESS_TOKEN,
      context.signal,
      { now, waitUntil: (until) => context.waitUntil(until) },
    );
  const content = context.forScope("reader-content");
  const shared = new SharedRows(
    account,
    context,
    reader,
    context.known === undefined
      ? undefined
      : async (job) => {
          const manifest = await context.inspect(readerFileType.id, {
            links: [`${job.canonical}:content:manifest`],
          });
          if (isAccountedContent(manifest.items[0], job)) return;
          if (await enqueueContent(content.state, [job])) return;
          await preserve();
          if (!(await enqueueContent(content.state, [job])))
            throw new PreservationQueueFull(
              "Reader preservation queue is full; metadata waits for acknowledged content work",
            );
        },
  );
  const shape = hash([
    readerBase,
    sourceType,
    highlightType,
    [...context.written(sourceType.id)].sort(),
    [...context.written(highlightType.id)].sort(),
  ]);
  const scope = context.forScope("export", {
    retry: { mode: "refetch", context: hash([account, base, shape]) },
  });
  let saved = progress(scope.state.get(stateKey), account, base, shape);
  if (saved.retryUntil !== undefined && Date.parse(saved.retryUntil) > now()) {
    context.log.unreached({ prefixes: ["readwise:"] });
    context.log.condition(
      "readwise:rate-limit",
      `Readwise export waits until ${saved.retryUntil}`,
    );
    return;
  }
  const client =
    options.client ??
    new Client(base, context.env.READWISE_ACCESS_TOKEN, context.signal, {
      now,
      waitUntil: (until) => context.waitUntil(until),
    });
  const reachedContent = new Set<string>();
  const preserve = async () => {
    if (context.known !== undefined)
      await drainContent(
        {
          ...context,
          known: context.known,
          log: {
            ...context.log,
            unreached: ({ exceptKeys = [] }) => {
              for (const key of exceptKeys) reachedContent.add(key);
            },
            condition: (key, message) => {
              if (key !== "readwise:content-pending")
                context.log.condition(key, message);
            },
          },
        },
        reader,
        content.state,
        { now, exportClient: client, maxBytes: maximumContentBytes },
      );
  };
  try {
    await preserve();
    if (saved.retryUntil !== undefined) {
      delete saved.retryUntil;
      await checkpoint(scope, saved);
    }
    await refetch(scope, client, saved, context, shared);
    const refreshScope = context.forScope("reader-refresh", {
      retry: { mode: "refetch", context: hash([account, readerBase, shape]) },
    });
    if (await shared.refresh(refreshScope)) {
      const refreshed = await refreshScope.state.checkpoint(
        "refresh",
        new Date(now()).toISOString(),
      );
      if (!refreshed.committed)
        throw new Error(`Reader refresh was not saved: ${refreshed.reason}`);
    }
    if (saved.shape !== shape) {
      saved = { ...saved, shape };
      delete saved.walk;
      delete saved.fullAt;
    }
    if (saved.walk === undefined) {
      const full =
        saved.completed === undefined ||
        saved.fullAt === undefined ||
        now() - Date.parse(saved.fullAt) >= fullEvery;
      saved.walk = {
        lower: full
          ? null
          : new Date(Date.parse(saved.completed ?? "") - overlap).toISOString(),
        start: new Date(now()).toISOString(),
        cursor: null,
        seen: [],
        full,
      };
      await checkpoint(scope, saved);
    }
    let restarted = false;
    for (let at = 0; at < (options.maxPages ?? 50); at++) {
      context.signal.throwIfAborted();
      const walk = saved.walk;
      if (walk === undefined) throw new Error("Readwise export lost its walk");
      const query: Query = {
        ...(walk.lower !== null && { updatedAfter: walk.lower }),
        ...(walk.cursor !== null && { cursor: walk.cursor }),
      };
      let page: ExportPage;
      try {
        page = await client.page(query);
      } catch (error) {
        if (
          !(error instanceof InvalidCursor) ||
          walk.cursor === null ||
          restarted
        )
          throw error;
        saved = { ...saved, walk: { ...walk, cursor: null, seen: [] } };
        await checkpoint(scope, saved);
        restarted = true;
        at--;
        continue;
      }
      const seen = nextSeen(walk.seen, page.nextPageCursor);
      await write(scope, page, account, shared, saved, context);
      const next: Progress = { ...saved };
      if (page.nextPageCursor === null) {
        next.completed = walk.start;
        if (walk.full) next.fullAt = walk.start;
        delete next.walk;
      } else next.walk = { ...walk, cursor: page.nextPageCursor, seen };
      await checkpoint(scope, next);
      saved = next;
      if (saved.walk === undefined) {
        await preserve();
        return;
      }
    }
    context.log.condition(
      "readwise:unfinished",
      "Readwise export has more pages; the next scheduled run resumes its saved cursor",
    );
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    // Per-record GETs can throttle after writes; retain only acknowledged progress.
    const acknowledged = progress(
      scope.state.get(stateKey),
      account,
      base,
      shape,
    );
    await checkpoint(scope, { ...acknowledged, retryUntil: error.until });
    context.log.unreached({ prefixes: ["readwise:"] });
    context.log.condition("readwise:rate-limit", error.message);
  } finally {
    if (context.known !== undefined)
      await drainContent(
        {
          ...context,
          known: context.known,
          log: {
            ...context.log,
            // Independent batches must not mask jobs reached by another drain.
            unreached: (selectors) => {
              context.log.unreached({
                ...selectors,
                exceptKeys: [...reachedContent],
              });
            },
          },
        },
        reader,
        content.state,
        { maxJobs: 0 },
      );
  }
}
