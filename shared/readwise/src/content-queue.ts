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
  digest,
  download,
  saveContentQueue,
  StorageEmpty,
  StorageUnavailable,
  type ContentJob,
  type Resource,
} from "./content.js";
import { ReadwiseThrottleError, ReadwiseAuthorizationError } from "./http.js";
import { readerFileType } from "./content-types.js";
import {
  mapReaderHighlight,
  mapReaderSource,
  type ReaderDocument,
} from "./reader.js";
import type { ExportClient } from "./export-client.js";
import type { ReaderReader } from "./reader-client.js";

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
interface Preservation {
  complete: boolean;
  progressed: boolean;
}
async function preserve(
  context: Context,
  client: ReaderReader,
  job: ContentJob,
  options: { fetch?: typeof fetch; exportClient?: ExportClient },
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
    let text: string | undefined;
    let complete = false;
    for (let at = 0; at < 50; at++) {
      const page = await options.exportClient.page({
        sourceId: job.exportSourceId,
        ...(cursor !== undefined && { cursor }),
      });
      for (const source of page.results) {
        if (
          source.user_book_id !== job.exportSourceId ||
          source.external_id !== row.parent_id
        )
          throw new Error("Reader export-text source identity changed");
        for (const highlight of source.highlights)
          if (
            highlight.id === job.exportHighlightId &&
            highlight.external_id === row.id &&
            !highlight.is_deleted &&
            !source.is_deleted
          ) {
            if (text !== undefined && text !== highlight.text)
              throw new Error("Reader export-text lookup is ambiguous");
            text = highlight.text;
          }
      }
      if (page.nextPageCursor === null) {
        complete = true;
        break;
      }
      if (seen.has(page.nextPageCursor))
        throw new Error("Reader export-text lookup repeated a cursor");
      seen.add(page.nextPageCursor);
      cursor = page.nextPageCursor;
    }
    if (!complete || text === undefined)
      throw new Error(
        "Reader export-text lookup did not establish a complete matching passage",
      );
    enrichment["readwise_text"] = text;
  }
  const mapped = mapper(String(parent.properties["account"]), row, {
    notes,
    sourceId: parent.source_id ?? job.canonical,
    properties: enrichment,
  });
  const plan = contentPlan(job.canonical, row, mapped.textFiles);
  let refreshed: ReaderDocument | undefined;
  const kept = new Map<string, string>();
  const purged = new Set<string>();
  for (let offset = 0; offset < plan.files.length; offset += 100) {
    const keys = plan.files
      .slice(offset, offset + 100)
      .map((file) => file.sourceId);
    const evidence = await context.inspect(readerFileType.id, { links: keys });
    const agreed = await context.known(readerFileType.id, keys);
    for (const item of evidence.items) {
      const key = item.properties["canonical_key"];
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
  let attempted = 0;
  let progressed = false;
  let failed = false;
  for (const file of plan.files) {
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
        // Vendor reads may checkpoint a wait; finish them before the row write owns the scope.
        const retained = {
          bytes: new Uint8Array(
            await new Response(prepared.bytes).arrayBuffer(),
          ),
          mime_type: prepared.mime_type,
        };
        value.file = { key: file.key, load: () => Promise.resolve(retained) };
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
      resource.reason = "download-or-storage-not-acknowledged";
      context.log.condition(
        `readwise:content:${digest(job.canonical)}`,
        "Reader content remains pending; the last acknowledged file is retained",
      );
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
        due:
          now() +
          Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts, 10)),
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
