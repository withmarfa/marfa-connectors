import {
  defineConnector,
  main,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  feedList,
  feedName,
  fetchFeed,
  readFeed,
  type Validators,
} from "./feeds.js";
import rssEntry from "./rss.entry.json" with { type: "json" };

const connector = defineConnector({
  name: "rss",
  description: "Entries from Atom and RSS 2.0 feeds.",
  source: "rss",
  // Imported JSON widens every string, so its field types read as `string`
  // here; the check on start holds the file to the server's type.
  type: rssEntry as TypeDefinition,
  env: {
    RSS_FEEDS: "required",
  },
  async run({ env, signal, state, log, upsert }) {
    const feeds = feedList(env.RSS_FEEDS);
    const known = (state.get("validators") ?? {}) as Record<string, Validators>;
    const validators: Record<string, Validators> = {};

    // A feed that fails is a condition of that feed alone: the others are
    // read, and its validators stay as they were so it is asked again whole.
    for (const feedUrl of feeds) {
      const name = feedName(feedUrl);
      const held = known[feedUrl];
      if (held !== undefined) validators[feedUrl] = held;
      let fetched;
      try {
        fetched = await fetchFeed(feedUrl, held, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        log.condition(
          `unreachable:${feedUrl}`,
          `the feed ${name} could not be fetched`,
        );
        continue;
      }
      if (fetched.status === 304) continue;
      if (!("text" in fetched)) {
        log.condition(
          `status:${feedUrl}`,
          `the feed ${name} answered ${String(fetched.status)}`,
        );
        continue;
      }
      let read;
      try {
        read = readFeed(feedUrl, fetched.text);
      } catch {
        log.condition(
          `unreadable:${feedUrl}`,
          `the feed ${name} is not an Atom or RSS 2.0 feed`,
        );
        continue;
      }
      if (read.unkeyed > 0) {
        log.condition(
          `unkeyed:${feedUrl}`,
          read.unkeyed === 1
            ? `an entry in the feed ${name} carries neither an id nor a link, and is left out`
            : `${String(read.unkeyed)} entries in the feed ${name} carry neither an id nor a link, and are left out`,
        );
      }
      await upsert(read.entries);
      validators[feedUrl] = fetched.validators;
    }
    state.set("validators", validators);
  },
});

await main(connector);
