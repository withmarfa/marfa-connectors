import { lookup as resolve } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const fetchTimeoutMs = 60_000;

/** Applied to the bytes on the wire and again to the bytes they decompress
 *  to, so a compressed bomb stops where a plain body would. */
export const maxFeedBytes = 16 * 1024 * 1024;

export const maxRedirects = 5;

export class TooLarge extends Error {
  override name = "TooLarge";
}

export class RefusedRedirect extends Error {
  override name = "RefusedRedirect";
}

export class TooManyRedirects extends Error {
  override name = "TooManyRedirects";
}

// Loopback, private, shared, link-local (cloud metadata among them), unique
// local, multicast and reserved; IPv4 rules also match IPv4-mapped IPv6.
const unreachable = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  unreachable.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  unreachable.addSubnet(network, prefix, "ipv6");
}

function isPrivate(address: string): boolean {
  const family = isIP(address);
  return (
    family !== 0 && unreachable.check(address, family === 6 ? "ipv6" : "ipv4")
  );
}

// Checked as the socket connects, so a name that resolves to a public address
// for a check and a private one for the connection cannot slip through.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  resolve(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, []);
      return;
    }
    const first = addresses[0];
    if (
      first === undefined ||
      addresses.some(({ address }) => isPrivate(address))
    ) {
      callback(new RefusedRedirect(), []);
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

function get(
  url: URL,
  headers: Record<string, string>,
  guarded: boolean,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const sent = request(url, {
      headers,
      signal,
      // A pooled socket was connected for another feed, perhaps unguarded.
      agent: false,
      ...(guarded && { lookup: guardedLookup }),
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
}

const redirects = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects by hand: a redirect to another host is refused where the
 * host resolves to this machine or a private network, and the credentials a
 * configured address carries go to its own origin alone. The configured
 * address itself may be private, as a feed on a home network is.
 */
export async function getFeed(
  configured: string,
  headers: Readonly<Record<string, string>>,
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
  let url = start;
  for (let hop = 0; ; hop += 1) {
    const sameHost = url.hostname === start.hostname;
    if (!sameHost && isPrivate(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw new RefusedRedirect();
    }
    const response = await get(
      url,
      {
        ...headers,
        "Accept-Encoding": "gzip, deflate, br",
        ...(credentials !== undefined &&
          url.origin === start.origin && { Authorization: credentials }),
      },
      !sameHost,
      signal,
    );
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (redirects.has(status) && location !== undefined) {
      response.destroy();
      if (hop >= maxRedirects) throw new TooManyRedirects();
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new RefusedRedirect();
      }
      next.username = "";
      next.password = "";
      next.hash = "";
      url = next;
      continue;
    }
    if (status !== 200) {
      response.destroy();
      return { status, headers: response.headers, url: url.href };
    }
    return {
      status,
      headers: response.headers,
      bytes: await bodyOf(response, signal),
      url: url.href,
    };
  }
}
