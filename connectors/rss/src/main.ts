import {
  defineConnector,
  main,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  entryFields,
  feedList,
  feedName,
  fetchFeed,
  maxFeedElements,
  maxFeedEntries,
  privateHosts,
  TooManyElements,
  TooManyEntries,
  type Feed,
  type Validators,
} from "./feeds.js";
import {
  maxFeedBytes,
  maxRedirects,
  RefusedAddress,
  TooLarge,
  TooManyRedirects,
} from "./fetch.js";
import {
  parseLimits,
  parseTimeoutMs,
  readBounded,
  TooHeavy,
  TooSlow,
} from "./parse.js";
import rssEntry from "./rss.entry.json" with { type: "json" };

interface FeedState {
  validators?: Validators;
  /** The key of the address the validators belong to. */
  address?: string;
  /** The key the feed's rows were last written under. */
  key?: string;
  /** Keys its rows were written under before, newest first: a row in the bin
   *  or purged stays under one, so every read names them. */
  was?: string[];
  /** Earlier keys another saved feed also wrote under, whose rows are left
   *  where they are rather than handed to either. */
  shared?: string[];
  unkeyed?: number;
  declared?: string;
  /** When it left RSS_FEEDS, for a feed kept only so its earlier keys are
   *  named again if it returns. */
  left?: string;
}

/** Feeds kept after leaving the list, newest first; one leaves only by the
 *  owner's edit, so this holds a long history of them. */
const maxDeparted = 100;

function refusal(error: unknown): string | undefined {
  if (error instanceof TooLarge) {
    return `is larger than ${String(maxFeedBytes / 1024 / 1024)} MiB, so it is skipped`;
  }
  if (error instanceof TooManyEntries) {
    return `carries more than ${String(maxFeedEntries)} entries, so it is skipped`;
  }
  if (error instanceof TooManyElements) {
    return `holds more than ${String(maxFeedElements)} elements, so it is skipped`;
  }
  if (error instanceof RefusedAddress) {
    return error.hop === 0
      ? "is on this machine or a private network, which is read only when RSS_PRIVATE_HOSTS names its host"
      : "redirected to an address on this machine or a private network, which is not followed";
  }
  if (error instanceof TooManyRedirects) {
    return `redirected more than ${String(maxRedirects)} times, so it is skipped`;
  }
  if (error instanceof TooHeavy) {
    return `needs more than ${String(parseLimits.maxOldGenerationSizeMb)} MB to read, so it is skipped`;
  }
  if (error instanceof TooSlow) {
    return `takes longer than ${String(parseTimeoutMs / 1000)} seconds to read, so it is skipped`;
  }
  return undefined;
}

