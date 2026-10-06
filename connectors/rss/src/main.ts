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
  maxFieldLength,
  privateHosts,
  TooManyElements,
  TooManyEntries,
  type Feed,
  type Validators,
} from "./feeds.js";
import {
  failureOf,
  maxFeedBytes,
  maxRedirects,
  RefusedAddress,
  TooLarge,
  TooManyRedirects,
} from "./fetch.js";
import {
  parseLimits,
  parseTimeoutMs,
  maxResultChars,
  readBounded,
  TooBig,
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
  dropped?: number;
  declared?: string;
  /** When it left RSS_FEEDS, for a feed kept only so its earlier keys are
   *  named again if it returns. */
  left?: string;
  /** Set when its address answered 410: it is not read again while its
   *  `address` stays the one that answered. */
  gone?: true;
  /** Set when its address answers with a permanent redirect, which is
   *  followed. */
  moved?: true;
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
  if (error instanceof TooBig) {
    return `reads to more than ${String(maxResultChars / 1024 / 1024)} Mi characters of entries, so it is skipped`;
  }
  if (error instanceof TooSlow) {
    return `takes longer than ${String(parseTimeoutMs / 1000)} seconds to read, so it is skipped`;
  }
  return undefined;
}

const connector = defineConnector({
  name: "rss",
  description: "Entries from Atom, RSS and JSON feeds.",
  source: "rss",
  readme: "connectors/rss/README.md",
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
  async run({ env, signal, state, log, forScope }) {
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
      if (held.moved === true) {
        log.condition(
          `moved:${feed.key}`,
          `${name} has moved permanently, and is followed; update its address in RSS_FEEDS`,
        );
      }
      if (held.gone === true && held.address === feed.address) {
        log.condition(
          `gone:${feed.key}`,
          `${name} answered 410, so it is not read again while its address stays the same; remove it from RSS_FEEDS, or change its address if the feed has a new one`,
        );
      }
      const long = held.dropped ?? 0;
      if (long > 0) {
        log.condition(
          `long:${feed.key}`,
          long === 1
            ? `a value in ${name} is longer than ${String(maxFieldLength)} characters, and is left out`
            : `${String(long)} values in ${name} are longer than ${String(maxFieldLength)} characters, and are left out`,
        );
      }
      const count = held.unkeyed ?? 0;
      if (count > 0) {
        log.condition(
          `unkeyed:${feed.key}`,
          count === 1
            ? `an entry in ${name} has no id or link to be known by, or only one over 100,000 characters, and is left out`
            : `${String(count)} entries in ${name} have no id or link to be known by, or only one over 100,000 characters, and are left out`,
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

    // A checkpoint replaces the whole value, so the candidate is the last
    // acknowledged one with this feed's entry alone changed.
    const checkpointed = async (
      feed: Feed,
      id: string | undefined,
      next: FeedState,
    ) => {
      const scope = forScope(feed.key);
      const saved = {
        ...((scope.state.get("feeds") ?? {}) as Record<string, FeedState>),
      };
      if (id !== undefined && id !== feed.key) {
        Reflect.deleteProperty(saved, id);
      }
      saved[feed.key] = next;
      return scope.state.checkpoint("feeds", saved);
    };

    let read = 0;
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
      let carried: FeedState = {
        ...held,
        ...(was.length > 0 && { was }),
        ...(shared.length > 0 && { shared }),
      };
      kept[feed.key] = carried;
      if (held.gone === true && held.address === feed.address) {
        raise(feed, carried);
        continue;
      }
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
          `${name} ${why ?? `could not be fetched: ${failureOf(error)}`}`,
        );
        raise(feed, carried);
        continue;
      }
      carried = { ...carried };
      if (fetched.moved) carried.moved = true;
      else Reflect.deleteProperty(carried, "moved");
      kept[feed.key] = carried;
      if (fetched.status === 410) {
        Reflect.deleteProperty(carried, "validators");
        carried = { ...carried, address: feed.address, gone: true };
        kept[feed.key] = carried;
        raise(feed, carried);
        await checkpointed(feed, id, carried);
        continue;
      }
      if (fetched.status === 304) {
        read += 1;
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
      let parsed;
      try {
        parsed = await readBounded(
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
          `${name} ${why ?? "is not an Atom, RSS or JSON feed"}`,
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
        ...(fetched.moved && { moved: true as const }),
        ...(parsed.unkeyed > 0 && { unkeyed: parsed.unkeyed }),
        ...(parsed.dropped > 0 && { dropped: parsed.dropped }),
        ...(parsed.declared !== undefined && { declared: parsed.declared }),
      };
      read += 1;
      kept[feed.key] = now;
      raise(feed, now);
      signal.throwIfAborted();
      // Each feed is a scope of its own, so its reading progress is saved
      // once its entries are acknowledged and a refused entry in one feed
      // holds back that feed alone.
      await forScope(feed.key).upsert(
        rssEntry.id,
        was.length === 0
          ? parsed.entries
          : parsed.entries.map((entry) => {
              const id = entry.source_id.slice(feed.key.length);
              return { ...entry, movedFrom: was.map((key) => `${key}${id}`) };
            }),
      );
      const progress = await checkpointed(feed, id, now);
      if (!progress.committed) {
        kept[feed.key] = carried;
        log.condition(
          `progress:${feed.key}`,
          `${name} is read again next run, since its reading progress was not saved (${progress.reason})`,
        );
      }
    }
    if (feeds.length > 0 && read === 0) {
      throw new Error(
        feeds.length === 1
          ? "the feed in RSS_FEEDS could not be read, so this run read nothing"
          : `none of the ${String(feeds.length)} feeds in RSS_FEEDS could be read, so this run read nothing`,
      );
    }
    state.set("feeds", { ...kept, ...Object.fromEntries(departed) });
  },
});

await main(connector);
