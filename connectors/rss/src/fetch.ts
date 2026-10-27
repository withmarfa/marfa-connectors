import {
  guardHost,
  hostOf,
  isPrivate,
  RefusedAddress,
} from "@withmarfa/connector/network";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const fetchTimeoutMs = 60_000;

/** Applied to the bytes on the wire and again to the bytes they decompress
 *  to, so a compressed bomb stops where a plain body would. Large podcast
 *  feeds run to about 20 MiB. */
export const maxFeedBytes = 24 * 1024 * 1024;

export const maxRedirects = 5;

/** A product token and where to read about it, as sites ask of a crawler.
 *  It carries no version: a version exists only as a git tag. */
export const userAgent =
  "MarfaRSS (+https://github.com/withmarfa/marfa-connectors)";

export class TooLarge extends Error {
  override name = "TooLarge";
}

export class TooManyRedirects extends Error {
  override name = "TooManyRedirects";
}

const plainly: Record<string, string> = {
  ECONNREFUSED: "its server refused the connection",
  ECONNRESET: "its server closed the connection before answering",
  ENOTFOUND: "its host was not found",
  EAI_AGAIN: "its host could not be looked up for now",
  EHOSTUNREACH: "its host could not be reached",
  ENETUNREACH: "its network could not be reached",
  ETIMEDOUT: "its server did not answer in time",
  CERT_HAS_EXPIRED: "its certificate has expired",
  ERR_TLS_CERT_ALTNAME_INVALID: "its certificate is for another host",
  DEPTH_ZERO_SELF_SIGNED_CERT: "its certificate is self-signed",
  SELF_SIGNED_CERT_IN_CHAIN: "its certificate is not one this machine trusts",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "its certificate is not one this machine trusts",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    "its certificate is not one this machine trusts",
};

/**
 * Why a feed could not be fetched, in plain words, from the error's code,
 * never its message, which a transport may write the address into.
 */
export function failureOf(error: unknown): string {
  for (
    let at: unknown = error, depth = 0;
    at instanceof Error && depth < 8;
    at = at.cause, depth += 1
  ) {
    if (at.name === "TimeoutError") {
      return `it did not answer within ${String(fetchTimeoutMs / 1000)} seconds`;
    }
    const code = (at as NodeJS.ErrnoException).code;
    if (typeof code === "string")
      return `${plainly[code] ?? "it failed"} (${code})`;
  }
  return error instanceof Error && error.constructor === Error
    ? error.message
    : "the cause was not given";
}

function get(
  url: URL,
  headers: Record<string, string>,
  lookup: LookupFunction | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const sent = request(url, {
      headers,
      signal,
      // A pooled socket was connected for another feed, perhaps unguarded.
      agent: false,
      ...(lookup !== undefined && { lookup }),
    });
    sent.once("response", done);
    sent.once("error", fail);
    sent.end();
  });
}

function decoderFor(encoding: string | undefined): Transform | undefined {
  switch (encoding?.trim().toLowerCase() ?? "identity") {
    case "":
    case "identity":
      return undefined;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Error(`a body in the ${String(encoding)} encoding`);
  }
}

async function bodyOf(
  response: IncomingMessage,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxFeedBytes) {
    response.destroy();
    throw new TooLarge();
  }
  let decoder;
  try {
    decoder = decoderFor(response.headers["content-encoding"]);
  } catch (error) {
    response.destroy();
    throw error;
  }
  let wire = 0;
  let size = 0;
  const chunks: Buffer[] = [];
  async function* counted(source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      wire += chunk.byteLength;
      if (wire > maxFeedBytes) throw new TooLarge();
      yield chunk;
    }
  }
  async function kept(source: AsyncIterable<Buffer>): Promise<void> {
    for await (const chunk of source) {
      size += chunk.byteLength;
      if (size > maxFeedBytes) throw new TooLarge();
      chunks.push(chunk);
    }
  }
  if (decoder === undefined) {
    await pipeline(response, counted, kept, { signal });
  } else {
    await pipeline(response, counted, decoder, kept, { signal });
  }
  return Buffer.concat(chunks);
}

export interface Answer {
  status: number;
  headers: IncomingMessage["headers"];
  /** Only on a 200. */
  bytes?: Uint8Array;
  /** Where the answer came from, after any redirects. */
  url: string;
  /** Whether the feed's own address answered with a permanent redirect. */
  moved: boolean;
}

const redirects = new Set([301, 302, 303, 307, 308]);
const permanent = new Set([301, 308]);

/**
 * Follows redirects by hand, checking every hop, the first among them: a host
 * that resolves to this machine or a private network is refused unless the
 * owner named it in `privateHosts`, or listed the feed by a private address
 * itself. The credentials a listed address carries go to its own origin
 * alone.
 */
export async function getFeed(
  configured: string,
  headers: Readonly<Record<string, string>>,
  privateHosts: ReadonlySet<string>,
  outer: AbortSignal,
): Promise<Answer> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(fetchTimeoutMs)]);
  const start = new URL(configured);
  // Sent as the Basic authorization the address's userinfo stands for.
  const credentials =
    start.username !== "" || start.password !== ""
      ? `Basic ${Buffer.from(`${decodeURIComponent(start.username)}:${decodeURIComponent(start.password)}`).toString("base64")}`
      : undefined;
  start.username = "";
  start.password = "";
  start.hash = "";
  const listed = hostOf(start);
  // The owner's leave covers the host they listed and no other, so a public
  // feed cannot redirect onto a host named for another feed.
  const ownerAllows = isPrivate(listed) || privateHosts.has(listed);
  let url = start;
  let moved = false;
  for (let hop = 0; ; hop += 1) {
    const host = hostOf(url);
    const allowed = ownerAllows && host === listed;
    const lookup = guardHost(host, allowed, hop);
    let response;
    try {
      response = await get(
        url,
        {
          ...headers,
          "Accept-Encoding": "gzip, deflate, br",
          "User-Agent": userAgent,
          ...(credentials !== undefined &&
            url.origin === start.origin && { Authorization: credentials }),
        },
        lookup,
        signal,
      );
    } catch (error) {
      throw error instanceof RefusedAddress ? new RefusedAddress(hop) : error;
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (redirects.has(status) && location !== undefined) {
      response.destroy();
      if (hop === 0 && permanent.has(status)) moved = true;
      if (hop >= maxRedirects) throw new TooManyRedirects();
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error("a redirect to an address that is not http or https");
      }
      next.username = "";
      next.password = "";
      next.hash = "";
      url = next;
      continue;
    }
    if (status !== 200) {
      response.destroy();
      return { status, headers: response.headers, url: url.href, moved };
    }
    return {
      status,
      headers: response.headers,
      bytes: await bodyOf(response, signal),
      url: url.href,
      moved,
    };
  }
}
