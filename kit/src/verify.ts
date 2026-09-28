import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacCheck {
  /** The secret the sender signs with. */
  readonly secret: string;
  /** The body exactly as it arrived. A re-serialized copy never matches. */
  readonly body: Uint8Array;
  /** The signature as the sender's header carries it. */
  readonly signature: string | undefined;
  readonly algorithm?: "sha256" | "sha1" | "sha512";
  readonly encoding?: "hex" | "base64";
  /** Text before the digest in the header, such as GitHub's `sha256=`. */
  readonly prefix?: string;
}

/**
 * Whether a body carries its sender's HMAC signature, compared in constant
 * time. Malformed input, a missing header or empty secret included, is `false`; hex ignores case, base64 must match exactly.
 */
export function verifyHmac(check: HmacCheck): boolean {
  const { signature, prefix = "", encoding = "hex" } = check;
  if (check.secret === "") return false;
  if (signature?.startsWith(prefix) !== true) return false;
  const digest = signature.slice(prefix.length);
  // Compared as text: a decoder stops at the first stray character, so a
  // right digest with junk after it would otherwise pass.
  const given = Buffer.from(encoding === "hex" ? digest.toLowerCase() : digest);
  const expected = Buffer.from(
    createHmac(check.algorithm ?? "sha256", check.secret)
      .update(check.body)
      .digest(encoding),
  );
  return given.length === expected.length && timingSafeEqual(given, expected);
}
