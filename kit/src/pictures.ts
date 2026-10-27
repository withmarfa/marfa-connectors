import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline } from "node:stream/promises";
import { guardHost, hostOf, RefusedAddress } from "./network.js";
import { isTracker } from "./trackers.js";

/** The most bytes a picture may hold. */
export const maxPictureBytes = 25 * 1024 * 1024;

/** The most redirects followed to reach a picture. */
export const maxPictureRedirects = 4;

/** The most pixels a picture may claim, width times height. A header can
 *  claim far more than its bytes hold; a later decoder is not handed that. */
export const maxPicturePixels = 100_000_000;

/** The longest a fetch may take, from the first request to the last byte. */
export const pictureTimeoutMs = 30_000;

/** A product token and where to read about it, as sites ask of a crawler.
 *  It carries no version: a version exists only as a git tag. */
export const pictureUserAgent =
  "MarfaPictures (+https://github.com/withmarfa/marfa-connectors)";

/** The types a picture may have, as its first bytes name them. */
export type PictureType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/avif"
  | "image/heic";

/**
 * Why a picture was not fetched. A code is stable: a connector may keep it.
 *
 * - `invalid_address`: not a web address, or one that carries credentials.
 * - `not_https`: the address, or a redirect, is not `https`.
 * - `private_address`: the host is, or resolves to, this machine or a private
 *   network that the connector did not allow.
 * - `tracker`: the address is a known tracker's counting pixel.
 * - `too_many_redirects`: more than four redirects.
 * - `bad_status`: the answer was not a 200.
 * - `too_large`: more than 25 MiB, by the declared or the streamed length.
 * - `timed_out`: not complete within 30 seconds.
 * - `fetch_failed`: the connection, the certificate or the transfer failed.
 * - `not_a_picture`: the first bytes are none of the types above, or the
 *   picture's size cannot be read from them.
 * - `svg`: the bytes are an SVG document, which is never fetched.
 * - `one_pixel`: the picture is one pixel wide or high.
 * - `too_large_dimensions`: the picture claims more than 100 million pixels,
 *   whatever its length in bytes.
 */
export type PictureRefusal =
  | "invalid_address"
  | "not_https"
  | "private_address"
  | "tracker"
  | "too_many_redirects"
  | "bad_status"
  | "too_large"
  | "timed_out"
  | "fetch_failed"
  | "not_a_picture"
  | "svg"
  | "one_pixel"
  | "too_large_dimensions";

export type Picture =
  | {
      readonly ok: true;
      /** The whole picture, at most 25 MiB. */
      readonly bytes: Uint8Array;
      /** Decided by the first bytes, never by the server's header. */
      readonly mime_type: PictureType;
      readonly width: number;
      readonly height: number;
      /** Where the picture came from, after any redirects. */
      readonly url: string;
    }
  | { readonly ok: false; readonly reason: PictureRefusal };

export interface PictureOptions {
  /**
   * Hosts the connector's owner allows to resolve to this machine or a
   * private network, as `privateHostSet` reads them. A host named here is
   * allowed for the picture's own address and its redirects to that same
   * host, and never as a redirect from another host.
   */
  readonly privateHosts?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
  /** Lowers the limit of 30 seconds; a higher value changes nothing. */
  readonly timeoutMs?: number;
  /** Lowers the limit of 25 MiB; a higher value changes nothing. */
  readonly maxBytes?: number;
}

class Refuse extends Error {
  override name = "Refuse";

  constructor(readonly reason: PictureRefusal) {
    super(reason);
  }
}

const redirects = new Set([301, 302, 303, 307, 308]);

function lower(value: number | undefined, limit: number): number {
  if (value === undefined) return limit;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("a picture limit is a positive whole number");
  }
  return Math.min(value, limit);
}

function checked(url: URL | null): URL {
  if (url === null) throw new Refuse("invalid_address");
  if (url.protocol !== "https:") throw new Refuse("not_https");
  if (url.username !== "" || url.password !== "") {
    throw new Refuse("invalid_address");
  }
  url.hash = "";
  return url;
}

function get(
  request: typeof httpsRequest,
  url: URL,
  lookup: LookupFunction | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((done, fail) => {
    const sent = request(url, {
      method: "GET",
      // No cookie, authorization or referrer, ever.
      headers: {
        Accept:
          "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
        "Accept-Encoding": "identity",
        "User-Agent": pictureUserAgent,
      },
      signal,
      // A pooled socket was connected for another request, perhaps unguarded.
      agent: false,
      ...(lookup !== undefined && { lookup }),
    });
    sent.once("response", done);
    sent.once("error", fail);
    sent.end();
  });
}

