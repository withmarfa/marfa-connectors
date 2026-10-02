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
  readFeed,
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
}

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
  },
  async run({ env, signal, state, log, upsert }) {
    const feeds = feedList(env.RSS_FEEDS);
    const allowed = privateHosts(env.RSS_PRIVATE_HOSTS);
    const known = (state.get("feeds") ?? {}) as Record<string, FeedState>;
    const configured = new Set(feeds.map((feed) => feed.key));
    const claimed = new Set<string>();
    const kept: Record<string, FeedState> = {};
    const declaredBy = new Map<string, Feed>();
    const holders = new Map<string, number>();
    for (const held of Object.values(known)) {
      for (const key of new Set([
        ...(held.key === undefined ? [] : [held.key]),
        ...(held.was ?? []),
      ])) {
        holders.set(key, (holders.get(key) ?? 0) + 1);
      }
    }

    // A feed renamed, or named for the first time, finds its rows by its
    // address; one moved under its name keeps its key.
    const previous = (feed: Feed): FeedState => {
      const own = known[feed.key];
      if (own !== undefined) {
        return { ...own, address: own.address ?? feed.key };
      }
      for (const [key, held] of Object.entries(known)) {
        if (configured.has(key) || claimed.has(key)) continue;
        const address = held.address ?? key;
        if (address === feed.address) {
          claimed.add(key);
          return { ...held, address };
        }
      }
      return {};
    };

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
      const held = previous(feed);
      const earlier = [
        ...new Set([
          ...(held.key === undefined ? [] : [held.key]),
          ...(held.was ?? []),
        ]),
      ].filter((key) => key !== feed.key);
      const shared = [
        ...new Set([
          ...(held.shared ?? []),
          ...earlier.filter((key) => (holders.get(key) ?? 0) > 1),
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
      if (!("text" in fetched)) {
        log.condition(
          `status:${feed.key}`,
          `${name} answered ${String(fetched.status)}`,
        );
        raise(feed, carried);
        continue;
      }
      let read;
      try {
        read = readFeed(feed, fetched.text, fetched.url);
      } catch (error) {
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
    state.set("feeds", kept);
  },
});

await main(connector);