const connector = defineConnector({
  name: "rss",
  description: "Entries from Atom and RSS 2.0 feeds.",
  source: "rss",
  types: [
    {
      // Imported JSON widens every string, so its field types read as
      // `string` here; the check on start holds the file to the server's.
      type: rssEntry as TypeDefinition,
      fields: entryFields,
    },
  ],
  // A secret, since a private feed's address carries its token.
  env: {
    RSS_FEEDS: "secret",
    RSS_PRIVATE_HOSTS: "optional",
  },
  checkEnv(env) {
    feedList(env.RSS_FEEDS);
    privateHosts(env.RSS_PRIVATE_HOSTS);
  },
  async run({ env, signal, state, log, upsert }) {
    const feeds = feedList(env.RSS_FEEDS);
    const allowed = privateHosts(env.RSS_PRIVATE_HOSTS);
    const known = (state.get("feeds") ?? {}) as Record<string, FeedState>;
    const configured = new Set(feeds.map((feed) => feed.key));
    const claimed = new Set<string>();
    const kept: Record<string, FeedState> = {};
    const declaredBy = new Map<string, Feed>();
    const holders = new Map<string, Set<string>>();
    for (const [id, held] of Object.entries(known)) {
      for (const key of [held.key ?? [], held.was ?? []].flat()) {
        holders.set(key, (holders.get(key) ?? new Set()).add(id));
      }
    }

    // A feed renamed, or named for the first time, in the same edit finds
    // its rows by its address; one moved under its name keeps its key. A
    // feed that left the list is found again by its key alone: another
    // account can be read at the same address.
    const previous = (feed: Feed): { held: FeedState; id?: string } => {
      const own = known[feed.key];
      if (own !== undefined) {
        claimed.add(feed.key);
        const held: FeedState = { ...own, address: own.address ?? feed.key };
        Reflect.deleteProperty(held, "left");
        return { held, id: feed.key };
      }
      for (const [id, held] of Object.entries(known)) {
        if (configured.has(id) || claimed.has(id) || held.left !== undefined) {
          continue;
        }
        const address = held.address ?? id;
        if (address === feed.address) {
          claimed.add(id);
          return { held: { ...held, address }, id };
        }
      }
      return { held: {} };
    };
    const records = new Map(feeds.map((feed) => [feed, previous(feed)]));

    // Rows are moved from an earlier key only when this feed alone held it:
    // never from a key another listed feed now owns, nor one another saved
    // feed also wrote under.
    const sharedWith = (key: string, id: string | undefined): boolean =>
      configured.has(key) ||
      [...(holders.get(key) ?? [])].some((holder) => holder !== id);

    const now = new Date().toISOString();
    const departed = Object.entries(known)
      .filter(([id]) => !claimed.has(id) && !configured.has(id))
      .map(([id, held]): [string, FeedState] => [
        id,
        {
          ...(held.address !== undefined && { address: held.address }),
          ...(held.key !== undefined && { key: held.key }),
          ...(held.was !== undefined && { was: held.was }),
          ...(held.shared !== undefined && { shared: held.shared }),
          left: held.left ?? now,
        },
      ])
      .sort(([, a], [, b]) => (b.left ?? "").localeCompare(a.left ?? ""))
      .slice(0, maxDeparted);

    // A feed not read this run (304 or failed) raises its conditions again;
    // the kit would otherwise take them as cleared.
    const raise = (feed: Feed, held: FeedState): void => {
      const name = feedName(feed);
      const count = held.unkeyed ?? 0;
      if (count > 0) {
        log.condition(
          `unkeyed:${feed.key}`,
          count === 1
            ? `an entry in ${name} carries neither an id nor a link, and is left out`
            : `${String(count)} entries in ${name} carry neither an id nor a link, and are left out`,
        );
      }
      if ((held.shared ?? []).length > 0) {
        log.condition(
          `shared:${feed.key}`,
          `rows written for ${name} before share their key with another feed's, so they are left as they are and its entries are written anew`,
        );
      }
      if (held.declared === undefined) return;
      const first = declaredBy.get(held.declared);
      if (first === undefined) {
        declaredBy.set(held.declared, feed);
        return;
      }
      log.condition(
        `same-id:${feed.key}`,
        `${name} declares the same feed id as ${feedName(first)}, and each keeps its own entries`,
      );
    };

    for (const feed of feeds) {
      const name = feedName(feed);
      const { held, id } = records.get(feed) ?? { held: {} };
      const earlier = [
        ...new Set([
          ...(held.key === undefined ? [] : [held.key]),
          ...(held.was ?? []),
        ]),
      ].filter((key) => key !== feed.key);
      const shared = [
        ...new Set([
          ...(held.shared ?? []),
          ...earlier.filter((key) => sharedWith(key, id)),
        ]),
      ];
      const was = earlier.filter((key) => !shared.includes(key));
      const carried: FeedState = {
        ...held,
        ...(was.length > 0 && { was }),
        ...(shared.length > 0 && { shared }),
      };
      kept[feed.key] = carried;
      let fetched;
      try {
        // Rows not yet under this key are read whole, so they move now.
        fetched = await fetchFeed(
          feed,
          held.address === feed.address && held.key === feed.key
            ? held.validators
            : undefined,
          allowed,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const why = refusal(error);
        log.condition(
          why === undefined ? `unreachable:${feed.key}` : `refused:${feed.key}`,
          `${name} ${why ?? "could not be fetched"}`,
        );
        raise(feed, carried);
        continue;
      }
      if (fetched.status === 304) {
        raise(feed, carried);
        continue;
      }
      if (!("bytes" in fetched)) {
        log.condition(
          `status:${feed.key}`,
          `${name} answered ${String(fetched.status)}`,
        );
        raise(feed, carried);
        continue;
      }
      let read;
      try {
        read = await readBounded(
          {
            feed,
            bytes: fetched.bytes,
            contentType: fetched.contentType,
            documentUrl: fetched.url,
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const why = refusal(error);
        log.condition(
          why === undefined ? `unreadable:${feed.key}` : `refused:${feed.key}`,
          `${name} ${why ?? "is not an Atom or RSS 2.0 feed"}`,
        );
        raise(feed, carried);
        continue;
      }
      const now: FeedState = {
        validators: fetched.validators,
        address: feed.address,
        key: feed.key,
        ...(was.length > 0 && { was }),
        ...(shared.length > 0 && { shared }),
        ...(read.unkeyed > 0 && { unkeyed: read.unkeyed }),
        ...(read.declared !== undefined && { declared: read.declared }),
      };
      kept[feed.key] = now;
      raise(feed, now);
      await upsert(
        rssEntry.id,
        was.length === 0
          ? read.entries
          : read.entries.map((entry) => {
              const id = entry.source_id.slice(feed.key.length);
              return { ...entry, movedFrom: was.map((key) => `${key}${id}`) };
            }),
      );
    }
    state.set("feeds", { ...kept, ...Object.fromEntries(departed) });
  },
});

await main(connector);