async function bodyOf(
  response: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = response.headers["content-length"];
  if (
    declared !== undefined &&
    /^\d+$/.test(declared) &&
    Number(declared) > limit
  ) {
    response.destroy();
    throw new Refuse("too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await pipeline(
    response,
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > limit) throw new Refuse("too_large");
        chunks.push(chunk);
      }
    },
    { signal },
  );
  return Buffer.concat(chunks);
}

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  Buffer.from(bytes.subarray(from, to)).toString("latin1");

const be32 = (bytes: Uint8Array, at: number): number =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32BE(
    at,
  );

const avifBrands = new Set(["avif", "avis"]);
const heicBrands = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
]);

interface Box {
  readonly type: string;
  readonly body: number;
  readonly end: number;
}

/** The most boxes read at one level. A picture's header holds a few dozen;
 *  a body of millions of tiny boxes is not one. */
const maxBoxes = 4096;

/** The longest `ftyp` box read. Its brands are a handful. */
const maxFtypBytes = 256;

/** The boxes of an ISO base media file between two offsets, one at a time,
 *  stopping at one whose size does not fit, or after `maxBoxes`. A caller
 *  stops reading when it has what it wants. */
function* boxes(bytes: Uint8Array, from: number, to: number): Generator<Box> {
  let at = from;
  for (let count = 0; count < maxBoxes && at + 8 <= to; count += 1) {
    let size = be32(bytes, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      const high = be32(bytes, at + 8);
      if (high > 0xffff) return;
      size = high * 2 ** 32 + be32(bytes, at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) return;
    yield {
      type: ascii(bytes, at + 4, at + 8),
      body: at + header,
      end: at + size,
    };
    at += size;
  }
}

const firstBox = (
  bytes: Uint8Array,
  from: number,
  to: number,
  type: string,
): Box | undefined => {
  for (const box of boxes(bytes, from, to)) if (box.type === type) return box;
  return undefined;
};

/** The size of the largest image property in an AVIF or HEIC file. The
 *  properties sit in `meta`, `iprp`, `ipco`, each an `ispe` box; the largest
 *  stands for the picture, since a thumbnail or a tile of a grid is smaller. */
function isobmffSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const meta = firstBox(bytes, 0, bytes.length, "meta");
  if (meta === undefined) return undefined;
  const iprp = firstBox(bytes, meta.body + 4, meta.end, "iprp");
  if (iprp === undefined) return undefined;
  const properties = firstBox(bytes, iprp.body, iprp.end, "ipco");
  if (properties === undefined) return undefined;
  let largest: { width: number; height: number } | undefined;
  for (const box of boxes(bytes, properties.body, properties.end)) {
    if (box.type !== "ispe" || box.end - box.body < 12) continue;
    const width = be32(bytes, box.body + 4);
    const height = be32(bytes, box.body + 8);
    if (
      largest === undefined ||
      width * height > largest.width * largest.height
    ) {
      largest = { width, height };
    }
  }
  return largest;
}

function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (at + 9 > bytes.length) return undefined;
      return {
        height: view.readUInt16BE(at + 5),
        width: view.readUInt16BE(at + 7),
      };
    }
    at += 2 + view.readUInt16BE(at + 2);
  }
  return undefined;
}

function webpSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (ascii(bytes, 12, 16)) {
    case "VP8 ":
      if (ascii(bytes, 23, 26) !== "\x9d\x01\x2a") return undefined;
      return {
        width: view.readUInt16LE(26) & 0x3fff,
        height: view.readUInt16LE(28) & 0x3fff,
      };
    case "VP8L": {
      if (bytes[20] !== 0x2f) return undefined;
      const bits = view.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    case "VP8X":
      return {
        width: view.readUIntLE(24, 3) + 1,
        height: view.readUIntLE(27, 3) + 1,
      };
    default:
      return undefined;
  }
}

/**
 * What the first bytes say a picture is, and its size read from the same
 * bytes: PNG's header chunk, GIF's screen descriptor, the first frame header
 * of a JPEG, the first chunk of a WebP, and for AVIF and HEIC the largest
 * `ispe` image property. No decoder runs, so a picture whose size cannot be
 * read this way is refused as `not_a_picture`.
 */
