# RSS

Reads feeds in Atom, RSS 2.0, RSS 1.0 (RDF) and JSON Feed into `rss.entry` rows at the feed tier, one row for each entry. It only reads: nothing goes back to a feed. By default it keeps only the addresses of an entry's pictures; if you ask it to, it also saves those pictures as files attached to the entry (see [Saving pictures](#saving-pictures)). It never writes an entry into the library, and moving an entry to the library is a person's or an app's act. A picture file reaches the library only as part of an entry that is already there.

## What it does

Each run fetches every feed in `RSS_FEEDS`, reads the entries it finds, and writes the ones that are new or changed. A feed that has not changed since the last run, as its server says by answering 304, is not read again. That progress is saved for each feed once Marfa has taken all of that feed's entries. When Marfa refuses an entry, only its feed keeps the progress it had before, so the next run reads that feed again, and the other feeds keep theirs. Every request carries the `User-Agent` `MarfaRSS (+https://github.com/withmarfa/marfa-connectors)`, so a feed's owner can tell who is reading. A run reports its counts, such as `created 4, updated 0, archived 0, unchanged 0, skipped 0`, and the conditions it raised. Read them with `marfa connectors runs <connector-id>`; `marfa connectors list` shows the id.

## Set it up

You need a Marfa server, the CLI (`marfa`), a credential that can mint keys, and Node 22.13 or later.

