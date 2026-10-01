import {
  defineConnector,
  main,
  type Log,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  entryFields,
  feedHash,
  feedList,
  feedName,
  fetchFeed,
  readFeed,
  type Validators,
} from "./feeds.js";
import rssEntry from "./rss.entry.json" with { type: "json" };

interface FeedState {
  validators?: Validators;
  key?: string;
  unkeyed?: number;
  sameAs?: string;
}

// A feed not read this run (304 or failed) raises its conditions again; the
// kit would otherwise take them as cleared.
function raiseHeld(log: Log, id: string, name: string, feed: FeedState): void {
  const count = feed.unkeyed ?? 0;
  if (count > 0) {
    log.condition(
      `unkeyed:${id}`,
      count === 1
        ? `an entry in the feed ${name} carries neither an id nor a link, and is left out`
        : `${String(count)} entries in the feed ${name} carry neither an id nor a link, and are left out`,
    );
  }
  if (feed.sameAs !== undefined) {
    log.condition(
      `same:${id}`,
      `the feed ${name} is the feed ${feed.sameAs} under another address, and is read once`,
    );
  }
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
  },
  checkEnv(env) {
    feedList(env.RSS_FEEDS);
  },
  async run({ env, signal, state, log, upsert }) {
    const feeds = feedList(env.RSS_FEEDS);
    const known = (state.get("feeds") ?? {}) as Record<string, FeedState>;
    const kept: Record<string, FeedState> = {};
    const read = new Map<string, string>();

    for (const feedUrl of feeds) {
      const name = feedName(feedUrl);
      const id = feedHash(feedUrl);
      const held = known[id] ?? {};
      kept[id] = held;
      const unread = (): void => {
        if (held.key !== undefined && !read.has(held.key)) {
          read.set(held.key, name);
        }
        raiseHeld(log, id, name, held);
      };
      let fetched;
      try {
        fetched = await fetchFeed(feedUrl, held.validators, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        log.condition(
          `unreachable:${id}`,
          `the feed ${name} could not be fetched`,
        );
        unread();
        continue;
      }
      if (fetched.status === 304) {
        unread();
        continue;
      }
      if (!("text" in fetched)) {
        log.condition(
          `status:${id}`,
          `the feed ${name} answered ${String(fetched.status)}`,
        );
        unread();
        continue;
      }
      let entries;
      try {
        entries = readFeed(feedUrl, fetched.text, fetched.url);
      } catch {
        log.condition(
          `unreadable:${id}`,
          `the feed ${name} is not an Atom or RSS 2.0 feed`,
        );
        unread();
        continue;
      }
      const first = read.get(entries.key);
      const now: FeedState = {
        validators: fetched.validators,
        key: entries.key,
        ...(entries.unkeyed > 0 && { unkeyed: entries.unkeyed }),
        ...(first !== undefined && { sameAs: first }),
      };
      kept[id] = now;
      raiseHeld(log, id, name, now);
      if (first !== undefined) continue;
      read.set(entries.key, name);
      await upsert(rssEntry.id, entries.entries);
    }
    state.set("feeds", kept);
  },
});

await main(connector);
