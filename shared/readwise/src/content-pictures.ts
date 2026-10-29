import type {
  CheckpointState,
  EnvDeclaration,
  RunContext,
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
  type ContentJob,
  type Resource,
} from "./content.js";
import {
  commit,
  document,
  entry,
  fileEvidence,
  heldPictures,
  holds,
  isAccountedContent,
  listPictures,
  retryDelay,
  type Context,
  type PictureListing,
} from "./content-queue.js";
import { readerFileFields, readerFileType } from "./content-types.js";
import { ReadwiseAuthorizationError, ReadwiseThrottleError } from "./http.js";
import { mapReaderSource } from "./reader.js";
import type { ReaderReader } from "./reader-client.js";

/** What the connector does with the pictures a document's HTML draws from
 *  other websites, as `READWISE_READER_PICTURES` names it. */
export type PicturesSetting = "addresses" | "save" | "save-in-library";

/** At most this many pictures are fetched in one run. */
export const maxPicturesPerRun = 100;
/** A picture that would take the bytes saved in one run past this is left
 *  for the next run. */
export const maxPictureBytesPerRun = 200 * 1024 * 1024;
/** No picture is fetched once this long has passed since the run's first
 *  picture fetch. A fetch that has begun may take up to 30 seconds more. */
export const maxPicturePassMs = 10 * 60 * 1000;
/** A picture whose fetch fails in a way that may pass is asked for this many
 *  times, a run at a time, before it is not kept. */
export const maxPictureAttempts = 3;
/** At most this many documents wait for picture work. */
export const maxPictureJobs = 256;
/** At most this many documents are read from Reader for pictures in one
 *  run. */
export const maxPictureDocumentsPerRun = 25;
/** At most this many refused pictures are remembered; the oldest go first. */
export const maxPictureRefusals = 1024;
/** A saved picture that lacks its connection is written again in at most
 *  this many runs in a row, then left. */
export const maxPictureRepairs = 5;
const stateKey = "pictures";

/** One run's share of picture fetches. Its time starts at the first fetch,
 *  so a listing slowed by Reader's rate limit leaves pictures their time. */
