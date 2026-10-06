# RSS

Reads Atom and RSS 2.0 feeds into `rss.entry` rows at the feed tier, one row for each entry. It only reads: nothing goes back to a feed, and it never writes into a library type. Promoting an entry out of the feed is a person's or an app's act.

## What it does

Each run fetches every feed in `RSS_FEEDS`, reads the entries it finds, and writes the ones that are new or changed. A feed that has not changed since the last run, as its server says by answering 304, is not read again. That progress is saved for each feed once Marfa has taken all of that feed's entries. When Marfa refuses an entry, only its feed keeps the progress it had before, so the next run reads that feed again, and the other feeds keep theirs. A run reports its counts, such as `created 4, updated 0, archived 0, unchanged 0, skipped 0`, and the conditions it raised. Read them with `marfa connectors runs <connector-id>`; `marfa connectors list` shows the id.

## Set it up

You need a Marfa server, the `marfa` command-line tool, a credential that can mint keys, and Node 22.13 or later.

1. From the repository root, install and build:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. Mint the connector's key, with `marfa` pointed at your server (`MARFA_API_URL`, and `MARFA_API_KEY` set to a key that holds `keys.mint`, such as the operator key):

   ```bash
   marfa keys create --label rss --source rss --type-permission rss.entry=write --metadata-permission types=write --default-tier feed
   ```

   The answer shows the key once; keep it in your secret store.

   - `--source rss`: the source every row the connector writes carries.
   - `--type-permission rss.entry=write`: read and write on its one type, and on nothing else.
   - `--metadata-permission types=write`: lets it register `rss.entry` on its first start and keep the type current.
   - `--default-tier feed`: puts what it writes in the feed.

   The key holds no other permission, and the connector refuses to run on a key that holds more, or less, naming what is wrong. Revoke such a key with `marfa keys revoke <key-id>` and mint another as above. [The template's README](../../template/README.md#the-key) says why the key has this shape, and how to give a second account's connector its own key.

3. Set the connector's settings, below, and run it.

## Settings

The connector reads its settings from the environment.

| Variable            | Required | What it holds                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `MARFA_API_URL`     | yes      | The address of the Marfa server.                                                           |
| `MARFA_API_KEY`     | yes      | The connector's key from step 2.                                                           |
| `RSS_FEEDS`         | yes      | The feeds to read, as below. A secret.                                                     |
| `RSS_PRIVATE_HOSTS` | no       | Host names that may resolve to this machine or a private network, set apart by whitespace. |

### `RSS_FEEDS`

`RSS_FEEDS` holds one entry for each feed, set apart by whitespace, so one per line works. A comma is part of an address, not a separator. An entry is either:

- an `http` or `https` address, such as `https://example.org/feed.xml`; or
- `name=address`, such as `news=https://example.org/feed.xml?token=abc`. The name is any text without whitespace or `=`, and one name stands for one feed, so the same name on two different addresses stops the start.

Give a feed a name when its address may change, or carries a token that rotates. The name, not the address, then identifies the feed, and its entries keep their rows when the address moves. Naming a feed that was listed without a name, with its address unchanged in the same edit, moves its existing rows to the name rather than writing them twice.

Without a name, the address identifies the feed. Two spellings of one address are one feed, read once: `http` and `https`, with and without `www.`, with and without a trailing slash, and with or without credentials or a fragment. A path's case and a query string do count, so a feed that changes its address, or only the token in its query, starts new rows for its entries.

An entry that is not an `http` or `https` address stops the start with exit code 2, without saying which, since an address may hold a token.

An address may carry credentials, as `https://reader:pass@example.org/feed.xml`. The connector sends them as Basic authorization to that address's own origin and to no other, a redirect included.

### `RSS_PRIVATE_HOSTS`

The connector does not fetch from this machine or a private network, whether a feed names one, or redirects to one. An address that lists a private IP address itself is allowed. To read a feed at a host name that resolves to a private address, name the host in `RSS_PRIVATE_HOSTS`, such as `feeds.internal.example`. A host here is allowed for the feed listed at it, and its redirects to the same host, and is never allowed as another feed's redirect. An entry holds a host name only, with no port, path or credentials, or the start stops with exit code 2.

## Run it

Run it once, then exit, from a scheduler such as cron or launchd:

```bash
export MARFA_API_URL=https://marfa.example.com
export MARFA_API_KEY=<the connector's key>
export RSS_FEEDS='https://example.org/feed.xml
news=https://example.com/atom.xml?token=abc'
node connectors/rss/dist/main.js --once
```

The exit code is `0` for a run that succeeded, `1` for a run that failed or a start that could not complete, and `2` for a missing or malformed setting.

Or leave it running, which checks every feed every 15 minutes:

```bash
node connectors/rss/dist/main.js --every 15m
```

[The template's README](../../template/README.md#run-it) says more about both schedules, including a launchd example and a container image: build one with `docker build -f template/Dockerfile --build-arg CONNECTOR=rss -t rss .` and pass the settings with `-e`. The connector keeps no file. Its state, which holds the validators it asks each feed with and the keys each feed's rows were written under, is on the instance, so a new process or container picks up where the last left off.

Keep `RSS_FEEDS` and `MARFA_API_KEY` in your secret store and start the connector under a tool that sets them, so neither is in a file in the checkout or in a launchd plist.

## What lands in Marfa

Each entry is an `rss.entry` row, a kind of `core.bookmark`, written at the feed tier with the source `rss`. The row's `source_id` is the feed's identity, a hash of its name or, without one, its address, then a colon, then the entry's id.

| Field          | What it holds                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entry_id`     | The entry's id in its feed: its Atom `id` or RSS `guid`, else its link. An entry with none of these has nothing to be known by, and is left out.             |
| `url`          | The entry's link: an Atom entry's `alternate` link, or an RSS item's `link`.                                                                                 |
| `title`        | The entry's title, as plain text.                                                                                                                            |
| `description`  | The entry's summary as plain text. Where the summary is only a picture, the picture's `title` text, else its `alt` text.                                     |
| `body`         | The entry's content with its markup, as the feed gave it. Where the feed gives no content, its summary with its markup, if the summary holds any. See below. |
| `author`       | The first author the entry names, else, for Atom, the feed's first author.                                                                                   |
| `published_at` | When the feed says the entry was published, in UTC.                                                                                                          |
| `image_url`    | The entry's image enclosure, else the first picture in its content or summary. See below.                                                                    |
| `source_url`   | The address of the feed's site.                                                                                                                              |
| `source_title` | The feed's title.                                                                                                                                            |
| `language`     | The feed's language, as a BCP 47 tag, where it gives one that is well formed.                                                                                |
| `feed_origin`  | The scheme, host and port of the feed's address, with no path or query, where a private feed carries its token.                                              |
| `feed_hash`    | The hash that identifies the feed, the same for every entry of one feed.                                                                                     |

The connector writes a field only where the feed has a value for it. A value longer than 100,000 characters, which Marfa refuses, is left out of its entry, and the rest of the entry is written. Each run names what it left out.

Links are resolved against the feed's `xml:base`, or else the address the feed was fetched from. Credentials in a link are dropped. A link relative to the path the feed was fetched from is not written, since it would carry that path, where a private feed may carry its token.

### Content and description

Where a feed gives an entry content (an Atom `content`, an RSS `content:encoded`), `body` holds it and `description` holds the plain text of the summary, if there is one.

Where the summary or description is the feed's only content, `body` holds its markup and `description` holds its plain text. This applies when the summary holds markup: an Atom summary of type `html` or `xhtml`, or an RSS description with HTML in it, which RSS 2.0 allows to be entity-encoded. An Atom summary of type `text`, or a description without markup, is plain text already, so it goes to `description` alone. A summary whose markup shows nothing, such as a lone tracking pixel or empty paragraphs and line breaks, gives no `body`; one that shows anything else, such as an embedded player or a picture that does not count as the entry's image, keeps its markup in `body`.

The connector does not clean the markup it keeps in `body`. Treat it as untrusted wherever it is shown.

A summary that is only a picture, as in a comic's feed, gives a `body` that is the picture's markup, a `description` from the picture's `title` text, else its `alt` text, and an `image_url`.

### Which images count

An entry with an image enclosure takes it as `image_url`. Otherwise `image_url` is the first `<img>` in the entry's content, else in its summary, that counts. An `<img>` does not count when:

- it has no `src`, or its `src` is not an `http` or `https` address once resolved, such as a `data:` URI;
- its `src` is a link relative to the feed's fetch path, as above; or
- it declares a `width` or `height` of 0 or 1 pixel, as a tracking pixel does.

Only the declared size is read: a picture is never fetched, and one that is hidden by a style or sized by the stylesheet counts.

### Dates

`published_at` is the entry's published time: an Atom `published`, or an RSS `pubDate`. The entry's own time in Marfa, its `occurred_at`, is that time, else an Atom `updated` or an RSS `dc:date`.

An entry with none of these has no date from its feed. Marfa then dates it by when the connector first stored it. That date does not move when the entry is read again, however the entry changes, until the feed gives the entry a date of its own. The first run over a feed therefore gives every undated entry in it the time of that run. The connector keeps no date of its own for these entries: one kept in its state would be the same time, and the state would grow with every entry.

### What identifies an entry

An entry is its feed's identity and its `entry_id`. A change to an entry's title, content or link, where it has an id, updates its row. A change to an entry's id makes a new row, and so does a change to the link of an entry that has no `guid` or Atom `id`, since its link is its id. Moving a feed that has no name makes a new row of every entry.

## What stays

The connector never archives, trashes or removes a row.

- An entry a feed drops stays in Marfa as it was last written. Feeds hold only their latest entries, so this is how the older ones are kept.
- A feed taken out of `RSS_FEEDS` leaves its rows where they are, and stops being read. Put it back, under the same name or address, and it carries on from them. The connector remembers the last hundred feeds that left the list, so a feed that returns finds the rows it wrote before it left.
- A feed moved without a name, as above, leaves its old rows beside the new ones.

To remove rows, trash or purge them in Marfa. A row you trash or purge stays gone: the connector does not write it back, however often the feed is read after.

## Limits and conditions

A feed is skipped, and named in the run, when it:

- is larger than 24 MiB, on the wire or after decompression;
- carries more than 5,000 entries or 300,000 elements;
- needs more memory to read than the connector allows, reads to more than 33,554,432 characters of entries, or takes more than 30 seconds to read;
- is not Atom or RSS 2.0;
- redirects more than five times, or to this machine or a private network that `RSS_PRIVATE_HOSTS` does not allow; or
- does not answer, or answers with a status other than 200 or 304.

The other feeds are still read. A run fails for its feeds only when none of those in `RSS_FEEDS` could be read.

A feed's address is a secret, since a private feed's address carries its token. The connector keeps it out of every log line and report, the rows and its state. A feed is named instead by its place in `RSS_FEEDS`, counted from 1, and its origin, such as `feed 2 in RSS_FEEDS (https://example.org)`, and its entries carry only its origin and the hash that identifies it, never its path or query.
