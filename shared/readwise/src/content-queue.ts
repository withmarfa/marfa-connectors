import type {
  CheckpointState,
  Entry,
  Item,
  EnvDeclaration,
  RunContext,
  ScopedRunContext,
} from "@withmarfa/connector";
import {
  fetchPicture,
  type Picture,
  type PictureRefusal,
} from "@withmarfa/connector/pictures";
import {
  contentPlan,
  contentQueue,
  digest,
  download,
  maxPicturesPerDocument,
  saveContentQueue,
  StorageEmpty,
  StorageLimitExceeded,
  StorageUnavailable,
  type ContentJob,
  type Resource,
} from "./content.js";
import { parsePage, readerExportPassage, type Source } from "./export.js";
import { ReadwiseThrottleError, ReadwiseAuthorizationError } from "./http.js";
import { readerFileType } from "./content-types.js";
import {
  mapReaderHighlight,
  mapReaderSource,
  type ReaderDocument,
} from "./reader.js";
import type { ExportClient } from "./export-client.js";
import type { ReaderReader } from "./reader-client.js";
import { stageContent } from "./content-staging.js";

type Context = Pick<RunContext<EnvDeclaration>, "known" | "signal" | "log"> & {
  inspect(
    type: string,
    query: { links: readonly string[] },
  ): Promise<{
    items: readonly Item[];
    tombstones: readonly { key: string }[];
  }>;
  forScope(
    name: string,
  ): Pick<ScopedRunContext<EnvDeclaration>, "upsert" | "state">;
};
async function document(
  client: ReaderReader,
  id: string,
): Promise<ReaderDocument | undefined> {
  const page = await client.page({
    id,
    withHtmlContent: true,
    withRawSourceUrl: true,
  });
  if (
    page.nextPageCursor !== null ||
    page.count !== page.results.length ||
    ![0, 1].includes(page.count) ||
    page.results.some((row) => row.id !== id)
  )
    throw new Error("Reader content lookup was not a complete direct answer");
  return page.results[0];
}
function entry(
  job: ContentJob,
  id: string,
  kind: string,
  revision: string,
  properties: Record<string, unknown> = {},
): Entry {
  return {
    source_id: id,
    properties: {
      canonical_key: id,
      account: job.canonical.split(":")[0],
      document_key: job.canonical,
      resource_kind: kind,
      reader_revision: revision,
      title: `Reader ${kind}`,
      ...properties,
    },
    connections: { "attached-to": [{ type: job.type, id: job.canonical }] },
  };
}
export function isAccountedContent(
  manifest: Item | undefined,
  job: Pick<ContentJob, "canonical" | "revision">,
): boolean {
  return (
    manifest?.properties["canonical_key"] ===
      `${job.canonical}:content:manifest` &&
    manifest.properties["reader_revision"] === job.revision &&
    manifest.properties["preservation"] === "accounted" &&
    typeof manifest.properties["blob_ref"] === "string"
  );
}
async function commit(context: Context, file: Entry): Promise<void> {
  const scope = context.forScope(`reader-file:${digest(file.source_id)}`);
  await scope.upsert(readerFileType.id, [file]);
  const result = await scope.state.checkpoint("reader-content-last", {
    key: file.source_id,
    revision: file.file?.key,
  });
  if (!result.committed)
    throw new Error(
      `Reader content write was not acknowledged: ${result.reason}`,
    );
}
/** At most this many pictures are fetched in one run. */
export const maxPicturesPerRun = 100;
/** A picture that would take the bytes saved in one run past this is left
 *  for the next run. */
export const maxPictureBytesPerRun = 200 * 1024 * 1024;
/** No picture is fetched after the run has spent this long on them. A fetch
 *  that has begun may take up to 30 seconds more. */
export const maxPicturePassMs = 10 * 60 * 1000;
/** A picture whose fetch fails in a way that may pass is asked for this many
 *  times, a run at a time, before it is not kept. */
export const maxPictureAttempts = 3;