export class PictureBudget {
  fetched = 0;
  bytes = 0;
  limit: string | undefined;
  private started: number | undefined;
  constructor(
    private readonly now: () => number = Date.now,
    readonly limits = {
      pictures: maxPicturesPerRun,
      bytes: maxPictureBytesPerRun,
      ms: maxPicturePassMs,
    },
  ) {}
  /** The limit this run has reached, if any. */
  reached(): string | undefined {
    if (this.limit !== undefined) return this.limit;
    if (this.fetched >= this.limits.pictures)
      this.limit = `${String(this.limits.pictures)} pictures`;
    else if (
      this.started !== undefined &&
      this.now() - this.started >= this.limits.ms
    )
      this.limit = `${String(this.limits.ms / 60_000)} minutes`;
    return this.limit;
  }
  /** Counts a fetch about to begin. */
  take(): void {
    this.started ??= this.now();
    this.fetched++;
  }
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

interface PictureJob {
  id: string;
  canonical: string;
  type: string;
  /** Runs a fetch that may pass has failed in, by picture key. */
  attempts?: Record<string, number>;
  /** Pictures were saved or repaired in an earlier run, and are listed as
   *  kept only once Marfa shows them attached. */
  saved?: true;
  /** Runs in a row that failed, waited or repaired a connection. */
  failures?: number;
  /** Not tried again before this time, in milliseconds. */
  due?: number;
}
interface PictureState {
  setting: PicturesSetting;
  queue: PictureJob[];
  /** Pictures given up on, by picture key, such as `svg` or
   *  `bad_status:404`. Kept across documents, runs and manifest rewrites. */
  refused: Record<string, string>;
  /** While documents kept before the setting was turned on are handed to
   *  the queue: the last canonical key handed over. */
  backfill?: string;
}
const pictureKeyOf = (address: string): string => digest(address).slice(0, 24);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const emptyState = (): PictureState => ({
  setting: "addresses",
  queue: [],
  refused: {},
});

class InvalidPictureState extends Error {
  constructor() {
    super("Reader picture progress is invalid");
  }
}
function pictureState(state: Pick<CheckpointState, "get">): PictureState {
  const value = state.get(stateKey);
  if (value === undefined) return emptyState();
  const invalid = () => new InvalidPictureState();
  if (!isRecord(value)) throw invalid();
  const { setting, queue, refused, backfill } = value;
  if (
    !["addresses", "save", "save-in-library"].includes(setting as string) ||
    !Array.isArray(queue) ||
    queue.length > maxPictureJobs ||
    !isRecord(refused) ||
    (backfill !== undefined && typeof backfill !== "string") ||
    Object.values(refused).some((one) => typeof one !== "string") ||
    queue.some(
      (job: unknown) =>
        !isRecord(job) ||
        ["id", "canonical", "type"].some(
          (field) => typeof job[field] !== "string",
        ) ||
        ["failures", "due"].some(
          (field) =>
            job[field] !== undefined && !Number.isSafeInteger(job[field]),
        ) ||
        (job["saved"] !== undefined && job["saved"] !== true) ||
        (job["attempts"] !== undefined &&
          (!isRecord(job["attempts"]) ||
            Object.values(job["attempts"]).some(
              (one) => !Number.isSafeInteger(one),
            ))),
    )
  )
    throw invalid();
  return value as unknown as PictureState;
}
/** The saved picture state, or, when it cannot be read, an empty queue
 *  saved in its place, so that picture work starts again. */
async function loadPictureState(
  state: CheckpointState,
  log: Pick<RunContext<EnvDeclaration>["log"], "condition">,
): Promise<PictureState> {
  try {
    return pictureState(state);
  } catch (error) {
    if (!(error instanceof InvalidPictureState)) throw error;
    log.condition(
      "readwise:reader-pictures-invalid",
      "Reader picture progress could not be read; picture work starts again from an empty queue",
    );
    const fresh = emptyState();
    await savePictureState(state, fresh);
    return fresh;
  }
}
async function savePictureState(
  state: Pick<CheckpointState, "checkpoint">,
  value: PictureState,
): Promise<void> {
  value.refused = Object.fromEntries(
    Object.entries(value.refused).slice(-maxPictureRefusals),
  );
  const result = await state.checkpoint(stateKey, value);
  if (!result.committed)
    throw new Error(`Reader picture progress was not saved: ${result.reason}`);
}

/** How Reader's content preservation lists pictures under the setting. */
export function pictureListing(
  state: Pick<CheckpointState, "get">,
  setting: Exclude<PicturesSetting, "addresses">,
): PictureListing {
  return {
    setting,
    refused: (address) => {
      try {
        return pictureState(state).refused[pictureKeyOf(address)];
      } catch (error) {
        if (error instanceof InvalidPictureState) return undefined;
        throw error;
      }
    },
  };
}

/**
 * Hands documents whose content changed to picture work. When the queue is
 * full, the documents kept in Marfa are gone over again from the start, so
 * none is missed.
 */
export async function admitPictures(
  state: CheckpointState,
  jobs: readonly ContentJob[],
  log: Pick<RunContext<EnvDeclaration>["log"], "condition">,
): Promise<void> {
  const saved = await loadPictureState(state, log);
  let changed = false;
  for (const job of jobs) {
    if (job.type !== "readwise.source") continue;
    if (saved.queue.some((one) => one.id === job.id)) continue;
    if (saved.queue.length >= maxPictureJobs) {
      saved.backfill = "";
      log.condition(
        "readwise:reader-pictures-backlog",
        "Reader picture work is full; documents kept in Marfa are gone over again for their pictures",
      );
      changed = true;
      break;
    }
    saved.queue.push({ id: job.id, canonical: job.canonical, type: job.type });
    changed = true;
  }
  if (changed) await savePictureState(state, saved);
}

/**
 * Records that the setting is off, so that turning it on again goes over
 * the documents kept meanwhile. Writes nothing where picture work never
 * ran, and clears progress that cannot be read.
 */
export async function pausePictures(state: CheckpointState): Promise<void> {
  if (state.get(stateKey) === undefined) return;
  let saved: PictureState;
  try {
    saved = pictureState(state);
  } catch (error) {
    if (!(error instanceof InvalidPictureState)) throw error;
    await savePictureState(state, emptyState());
    return;
  }
  if (saved.setting === "addresses") return;
  await savePictureState(state, { ...emptyState(), refused: saved.refused });
}

type PictureContext = Pick<
  Context,
  "inspect" | "known" | "linked" | "signal" | "log" | "forScope"
> &
  Pick<RunContext<EnvDeclaration>, "held">;

/**
 * One run of Reader's picture work, outside the content queue: hands
 * documents kept before the setting to the queue, then for each document
 * whose content is accounted for, saves its pictures within the run's
 * limits, repairs a saved picture that lacks its connection, and once every
 * picture is settled and attached, writes the manifest again at the
 * revision it is at.
 */
export async function drainPictures(
  context: PictureContext,
  client: ReaderReader,
  state: CheckpointState,
  options: {
    setting: Exclude<PicturesSetting, "addresses">;
    account: string;
    /** The content queue, whose documents wait for their content first. */
    contentState: Pick<CheckpointState, "get">;
    now?: () => number;
    fetch?: typeof fetchPicture;
    budget?: PictureBudget;
  },
): Promise<void> {
  const now = options.now ?? Date.now;
  const budget = options.budget ?? new PictureBudget(now);
  const saved = await loadPictureState(state, context.log);
  if (saved.setting !== options.setting) {
    saved.setting = options.setting;
    saved.backfill = "";
    await savePictureState(state, saved);
  }
  if (saved.backfill !== undefined && saved.queue.length < maxPictureJobs / 2) {
    const prefix = `${options.account}:reader-document:`;
    const after = saved.backfill;
    const kept = (await context.held("readwise.source", { state: "active" }))
      .map((row) => ({ row, key: row.properties["canonical_key"] }))
      .filter(
        (one): one is { row: typeof one.row; key: string } =>
          typeof one.key === "string" &&
          one.key.startsWith(prefix) &&
          one.key > after,
      )
      .sort((x, y) => (x.key < y.key ? -1 : 1));
    const room = maxPictureJobs / 2 - saved.queue.length;
    for (const { key } of kept.slice(0, room))
      if (!saved.queue.some((one) => one.canonical === key))
        saved.queue.push({
          id: key.slice(prefix.length),
          canonical: key,
          type: "readwise.source",
        });
    if (kept.length > room) saved.backfill = kept[room - 1]?.key ?? after;
    else delete saved.backfill;
    await savePictureState(state, saved);
  }
  const waiting = new Set(contentQueue(options.contentState).map((j) => j.id));
  let read = 0;
  let left = 0;
  for (const job of [...saved.queue]) {
    if (budget.reached() !== undefined) break;
    if (read >= maxPictureDocumentsPerRun) break;
    if (waiting.has(job.id)) continue;
    if (job.due !== undefined && job.due > now()) continue;
    context.signal.throwIfAborted();
    let next: PictureJob | undefined;
    try {
      const outcome = await picturesOf(context, client, job, saved, budget, {
        setting: options.setting,
        account: options.account,
        fetch: options.fetch ?? fetchPicture,
        now,
      });
      if (outcome.read) read++;
      left += outcome.left;
      next = outcome.job;
    } catch (error) {
      if (
        error instanceof ReadwiseThrottleError ||
        error instanceof ReadwiseAuthorizationError
      )
        throw error;
      context.signal.throwIfAborted();
      read++;
      context.log.condition(
        `readwise:pictures:${digest(job.canonical)}`,
        "Reader picture work for a document failed; it is tried again in a later run",
      );
      next = backedOff(job, now);
    }
    saved.queue = saved.queue.filter((one) => one.id !== job.id);
    if (next !== undefined) saved.queue.push(next);
    await savePictureState(state, saved);
  }
  if (budget.limit !== undefined)
    context.log.condition(
      "readwise:reader-pictures-limit",
      `This run reached its limit of ${budget.limit}; ${String(left || saved.queue.length)} Reader pictures or documents are left for the next run`,
    );
}

/** The job, tried again later, as the content queue does. */
function backedOff(job: PictureJob, now: () => number): PictureJob {
  const failures = (job.failures ?? 0) + 1;
  return { ...job, failures, due: now() + retryDelay(failures) };
}

async function picturesOf(
  context: PictureContext,
  client: ReaderReader,
  job: PictureJob,
  saved: PictureState,
  budget: PictureBudget,
  options: {
    setting: Exclude<PicturesSetting, "addresses">;
    account: string;
    fetch: typeof fetchPicture;
    now: () => number;
  },
): Promise<{ job: PictureJob | undefined; read: boolean; left: number }> {
  const manifestKey = `${job.canonical}:content:manifest`;
  const existing = await context.inspect(readerFileType.id, {
    links: [manifestKey],
  });
  if (existing.tombstones.length)
    return { job: undefined, read: false, left: 0 };
  const manifest = existing.items[0];
  const revision = manifest?.properties["reader_revision"];
  // Content is preserved first, by either connector.
  if (
    typeof revision !== "string" ||
    !isAccountedContent(manifest, { canonical: job.canonical, revision })
  )
    return { job: backedOff(job, options.now), read: false, left: 0 };
  const target = await context.inspect(job.type, { links: [job.canonical] });
  const parent = target.items[0];
  if (target.tombstones.length || parent?.state === "trashed")
    return { job: undefined, read: false, left: 0 };
  if (target.items.length !== 1 || parent === undefined)
    return { job: backedOff(job, options.now), read: false, left: 0 };
  if (options.setting === "save-in-library" && parent.tier !== "library")
    return { job: undefined, read: false, left: 0 };
  const row = await document(client, job.id);
  if (row === undefined || ["highlight", "note"].includes(row.category))
    return { job: undefined, read: true, left: 0 };
  const mapped = mapReaderSource(String(parent.properties["account"]), row, {
    notes: [],
    sourceId: parent.source_id ?? job.canonical,
    properties: { ...parent.properties },
  });
  const plan = contentPlan(job.canonical, row, mapped.textFiles, {
    pictures: true,
  });
  const evidence = await fileEvidence(context, plan.files, {
    agreements: false,
  });
  // The manifest is written again only while every other file it lists is
  // as Marfa holds it now.
  let faithful = true;
  for (const file of plan.files) {
    if (file.kind === "picture") continue;
    const resource = plan.resources.find((one) => one.id === file.id);
    if (resource === undefined) continue;
    if (evidence.purged.has(file.sourceId)) {
      resource.status = "unavailable";
      resource.reason = "file-purged-in-marfa";
      delete resource.fileKey;
    } else if (holds(evidence.rows.get(file.sourceId), file))
      resource.status = "kept";
    else faithful = false;
  }
  const held = await heldPictures(context, job, plan, evidence);
  const refused = (address: string) => saved.refused[pictureKeyOf(address)];
  const open = listPictures(plan, held, { fetching: true, refused });
  let next: PictureJob = {
    id: job.id,
    canonical: job.canonical,
    type: job.type,
  };
  const attempts: Record<string, number> = {};
  let left = 0;
  const repairing =
    held.unattached.size > 0 && (job.failures ?? 0) < maxPictureRepairs;
  if (held.unattached.size > 0 && !repairing)
    context.log.condition(
      `readwise:pictures-repair:${digest(job.canonical)}`,
      `A saved Reader picture still lacks its connection to its document after ${String(maxPictureRepairs)} repairs; it is listed as not kept`,
    );
  if (repairing)
    next = backedOff({ ...next, failures: job.failures ?? 0 }, options.now);
  for (const [key, row] of repairing ? held.unattached : []) {
    // The row as it is, written again with its connection.
    const repair = entry(job, key, "picture", revision);
    repair.properties = Object.fromEntries(
      readerFileFields
        .filter((field) => row.properties[field] !== undefined)
        .map((field) => [field, row.properties[field]]),
    );
    repair.tier = row.tier ?? "feed";
    await commit(context, repair);
    next.saved = true;
  }
  for (const file of open) {
    const address = file.url ?? "";
    const key = pictureKeyOf(address);
    const resource = plan.resources.find((one) => one.id === file.id);
    if (!resource) throw new Error("Reader picture resource was not planned");
    const tried = job.attempts?.[key];
    if (budget.reached() !== undefined) {
      if (tried !== undefined) attempts[key] = tried;
      left++;
      continue;
    }
    context.signal.throwIfAborted();
    budget.take();
    let got: Picture;
    try {
      got = await options.fetch(address, {
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
    } else if (budget.bytes + got.bytes.length > budget.limits.bytes) {
      budget.limit = `${String(budget.limits.bytes / 1024 / 1024)} MiB`;
      if (tried !== undefined) attempts[key] = tried;
      left++;
      continue;
    } else {
      const value = entry(job, file.sourceId, "picture", revision, {
        content_key: file.key,
        source_url: address,
      });
      value.tier = parent.tier ?? "feed";
      const { bytes, mime_type } = got;
      value.file = {
        key: file.key,
        load: () => Promise.resolve({ bytes, mime_type }),
      };
      try {
        await commit(context, value);
        budget.bytes += bytes.length;
        next.saved = true;
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
    const tries = (tried ?? 0) + 1;
    if (pictureMayPass(failure, status) && tries < maxPictureAttempts) {
      attempts[key] = tries;
      left++;
      continue;
    }
    saved.refused[key] =
      status === undefined ? failure : `${failure}:${String(status)}`;
    resource.status = "unavailable";
    resource.reason = failure;
    if (status !== undefined) resource.httpStatus = status;
  }
  if (Object.keys(attempts).length > 0) next.attempts = attempts;
  if (left > 0 || next.saved) return { job: next, read: true, left };
  if (faithful) await rewrite(context, job, revision, plan.resources);
  return { job: undefined, read: true, left: 0 };
}

/** Writes the manifest again at its revision, only while it is still the
 *  accounted manifest of that revision and only when its bytes change. */
async function rewrite(
  context: PictureContext,
  job: PictureJob,
  revision: string,
  resources: Resource[],
): Promise<void> {
  const manifestKey = `${job.canonical}:content:manifest`;
  const text = JSON.stringify({ document: job.canonical, revision, resources });
  const current = (
    await context.inspect(readerFileType.id, { links: [manifestKey] })
  ).items[0];
  if (!isAccountedContent(current, { canonical: job.canonical, revision }))
    return;
  if (current?.properties["blob_ref"] === `sha256:${digest(text)}`) return;
  const value = entry(job, manifestKey, "manifest", revision, {
    preservation: "accounted",
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
}
