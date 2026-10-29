import { createHash } from "node:crypto";
import type {
  CheckpointState,
  Entry,
  RunContext,
  ScopedRunContext,
  Item,
} from "@withmarfa/connector";
import {
  Client,
  ReaderClient,
  InvalidCursor,
  RateLimited,
  ReadwiseThrottleError,
  ReadwiseAuthorizationError,
  parseReaderPage,
  isReaderManaged,
  mapReaderSource,
  mapReaderHighlight,
  readerContentRevision,
  readerIdentity,
  type ReaderReader,
  type ExportClient,
  type ReaderDocument,
  enqueueContent,
  drainContent,
  admitPictures,
  drainPictures,
  pausePictures,
  pictureListing,
  sourceType,
  highlightType,
  readerFileType,
  readerMutableSourceFields,
  readerMutableHighlightFields,
  type ContentJob,
} from "@withmarfa/readwise";
import { env, parseConfig } from "./config.js";
import { ReaderIdentities } from "./identity.js";
import { packIdentities, unpackIdentities } from "./checkpoint.js";
export type ReaderScope = Pick<
  ScopedRunContext<typeof env>,
  "state" | "upsert" | "archive" | "refusals"
>;
export interface ReaderContext extends Pick<
  RunContext<typeof env>,
  | "env"
  | "signal"
  | "waitUntil"
  | "hints"
  | "written"
  | "held"
  | "inspect"
  | "known"
  | "log"
  | "pendingOutbound"