/** What the connector does with the pictures a document's HTML draws from
 *  other websites, as `READWISE_READER_PICTURES` names it. */
export type PicturesSetting = "addresses" | "save" | "save-in-library";

/** One run's share of picture fetches, kept across its drains. */
export class PictureBudget {
  fetched = 0;
  bytes = 0;
  saved = 0;
  left = 0;
  limit: string | undefined;
  /** Jobs left for the next run, which this run does not plan again. */
  readonly deferred = new Set<string>();
  private readonly started: number;
  constructor(
    private readonly now: () => number = Date.now,
    readonly limits = {
      pictures: maxPicturesPerRun,
      bytes: maxPictureBytesPerRun,
      ms: maxPicturePassMs,
    },
  ) {
    this.started = now();
  }
  /** The limit this run has reached, if any. */
  reached(): string | undefined {
    if (this.limit !== undefined) return this.limit;
    if (this.fetched >= this.limits.pictures)
      this.limit = `${String(this.limits.pictures)} pictures`;
    else if (this.now() - this.started >= this.limits.ms)
      this.limit = `${String(this.limits.ms / 60_000)} minutes`;
    return this.limit;
  }
}

export interface PictureWork {
  setting: Exclude<PicturesSetting, "addresses">;
  budget: PictureBudget;
  /** The picture fetch; for tests. */
  fetch?: typeof fetchPicture;
}

/**
 * Whether a refused picture may be fetched later: a failure of the transfer
 * or the upload, or an answer that asks a client to wait or try again (408,
 * 425, 429 and any 5xx). Any other status, such as a 404 or a 403, is the
 * host's answer about this picture.
 */
export function pictureMayPass(
  reason: PictureRefusal | "upload_failed",
  status?: number,
): boolean {
  if (["timed_out", "fetch_failed", "upload_failed"].includes(reason))
    return true;
  return (
    reason === "bad_status" &&
    status !== undefined &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  );
}

/** The revision a manifest is written at: a plan that fetches pictures is
 *  not the plan that does not, so turning the setting on plans again a
 *  document accounted for without them. */
export function plannedRevision(revision: string, fetching: boolean): string {
  return fetching ? digest(["pictures", revision].join("\n")) : revision;
}

