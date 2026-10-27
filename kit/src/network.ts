import { lookup as resolve } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** An address on this machine or a private network the owner did not name. */
export class RefusedAddress extends Error {
  override name = "RefusedAddress";

  constructor(readonly hop: number) {
    super("refused");
  }
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
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
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

/**
 * Checks one hop's host before a request is made: a private or local address
 * literal is refused unless `allowed`, and so is a name that resolves to one,
 * which the returned `lookup` refuses as the socket connects. The result is
 * the `lookup` option for the request, or `undefined` for a host that needs
 * none, an allowed host or an address literal.
 */
export function guardHost(
  host: string,
  allowed: boolean,
  hop: number,
): LookupFunction | undefined {
  if (allowed) return undefined;
  if (isPrivate(host)) throw new RefusedAddress(hop);
  return isIP(host) === 0 ? guardedLookup : undefined;
}

/**
 * Hosts an owner allows to resolve to this machine or a private network,
 * separated by whitespace, each read as a URL reads its host: lowercased,
 * an international name in its ASCII form, an IPv6 address in brackets or
 * bare. `setting` names the environment variable the value came from, for the
 * error. An entry holds a host name only, with no port, path or credentials.
 */
export function privateHostSet(
  value: string | undefined,
  setting: string,
): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (value ?? "")
    .split(/\s+/)
    .filter((part) => part !== "")) {
    const url = URL.parse(`http://${isIP(entry) === 6 ? `[${entry}]` : entry}`);
    if (
      url?.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error(`${setting} holds an entry that is not a host name`);
    }
    hosts.add(hostOf(url));
  }
  return hosts;
}
