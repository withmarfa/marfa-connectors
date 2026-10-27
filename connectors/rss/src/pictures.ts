import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ConnectionDefinition,
  Entry,
  EnvDeclaration,
  Item,
  RunContext,
  TypeDefinition,
} from "@withmarfa/connector";
import { hostOf } from "@withmarfa/connector/network";
import { fetchPicture, type PictureType } from "@withmarfa/connector/pictures";
import rssEntry from "./rss.entry.json" with { type: "json" };
import rssPicture from "./rss.picture.json" with { type: "json" };

/**
 * What the connector does with the pictures an entry points to:
 *
 * - `addresses`: nothing. The entry keeps the addresses in its text.
 * - `save`: saves the pictures of each entry as files, in the tier the entry
 *   is in.
 * - `save-in-library`: saves the pictures of each entry that is in the
 *   library, and of none that is in the feed.
 */
export type PicturesSetting = "addresses" | "save" | "save-in-library";

export function picturesSetting(value: string | undefined): PicturesSetting {
  if (value === undefined || value === "addresses") return "addresses";
  if (value === "save" || value === "save-in-library") return value;
  throw new Error("RSS_PICTURES must be addresses, save or save-in-library");
}

/** A picture's type, the entry's property that accounts for its pictures,
 *  and the connection that attaches one to the other. */
export const pictureTypeId = rssPicture.id;
export const manifestField = "rss_pictures";
export const attachedTo: ConnectionDefinition = {
  id: "attached-to",
  cardinality: "many-to-many",
  source_type_constraints: [rssPicture.id],
  target_type_constraints: [rssEntry.id],
};

/** The entry type as it is declared when pictures are saved: with the field
 *  that accounts for them. */
export function entryTypeWithManifest(): TypeDefinition {
  return {
    ...(rssEntry as TypeDefinition),
    fields: {
      ...(rssEntry.fields as TypeDefinition["fields"]),
      [manifestField]: {
        type: "object",
        description:
          "What became of each picture address in the entry's text and image: those saved, those left for the next run, and those not kept with a reason, beside a hash of the text they were read from. The connector sets it; the addresses are not secrets, and signed ones should not be in a feed.",
      },
    },
  };
}

export const pictureKind = {
  type: rssPicture as TypeDefinition,
  fields: ["title", "source_url", "blob_ref", "mime_type"],
};

/** At most this many distinct picture addresses are read from one entry's
 *  image and text, in the order they come; the rest are only counted. */
export const maxPicturesPerEntry = 20;
/** At most this many pictures are fetched in one run. */
export const maxPicturesPerRun = 100;
/** A picture that would take the bytes saved in one run past this is left
 *  for the next run. */
export const maxBytesPerRun = 200 * 1024 * 1024;
/** No picture is fetched after the pass has run this long. The pictures it
 *  did not reach stay pending for the next run. A fetch that has begun may
 *  take up to 30 seconds more. */
export const maxPassMs = 10 * 60 * 1000;
/** A picture whose fetch fails in a way that may pass is asked for this many
 *  times, a run at a time, before it is not kept. */
export const maxAttempts = 3;
/** A longer address is not read from an entry's text. */
export const maxAddressLength = 2048;

/** Why a picture was left out, beside the reasons the kit's fetch gives. */
export type Reason = "removed" | "not_https";

/** Failures that may pass, which are asked for again in a later run. */
const transient = new Set(["timed_out", "fetch_failed", "upload_failed"]);

/**
 * Whether a refused picture may be fetched later. A failure of the transfer
 * may pass. So may an answer that asks a client to wait or try again: 408,
 * 425, 429 and any 5xx. Any other status, such as a 404 or a 403, is a
 * host's answer about this picture and stays refused.
 */
export function mayPass(reason: string, status?: number): boolean {
  if (transient.has(reason)) return true;
  return (
    reason === "bad_status" &&
    status !== undefined &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  );
}

