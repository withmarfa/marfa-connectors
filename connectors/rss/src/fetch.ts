import { lookup as resolve } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
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

/** An address on this machine or a private network the owner did not name. */
export class RefusedAddress extends Error {
  override name = "RefusedAddress";

  constructor(readonly hop: number) {
    super("refused");
  }
}

export class TooManyRedirects extends Error {
  override name = "TooManyRedirects";
}

// Loopback, private, shared, link-local (cloud metadata among them), the
// Azure platform address, unique and site local, multicast and reserved;
// IPv4 rules also match IPv4-mapped IPv6.
const unreachable = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
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
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  unreachable.addSubnet(network, prefix, "ipv6");
}

function ipv6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad !== null) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const groups = (part: string): string[] =>
    part === "" ? [] : part.split(":");
  const before = groups(head);
  const after = tail === undefined ? [] : groups(tail);
  const words = [
    ...before,
    ...Array<string>(8 - before.length - after.length).fill("0"),
    ...after,
  ].map((word) => parseInt(word, 16));
  if (words.length !== 8 || words.some(Number.isNaN)) return undefined;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

const v4 = (bytes: number[]): string => bytes.join(".");

/** IPv4 addresses an IPv6 address carries: compatible, mapped and
 *  translated forms, NAT64's well-known prefix, 6to4 and Teredo. */
function embedded(address: string): string[] {
  const b = ipv6Bytes(address);
  if (b === undefined) return [];
  const zero = (from: number, to: number): boolean =>
    b.slice(from, to).every((byte) => byte === 0);
  const last = b.slice(12, 16);
  const found: string[] = [];
  if (zero(0, 8) && (zero(8, 12) || (b[10] === 0xff && b[11] === 0xff))) {
    found.push(v4(last));
  }
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) {
    found.push(v4(last));
  }
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    found.push(v4(last));
  }
  if (b[0] === 0x20 && b[1] === 0x02) found.push(v4(b.slice(2, 6)));
  if (b[0] === 0x20 && b[1] === 0x01 && zero(2, 4)) {
    found.push(v4(b.slice(4, 8)), v4(last.map((byte) => byte ^ 0xff)));
  }
  return found;
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

/** A URL's host as the checks compare it: no IPv6 brackets, no trailing dot. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isPrivate(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return unreachable.check(address, "ipv4");
  if (family !== 6) return false;
  return (
    unreachable.check(address, "ipv6") ||
    embedded(address).some((inner) => unreachable.check(inner, "ipv4"))
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
      callback(new RefusedAddress(0), []);
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
  for (let hop = 0; ; hop += 1) {
    const host = hostOf(url);
    const allowed = ownerAllows && host === listed;
    if (!allowed && isPrivate(host)) throw new RefusedAddress(hop);
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
        !allowed && isIP(host) === 0,
        signal,
      );
    } catch (error) {
      throw error instanceof RefusedAddress ? new RefusedAddress(hop) : error;
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (redirects.has(status) && location !== undefined) {
      response.destroy();
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