interface Preservation {
  complete: boolean;
  progressed: boolean;
  /** Pictures were left for a later run by the run's limits alone. */
  deferred?: boolean;
  pictureOutcomes?: Record<string, number | string>;
}
async function preserve(
  context: Context,
  client: ReaderReader,
  job: ContentJob,
  options: {
    fetch?: typeof fetch;
    exportClient?: ExportClient;
    maxBytes?: number;
    pictures?: PictureWork;
  },
): Promise<Preservation> {
  const manifestKey = `${job.canonical}:content:manifest`;
  const existing = await context.inspect(readerFileType.id, {
    links: [manifestKey],
  });
  // An explicit purge is not undone by the next content walk.
  if (existing.tombstones.length) return { complete: true, progressed: false };
  const manifest = existing.items[0];
  if (options.pictures === undefined && isAccountedContent(manifest, job))
    return { complete: true, progressed: false };
  const target = await context.inspect(job.type, { links: [job.canonical] });
  if (target.tombstones.length || target.items[0]?.state === "trashed")
    return { complete: true, progressed: false };
  if (target.items.length !== 1)
    throw new Error("Reader content waits for its unambiguous parent item");
  const parent = target.items[0];
  if (!parent) throw new Error("Reader content parent was not found");
  const fetching =
    options.pictures !== undefined &&
    (options.pictures.setting === "save" || parent.tier === "library");
  const revision = plannedRevision(job.revision, fetching);
  if (isAccountedContent(manifest, { canonical: job.canonical, revision }))
    return { complete: true, progressed: false };
  const row = await document(client, job.id);
  if (!row)
    throw new Error(
      "Reader content lookup returned no document; retained content remains unchanged",
    );
  const mapper =
    row.category === "highlight" ? mapReaderHighlight : mapReaderSource;
  const notes: ReaderDocument[] = [];
  for (const id of job.noteIds ?? []) {
    const note = await client.document(id);
    if (note?.category !== "note" || note.parent_id !== row.id)
      throw new Error(
        "Reader annotation preservation lacks its original note identity",
      );
    notes.push(note);
  }
  const enrichment: Record<string, unknown> = { ...parent.properties };
  if (job.exportSourceId !== undefined || job.exportHighlightId !== undefined) {
    if (
      !options.exportClient ||
      job.exportSourceId === undefined ||
      job.exportHighlightId === undefined
    )
      throw new Error(
        "Reader export-text preservation needs its verified export source",
      );
    let cursor: string | undefined;
    const seen = new Set<string>();
    const sources: Source[] = [];
    let complete = false;
    for (let at = 0; at < 50; at++) {
      const page = parsePage(
        await options.exportClient.page({
          sourceId: job.exportSourceId,
          ...(cursor !== undefined && { cursor }),
        }),
      );
      sources.push(...page.results);
      if (page.nextPageCursor === null) {
        complete = true;
        break;
      }
      if (seen.has(page.nextPageCursor))
        throw new Error("Reader export-text lookup repeated a cursor");
      seen.add(page.nextPageCursor);
      cursor = page.nextPageCursor;
    }
    if (!complete)
      throw new Error(
        "Reader export-text lookup did not establish a complete matching passage",
      );
    const text = readerExportPassage(sources, {
      sourceId: job.exportSourceId,
      highlightId: job.exportHighlightId,
      readerId: row.id,
      parentId: row.parent_id,
    });
    if (text === undefined)
      throw new Error("Reader export overflow passage remains unavailable");
    enrichment["readwise_text"] = text;
  }
  const mapped = mapper(String(parent.properties["account"]), row, {
    notes,
    sourceId: parent.source_id ?? job.canonical,
    properties: enrichment,
  });
  // Every picture address is looked for, whatever the setting, so that a
  // manifest written by either connector lists a picture held as kept.
  const whole = contentPlan(job.canonical, row, mapped.textFiles, {
    pictures: true,
  });
  let refreshed: ReaderDocument | undefined;
  const kept = new Map<string, string>();
  const purged = new Set<string>();
  const states = new Map<string, string>();
  for (let offset = 0; offset < whole.files.length; offset += 100) {
    const keys = whole.files
      .slice(offset, offset + 100)
      .map((file) => file.sourceId);
    const evidence = await context.inspect(readerFileType.id, { links: keys });
    const agreed = await context.known(readerFileType.id, keys);
    for (const item of evidence.items) {
      const key = item.properties["canonical_key"];
      if (typeof key === "string") states.set(key, item.state);
      if (
        typeof key === "string" &&
        agreed.has(key) &&
        typeof item.properties["blob_ref"] === "string" &&
        typeof item.properties["content_key"] === "string"
      )
        kept.set(key, item.properties["content_key"]);
    }
    for (const item of evidence.tombstones)
      if (typeof item.key === "string") purged.add(item.key);
  }
  const pictureFiles = whole.files.filter((file) => file.kind === "picture");
  const plan =
    fetching ||
    pictureFiles.some(
      (file) => states.has(file.sourceId) || purged.has(file.sourceId),
    )
      ? whole
      : contentPlan(job.canonical, row, mapped.textFiles);
  let attempted = 0;
  let progressed = false;
  let failed = false;
  let exceededLimit: number | undefined;
  for (const file of plan.files) {
    if (file.kind === "picture") continue;
    const resource = plan.resources.find(
      (candidate) => candidate.id === file.id,
    );
    if (!resource) throw new Error("Reader content resource was not planned");
    if (purged.has(file.sourceId)) {
      resource.status = "unavailable";
      resource.reason = "file-purged-in-marfa";
      continue;
    }
    if (kept.get(file.sourceId) === file.key) {
      resource.status = "kept";
      continue;
    }
    if (attempted >= 16) continue;
    attempted++;
    const value = entry(
      job,
      file.sourceId,
      file.kind,
      row.updated_at ?? job.revision,
      { content_key: file.key },
    );
    let staged: Awaited<ReturnType<typeof stageContent>> | undefined;
    try {
      if (file.text !== undefined) {
        value.file = {
          key: file.key,
          load: () =>
            Promise.resolve({
              bytes: new TextEncoder().encode(file.text),
              mime_type:
                file.kind === "html"
                  ? "text/html; charset=utf-8"
                  : "text/plain; charset=utf-8",
            }),
        };
      } else {
        if (!file.url)
          throw new Error("Reader content has no transient download URL");
        let prepared: Awaited<ReturnType<typeof download>>;
        try {
          prepared = await download(file.url, context.signal, options);
        } catch (error) {
          if (
            !(error instanceof StorageUnavailable) ||
            ![401, 403, 404].includes(error.status)
          )
            throw error;
          refreshed ??= await document(client, job.id);
          if (!refreshed)
            throw new Error(
              "Reader cannot refresh an unavailable content link",
              { cause: error },
            );
          const renewed = contentPlan(job.canonical, refreshed).files.find(
            (candidate) => candidate.id === file.id,
          );
          if (!renewed?.url)
            throw new Error("Reader did not return a fresh content link", {
              cause: error,
            });
          prepared = await download(renewed.url, context.signal, options);
        }
        staged = await stageContent(prepared, context.signal);
        value.file = { key: file.key, load: staged.load };
      }
      await commit(context, value);
      resource.status = "kept";
      progressed = true;
    } catch (error) {
      if (
        error instanceof ReadwiseThrottleError ||
        error instanceof ReadwiseAuthorizationError
      )
        throw error;
      context.signal.throwIfAborted();
      if (error instanceof StorageEmpty) {
        resource.status = "unavailable";
        resource.reason = "provider-returned-empty-content";
        continue;
      }
      resource.status = "pending";
      failed = true;
      resource.reason =
        error instanceof StorageLimitExceeded
          ? "resource-exceeds-byte-limit"
          : "download-or-storage-not-acknowledged";
      if (error instanceof StorageLimitExceeded) {
        resource.maxBytes = error.maxBytes;
        exceededLimit = error.maxBytes;
      }
      context.log.condition(
        `readwise:content:${digest(job.canonical)}`,
        exceededLimit !== undefined
          ? `Reader content exceeds READWISE_CONTENT_MAX_BYTES (${String(exceededLimit)} bytes); the last acknowledged file is retained`
          : "Reader content remains pending; the last acknowledged file is retained",
      );
    } finally {
      await staged?.dispose();
    }
  }
  const pictures =
    plan === whole
      ? await keepPictures(context, job, row, plan, {
          kept,
          purged,
          states,
          parentTier: parent.tier ?? "feed",
          work: fetching ? options.pictures : undefined,
        })
      : { progressed: false, failed: false, deferred: false, outcomes: {} };
  progressed ||= pictures.progressed;
  failed ||= pictures.failed;
  if (
    mapped.textFiles.length &&
    plan.resources
      .filter((resource) => resource.kind === "text")
      .every((resource) => resource.status === "kept")
  ) {
    const scope = context.forScope(`reader-text:${digest(job.canonical)}`);
    await scope.upsert(job.type, [mapped.entry]);
    const result = await scope.state.checkpoint(
      "reader-content-metadata-last",
      { key: job.canonical, revision: row.updated_at ?? job.revision },
    );
    if (!result.committed)
      throw new Error(
        `Reader text references were not acknowledged: ${result.reason}`,
      );
  }
  const complete = plan.resources.every(
    (resource) => resource.status !== "pending",
  );
  const resources: Resource[] = plan.resources;
  const text = JSON.stringify({
    document: job.canonical,
    revision,
    resources,
  });
  const value = entry(job, manifestKey, "manifest", revision, {
    preservation: complete ? "accounted" : "pending",
  });
  value.file = {
    key: digest(text),
    load: () =>
      Promise.resolve({
        bytes: new TextEncoder().encode(text),
        mime_type: "application/json",
      }),
  };
  await commit(context, value);
  return {
    complete,
    progressed: progressed && !failed,
    ...(fetching && {
      deferred: pictures.deferred,
      pictureOutcomes: pictures.outcomes,
    }),
  };
}
const outcomeKey = (id: string): string =>
  id.slice("picture:".length, "picture:".length + 16);