export interface Manifest {
  /** A hash of the text the addresses were read from. */
  text: string;
  /** Addresses whose pictures are held. */
  saved: string[];
  /** Addresses to try again in the next run. */
  pending: string[];
  /** Addresses given up on, each with the reason, until the text changes. */
  not_kept: Record<string, string>;
  /** How many runs a pending address has failed in. */
  attempts?: Record<string, number>;
  /** How many addresses past the limit for one entry were not read. */
  over?: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.every((one: unknown): one is string => typeof one === "string")
    ? value
    : undefined;

/** A manifest as the entry holds it, or `undefined` for anything else. */
export function manifestOf(value: unknown): Manifest | undefined {
  const at = object(value);
  const saved = strings(at["saved"]);
  const pending = strings(at["pending"]);
  if (typeof at["text"] !== "string" || saved === undefined) return undefined;
  if (pending === undefined) return undefined;
  const numbers = Object.entries(object(at["attempts"])).filter(
    (one): one is [string, number] => typeof one[1] === "number",
  );
  const over = at["over"];
  return {
    text: at["text"],
    saved,
    pending,
    not_kept: Object.fromEntries(
      Object.entries(object(at["not_kept"])).filter(
        (one): one is [string, string] => typeof one[1] === "string",
      ),
    ),
    ...(numbers.length > 0 && { attempts: Object.fromEntries(numbers) }),
    ...(typeof over === "number" && over > 0 && { over }),
  };
}

const sha256 = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");

/** The hash of the text a manifest was read from. */
export function textHash(body: unknown, image: unknown): string {
  return sha256(
    JSON.stringify([
      typeof body === "string" ? body : null,
      typeof image === "string" ? image : null,
    ]),
  );
}

// A Markdown image: its label, then its destination, which the converter
// writes without spaces, parentheses or angle brackets, and an optional title.
const markdownImage =
  /!\[(?:\\.|[^\]\\])*\]\(\s*<?([^\s()<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/**
 * The web addresses of an entry's pictures: its image, then the Markdown
 * images in its body, each once. Only `http` and `https` addresses count;
 * another scheme, a relative address and one over `maxAddressLength` are not
 * addresses to save.
 */
export function addressesOf(
  body: unknown,
  image: unknown,
): { addresses: string[]; over: number } {
  const found = new Set<string>();
  const take = (raw: string): void => {
    if (raw.length > maxAddressLength) return;
    const url = URL.parse(raw);
    if (url?.protocol !== "https:" && url?.protocol !== "http:") return;
    found.add(url.href);
  };
  if (typeof image === "string") take(image);
  if (typeof body === "string") {
    for (const match of body.matchAll(markdownImage)) take(match[1] ?? "");
  }
  const all = [...found];
  return {
    addresses: all.slice(0, maxPicturesPerEntry),
    over: Math.max(0, all.length - maxPicturesPerEntry),
  };
}

const extensions: Record<PictureType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
};

/** A picture's `source_id`: the id of its entry's row, which holds when a
 *  feed's key changes and its entries are moved to new ones, a number sign,
 *  and a hash of the address. */
export function pictureId(entryRow: string, address: string): string {
  return `${entryRow}#${sha256(address).slice(0, 32)}`;
}

/** The id of the entry row a picture was saved for. */
export function entryOf(pictureId: string): string {
  return pictureId.slice(0, pictureId.lastIndexOf("#"));
}

export function titleOf(address: string, type: PictureType): string {
  return `p-${sha256(address).slice(0, 12)}.${extensions[type]}`;
}

type Context = Pick<
  RunContext<EnvDeclaration>,
  "held" | "archive" | "derive" | "upsert" | "inspect" | "signal" | "log"
>;

/**
 * The hosts a picture of an entry may be fetched from although they resolve to
 * this machine or a private network: the host the owner listed, and only when
 * it is also the host of the entry's own feed. The owner's leave is for the
 * feed it was given for, so a feed's text cannot send the connector to an
 * internal host that is listed for another.
 */
export function privateHostsFor(
  listed: ReadonlySet<string>,
  feedOrigin: unknown,
  address: string,
): ReadonlySet<string> {
  const feed = typeof feedOrigin === "string" ? URL.parse(feedOrigin) : null;
  const picture = URL.parse(address);
  if (feed === null || picture === null) return new Set();
  const host = hostOf(picture);
  return host === hostOf(feed) && listed.has(host)
    ? new Set([host])
    : new Set();
}

/** Whether a picture row, read with its edges, holds an `attached-to`
 *  connection to the entry row. */
function isAttached(picture: Item, entryRow: string): boolean {
  return (
    picture.edges?.[attachedTo.id]?.data.some(
      (edge) => edge.target_id === entryRow,
    ) ?? false
  );
}

/** The manifests the entries hold, by `source_id`, for a read to carry. */
export async function manifestsHeld(
  context: Pick<Context, "held">,
): Promise<Map<string, Manifest>> {
  const manifests = new Map<string, Manifest>();
  for (const row of await context.held(rssEntry.id, { state: "any" })) {
    const manifest = manifestOf(row.properties[manifestField]);
    if (row.source_id !== undefined && manifest !== undefined) {
      manifests.set(row.source_id, manifest);
    }
  }
  return manifests;
}

/** The entries with the manifests their rows hold, so that a write of the
 *  entry does not clear what accounts for its pictures. */
export function carrying(
  entries: readonly Entry[],
  manifests: ReadonlyMap<string, Manifest>,
): Entry[] {
  return entries.map((entry) => {
    const manifest = [entry.source_id, [entry.movedFrom ?? []].flat()]
      .flat()
      .map((id) => manifests.get(id))
      .find((one) => one !== undefined);
    return manifest === undefined
      ? entry
      : {
          ...entry,
          properties: { ...entry.properties, [manifestField]: manifest },
        };
  });
}

export interface Saved {
  fetched: number;
  saved: number;
  notKept: number;
  left: number;
  swept: number;
  revived: number;
}

/**
 * One pass over the entries the setting names: archives the pictures of
 * entries that are no longer active, brings back those of entries that are
 * active again, and for each entry whose pictures are not all accounted for,
 * saves what it can and records the rest.
 */
export async function savePictures(
  context: Context,
  options: {
    setting: Exclude<PicturesSetting, "addresses">;
    privateHosts: ReadonlySet<string>;
    /** The clock the pass is timed by, in milliseconds; for tests. */
    now?: () => number;
    /** The picture fetch; for tests. */
    fetch?: typeof fetchPicture;
  },
): Promise<Saved> {
  const now = options.now ?? Date.now;
  const fetch = options.fetch ?? fetchPicture;
  const started = now();
  const result: Saved = {
    fetched: 0,
    saved: 0,
    notKept: 0,
    left: 0,
    swept: 0,
    revived: 0,
  };
  const entries = await context.held(rssEntry.id, { state: "any" });
  const states = new Map(entries.map((row) => [row.id, row]));
  // The connector's pictures are read in pages of up to 200, each row with
  // the connections it holds, so that whether a picture is attached to its
  // entry is known without asking about each entry. A read that fails ends
  // the pass before it has written anything; the next run reads again.
  const pictures = new Map<string, Item>();
  const readPictures = async (): Promise<void> => {
    for (const row of await context.held(pictureTypeId, {
      state: "any",
      edges: true,
    })) {
      if (row.source_id !== undefined) pictures.set(row.source_id, row);
    }
  };
  await readPictures();

  // A picture follows its entry out of use: one whose entry is archived,
  // trashed or gone is archived with it. The kit leaves a row a person has
  // restored since, so what was archived is read back rather than assumed.
  const gone = [...pictures]
    .filter(
      ([id, row]) =>
        row.state === "active" && states.get(entryOf(id))?.state !== "active",
    )
    .map(([id]) => id);
  if (gone.length > 0) {
    await context.archive(pictureTypeId, gone);
    await readPictures();
    result.swept = gone.filter(
      (id) => pictures.get(id)?.state === "archived",
    ).length;
  }

  // Pictures of an active entry that are archived: the kit brings back the
  // ones this connector archived when the entry is written again, and leaves
  // the ones a person or anything else archived.
  const revival: string[] = [];
  let limit: string | undefined;
  let bytes = 0;
  for (const entry of entries) {
    const entryId = entry.source_id;
    const tier = entry.tier ?? "feed";
    if (
      entryId === undefined ||
      entry.state !== "active" ||
      (options.setting === "save-in-library" && tier !== "library")
    ) {
      continue;
    }
    const text = textHash(
      entry.properties["body"],
      entry.properties["image_url"],
    );
    const { addresses, over } = addressesOf(
      entry.properties["body"],
      entry.properties["image_url"],
    );
    const prior = manifestOf(entry.properties[manifestField]);
    if (prior === undefined && addresses.length === 0) continue;
    const same = prior?.text === text ? prior : undefined;

    // An entry is left alone while its manifest still tells the truth: the
    // text is the one it was read from, nothing waits, and each picture it
    // lists is held, active and attached to it. A run that stopped after a
    // picture was saved leaves the picture without its connection, since
    // connections are written when a run ends.
    if (
      same?.pending.length === 0 &&
      same.saved.every((address) => {
        const row = pictures.get(pictureId(entry.id, address));
        return row?.state === "active" && isAttached(row, entry.id);
      })
    ) {
      continue;
    }

    const next: Manifest = { text, saved: [], pending: [], not_kept: {} };
    const attempts: Record<string, number> = {};
    const open: string[] = [];
    for (const address of addresses) {
      if (same !== undefined && address in same.not_kept) {
        next.not_kept[address] = same.not_kept[address] ?? "";
      } else if (address.startsWith("http:")) {
        next.not_kept[address] = "not_https";
      } else open.push(address);
    }

    // A picture removed in Marfa is not saved again for this entry, and one
    // already held is not fetched again.
    const ids = new Map(open.map((a) => [a, pictureId(entry.id, a)]));
    const missing = [...ids.values()].filter((id) => !pictures.has(id));
    const purged = new Set(
      missing.length === 0
        ? []
        : (
            await context.inspect(pictureTypeId, { source_ids: missing })
          ).tombstones.map((one) => one.key),
    );
    const repairs: Entry[] = [];
    const connection = {
      "attached-to": [{ type: rssEntry.id, id: entryId }],
    };
    for (const address of open) {
      context.signal.throwIfAborted();
      const id = ids.get(address) ?? "";
      const held = pictures.get(id);
      if (held !== undefined) {
        if (held.state === "trashed" || held.state === "revoked") {
          next.not_kept[address] = "removed";
          continue;
        }
        next.saved.push(address);
        const archived = held.state === "archived";
        if (archived || !isAttached(held, entry.id)) {
          // The row as it is, written again with its connection.
          repairs.push({
            source_id: id,
            properties: Object.fromEntries(
              pictureKind.fields
                .filter((field) => held.properties[field] !== undefined)
                .map((field) => [field, held.properties[field]]),
            ),
            tier: held.tier,
            connections: connection,
          });
          if (archived) revival.push(id);
        }
        continue;
      }
      if (purged.has(id)) {
        next.not_kept[address] = "removed";
        continue;
      }
      if (limit === undefined) {
        if (result.fetched >= maxPicturesPerRun) {
          limit = `${String(maxPicturesPerRun)} pictures`;
        } else if (now() - started >= maxPassMs) {
          limit = `${String(maxPassMs / 60_000)} minutes`;
        }
      }
      if (limit !== undefined) {
        next.pending.push(address);
        const tried = same?.attempts?.[address];
        if (tried !== undefined) attempts[address] = tried;
        continue;
      }
      result.fetched += 1;
      const got = await fetch(address, {
        privateHosts: privateHostsFor(
          options.privateHosts,
          entry.properties["feed_origin"],
          address,
        ),
        signal: context.signal,
      });
      let failure: string;
      let status: number | undefined;
      if (!got.ok) {
        failure = got.reason;
        status = got.status;
      } else if (bytes + got.bytes.length > maxBytesPerRun) {
        limit = `${String(maxBytesPerRun / 1024 / 1024)} MiB`;
        next.pending.push(address);
        const tried = same?.attempts?.[address];
        if (tried !== undefined) attempts[address] = tried;
        continue;
      } else {
        const row: Entry = {
          source_id: id,
          properties: {
            title: titleOf(address, got.mime_type),
            source_url: address,
          },
          tier,
          connections: connection,
          file: {
            key: sha256(got.bytes),
            load: () =>
              Promise.resolve({ bytes: got.bytes, mime_type: got.mime_type }),
          },
        };
        await context.upsert(pictureTypeId, [row]);
        const after = await context.inspect(pictureTypeId, {
          source_ids: [id],
        });
        const made = after.items.find((one) => one.source_id === id);
        if (typeof made?.properties["blob_ref"] === "string") {
          bytes += got.bytes.length;
          result.saved += 1;
          pictures.set(id, made);
          next.saved.push(address);
          continue;
        }
        failure = "upload_failed";
      }
      if (mayPass(failure, status)) {
        const tries = (same?.attempts?.[address] ?? 0) + 1;
        if (tries < maxAttempts) {
          next.pending.push(address);
          attempts[address] = tries;
          continue;
        }
      }
      next.not_kept[address] = failure;
    }
    if (repairs.length > 0) await context.upsert(pictureTypeId, repairs);
    if (Object.keys(attempts).length > 0) next.attempts = attempts;
    if (over > 0) next.over = over;
    result.notKept += Object.keys(next.not_kept).length;
    result.left += next.pending.length;
    if (!isDeepStrictEqual(prior, next)) {
      await context.derive(rssEntry.id, [entryId], { [manifestField]: next });
    }
  }
  if (revival.length > 0) {
    await readPictures();
    result.revived = revival.filter(
      (id) => pictures.get(id)?.state === "active",
    ).length;
  }
  if (result.left > 0 && limit !== undefined) {
    context.log.condition(
      "pictures:limit",
      `this run reached its limit of ${limit}, so ${String(result.left)} pictures are left for the next run`,
    );
  }
  return result;
}
