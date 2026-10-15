import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { CheckpointState, FileSource } from "@withmarfa/connector";
import type { ReaderDocument, TextFilePlan } from "./reader.js";

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const storageHosts = new Set(["readwise-assets.s3.amazonaws.com"]);
export function contentMaxBytes(value?: string | number): number {
  const bytes =
    value === undefined
      ? 256 * 1024 * 1024
      : typeof value === "string"
        ? /^\d+$/.test(value)
          ? Number(value)
          : NaN
        : value;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 1024 * 1024 * 1024)
    throw new Error(
      "READWISE_CONTENT_MAX_BYTES must be a decimal integer from 1 to 1073741824 bytes",
    );
  return bytes;
}
export function storageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Content is not on verified Readwise storage");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !storageHosts.has(url.hostname)
  )
    throw new Error("Content is not on verified Readwise storage");
  return url;
}
export class StorageUnavailable extends Error {
  constructor(readonly status: number) {
    super(`Readwise storage returned HTTP ${String(status)}`);
  }
}
export class StorageEmpty extends Error {
  constructor() {
    super("Readwise storage returned empty content");
  }
}
export class StorageLimitExceeded extends Error {
  constructor(readonly maxBytes: number) {
    super(
      `Readwise content exceeds the ${String(maxBytes)}-byte resource limit`,
    );
  }
}
function mime(bytes: Uint8Array, declared: string | null): string {
  const start = Buffer.from(bytes).subarray(0, 256);
  if (start.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (
    start.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (start[0] === 255 && start[1] === 216 && start[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(start.toString())) return "image/gif";
  if (
    start.subarray(0, 4).toString() === "RIFF" &&
    start.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (
    start.subarray(0, 2).toString() === "PK" &&
    start.includes(Buffer.from("application/epub+zip"))
  )
    return "application/epub+zip";
  if (/^\s*(?:<!doctype html|<html)/i.test(start.toString()))
    return "text/html";
  const type = declared?.split(";")[0]?.trim().toLowerCase();
  return type && /^[\w.+-]+\/[\w.+-]+$/.test(type)
    ? type
    : "application/octet-stream";
}
/** Storage never receives API authorization, cookies, referrers, or automatically followed redirects. */
export async function download(
  value: string,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): ReturnType<FileSource["load"]> {
  const fetcher = options.fetch ?? fetch;
  const max = contentMaxBytes(options.maxBytes);
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(options.timeoutMs ?? 120_000),
  ]);
  let url = storageUrl(value);
  let response: Response | undefined;
  for (let hop = 0; hop <= 4; hop++) {
    try {
      response = await fetcher(url, {
        signal: bounded,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Error("Readwise storage download failed");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || hop === 4)
      throw new Error("Readwise storage redirect limit reached");
    let redirected: string;
    try {
      redirected = new URL(location, url).href;
    } catch {
      throw new Error("Readwise storage returned an invalid redirect");
    }
    url = storageUrl(redirected);
  }
  if (!response?.ok) {
    await response?.body?.cancel();
    throw new StorageUnavailable(response?.status ?? 0);
  }
  const length = response.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) {
    await response.body?.cancel();
    throw new Error("Readwise storage returned an invalid content length");
  }
  if (length !== null && Number(length) > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new StorageLimitExceeded(max);
  }
  const emptyIsComplete =
    response.status === 200 && (length === null || Number(length) === 0);
  if (!response.body) {
    if (emptyIsComplete) throw new StorageEmpty();
    throw new Error("Readwise storage returned no content");
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const prefix: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    while (total < 256 && !done) {
      bounded.throwIfAborted();
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        total += chunk.value.byteLength;
        if (total > max) throw new StorageLimitExceeded(max);
        prefix.push(chunk.value);
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof StorageLimitExceeded) throw error;
    throw new Error("Readwise storage stream failed", { cause: error });
  }
  if (total === 0) {
    await reader.cancel();
    if (emptyIsComplete) throw new StorageEmpty();
    throw new Error("Readwise storage returned empty content");
  }
  const contentType = mime(
    Buffer.concat(prefix),
    response.headers.get("content-type"),
  );
  let index = 0;
  const bytes = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        bounded.throwIfAborted();
        if (index < prefix.length) {
          const value = prefix[index++];
          if (value) controller.enqueue(value);
          return;
        }
        if (done) {
          controller.close();
          return;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          controller.close();
          return;
        }
        total += chunk.value.byteLength;
        if (total > max) throw new StorageLimitExceeded(max);
        controller.enqueue(chunk.value);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(
          error instanceof StorageLimitExceeded
            ? error
            : new Error("Readwise storage stream failed"),
        );
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return { bytes, mime_type: contentType };
}
export type ResourceKind = "html" | "original" | "image" | "text";
export interface Resource {
  id: string;
  kind: ResourceKind;
  status: "kept" | "pending" | "unavailable" | "deliberately-unkept";
  reason?: string;
  fileKey?: string;
  maxBytes?: number;
}
export interface ContentFile {
  id: string;
  kind: ResourceKind;
  sourceId: string;
  key: string;
  text?: string;
  url?: string;
}
export interface ContentPlan {
  resources: Resource[];
  files: ContentFile[];
}
function imageUrls(html: string): string[] {
  const found: string[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node): void {
    if (
      "tagName" in node &&
      ["img", "source", "image"].includes(node.tagName)
    ) {
      for (const attr of node.attrs) {
        if (["src", "href", "data-src"].includes(attr.name))
          found.push(attr.value);
        if (["srcset", "data-srcset"].includes(attr.name)) {
          // A data URL's commas are not candidate delimiters; it is never downloaded.
          for (const candidate of attr.value.matchAll(
            /(?:^|,\s*)(\S+)(?:\s+[\d.]+[wx])?/g,
          ))
            if (candidate[1]) found.push(candidate[1]);
        }
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
    if ("content" in node) visit(node.content);
  }
  visit(parse(html));
  return found;
}
export function contentPlan(
  canonical: string,
  row: ReaderDocument,
  texts: readonly TextFilePlan[] = [],
): ContentPlan {
  const resources: Resource[] = [];
  const files: ContentFile[] = [];
  const revision = row.updated_at ?? "unknown";
  const addText = (
    id: string,
    kind: ResourceKind,
    text: string,
    sourceId = `${canonical}:content:${id}`,
  ): void => {
    files.push({ id, kind, sourceId, key: digest(text), text });
    resources.push({ id, kind, status: "pending", fileKey: sourceId });
  };
  if (row.html_content) addText("html", "html", row.html_content);
  else
    resources.push({
      id: "html",
      kind: "html",
      status: "unavailable",
      reason: "not-provided",
    });
  for (const text of texts)
    addText(`text:${text.field}`, "text", text.text, text.key);
  const urls = new Map<string, { value: string; kind: "image" | "original" }>();
  if (row.raw_source_url)
    urls.set("original", { value: row.raw_source_url, kind: "original" });
  else
    resources.push({
      id: "original",
      kind: "original",
      status: "unavailable",
      reason: "not-provided",
    });
  for (const value of [
    ...imageUrls(row.html_content ?? ""),
    ...(row.image_url ? [row.image_url] : []),
  ]) {
    let identity = value;
    try {
      const url = new URL(value);
      identity = url.origin + url.pathname;
    } catch {
      /* Relative and inline images remain explicitly unkept. */
    }
    urls.set(`image:${digest(identity)}`, { value, kind: "image" });
  }
  for (const [id, { value, kind }] of urls) {
    let url: URL;
    try {
      url = storageUrl(value);
    } catch {
      resources.push({
        id,
        kind,
        status: "deliberately-unkept",
        reason: "third-party",
      });
      continue;
    }
    const sourceId = `${canonical}:content:${id}`;
    files.push({
      id,
      kind,
      sourceId,
      key: digest([url.origin, url.pathname, revision].join("\n")),
      url: url.href,
    });
    resources.push({ id, kind, status: "pending", fileKey: sourceId });
  }
  return { resources, files };
}
export interface ContentJob {
  id: string;
  canonical: string;
  type: string;
  revision: string;
  exportSourceId?: number;
  exportHighlightId?: number;
  noteIds?: string[];
  attempts?: number;
  due?: number;
}
export const contentQueueKey = "content-queue";
export function contentQueue(
  state: Pick<CheckpointState, "get">,
): ContentJob[] {
  const value = state.get(contentQueueKey);
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some((v: unknown) => {
      if (typeof v !== "object" || v === null) return true;
      const row = v as Record<string, unknown>;
      return (
        ["id", "canonical", "type", "revision"].some(
          (key) => typeof row[key] !== "string" || row[key].length > 2048,
        ) ||
        ["exportSourceId", "exportHighlightId"].some(
          (key) =>
            row[key] !== undefined &&
            (!Number.isSafeInteger(row[key]) || (row[key] as number) <= 0),
        ) ||
        (row["noteIds"] !== undefined &&
          (!Array.isArray(row["noteIds"]) ||
            row["noteIds"].length > 256 ||
            row["noteIds"].some(
              (id: unknown) => typeof id !== "string" || id.length > 512,
            ))) ||
        (row["due"] !== undefined &&
          (typeof row["due"] !== "number" || !Number.isFinite(row["due"]))) ||
        (row["attempts"] !== undefined &&
          (!Number.isSafeInteger(row["attempts"]) ||
            (row["attempts"] as number) < 0))
      );
    })
  )
    throw new Error("Reader content queue is invalid");
  return structuredClone(value) as ContentJob[];
}
export async function saveContentQueue(
  state: CheckpointState,
  jobs: readonly ContentJob[],
): Promise<void> {
  const result = await state.checkpoint(contentQueueKey, jobs);
  if (!result.committed)
    throw new Error(
      `Reader content queue was not acknowledged: ${result.reason}`,
    );
}
export async function enqueueContent(
  state: CheckpointState,
  jobs: readonly ContentJob[],
  limit = 128,
): Promise<boolean> {
  const saved = contentQueue(state);
  const queue = new Map(saved.map((job) => [job.id, job]));
  for (const job of jobs) {
    const previous = queue.get(job.id);
    if (previous?.revision !== job.revision) queue.set(job.id, job);
  }
  if (
    queue.size > limit ||
    Buffer.byteLength(JSON.stringify([...queue.values()])) > 160_000
  )
    return false;
  contentQueue({ get: () => [...queue.values()] });
  await saveContentQueue(state, [...queue.values()]);
  return true;
}