> {
  linked?: RunContext<typeof env>["linked"];
  forScope(
    name: string,
    options?: { retry: { mode: "refetch"; context: string } },
  ): ReaderScope;
}
export interface ContentWork {
  enqueue(
    state: CheckpointState,
    jobs: readonly ContentJob[],
  ): Promise<boolean>;
  drain(
    context: ReaderContext,
    reader: ReaderReader,
    state: CheckpointState,
  ): Promise<void>;
}
interface Walk {
  start: string;
  lower: string | null;
  cursor: string | null;
  seen: string[];
  total: number | null;
  identities: string[];
  full: boolean;
  missing: string[];
}
interface Reconcile {
  remaining: string[];
  confirmed: string[];
}
interface Progress {
  account: string;
  endpoint: string;
  fingerprint: string;
  completed?: string;
  fullAt?: string;
  retryUntil?: string;
  walk?: Walk;
  reconcile?: Reconcile;
  pending: string[];
}
const fullEvery = 24 * 60 * 60 * 1000;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
function progress(
  value: unknown,
  account: string,
  endpoint: string,
  fingerprint: string,
): Progress {
  if (value === undefined)
    return { account, endpoint, fingerprint, pending: [] };
  if (typeof value !== "object" || value === null)
    throw new Error("Reader listing progress is invalid");
  const saved = structuredClone(value) as Progress;
  const restore = (ids: unknown): string[] => {
    const values = Array.isArray(ids)
      ? ids
      : unpackIdentities(ids, "listing identities");
    if (!strings(values))
      throw new Error("Reader saved listing identities are invalid");
    return values;
  };
  saved.pending = restore(saved.pending);
  if (saved.walk !== undefined) {
    saved.walk.missing = restore(saved.walk.missing);
    saved.walk.identities = restore(saved.walk.identities);
  }
  if (saved.reconcile !== undefined) {
    saved.reconcile.remaining = restore(saved.reconcile.remaining);
    saved.reconcile.confirmed = restore(saved.reconcile.confirmed);
  }
  if (saved.account !== account || saved.endpoint !== endpoint)
    throw new Error(
      "Reader account or endpoint changed against saved progress",
    );
  if (
    typeof saved.fingerprint !== "string" ||
    !strings(saved.pending) ||
    saved.pending.length > 1000 ||
    [saved.completed, saved.fullAt, saved.retryUntil].some(
      (value) => value !== undefined && !timestamp(value),
    )
  )
    throw new Error("Reader listing progress is invalid");
  if (saved.walk !== undefined) {
    const walk: Walk | undefined = saved.walk;
    if (
      !timestamp(walk.start) ||
      (walk.lower !== null && !timestamp(walk.lower)) ||
      (walk.cursor !== null && typeof walk.cursor !== "string") ||
      !strings(walk.seen) ||
      !strings(walk.missing) ||
      !strings(walk.identities) ||
      new Set(walk.identities).size !== walk.identities.length ||
      (walk.total !== null &&
        (!Number.isSafeInteger(walk.total) ||
          walk.total < walk.identities.length)) ||
      (walk.total === null && walk.identities.length !== 0) ||
      typeof walk.full !== "boolean"
    )
      throw new Error("Reader saved walk is invalid");
  }
  if (
    saved.reconcile !== undefined &&
    (!strings(saved.reconcile.remaining) || !strings(saved.reconcile.confirmed))
  )
    throw new Error("Reader reconciliation progress is invalid");
  return saved;
}
async function checkpoint(scope: ReaderScope, saved: Progress): Promise<void> {
  const compact = (ids: string[]) =>
    Buffer.byteLength(JSON.stringify(ids)) <= 4096
      ? ids
      : packIdentities(ids, "listing identities");
  const stored = {
    ...saved,
    pending: compact(saved.pending),
    ...(saved.walk !== undefined && {
      walk: {
        ...saved.walk,
        missing: compact(saved.walk.missing),
        identities: compact(saved.walk.identities),
      },
    }),
    ...(saved.reconcile !== undefined && {
      reconcile: {
        remaining: compact(saved.reconcile.remaining),
        confirmed: compact(saved.reconcile.confirmed),
      },
    }),
  };
  if (Buffer.byteLength(JSON.stringify(stored)) > 512 * 1024)
    throw new Error(
      "Reader listing state exceeds its bounded capacity; progress is retained",
    );
  const result = await scope.state.checkpoint("listing", stored);
  if (!result.committed)
    throw new Error(`Reader listing progress was not saved: ${result.reason}`);
}
function idFromKey(account: string, key: string): string {
  for (const kind of ["document", "highlight"]) {
    const prefix = `${account}:reader-${kind}:`;
    if (key.startsWith(prefix) && key.length > prefix.length)
      return key.slice(prefix.length);
  }
  throw new Error("Reader retry identity does not belong to this account");
}
function stableRevision(document: ReaderDocument): string {
  return readerContentRevision(document);
}
async function held(
  context: ReaderContext,
  account: string,
): Promise<Map<string, Item>> {
  const rows = new Map<string, Item>();
  for (const type of ["readwise.source", "readwise.highlight"])
    for (const row of await context.held(type, { state: "any" }))
      if (isReaderManaged(type, row.properties, account))
        rows.set(String(row.properties["canonical_key"]), row);
  return rows;
}
export async function sync(
  context: ReaderContext,
  options: {
    content?: ContentWork;
    reader?: ReaderReader;
    exportClient?: ExportClient;
    now?: () => number;
    maxPages?: number;
    /** Picture work's fetch and clock; for tests. */
    pictures?: Pick<Parameters<typeof drainPictures>[3], "fetch" | "budget">;
  } = {},
): Promise<void> {
  const config = parseConfig(context.env);
  const now = options.now ?? Date.now;
  const maxPages = options.maxPages ?? 15;
  const fingerprint = hash([
    config.includeFeed,
    sourceType,
    highlightType,
    readerFileType,
    readerMutableSourceFields,
    readerMutableHighlightFields,
    [...context.written("readwise.source")].sort(),
    [...context.written("readwise.highlight")].sort(),
    [...context.written("readwise.file")].sort(),
  ]);
  const scope = context.forScope("reader-list", {
    retry: {
      mode: "refetch",
      context: hash([config.account, config.readerBase, fingerprint]),
    },
  });
  const queueScope = context.forScope("reader-content-queue");
  const pictureScope = context.forScope("reader-pictures");
  let saved = progress(
    scope.state.get("listing"),
    config.account,
    config.readerBase,
    fingerprint,
  );
  if (saved.retryUntil !== undefined && Date.parse(saved.retryUntil) > now()) {
    context.log.condition(
      "readwise:reader-rate-limit",
      `Reader waits until ${saved.retryUntil}`,
    );
    context.log.unreached({ prefixes: ["readwise:"] });
    return;
  }
  const reader =
    options.reader ??
    new ReaderClient(
      config.readerBase,
      context.env.READWISE_ACCESS_TOKEN,
      context.signal,
      { now, waitUntil: (until) => context.waitUntil(until) },
    );
  const exportClient =
    options.exportClient ??
    new Client(
      config.exportBase,
      context.env.READWISE_ACCESS_TOKEN,
      context.signal,
      { now, waitUntil: (until) => context.waitUntil(until) },
    );
  const setting = config.pictures;
  const content: ContentWork = options.content ?? {
    enqueue: enqueueContent,
    drain: (ctx, client, state) =>
      drainContent(ctx, client, state, {
        now,
        exportClient,
        maxBytes: config.contentMaxBytes,
        ...(setting !== "addresses" && {
          pictures: pictureListing(pictureScope.state, setting),
        }),
      }),
  };
  const cached = new Map<string, ReaderDocument | undefined>();
  const get = async (id: string): Promise<ReaderDocument | undefined> => {
    if (cached.has(id)) return cached.get(id);
    const value = await reader.document(id);
    cached.set(id, value);
    return value;
  };
  const contain = (error: unknown, key: string): void => {
    if (
      error instanceof ReadwiseThrottleError ||
      error instanceof ReadwiseAuthorizationError
    )
      throw error;
    context.signal.throwIfAborted();
    context.log.condition(
      `readwise:reader-retry:${key}`,
      error instanceof Error
        ? error.message
        : "Reader lookup remains pending for retry",
    );
  };
  const identities = await ReaderIdentities.load(
    config.account,
    config.exportBase,
    context,
    context.forScope("reader-identities").state,
  );
  const inScope = async (document: ReaderDocument): Promise<boolean> => {
    if (config.includeFeed) return true;
    let current: ReaderDocument | undefined = document;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (seen.has(current.id))
        throw new Error("Reader parent graph contains a cycle");
      seen.add(current.id);
      if (current.location === "feed") return false;
      if (!current.parent_id) return true;
      if (seen.size > 3)
        throw new Error(
          "Reader parent graph exceeds the supported document hierarchy",
        );
      current = await get(current.parent_id);
    }
    return true;
  };
  const importDocuments = async (
    documents: readonly ReaderDocument[],
  ): Promise<boolean> => {
    for (const document of documents) cached.set(document.id, document);
    const combined = new Map<string, ReaderDocument>();
    const notes = new Map<string, ReaderDocument[]>();
    const pending = new Set(saved.pending);
    for (const document of documents) {
      if (document.category !== "note") {
        combined.set(document.id, document);
        continue;
      }
      if (!document.parent_id) {
        pending.add(document.id);
        context.log.condition(
          `readwise:reader-parent:${document.id}`,
          "Reader note has no highlight parent; its import remains pending",
        );
        continue;
      }
      notes.set(document.parent_id, [
        ...(notes.get(document.parent_id) ?? []),
        document,
      ]);
      let parent: ReaderDocument | undefined;
      try {
        parent = await get(document.parent_id);
      } catch (error) {
        contain(error, document.id);
        pending.add(document.id);
        continue;
      }
      if (parent?.category !== "highlight") {
        pending.add(document.id);
        context.log.condition(
          `readwise:reader-parent:${document.id}`,
          "Reader note's highlight is unavailable; its import remains pending",
        );
        continue;
      }
      combined.set(parent.id, parent);
    }
    const entries: { type: string; entry: Entry; id: string }[] = [];
    const jobs: ContentJob[] = [];
    const sorted = [...combined.values()].sort(
      (a, b) =>
        Number(a.category === "highlight") - Number(b.category === "highlight"),
    );
    for (const document of sorted) {
      context.signal.throwIfAborted();
      try {
        if (!(await inScope(document))) {
          pending.delete(document.id);
          continue;
        }
        const resolved = await identities.resolve(document);
        if (resolved.purged) {
          pending.delete(document.id);
          continue;
        }
        const enrichment = {
          ...resolved.enrichment,
          ...(notes.has(document.id)
            ? { notes: notes.get(document.id) ?? [] }
            : {}),
        };
        if ((notes.get(document.id)?.length ?? 0) > 256)
          throw new Error(
            "Reader note preservation exceeds the bounded identity list; metadata remains pending",
          );
        const mapped =
          document.category === "highlight"
            ? mapReaderHighlight(config.account, document, enrichment)
            : mapReaderSource(config.account, document, enrichment);
        const initial = resolved.previousProperties;
        const mutable =
          document.category === "highlight"
            ? readerMutableHighlightFields
            : readerMutableSourceFields;
        if (
          initial !== undefined &&
          initial["reader_managed"] !== true &&
          mutable.some(
            (field) =>
              JSON.stringify(initial[field] ?? null) !==
              JSON.stringify(mapped.entry.properties[field] ?? null),
          )
        )
          context.log.condition(
            `readwise:reader-adoption:${document.id}`,
            "Existing Marfa values differ from Reader. First adoption preserves them without sending an edit upstream; a subsequent local edit creates a new intent.",
          );
        if (document.category === "highlight" && document.parent_id) {
          const parent = await get(document.parent_id);
          if (parent === undefined) {
            mapped.entry.connections = { references: [] };
            mapped.conditions.push("unresolved-parent");
          } else if (
            parent.category === "highlight" ||
            parent.category === "note"
          )
            throw new Error("Reader highlight parent is not a source document");
          else {
            const parentIdentity = await identities.resolve(parent);
            if (parentIdentity.purged) {
              mapped.entry.connections = { references: [] };
              mapped.conditions.push("purged-parent");
            } else if (!combined.has(parent.id)) {
              const parentMapped = mapReaderSource(
                config.account,
                parent,
                parentIdentity.enrichment,
              );
              entries.push({
                type: parentIdentity.type,
                entry: parentMapped.entry,
                id: parent.id,
              });
              jobs.push({
                id: parent.id,
                canonical: parentIdentity.canonical,
                type: parentIdentity.type,
                revision: stableRevision(parent),
              });
            }
          }
        }
        for (const condition of mapped.conditions)
          context.log.condition(
            `readwise:reader-${condition}:${document.id}`,
            `Reader metadata requires attention: ${condition}`,
          );
        let exportIds:
          { exportSourceId: number; exportHighlightId: number } | undefined;
        if (mapped.textFiles.some((file) => file.field === "readwise_text")) {
          const sourceId = Number(
            resolved.enrichment.properties?.["readwise_source_id"],
          );
          const highlightId = Number(
            resolved.enrichment.properties?.["readwise_id"],
          );
          if (
            !Number.isSafeInteger(sourceId) ||
            sourceId <= 0 ||
            !Number.isSafeInteger(highlightId) ||
            highlightId <= 0
          )
            throw new Error(
              "Reader export text cannot be preserved without verified export identities",
            );
          exportIds = {
            exportSourceId: sourceId,
            exportHighlightId: highlightId,
          };
        }
        if (document.category !== "highlight" || mapped.textFiles.length > 0)
          jobs.push({
            id: document.id,
            canonical: resolved.canonical,
            type: resolved.type,
            revision: readerContentRevision(
              document,
              notes.get(document.id),
              mapped.textFiles,
            ),
            ...exportIds,
            ...((notes.get(document.id)?.length ?? 0) > 0
              ? {
                  noteIds: (notes.get(document.id) ?? []).map(
                    (note) => note.id,
                  ),
                }
              : {}),
          });
        if (
          mapped.textFiles.length > 0 &&
          resolved.previousProperties !== undefined
        ) {
          const values = { ...mapped.entry.properties };
          for (const file of mapped.textFiles) {
            const previous =
              resolved.previousProperties[file.field] ??
              (file.field === "readwise_text" &&
              resolved.previousProperties["reader_managed"] !== true
                ? resolved.previousProperties["text"]
                : undefined);
            if (previous !== undefined) values[file.field] = previous;
          }
          if (resolved.previousProperties["reader_text_files"] !== undefined)
            values["reader_text_files"] =
              resolved.previousProperties["reader_text_files"];
          mapped.entry.properties = values;
        }
        entries.push({
          type: resolved.type,
          entry: mapped.entry,
          id: document.id,
        });
        pending.delete(document.id);
        for (const note of notes.get(document.id) ?? [])
          pending.delete(note.id);
      } catch (error) {
        if (
          error instanceof ReadwiseThrottleError ||
          error instanceof ReadwiseAuthorizationError
        )
          throw error;
        context.signal.throwIfAborted();
        pending.add(document.id);
        for (const note of notes.get(document.id) ?? []) pending.add(note.id);
        context.log.condition(
          `readwise:reader-import:${document.id}`,
          error instanceof Error
            ? error.message
            : "Reader metadata could not be imported",
        );
      }
    }
    if (pending.size > 1000)
      throw new Error(
        "Reader pending metadata queue is full; page progress is retained",
      );
    if (!(await content.enqueue(queueScope.state, jobs))) {
      context.log.condition(
        "readwise:reader-content-backlog",
        "Reader listing is paused until bounded content work has room",
      );
      return false;
    }
    if (setting !== "addresses")
      await admitPictures(pictureScope.state, jobs, context.log);
    for (const { type, entry } of entries) await scope.upsert(type, [entry]);
    saved.pending = [...pending];
    return true;
  };
  const reconcile = async (): Promise<void> => {
    if (saved.reconcile === undefined) return;
    const inventory = await held(context, config.account);
    const current = saved.reconcile;
    for (const key of [...current.remaining]) {
      const row = inventory.get(key);
      let scoped = true;
      if (!config.includeFeed && row !== undefined) {
        let ancestor: Item | undefined = row;
        const seen = new Set<string>();
        while (ancestor !== undefined) {
          if (seen.has(ancestor.id))
            throw new Error("Reader stored parent graph contains a cycle");
          seen.add(ancestor.id);
          if (ancestor.properties["reader_location"] === "feed") {
            scoped = false;
            break;
          }
          const parent: unknown = ancestor.properties["reader_parent_id"];
          ancestor =
            typeof parent === "string"
              ? inventory.get(
                  readerIdentity(config.account, "document", parent),
                )
              : undefined;
        }
      }
      if (row?.state === "active" && scoped) {
        try {
          const answer = await get(idFromKey(config.account, key));
          if (answer === undefined) current.confirmed.push(key);
        } catch (error) {
          contain(error, key);
          continue;
        }
        // A surviving feed item is out of scope, never a confirmed deletion.
      }
      current.remaining = current.remaining.filter(
        (candidate) => candidate !== key,
      );
      await checkpoint(scope, saved);
    }
    if (current.remaining.length > 0) return;
    const confirmed = [...new Set(current.confirmed)];
    if (confirmed.length > 20) {
      context.log.condition(
        "readwise:reader-delete-limit",
        `${String(confirmed.length)} missing Reader items exceed the safety limit; none are archived`,
      );
      delete saved.reconcile;
      delete saved.fullAt;
      await checkpoint(scope, saved);
      return;
    }
    for (const type of ["readwise.highlight", "readwise.source"]) {
      const keys = confirmed.filter((key) => inventory.get(key)?.type === type);
      if (keys.length > 0) await scope.archive(type, keys);
    }
    delete saved.reconcile;
    await checkpoint(scope, saved);
  };
  const list = async (): Promise<void> => {
    if (saved.retryUntil !== undefined) {
      delete saved.retryUntil;
      await checkpoint(scope, saved);
    }
    if (saved.fingerprint !== fingerprint) {
      saved = { ...saved, fingerprint };
      delete saved.walk;
      delete saved.fullAt;
      delete saved.reconcile;
      await checkpoint(scope, saved);
    }
    await content.drain(context, reader, queueScope.state);
    if (
      !(await identities.prepare(
        exportClient,
        maxPages,
        saved.walk === undefined &&
          saved.completed !== undefined &&
          (saved.fullAt === undefined ||
            now() - Date.parse(saved.fullAt) >= fullEvery),
      ))
    ) {
      context.log.condition(
        "readwise:reader-identities",
        "Reader waits for complete export identity reconciliation",
      );
      return;
    }
    await reconcile();
    for (const pending of [...saved.pending]) {
      let document: ReaderDocument | undefined;
      try {
        document = await get(pending);
      } catch (error) {
        contain(error, pending);
        continue;
      }
      if (document === undefined) {
        context.log.condition(
          `readwise:reader-retry:${pending}`,
          "Reader retry did not return a document; identity is retained",
        );
        continue;
      }
      if (!(await importDocuments([document]))) return;
      await checkpoint(scope, saved);
    }
    for (const { record, due } of scope.refusals.pending()) {
      if (!due) continue;
      const key = record.identity.link ?? record.identity.sourceId;
      let document: ReaderDocument | undefined;
      try {
        document = await get(idFromKey(config.account, key));
      } catch (error) {
        contain(error, key);
        continue;
      }
      if (document === undefined) {
        context.log.condition(
          `readwise:reader-retry:${key}`,
          "Reader retry did not return a document; identity is retained",
        );
        continue;
      }
      if (!(await importDocuments([document]))) return;
      await checkpoint(scope, saved);
    }
    await checkpoint(scope, saved);
    if (context.hints !== undefined) {
      const retain = (id: string): void => {
        if (saved.pending.includes(id)) return;
        if (saved.pending.length >= 1000)
          throw new Error(
            "Reader pending metadata queue is full; hints remain pending",
          );
        saved.pending.push(id);
      };
      const hinted = [...context.hints].flatMap(([type, keys]) =>
        ["readwise.source", "readwise.highlight"].includes(type)
          ? [...keys].map((key) => ({
              key,
              id: idFromKey(config.account, key),
            }))
          : [],
      );
      for (const { id } of hinted) retain(id);
      await checkpoint(scope, saved);
      for (const { key, id } of hinted) {
        let document: ReaderDocument | undefined;
        try {
          document = await get(id);
        } catch (error) {
          contain(error, key);
          continue;
        }
        if (document === undefined) {
          context.log.condition(
            `readwise:reader-retry:${key}`,
            "Reader retry did not return a document; identity is retained",
          );
          continue;
        }
        if (!(await importDocuments([document]))) return;
        await checkpoint(scope, saved);
      }
      await content.drain(context, reader, queueScope.state);
      return;
    }
    if (saved.walk === undefined) {
      const full =
        saved.completed === undefined ||
        saved.fullAt === undefined ||
        now() - Date.parse(saved.fullAt) >= fullEvery;
      const inventory = full
        ? await held(context, config.account)
        : new Map<string, Item>();
      saved.walk = {
        start: new Date(now()).toISOString(),
        lower: full
          ? null
          : new Date(Date.parse(saved.completed ?? "") - 300_000).toISOString(),
        cursor: null,
        seen: [],
        total: null,
        identities: [],
        full,
        missing: [...inventory.keys()],
      };
      await checkpoint(scope, saved);
    }
    let restarted = false;
    for (let at = 0; at < maxPages; at++) {
      context.signal.throwIfAborted();
      const walk: Walk | undefined = saved.walk;
      let page;
      try {
        page = parseReaderPage(
          await reader.page({
            ...(walk.lower ? { updatedAfter: walk.lower } : {}),
            ...(walk.cursor ? { cursor: walk.cursor } : {}),
          }),
        );
      } catch (error) {
        if (
          !(error instanceof InvalidCursor) ||
          walk.cursor === null ||
          restarted
        )
          throw error;
        saved.walk = {
          ...walk,
          cursor: null,
          seen: [],
          total: null,
          identities: [],
          missing: [...(await held(context, config.account)).keys()],
        };
        await checkpoint(scope, saved);
        restarted = true;
        at--;
        continue;
      }
      const incomplete = async (message: string): Promise<never> => {
        delete saved.walk;
        delete saved.fullAt;
        await checkpoint(scope, saved);
        throw new Error(message);
      };
      const total = walk.total ?? page.count;
      if (page.count !== total - walk.identities.length)
        await incomplete(
          "Reader remaining count does not match the listing progress",
        );
      const observedIds = new Set([
        ...walk.identities,
        ...page.results.map((row) => row.id),
      ]);
      if (
        observedIds.size !== walk.identities.length + page.results.length ||
        page.results.length > page.count ||
        (page.nextPageCursor === null &&
          (page.count !== page.results.length || observedIds.size !== total))
      )
        await incomplete(
          "Reader listing count does not match its unique documents",
        );
      if (page.results.length === 0 && page.nextPageCursor !== null)
        await incomplete("Reader returned an empty intermediate listing page");
      if (page.nextPageCursor !== null) {
        const digest = hash(page.nextPageCursor);
        if (walk.seen.includes(digest))
          throw new Error("Reader repeated a listing cursor");
        if (walk.seen.length >= 4096)
          throw new Error("Reader cursor history is full");
        walk.seen.push(digest);
      }
      if (!(await importDocuments(page.results))) return;
      walk.total = total;
      walk.identities = [...observedIds];
      const observed = new Set(
        page.results
          .filter((row) => row.category !== "note")
          .map((row) =>
            readerIdentity(
              config.account,
              row.category === "highlight" ? "highlight" : "document",
              row.id,
            ),
          ),
      );
      walk.missing = walk.missing.filter((key) => !observed.has(key));
      if (page.nextPageCursor === null) {
        saved.completed = walk.start;
        if (walk.full) {
          saved.fullAt = walk.start;
          saved.reconcile = { remaining: walk.missing, confirmed: [] };
        }
        delete saved.walk;
        await checkpoint(scope, saved);
        await reconcile();
        context.log.info(
          "Reader listing completed; content preservation continues independently",
        );
        await content.drain(context, reader, queueScope.state);
        return;
      }
      walk.cursor = page.nextPageCursor;
      await checkpoint(scope, saved);
      await content.drain(context, reader, queueScope.state);
    }
    context.log.condition(
      "readwise:reader-unfinished",
      "Reader listing has more pages; the next run resumes its saved cursor",
    );
  };
  try {
    await list();
    // Picture work has its own queue and limits, after the listing and
    // content work, and leaves a run that a hint started to that hint.
    if (setting !== "addresses" && context.hints === undefined)
      await drainPictures(context, reader, pictureScope.state, {
        setting,
        account: config.account,
        contentState: queueScope.state,
        now,
        ...options.pictures,
      });
    else if (setting === "addresses") await pausePictures(pictureScope.state);
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    const acknowledged = progress(
      scope.state.get("listing"),
      config.account,
      config.readerBase,
      fingerprint,
    );
    await checkpoint(scope, { ...acknowledged, retryUntil: error.until });
    context.log.unreached({ prefixes: ["readwise:"] });
    context.log.condition("readwise:reader-rate-limit", error.message);
  }
}