/**
 * Settles each picture resource of a plan made with pictures: one held in
 * Marfa is kept and one removed there is not fetched again, whatever the
 * setting; with `work`, the rest are fetched within the document's and the
 * run's limits. One picture's failure leaves the others to go on.
 */
async function keepPictures(
  context: Context,
  job: ContentJob,
  row: ReaderDocument,
  plan: ReturnType<typeof contentPlan>,
  held: {
    kept: ReadonlyMap<string, string>;
    purged: ReadonlySet<string>;
    states: ReadonlyMap<string, string>;
    parentTier: "feed" | "library";
    work: PictureWork | undefined;
  },
): Promise<{
  progressed: boolean;
  failed: boolean;
  deferred: boolean;
  outcomes: Record<string, number | string>;
}> {
  const result = {
    progressed: false,
    failed: false,
    deferred: false,
    outcomes: {} as Record<string, number | string>,
  };
  const fetch = held.work?.fetch ?? fetchPicture;
  let position = 0;
  let over = 0;
  for (const file of plan.files) {
    if (file.kind !== "picture" || file.url === undefined) continue;
    const resource = plan.resources.find(
      (candidate) => candidate.id === file.id,
    );
    if (!resource) throw new Error("Reader content resource was not planned");
    position++;
    const state = held.states.get(file.sourceId);
    if (
      held.purged.has(file.sourceId) ||
      state === "trashed" ||
      state === "revoked"
    ) {
      resource.status = "deliberately-unkept";
      resource.reason = "removed";
      continue;
    }
    if (held.kept.get(file.sourceId) === file.key) {
      resource.status = "kept";
      continue;
    }
    const work = held.work;
    if (work === undefined) {
      resource.status = "deliberately-unkept";
      resource.reason = "third-party";
      continue;
    }
    if (position > maxPicturesPerDocument) {
      resource.status = "deliberately-unkept";
      resource.reason = "over-document-limit";
      over++;
      continue;
    }
    const key = outcomeKey(file.id);
    const prior = job.pictureOutcomes?.[key];
    if (typeof prior === "string") {
      const [reason, code] = prior.split(":");
      resource.status = "unavailable";
      resource.reason = reason ?? prior;
      if (code !== undefined) resource.httpStatus = Number(code);
      result.outcomes[key] = prior;
      continue;
    }
    const tried = prior;
    const leave = (): void => {
      resource.status = "pending";
      resource.reason = "run-limit";
      if (tried !== undefined) result.outcomes[key] = tried;
      result.deferred = true;
      work.budget.left++;
    };
    if (work.budget.reached() !== undefined) {
      leave();
      continue;
    }
    context.signal.throwIfAborted();
    work.budget.fetched++;
    let got: Picture;
    try {
      got = await fetch(file.url, {
        privateHosts: new Set(),
        signal: context.signal,
      });
    } catch {
      context.signal.throwIfAborted();
      got = { ok: false, reason: "fetch_failed" };
    }
    let failure: PictureRefusal | "upload_failed";
    let status: number | undefined;
    if (!got.ok) {
      failure = got.reason;
      status = got.status;
    } else if (
      work.budget.bytes + got.bytes.length >
      work.budget.limits.bytes
    ) {
      work.budget.limit = `${String(work.budget.limits.bytes / 1024 / 1024)} MiB`;
      leave();
      continue;
    } else {
      const value = entry(
        job,
        file.sourceId,
        "picture",
        row.updated_at ?? job.revision,
        { content_key: file.key, source_url: file.url },
      );
      value.tier = held.parentTier;
      const bytes = got.bytes;
      const type = got.mime_type;
      value.file = {
        key: file.key,
        load: () => Promise.resolve({ bytes, mime_type: type }),
      };
      try {
        await commit(context, value);
        work.budget.bytes += bytes.length;
        work.budget.saved++;
        resource.status = "kept";
        result.progressed = true;
        continue;
      } catch (error) {
        if (
          error instanceof ReadwiseThrottleError ||
          error instanceof ReadwiseAuthorizationError
        )
          throw error;
        context.signal.throwIfAborted();
        failure = "upload_failed";
      }
    }
    if (pictureMayPass(failure, status)) {
      const tries = (tried ?? 0) + 1;
      if (tries < maxPictureAttempts) {
        resource.status = "pending";
        resource.reason = failure;
        if (status !== undefined) resource.httpStatus = status;
        result.outcomes[key] = tries;
        result.failed = true;
        continue;
      }
    }
    resource.status = "unavailable";
    resource.reason = failure;
    if (status !== undefined) resource.httpStatus = status;
    result.outcomes[key] =
      status === undefined ? failure : `${failure}:${String(status)}`;
  }
  if (over > 0)
    context.log.info(
      `A Reader document has ${String(over)} pictures past the limit of ${String(maxPicturesPerDocument)}; they are listed in its manifest and not fetched`,
    );
  return result;
}
/** Queue acknowledgement is independent of metadata and of each resource's checkpoint. */
export async function drainContent(
  context: Context,
  client: ReaderReader,
  state: CheckpointState,
  options: {
    fetch?: typeof fetch;
    exportClient?: ExportClient;
    maxJobs?: number;
    now?: () => number;
    maxBytes?: number;
    pictures?: PictureWork;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  let queue = contentQueue(state);
  let attempted = 0;
  const reached: string[] = [];
  for (const job of [...queue]) {
    if (attempted >= (options.maxJobs ?? 8)) break;
    if (job.due !== undefined && job.due > now()) continue;
    const budget = options.pictures?.budget;
    if (budget?.deferred.has(job.id) && budget.reached() !== undefined)
      continue;
    context.signal.throwIfAborted();
    attempted++;
    reached.push(`readwise:content:${digest(job.canonical)}`);
    let result: Preservation = { complete: false, progressed: false };
    try {
      result = await preserve(context, client, job, options);
    } catch (error) {
      if (
        error instanceof ReadwiseThrottleError ||
        error instanceof ReadwiseAuthorizationError
      )
        throw error;
      context.signal.throwIfAborted();
      context.log.condition(
        `readwise:content:${digest(job.canonical)}`,
        "Reader preservation is incomplete; content work is retained for retry",
      );
    }
    queue = queue.filter((candidate) => candidate.id !== job.id);
    const carried: ContentJob = { ...job };
    if (result.pictureOutcomes !== undefined) {
      delete carried.pictureOutcomes;
      if (Object.keys(result.pictureOutcomes).length > 0)
        carried.pictureOutcomes = result.pictureOutcomes;
    }
    if (result.deferred) budget?.deferred.add(job.id);
    if (!result.complete && (result.progressed || result.deferred))
      queue.push(carried);
    else if (!result.complete) {
      const attempts = (job.attempts ?? 0) + 1;
      queue.push({
        ...carried,
        attempts,
        due:
          now() +
          Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts, 10)),
      });
    }
    await saveContentQueue(state, queue);
  }
  const budget = options.pictures?.budget;
  if (budget?.limit !== undefined && budget.left > 0) {
    reached.push("readwise:content:pictures-limit");
    context.log.condition(
      "readwise:content:pictures-limit",
      `This run reached its limit of ${budget.limit}, so ${String(budget.left)} Reader pictures are left for the next run`,
    );
  }
  if (queue.length)
    context.log.condition(
      "readwise:content-pending",
      `Reader metadata and preservation are separate: ${String(queue.length)} documents still have pending content work`,
    );
  context.log.unreached({
    prefixes: ["readwise:content:"],
    exceptKeys: reached,
  });
}
