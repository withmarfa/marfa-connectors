import type {
  CheckpointState,
  Entry,
  Item,
  EnvDeclaration,
  RunContext,
  ScopedRunContext,
} from "@withmarfa/connector";
import {
  contentPlan,
  contentQueue,
  maxPicturesPerDocument,
  digest,
  download,
  saveContentQueue,
  StorageEmpty,
  StorageLimitExceeded,
  StorageUnavailable,
  type ContentFile,
  type ContentJob,
  type ContentPlan,
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

export type Context = Pick<
  RunContext<EnvDeclaration>,
  "known" | "signal" | "log"
> & {
  /** Without it, no picture is proven attached to its document, so none is
   *  listed as kept. */
  linked?: RunContext<EnvDeclaration>["linked"];
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
/** How long work that failed `attempts` runs in a row waits before it is
 *  tried again: doubling from two minutes, at most a day. */
export const retryDelay = (attempts: number): number =>
  Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts, 10));

export async function document(
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
export function entry(
  job: Pick<ContentJob, "canonical" | "type">,
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
export async function commit(
  context: Pick<Context, "forScope">,
  file: Entry,
): Promise<void> {
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
/** What Marfa holds of a plan's files, whoever wrote them. */
export interface FileEvidence {
  /** Rows by canonical key. */
  rows: Map<string, Item>;
  /** Canonical keys this connector holds an agreement for. */
  agreed: Set<string>;
  purged: Set<string>;
}
export async function fileEvidence(
  context: Pick<Context, "inspect" | "known">,
  files: readonly ContentFile[],
  options: { agreements: boolean } = { agreements: true },
): Promise<FileEvidence> {
  const found: FileEvidence = {
    rows: new Map(),
    agreed: new Set(),
    purged: new Set(),
  };
  for (let offset = 0; offset < files.length; offset += 100) {
    const keys = files.slice(offset, offset + 100).map((file) => file.sourceId);
    const evidence = await context.inspect(readerFileType.id, { links: keys });
    if (options.agreements)
      for (const key of await context.known(readerFileType.id, keys))
        found.agreed.add(key);
    for (const item of evidence.items) {
      const key = item.properties["canonical_key"];
      if (typeof key === "string") found.rows.set(key, item);
    }
    for (const item of evidence.tombstones)
      if (typeof item.key === "string") found.purged.add(item.key);
  }
  return found;
}
/** Whether a file row holds the bytes of the planned file. */
export function holds(row: Item | undefined, file: ContentFile): boolean {
  return (
    typeof row?.properties["blob_ref"] === "string" &&
    row.properties["content_key"] === file.key
  );
}

/** What Marfa holds of a document's pictures. */
export interface HeldPictures {
  /** Active, with their bytes and address, and attached to the document. */
  kept: Set<string>;
  /** Active, with their bytes and address, and not attached to the
   *  document, as a run that stopped before its connections were written
   *  leaves one. */
  unattached: Map<string, Item>;
  /** Purged, trashed, revoked or archived in Marfa. */
  removed: Set<string>;
}
export async function heldPictures(
  context: Pick<Context, "linked">,
  job: Pick<ContentJob, "canonical" | "type">,
  plan: ContentPlan,
  evidence: FileEvidence,
): Promise<HeldPictures> {
  const held: HeldPictures = {
    kept: new Set(),
    unattached: new Map(),
    removed: new Set(),
  };
  const candidates = new Map<string, Item>();
  for (const file of plan.files) {
    if (file.kind !== "picture") continue;
    const row = evidence.rows.get(file.sourceId);
    if (
      evidence.purged.has(file.sourceId) ||
      (row !== undefined && row.state !== "active")
    )
      held.removed.add(file.sourceId);
    else if (
      row?.properties["resource_kind"] === "picture" &&
      row.properties["source_url"] === file.url &&
      typeof row.properties["blob_ref"] === "string"
    )
      candidates.set(file.sourceId, row);
  }
  if (candidates.size === 0) return held;
  const attached = new Set(
    context.linked === undefined
      ? []
      : (
          await context.linked(
            readerFileType.id,
            "attached-to",
            { type: job.type, id: job.canonical },
            { rows: "all" },
          )
        ).map((row) => row.id),
  );
  for (const [key, row] of candidates)
    if (attached.has(row.id)) held.kept.add(key);
    else held.unattached.set(key, row);
  return held;
}

/** How a connector that saves pictures lists those of a document. */
export interface PictureListing {
  setting: "save" | "save-in-library";
  /** The reason a picture was given up on, such as `svg` or
   *  `bad_status:404`. */
  refused: (address: string) => string | undefined;
}
/**
 * Sets the status of each picture resource from what Marfa holds: kept when
 * held and attached, not kept when removed in Marfa or refused, and
 * otherwise not kept as a third party's. With `fetching`, a picture past the
 * limit for one document is listed as over it. Answers the pictures that
 * are still to fetch, in order.
 */
export function listPictures(
  plan: ContentPlan,
  held: HeldPictures,
  options: { fetching: boolean; refused?: PictureListing["refused"] },
): ContentFile[] {
  const open: ContentFile[] = [];
  let position = 0;
  for (const file of plan.files) {
    if (file.kind !== "picture" || file.url === undefined) continue;
    const resource = plan.resources.find((one) => one.id === file.id);
    if (!resource) throw new Error("Reader content resource was not planned");
    position++;
    delete resource.fileKey;
    if (held.removed.has(file.sourceId)) {
      resource.status = "deliberately-unkept";
      resource.reason = "removed";
      continue;
    }
    if (held.kept.has(file.sourceId)) {
      resource.status = "kept";
      resource.fileKey = file.sourceId;
      continue;
    }
    const refused = options.refused?.(file.url);
    if (refused !== undefined) {
      const [reason, code] = refused.split(":");
      resource.status = "unavailable";
      resource.reason = reason ?? refused;
      if (code !== undefined) resource.httpStatus = Number(code);
      continue;
    }
    resource.status = "deliberately-unkept";
    if (options.fetching && position > maxPicturesPerDocument) {
      resource.reason = "over-document-limit";
      continue;
    }
    resource.reason = "third-party";
    if (!held.unattached.has(file.sourceId)) open.push(file);
  }
  return open;
}

interface Preservation {
  complete: boolean;
  progressed: boolean;
}
async function preserve(
  context: Context,
  client: ReaderReader,
  job: ContentJob,
  options: {
    fetch?: typeof fetch;
    exportClient?: ExportClient;
    maxBytes?: number;
    pictures?: PictureListing;
  },
): Promise<Preservation> {
  const manifestKey = `${job.canonical}:content:manifest`;
  const existing = await context.inspect(readerFileType.id, {
    links: [manifestKey],
  });
  // An explicit purge is not undone by the next content walk.
  if (existing.tombstones.length) return { complete: true, progressed: false };
  const manifest = existing.items[0];
  if (isAccountedContent(manifest, job))
    return { complete: true, progressed: false };
  const target = await context.inspect(job.type, { links: [job.canonical] });
  if (target.tombstones.length || target.items[0]?.state === "trashed")
    return { complete: true, progressed: false };
  if (target.items.length !== 1)
    throw new Error("Reader content waits for its unambiguous parent item");
  const parent = target.items[0];
  if (!parent) throw new Error("Reader content parent was not found");
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
  // Each picture address is looked for whatever the setting, so that a
  // manifest either connector writes lists a picture Marfa holds as kept.
  const whole = contentPlan(job.canonical, row, mapped.textFiles, {
    pictures: true,
  });
  const evidence = await fileEvidence(context, whole.files);
  const fetching =
    options.pictures !== undefined &&
    (options.pictures.setting === "save" || parent.tier === "library");
  // With nothing held and nothing to fetch, the plan is the one made
  // without pictures, so the manifest is as it was before pictures.
  const plan =
    fetching ||
    whole.files.some(
      (file) =>
        file.kind === "picture" &&
        (evidence.rows.has(file.sourceId) ||
          evidence.purged.has(file.sourceId)),
    )
      ? whole
      : contentPlan(job.canonical, row, mapped.textFiles);
  if (plan === whole)
    listPictures(plan, await heldPictures(context, job, plan, evidence), {
      fetching,
      ...(fetching &&
        options.pictures && { refused: options.pictures.refused }),
    });
  let refreshed: ReaderDocument | undefined;
  const kept = new Map<string, string>();
  const purged = evidence.purged;
  for (const [key, item] of evidence.rows)
    if (
      evidence.agreed.has(key) &&
      typeof item.properties["blob_ref"] === "string" &&
      typeof item.properties["content_key"] === "string"
    )
      kept.set(key, item.properties["content_key"]);
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
    revision: job.revision,
    resources,
  });
  const value = entry(job, manifestKey, "manifest", job.revision, {
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
  return { complete, progressed: progressed && !failed };
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
    pictures?: PictureListing;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  let queue = contentQueue(state);
  let attempted = 0;
  const reached: string[] = [];
  for (const job of [...queue]) {
    if (attempted >= (options.maxJobs ?? 8)) break;
    if (job.due !== undefined && job.due > now()) continue;
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
    if (!result.complete && result.progressed) queue.push(job);
    else if (!result.complete) {
      const attempts = (job.attempts ?? 0) + 1;
      queue.push({
        ...job,
        attempts,
        due: now() + retryDelay(attempts),
      });
    }
    await saveContentQueue(state, queue);
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