function read(
  bytes: Uint8Array,
): { type: PictureType; width: number; height: number } | PictureRefusal {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = ascii(bytes, 0, 12);
  let type: PictureType | undefined;
  let size: { width: number; height: number } | undefined;
  if (
    bytes.length >= 24 &&
    head.startsWith("\x89PNG\r\n\x1a\n") &&
    ascii(bytes, 12, 16) === "IHDR"
  ) {
    type = "image/png";
    size = { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    type = "image/jpeg";
    size = jpegSize(bytes);
  } else if (bytes.length >= 10 && /^GIF8[79]a/.test(head)) {
    type = "image/gif";
    size = { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
  } else if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    type = "image/webp";
    size = webpSize(bytes);
  } else if (head.slice(4, 8) === "ftyp") {
    const length = be32(bytes, 0);
    const brands: string[] = [];
    if (length >= 16 && length <= maxFtypBytes && length <= bytes.length) {
      brands.push(ascii(bytes, 8, 12));
      for (let at = 16; at + 4 <= length; at += 4) {
        brands.push(ascii(bytes, at, at + 4));
      }
    }
    const brand = brands.find(
      (one) => avifBrands.has(one) || heicBrands.has(one),
    );
    if (brand !== undefined) {
      type = avifBrands.has(brand) ? "image/avif" : "image/heic";
      size = isobmffSize(bytes);
    }
  }
  if (type === undefined) {
    // Linear in the bytes read. Both outcomes are refusals, so an HTML page
    // with an inline `<svg` that is labeled `svg` is harmless.
    return /<svg[\s>/]/i.test(
      ascii(bytes, 0, 2048).replace(/^\xef\xbb\xbf/, ""),
    )
      ? "svg"
      : "not_a_picture";
  }
  if (size === undefined) return "not_a_picture";
  return { type, ...size };
}

/**
 * A fetcher that makes its requests with `request`. It is exported for tests,
 * which supply a `request` that trusts their own server's certificate; a
 * connector uses `fetchPicture`.
 */
export function pictureFetcher(
  request: typeof httpsRequest,
): (address: string, options?: PictureOptions) => Promise<Picture> {
  return async (address, options = {}) => {
    const limit = lower(options.maxBytes, maxPictureBytes);
    const timeout = AbortSignal.timeout(
      lower(options.timeoutMs, pictureTimeoutMs),
    );
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    const privateHosts = options.privateHosts ?? new Set<string>();
    try {
      let url = checked(URL.parse(address));
      // The owner's leave covers the host the address names and no other, so
      // a picture on a public host cannot redirect onto a host named for
      // another.
      const listed = hostOf(url);
      for (let hop = 0; ; hop += 1) {
        if (isTracker(url.href)) throw new Refuse("tracker");
        const host = hostOf(url);
        const lookup = guardHost(
          host,
          privateHosts.has(listed) && host === listed,
          hop,
        );
        const response = await get(request, url, lookup, signal);
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (redirects.has(status) && location !== undefined) {
          response.destroy();
          if (hop >= maxPictureRedirects)
            throw new Refuse("too_many_redirects");
          url = checked(URL.parse(location, url.href));
          continue;
        }
        if (status !== 200) {
          response.destroy();
          throw new Refuse("bad_status");
        }
        const bytes = await bodyOf(response, limit, signal);
        const found = read(bytes);
        if (typeof found === "string") throw new Refuse(found);
        if (found.width <= 1 || found.height <= 1)
          throw new Refuse("one_pixel");
        if (found.width * found.height > maxPicturePixels) {
          throw new Refuse("too_large_dimensions");
        }
        return {
          ok: true,
          bytes,
          mime_type: found.type,
          width: found.width,
          height: found.height,
          url: url.href,
        };
      }
    } catch (error) {
      if (error instanceof Refuse) return { ok: false, reason: error.reason };
      if (options.signal?.aborted === true) throw options.signal.reason;
      if (timeout.aborted) return { ok: false, reason: "timed_out" };
      if (error instanceof RefusedAddress) {
        return { ok: false, reason: "private_address" };
      }
      return { ok: false, reason: "fetch_failed" };
    }
  };
}

/**
 * Fetches one picture from a web address and returns its bytes and type, or
 * why it was refused; it throws only when `options.signal` aborts, and for a
 * limit that is not a positive whole number. It makes `GET` requests over
 * `https` only, with a fixed `User-Agent` and no credentials, cookies or
 * referrer. Each address it asks, the first and every redirect's, is checked
 * before a connection: a private or local address, a name that resolves to
 * one, and a known tracker's counting pixel are refused.
 */
export const fetchPicture = pictureFetcher(httpsRequest);
