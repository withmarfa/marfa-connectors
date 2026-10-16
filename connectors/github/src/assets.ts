import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export const maxAssetBytes = 25 * 1024 * 1024;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function assetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid GitHub asset address");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "private-user-images.githubusercontent.com" ||
      url.hostname === "objects.githubusercontent.com" ||
      /^github-production-user-asset-[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?\.s3\.amazonaws\.com$/.test(
        url.hostname,
      )
    )
  )
    throw new Error("GitHub asset host is not allowed");
  return url;
}
export interface Asset {
  id: string;
  url: string;
  title: string;
}
export function assetsIn(html: string): {
  assets: Asset[];
  unsigned: string[];
  unavailable: string[];
} {
  const assets = new Map<string, Asset>();
  const unsigned = new Set<string>();
  const unavailable = new Map<string, string>();
  const visit = (
    node:
      | DefaultTreeAdapterTypes.ChildNode
      | DefaultTreeAdapterTypes.DocumentFragment,
  ): void => {
    if ("tagName" in node && ["pre", "code"].includes(node.tagName)) return;
    if ("attrs" in node) {
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name, a.value]),
      );
      for (const name of ["src", "href"]) {
        const value = attrs[name];
        if (!value) continue;
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          continue;
        }
        if (
          url.protocol === "https:" &&
          url.hostname === "github.com" &&
          !url.username &&
          !url.password &&
          !url.port &&
          url.pathname.startsWith("/user-attachments/files/")
        )
          unsigned.add(url.origin + url.pathname);
        if (
          url.protocol === "https:" &&
          url.hostname === "github.com" &&
          !url.username &&
          !url.password &&
          !url.port &&
          url.pathname.startsWith("/user-attachments/assets/")
        ) {
          const id = uuid
            .exec(url.pathname.slice("/user-attachments/assets/".length))?.[0]
            .toLowerCase();
          if (id)
            unavailable.set(
              id,
              `https://github.com/user-attachments/assets/${id}`,
            );
        }
        try {
          url = assetUrl(value);
        } catch {
          continue;
        }
        const id = uuid.exec(url.pathname)?.[0].toLowerCase();
        if (id && !assets.has(id))
          assets.set(id, { id, url: url.href, title: attrs["alt"] ?? id });
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parseFragment(html));
  return {
    assets: [...assets.values()],
    unsigned: [...unsigned].sort(),
    unavailable: [...unavailable]
      .filter(([id]) => !assets.has(id))
      .map(([, url]) => url)
      .sort(),
  };
}
function media(prefix: Uint8Array, declared: string | null): string {
  const bytes = Buffer.from(prefix);
  const text = bytes.toString("utf8").trimStart();
  if (/^(?:<!doctype html|<html)/i.test(text))
    throw new Error("GitHub asset returned HTML instead of bytes");
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (text.startsWith("%PDF-")) return "application/pdf";
  const mime = declared?.split(";")[0]?.trim().toLowerCase();
  if (
    mime?.startsWith("image/") &&
    !(
      /<svg[\s>]/i.test(text) ||
      bytes.subarray(4, 8).toString() === "ftyp" ||
      text.startsWith("BM") ||
      bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
    )
  )
    throw new Error("GitHub asset has invalid image bytes");
  if (mime === "text/html")
    throw new Error("GitHub asset returned HTML instead of bytes");
  return mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
}
/** Signed storage requests carry no API credentials, even across redirects. */
export async function openAsset(
  value: string,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ bytes: ReadableStream<Uint8Array>; mime_type: string }> {
  const limit = options.maxBytes ?? maxAssetBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("Invalid GitHub asset byte limit");
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
  ]);
  let url = assetUrl(value);
  let response: Response | undefined;
  for (let hop = 0; hop <= 4; hop++) {
    try {
      response = await (options.fetch ?? fetch)(url, {
        signal: bounded,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Error("GitHub asset download failed");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || hop === 4)
      throw new Error("GitHub asset redirect limit reached");
    try {
      url = assetUrl(new URL(location, url).href);
    } catch {
      throw new Error("GitHub asset redirect is not allowed");
    }
  }
  const refuse = async (message: string): Promise<never> => {
    await response?.body?.cancel();
    throw new Error(message);
  };
  if (!response?.ok || response.status !== 200)
    return refuse(
      `GitHub asset returned HTTP ${String(response?.status ?? 0)}`,
    );
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
  )
    return refuse("GitHub asset has invalid content length");
  if (length !== null && Number(length) > limit)
    return refuse("GitHub asset exceeds the byte limit");
  if (!response.body) return refuse("GitHub asset returned no bytes");
  const expected = response.headers.get("content-encoding")
    ? undefined
    : length === null
      ? undefined
      : Number(length);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const prefix: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const complete = (): void => {
    if (total === 0 || (expected !== undefined && total !== expected))
      throw new Error("GitHub asset is empty or incomplete");
  };
  try {
    while (total < 512 && !done) {
      bounded.throwIfAborted();
      const part = await reader.read();
      done = part.done;
      if (part.value) {
        total += part.value.byteLength;
        if (total > limit)
          throw new Error("GitHub asset exceeds the byte limit");
        prefix.push(part.value);
      }
    }
    if (done) complete();
    const mime_type = media(
      Buffer.concat(prefix),
      response.headers.get("content-type"),
    );
    let at = 0;
    const bytes = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          bounded.throwIfAborted();
          const next = prefix[at++];
          if (next) {
            controller.enqueue(next);
            return;
          }
          if (done) {
            complete();
            controller.close();
            return;
          }
          const part = await reader.read();
          done = part.done;
          if (part.value) {
            total += part.value.byteLength;
            if (total > limit)
              throw new Error("GitHub asset exceeds the byte limit");
            controller.enqueue(part.value);
          }
          if (done) {
            complete();
            controller.close();
          }
        } catch {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error("GitHub asset stream failed"));
        }
      },
      cancel: () => reader.cancel(),
    });
    return { bytes, mime_type };
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("GitHub asset bytes could not be kept");
  }
}