1. From the repository root, install and build:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. Mint the connector's key, with `marfa` pointed at your server (`MARFA_API_URL`, and `MARFA_API_KEY` set to a key that holds `keys.mint` and the content permissions listed below):

   ```bash
   marfa keys create --label rss --source rss --type-permission rss.entry=write --metadata-permission types=write --default-tier feed
   ```

   The answer shows the key once; keep it in your secret store.

   - `--source rss`: the source every row the connector writes carries.
   - `--type-permission rss.entry=write`: read and write on its one type, and on nothing else.
   - `--metadata-permission types=write`: lets it register `rss.entry` on its first start and keep the type current.
   - `--default-tier feed`: puts what it writes in the feed.

   To have the connector save pictures, set `RSS_PICTURES` to `save` or `save-in-library`, and mint the key with two more permissions:

   ```bash
   marfa keys create --label rss --source rss --type-permission rss.entry=write --type-permission rss.picture=write --edge-permission attached-to=write --metadata-permission types=write --default-tier feed
   ```

   - `--type-permission rss.picture=write`: read and write on the picture type, which the connector registers.
   - `--edge-permission attached-to=write`: lets it attach a picture to its entry. The connection type ships with Marfa, so the connector does not register it.

   The key holds no other permission, and the connector refuses to run on a key that holds more, or less, naming what is wrong. That includes the picture permissions: they belong on the key only when `RSS_PICTURES` is `save` or `save-in-library`, and a key that holds them is refused while it is `addresses`. Changing the setting therefore means a key of the other shape. Revoke such a key with `marfa keys revoke <key-id>` and mint another as above. [The template's README](../../template/README.md#the-key) says why the key has this shape, and how to give a second account's connector its own key.

3. Set the connector's settings, below, and run it.

## Settings

The connector reads its settings from the environment.

| Variable            | Required | What it holds                                                                                            |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `MARFA_API_URL`     | yes      | The address of the Marfa server.                                                                         |
| `MARFA_API_KEY`     | yes      | The connector's key from step 2.                                                                         |
| `RSS_FEEDS`         | yes      | The feeds to read, as below. A secret.                                                                   |
| `RSS_PRIVATE_HOSTS` | no       | Host names that may resolve to this machine or a private network, set apart by whitespace.               |
| `RSS_PICTURES`      | no       | What to do with the pictures an entry points to: `addresses` (the default), `save` or `save-in-library`. |

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

For a picture the leave is narrower. A listed host is allowed for a picture only when the picture is on the same host as the feed its entry came from. A picture on any other private host is refused as `private_address`, whatever this setting lists, so one feed's text cannot make the connector fetch an internal host that is listed for another feed. A picture on a public host is unaffected.

### `RSS_PICTURES`

- `addresses` (the default): the connector keeps the addresses of an entry's pictures in its text and `image_url`, and fetches nothing from them. The rows, the type and the key are exactly as they are without this setting.
- `save`: the connector saves the pictures of every entry, whether it is in the feed or in the library, as files attached to the entry. A picture of an entry in the library is written at the library tier, and a picture of an entry in the feed at the feed tier.
- `save-in-library`: the connector saves the pictures only of entries that are already in the library. An entry in the feed gets none until a person or an app moves it.

Any other value stops the start with exit code 2. [Saving pictures](#saving-pictures) says what is saved and how.

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

[The template's README](../../template/README.md#run-it) says more about both schedules, including a launchd example and a container image: build one with `docker build -f template/Dockerfile --build-arg CONNECTOR=rss -t rss .` and pass the settings with `-e`. The connector keeps no file. Its state, which holds the validators it asks each feed with, the keys each feed's rows were written under, and whether a feed is gone or has moved, is on the instance, so a new process or container picks up where the last left off.

Keep `RSS_FEEDS` and `MARFA_API_KEY` in your secret store and start the connector under a tool that sets them, so neither is in a file in the checkout or in a launchd plist.

## What lands in Marfa

Each entry is an `rss.entry` row, a kind of `core.bookmark`, written at the feed tier with the source `rss`. The row's `source_id` is the feed's identity, a hash of its name or, without one, its address, then a colon, then the entry's id.

| Field          | What it holds                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry_id`     | The entry's id in its feed: its Atom `id`, RSS `guid`, RSS 1.0 `rdf:about` or JSON Feed `id`, else its link. An entry with none of these has nothing to be known by, and is left out. |
| `url`          | The entry's link: an Atom entry's `alternate` link, an RSS item's `link`, or a JSON Feed item's `url`.                                                                                |
| `title`        | The entry's title as plain text: entities decoded, markup removed and whitespace collapsed, whatever the feed's format.                                                               |
| `description`  | The entry's summary as plain text. Where the summary is only a picture, the picture's `title` text, else its `alt` text.                                                              |
| `body`         | The entry's content as Markdown. Where the feed gives no content, its summary as Markdown, if the summary holds markup. See below.                                                    |
| `author`       | The first author the entry names, else, for Atom and JSON Feed, the feed's first author.                                                                                              |
| `published_at` | When the feed says the entry was published, in UTC.                                                                                                                                   |
| `image_url`    | The entry's image enclosure, else the first picture in its content or summary, else its first `media:thumbnail`. See below.                                                           |
| `source_url`   | The address of the feed's site.                                                                                                                                                       |
| `source_title` | The feed's title, as plain text in the same way.                                                                                                                                      |
| `language`     | The feed's language, or for a JSON Feed the item's own, as a BCP 47 tag, where it gives one that is well formed.                                                                      |
| `feed_origin`  | The scheme, host and port of the feed's address, with no path or query, where a private feed carries its token.                                                                       |
| `feed_hash`    | The hash that identifies the feed, the same for every entry of one feed.                                                                                                              |

The connector writes a field only where the feed has a value for it. A value longer than 100,000 characters, which Marfa refuses, is left out of its entry, and the rest of the entry is written. Each run names what it left out.

Links are resolved against the feed's `xml:base`, or else the address the feed was fetched from. Credentials in a link are dropped. A link relative to the path the feed was fetched from is not written, since it would carry that path, where a private feed may carry its token.

### Formats

The connector reads four formats, and writes the same fields for each:

- Atom;
- RSS 2.0;
- RSS 1.0, which is RDF: an item's `rdf:about` is its id, else its link, and its `dc:date` and `dc:creator` are its date and author; and
- JSON Feed: an item's `id`, `url`, `title`, `content_html` or `content_text`, `summary`, `image`, `banner_image`, `date_published`, `authors` and `language`, and the feed's `title`, `home_page_url`, `authors` and `language`.

A document in another format is skipped and named in the run. The connector reads a feed by what the document is, not by the content type its server names.

### Content and description

Where a feed gives an entry content (an Atom `content`, an RSS `content:encoded`), `body` holds it and `description` holds the plain text of the summary, if there is one.

An item's `body` is Markdown. Where the content is HTML, the connector converts it before it writes: an Atom `content` of type `html` or `xhtml`, an RSS `content:encoded`, and a JSON Feed `content_html`. Headings, emphasis, links, lists, quotes, code and tables stay, and a picture becomes a Markdown image. A script, a style, a frame, a video or audio player, a form control and a picture that counts the reader (one pixel wide or high, or from a known tracker such as FeedBurner or WordPress stats) are dropped. A link or picture address is resolved the way the entry's other links are, against the entry's base, and one that is not an `http` or `https` address, or is relative to the path the feed was fetched from, is left out, keeping a link's text. A `mailto:` link is kept. Content that is text is written as it is, without escaping: an Atom `content` of type `text`, a JSON Feed `content_text`, and an RSS description with no HTML in it.

Markup longer than 600,000 characters, with more than 25,000 elements or nested more than 200 levels deep is not converted. The entry is written without a `body`, and the run names how many entries that happened to. A JSON Feed entry with a `content_text` uses it as its body instead, and the run counts those apart. The rest of the feed is read as usual.

A feed's conversions share 12 seconds. If a feed runs out of them, the run says it ran out of time, and the entries whose markup comes after that point are not written. The connector also drops the feed's saved validators, so the next run reads the feed again, whatever its server says, and writes those entries with their bodies. The entries converted in time are written, and the bodies Marfa already holds for the others are not changed.

In a JSON Feed, `content_html` is the content and is converted to Markdown. `content_text` is the content as plain text, so `body` holds it as it is, and it is also the fallback when `content_html` is refused or converts to nothing. A `summary` is plain text, so it goes to `description` alone, and a JSON Feed item with only a summary has no `body`.

Where the summary or description is the feed's only content, `body` holds it as Markdown and `description` holds its plain text. This applies when the summary holds markup: an Atom summary of type `html` or `xhtml`, or an RSS 2.0 or RSS 1.0 description with HTML in it, which RSS 2.0 allows to be entity-encoded. An Atom summary of type `text`, or a description without markup, is plain text already, so it goes to `description` alone. A summary whose markup shows nothing once converted, such as a lone tracking pixel, empty paragraphs and line breaks, or only an embedded player or frame, gives no `body`.

The conversion drops what runs, but `body` is still text a feed wrote: treat it as untrusted wherever it is shown.

A summary that is only a picture, as in a comic's feed, gives a `body` that is the picture as a Markdown image, a `description` from the picture's `title` text, else its `alt` text, and an `image_url`.

### Which images count

An entry with an image enclosure takes it as `image_url`: an Atom `enclosure` link or an RSS `enclosure` of an image type, or in a JSON Feed the item's `image`, else its `banner_image`. Otherwise `image_url` is the first `<img>` in the entry's content, else in its summary, that counts. Only where none does, it is the first `media:thumbnail` of the entry that counts, looked for on the entry, then in its `media:content` elements, then in its `media:group` elements. An `<img>` does not count when:

- it has no `src`, or its `src` is not an `http` or `https` address once resolved, such as a `data:` URI;
- its `src` is a link relative to the feed's fetch path, as above; or
- it declares a `width` or `height` of 0 or 1 pixel, as a tracking pixel does.

A `media:thumbnail` is held to the same rules, with its `url` for the `src`.

Only the declared size is read, and one that is hidden by a style or sized by the stylesheet counts. A picture is fetched only when `RSS_PICTURES` is `save` or `save-in-library`, as [Saving pictures](#saving-pictures) says.

### Dates

`published_at` is the entry's published time: an Atom `published`, an RSS `pubDate`, an RSS 1.0 `dc:date` or a JSON Feed `date_published`. The entry's own time in Marfa, its `occurred_at`, is that time, else an Atom `updated`, an RSS 2.0 `dc:date` or a JSON Feed `date_modified`.

An entry with none of these has no date from its feed. Marfa then dates it by when the connector first stored it. That date does not move when the entry is read again, however the entry changes, until the feed gives the entry a date of its own. The first run over a feed therefore gives every undated entry in it the time of that run. The connector keeps no date of its own for these entries: one kept in its state would be the same time, and the state would grow with every entry.

### What identifies an entry

An entry is its feed's identity and its `entry_id`. A change to an entry's title, content or link, where it has an id, updates its row. A change to how the connector renders an entry, such as the Markdown conversion, reaches entries already stored the next time their feed is read, and the connector reads every feed whole once after such a release, though its server says it has not changed. An entry its feed no longer carries is not read again, so it keeps the body it was written with. A change to an entry's id makes a new row, and so does a change to the link of an entry that has no `guid` or Atom `id`, since its link is its id. Moving a feed that has no name makes a new row of every entry.

## Saving pictures

With `RSS_PICTURES` set to `save` or `save-in-library`, the connector fetches the pictures an entry points to and saves each one as a file in Marfa. The entry's text is not changed: its `body` and `image_url` still hold the addresses the feed gave.

### Choices that are easy to miss

- A picture a person trashed or purged is never saved again for that entry, even when the entry's text changes.
- `save` covers entries in the library as well as in the feed.
- A fetch that fails in a way that may pass (see [When a picture is tried again](#when-a-picture-is-tried-again)) is tried up to three times, one run at a time, before it is recorded as not kept.
- A picture the entry's text no longer mentions is kept.
- The time spent fetching pictures in a run is capped at 10 minutes.
- A private host is allowed for a picture only on the host of its own entry's feed.

### What is saved

For each entry it is allowed to work on, the connector takes the entry's `image_url`, then the Markdown images in its `body`, in that order, each address once. Only an address that is `https` is fetched. An `http` address is never fetched and is recorded as not kept with the reason `not_https`; a redirect to an `http` address is refused for the same reason. A relative address, another scheme and an address longer than 2,048 characters are not addresses to save and are ignored.

Every picture is fetched with the connector kit's picture fetch. It follows at most four redirects, each to an `https` address; refuses a private or local address unless `RSS_PRIVATE_HOSTS` names its host and the picture is on the same host as its entry's feed; refuses a known tracker; reads at most 25 MiB; and keeps only a PNG, JPEG, GIF, WebP, AVIF or HEIC file that is neither one pixel wide nor one pixel high and is not larger than 100 million pixels. An SVG file is refused.

Each saved picture is an `rss.picture` row, a kind of `core.file.image`, with these fields:

| Field                   | What it holds                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `source_url`            | The web address the picture was saved from, as the entry gave it, in the standard form a URL parser writes.             |
| `title`                 | `p-`, the first 12 characters of a hash of that address, then the extension for its type, such as `p-0123456789ab.png`. |
| `blob_ref`, `mime_type` | The file, and its type, as for every file in Marfa.                                                                     |

An `attached-to` connection runs from the picture to its entry. To find the pictures of an entry, follow its `attached-to` connections, and match a picture to an address in the entry's text by `source_url`. The title is the same for the same address wherever it appears, so a picture is told apart by its address and never by its file name: two sites that both serve `cat.png` give two pictures.

### What the entry records

Marfa does not show an entry's pictures from its text alone, so the entry carries `rss_pictures`, a read-only field the connector sets. It holds:

- `text`: a hash of the text (`body` and `image_url`) the addresses were read from;
- `saved`: the addresses whose pictures are held;
- `pending`: the addresses the connector will try again, or has not reached yet;
- `not_kept`: each address it gave up on, with a reason;
- `attempts`, where an address is pending: how many runs it has failed in; and
- `over`, where the entry had more than 20 addresses: how many past the first 20 were not read.

The reason for an address that was not kept is `removed` (a person trashed or purged the picture), `not_https`, or the reason the picture fetch gave: `invalid_address`, `private_address`, `tracker`, `too_many_redirects`, `bad_status`, `too_large`, `timed_out`, `fetch_failed`, `not_a_picture`, `svg`, `one_pixel`, `too_large_dimensions` or `upload_failed`. The addresses are not secrets, so signed ones should not be in a feed. An entry without `rss_pictures` has had no picture work done.

### When a picture is tried again

- An address in `saved` or `not_kept` is not fetched again while the entry's text is the one in `text`.
- When the text changes, the connector reads the addresses again. An address that was not kept is tried again; one already saved is kept without a new fetch.
- A fetch that fails in a way that may pass stays in `pending` and is tried in the next run, up to three runs in all, and is then recorded as not kept. These failures may pass:
  - `timed_out` and `fetch_failed`;
  - `upload_failed`, a file Marfa did not take;
  - `bad_status` when the picture's host answered 408, 425, 429 or any status from 500 up, such as a 503 from a host that is busy.
- Any other `bad_status`, such as a 404 or a 403, is the host's answer about that picture. It is recorded as not kept at once and is not asked for again until the text changes. The connector does not wait for the time a host names in `Retry-After`; it asks again in its next run.
- A picture a person trashed or purged is not saved again for that entry, even when the text changes.
- A picture the text no longer mentions stays where it is. The connector never removes a file it saved because the text stopped pointing at it.

### Limits

| Limit                        | Value      | Where it is reached                                                                                                                                                    |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pictures read from one entry | 20         | The rest are only counted, in `over`.                                                                                                                                  |
| Pictures fetched in one run  | 100        | The rest stay in `pending`, and the run raises `pictures:limit`.                                                                                                       |
| Bytes saved in one run       | 200 MiB    | A picture that would pass it stays in `pending`; the run raises `pictures:limit`.                                                                                      |
| Time spent fetching pictures | 10 minutes | No fetch starts after it, and the rest stay in `pending`; the run raises `pictures:limit`. A fetch already begun is allowed to finish, which takes at most 30 seconds. |

The limits are for each run, not for the connector's lifetime. A feed with a large backlog of pictures, such as the first run over a long feed, is therefore saved over many runs: each run saves up to its limits and the next carries on from where it stopped. Nothing is lost by this, and an operator has nothing to do but let the runs happen. The run's log line, which holds `340 left for the next run` when 340 pictures remain, says how many do.

An address in `pending` is one the connector has not finished with: it was not reached because a limit came first, or its fetch failed in a way that may pass and it is being tried again. It is not an error, and a person has no step to take. Each run takes up pending addresses again, and an address leaves `pending` when it is saved or recorded as not kept.

A run that has pictures to save does them after every feed has been read. To know which pictures it holds and which are attached to their entries, it reads the connector's `rss.picture` rows with their connections in pages of up to 200, so reading them costs about one request for every 200 pictures, and not one for every entry. A failure in the pictures, including a read that Marfa refuses, such as with `rate_limited`, is raised as `pictures:failed` and does not fail the feeds. The first read comes before any picture is fetched or written, so when Marfa refuses it nothing has changed, and the next run reads again. A later read, made after pictures were archived or brought back, can fail after those writes; they stand, and the next run reads again.

### `save` and `save-in-library`

With `save`, the connector works from every entry of its own. A picture is written at the tier its entry is in when the picture is created: the feed tier for an entry in the feed, and the library tier for an entry in the library. A picture keeps its tier if its entry later moves.

With `save-in-library`, the connector works from the entries of its own that are in the library. It looks for them at the start of each run, so a picture is saved up to one run interval after an entry reaches the library, and not at the moment it does. Its pictures are written at the library tier, since they belong to something already there. An entry in the feed, whether it was never moved or is moved back, gets no new pictures; the pictures it already has stay where they are, at the tier they were saved in.

### When an entry leaves

A picture follows its entry out of use. When an entry is archived or trashed, or is gone, the next run archives the pictures saved for it, so the file is not left on its own. When an entry that had its pictures archived this way is active again, the next run brings back those the entry's text still points to, without fetching them again. It brings back only a picture this connector archived: a picture that a person archived or trashed, or that was archived by anything else, stays as it is. If the connector's record of having archived a picture is lost, the picture is not brought back, and restoring it in Marfa is a person's step. The connector does not trash or purge a picture. A type's retention in Marfa, where an operator has set one on `rss.picture`, applies to these pictures as to any other file.

## What stays

The connector never trashes or removes a row. It archives a row only for a picture whose entry is archived, trashed or gone, and only when `RSS_PICTURES` is not `addresses`; it never archives an entry. It brings a picture back only as the section above says.

- An entry a feed drops stays in Marfa as it was last written. Feeds hold only their latest entries, so this is how the older ones are kept.
- A feed taken out of `RSS_FEEDS` leaves its rows where they are, and stops being read. Put it back, under the same name or address, and it carries on from them. The connector remembers the last hundred feeds that left the list, so a feed that returns finds the rows it wrote before it left.
- A feed moved without a name, as above, leaves its old rows beside the new ones.

To remove rows, trash or purge them in Marfa. A row you trash or purge stays gone: the connector does not write it back, however often the feed is read after.

## Limits and conditions

A feed is skipped, and named in the run, when it:

- is larger than 24 MiB, on the wire or after decompression;
- carries more than 5,000 entries or 300,000 elements;
- needs more memory to read than the connector allows, reads to more than 33,554,432 characters of entries, or takes more than 30 seconds to read;
- is not Atom, RSS 2.0, RSS 1.0 or JSON Feed;
- redirects more than five times, or to this machine or a private network that `RSS_PRIVATE_HOSTS` does not allow;
- does not answer, or answers with a status other than 200 or 304, bar 410, below; or
- answers 410 (gone). This one is not asked again while its address stays the same, and each run says so. Remove it from `RSS_FEEDS`, or give it its new address, which is read at once.

A feed whose listed address answers with a permanent redirect (301 or 308) is still read, from where it moved to, and each run says that it has moved. Update its address in `RSS_FEEDS`; a feed listed without a name starts new rows at its new address, as above, so name it, with its address unchanged, before you change the address. The new address is not named, since it may carry a token. A temporary redirect (302, 303 or 307) raises nothing.

The other feeds are still read. A run fails for its feeds only when none of those in `RSS_FEEDS` could be read.

A feed's address is a secret, since a private feed's address carries its token. The connector keeps it out of every log line and report, the rows and its state. A feed is named instead by its place in `RSS_FEEDS`, counted from 1, and its origin, such as `feed 2 in RSS_FEEDS (https://example.org)`, and its entries carry only its origin and the hash that identifies it, never its path or query.
