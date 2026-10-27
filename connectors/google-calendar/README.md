# Google Calendar

Reads the calendars and events of a Google account into Marfa, and carries changes made to events in Marfa back to Google Calendar. It never invites anyone and never has Google email anyone. It signs in through the shared [Google sign-in](../../shared/google/README.md), so it uses the same OAuth client and refresh token as any other Google connector.

For how to build, deploy and run a connector, see the [template README](../../template/README.md). This page covers what is specific to Google Calendar.

## What it reads

| Marfa type                 | Holds                                                         | Linked by                               |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `google.calendar.calendar` | One row for each calendar the connector reads.                | `calendar_id`                           |
| `google.calendar.event`    | One row for each event, with `core.event` as its parent type. | `google_id`, `<calendar ID>/<event ID>` |

Each event row connects to its calendar with the `google.calendar.in-calendar` connection. That connection orphans: if you trash a calendar in Marfa, its events stay.

A row's `source_id` is `<account>:<calendar ID>/<event ID>`, where `<account>` is the signed-in Google account's ID. The calendar ID is part of the name because one event ID can appear on several calendars.

### Which calendars

The connector reads every calendar in the account's calendar list, including hidden ones, that the account owns or can write to. It skips:

- The Birthdays calendar.
- A calendar the account can only read, unless you name it in `GOOGLE_CALENDAR_READ_ONLY_CALENDARS`.

A calendar whose access drops to read only, or a read-only calendar you stop naming, is archived with its events.

A calendar missing from the list is asked about first, because one listing that leaves a calendar out doesn't prove that it was removed. The connector archives it with its events only when Google answers that the calendar is gone or deleted. If Google still has it, the connector keeps it and its events as they are. If Google can't answer, the connector keeps them and raises `calendar-unconfirmed:<ID>`.

### Which events

The connector reads cancelled and past events as well as upcoming ones, because Google reports deletions as cancelled events. It archives the row of a cancelled event. It skips `workingLocation` events, which aren't appointments. It reads every other event kind, such as `outOfOffice` and `focusTime`, and sets `editable` to `false` on them.

## Set up

Build from the repository root with Node 22.13 or later:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Create a key for the connector:

```bash
marfa keys create \
  --label google-calendar \
  --source google-calendar \
  --type-permission google.calendar.calendar=write \
  --type-permission google.calendar.event=write \
  --edge-permission google.calendar.in-calendar=write \
  --edge-permission parent-of=write \
  --metadata-permission types=write \
  --metadata-permission edge_types=write \
  --default-tier feed
```

Writing `parent-of` is what lets a changed occurrence sit beneath its series. After the first run registers the connector's connections, you can lower `edge_types` to `read`.

Then sign in. Create a Desktop app OAuth client in your own Google Cloud project, turn on the Google Calendar API, and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Run setup and put the token it writes in `GOOGLE_REFRESH_TOKEN`:

```bash
node connectors/google-calendar/dist/main.js --setup <file>
```

Setup requests these scopes. Leave both ticked on the consent screen.

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

Without the calendar list scope, the connector reads nothing and raises a scope condition. Without the events scope, it writes the calendar rows and no events. [The shared page](../../shared/google/README.md) describes the sign-in steps, the conditions and what to do when Google asks you to sign in again.

## Configure

| Variable                              | Meaning                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MARFA_API_URL`                       | Marfa instance address.                                                                                                    |
| `MARFA_API_KEY`                       | The key above.                                                                                                             |
| `GOOGLE_CLIENT_ID`                    | The ID of your Desktop app OAuth client.                                                                                   |
| `GOOGLE_CLIENT_SECRET`                | That client's secret.                                                                                                      |
| `GOOGLE_REFRESH_TOKEN`                | The value `--setup` writes.                                                                                                |
| `GOOGLE_CALENDAR_READ_ONLY_CALENDARS` | Optional. Calendar IDs, separated by commas or spaces, of read-only calendars to read, such as a shared holidays calendar. |
| `GOOGLE_CALENDAR_CONFIRM_DELETES`     | Optional. Lets one held batch of deletions through; see [The safety stop](#the-safety-stop).                               |

Run it:

```bash
node connectors/google-calendar/dist/main.js --once
node connectors/google-calendar/dist/main.js --every 15m
```

A calendar ID in `GOOGLE_CALENDAR_READ_ONLY_CALENDARS` that isn't in the account's calendar list raises the condition `read-only-calendar-unknown:<ID>`.

## How events appear

### Times

A timed event stores its start and end as instants in UTC, with `timezone` set to the event's time zone, or the calendar's when the event has none. `end_timezone` is set only when the end is in a different zone.

An all-day event stores local midnights: `starts_at` is midnight at the start of its first day, and `ends_at` is midnight at the start of the day after its last. Both use the time zone of the event, or else the calendar, and never the zone of the process that runs the connector. The day an hour is added or removed to the clocks is 23 or 25 hours long, as in the calendar.

### Series, moved and cancelled occurrences

A recurring event is one row whose `recurrence` holds Google's rules. Marfa expands the occurrences.

- A **moved or edited occurrence** is its own row, with `original_starts_at` set to the time it replaces and `recurring_event_id` set. It sits beneath its series through `parent-of`, so Marfa shows it in place of the original occurrence.
- A **cancelled occurrence** is added to the series as an `EXDATE` line, in UTC for timed series and `EXDATE;VALUE=DATE:` for all-day ones. Google's own `EXDATE` lines stay as they are. The connector adds one line, without repeating a date.
- Cancelling a whole series archives the series and its changed occurrences.

### Moving an event to another calendar

When an event moves between two calendars of the account, the connector keeps its row, instead of archiving one and creating another. It tells a move from a copy by asking Google whether the event still exists on its first calendar. Only an answer of "gone" or "cancelled" is a move. If the first calendar refuses the question, the event gets a new row on its new calendar, and the first calendar's row stays.

### Whether Marfa may change an event

`editable` and `uneditable_reason` record whether Marfa carries a change to the event back to Google. `editable` is `false` when:

- The account can only read the calendar.
- Google reserves the event kind.
- The event is locked.
- Someone else organizes the event, even when Google lets guests change it.
- The event has guests other than the account. A change to an event with guests is a change to their calendars too, and Marfa doesn't send the invitations or updates that would tell them.

### Other fields

- `organizer` is an object with `email` and `name`.
- `guests` is a list of objects with `email`, `name`, `response`, and `optional`, `self`, `organizer` or `resource` where true.
- `description` is Markdown, the body of the row. Google lets a description hold HTML, and the connector converts it as it reads, keeping links, lists and emphasis and dropping scripts and styles. A description that is text is kept as it is. A change to `description` made in Marfa is converted to HTML (bold, italic, links, lists, quotes, code and line breaks) and sent to Google; a heading becomes bold, since Google has no headings, and text that looks like a tag stays text. A description over 600,000 characters or 25,000 elements is refused.
- `changed_at` is Google's `updated` time. `occurred_at` is the event's start.
- An event without a title is named `(No title)`.

## What it carries back

Google is asked for the event before each change, and the change is decided on the event as Google holds it then. Every write sets `sendUpdates=none`, so Google emails nobody, and no write names guests.

| In Marfa                                                         | In Google Calendar                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create an event row.                                             | Makes the event on the calendar the row connects to through `google.calendar.in-calendar`, or on the primary calendar when it connects to none.                    |
| Create an event row beneath a series, with `original_starts_at`. | Changes the occurrence that row replaces. See [Series](#series).                                                                                                   |
| Change `title`, `description`, `place`, `status` or the times.   | Changes those fields of the event.                                                                                                                                 |
| Change the `recurrence` of a series.                             | Changes the series' rules. See [Series](#series).                                                                                                                  |
| Connect the row to another calendar.                             | Moves the event to that calendar. The row keeps its identity.                                                                                                      |
| Trash the row.                                                   | Deletes the event. Deleting a series deletes its occurrences, so the changed occurrences the trash takes with it send nothing of their own. See [Series](#series). |
| Restore the row.                                                 | Brings the event back. If Google no longer has it, makes it again.                                                                                                 |
| Purge the row.                                                   | Deletes the event, if the trash before it didn't.                                                                                                                  |

Fields Google holds and Marfa doesn't change, such as `organizer`, `guests`, `url` and `calendar_id`, are read only: a change to one in Marfa is put back.

If one listing of the account's calendars leaves out the calendar a change needs, the connector asks Google about that calendar directly, as the read does. Only an answer that the calendar is gone or deleted counts as gone: a trash or purge of an event on it is then settled with nothing to delete, and other changes are refused. If Google still has the calendar, the change is carried as usual. If Google can't answer, the change waits for a later run.

`status` takes `confirmed` or `tentative`. Any other value is refused; trash the row to delete the event.

The times are carried as the row holds them. An all-day event is written as its dates in its own time zone, so a row whose `starts_at` is midnight in Los Angeles is written as that day in Los Angeles. A changed occurrence with no time zone of its own follows its series' time zone, not the calendar's. A switch between timed and all-day clears the form Google held before.

### Making an event

A row made in Marfa becomes an event whose Google ID is made from the row's ID. If the answer to the create is lost, the next run sends the same create, Google answers that it already holds that ID, and the connector links the row to the event the first try made. Until the row is linked, a read doesn't make a second row for that event.

If you trash or purge the row before the next run, the create isn't sent again. The connector asks Google whether the event under the row's ID exists on the calendar the create named. If it does, the connector deletes it; if it doesn't, nothing is sent. The create is then settled, and the read stops holding back that event. If the answer to the delete is lost too, the next run asks Google again. If you restore the row before the next run, or before a lost delete is settled, the create is sent again: Google answers that it already holds that ID, and the connector links the row to the event, bringing it back with the row's values if the delete removed it.

The connector refuses to make an event on a calendar the account can only read, and raises a condition that names the row.

### When both sides change

Each change sends only the fields changed in Marfa that differ from Google's event, held to Google's version of the event (its `etag`) that Marfa last read. A move to another calendar is held to that version too. If Google changed the event since, the change waits and the event isn't moved: the next read brings Google's change, and the kit decides between the two field by field. A field changed on one side only keeps that change.

### Events Marfa may not change

A change to an event whose `editable` is `false` isn't sent. The connector puts the fields changed in Marfa back to Google's values and raises the condition `declined:<row ID>`, with the reason. A trash of such a row leaves the event in Google. The same happens when Google refuses a change because the account isn't the organizer.

### Series

A change to a series' `recurrence` sends the rules it holds, and keeps Google's own `EXDATE` lines that the row still holds. The `EXDATE` lines the connector adds for cancelled occurrences are never sent as rules. Instead:

- An `EXDATE` added in Marfa cancels that occurrence in Google.
- An `EXDATE` removed in Marfa brings that cancelled occurrence back.

An `EXDATE` added or removed for an occurrence Marfa may not change, such as a changed occurrence with other guests, declines the whole change to the series: nothing is sent, the connector raises the condition `declined:<row ID>`, which names the occurrence and the reason, and puts back the row's changed fields, including any other field changed in the same edit. See [Events Marfa may not change](#events-marfa-may-not-change).

Deleting a series in Google deletes its changed occurrences too, and the kit sends no delete of its own for a changed occurrence trashed with its series. So before it deletes a series, the connector lists the calendar's events, which include every changed occurrence of the series, in whatever year it falls. If one that isn't cancelled is an occurrence Marfa may not change, such as one with other guests, the trash or purge is declined: nothing is sent, the series stays in Google, and the connector raises the condition `declined:<row ID>`, which names the occurrence and the reason.

A changed occurrence's row changes that occurrence alone. A series can't stop repeating from Marfa: a `recurrence` with no rules left is refused. An occurrence can't move to another calendar on its own, because Google moves a whole series.

To change one occurrence from Marfa, make a row beneath the series, through `parent-of`, with `original_starts_at` set to the start of the occurrence it replaces. For an all-day series, that's midnight of the occurrence's date in the series' time zone. Google already holds every occurrence of a series, so the connector changes that occurrence rather than making an event, and links the row to it. It sends the row's times, and each of `title`, `description`, `place` and `status` that the row holds and that differs from the occurrence. A field the row doesn't hold keeps the occurrence's value, such as the agenda and meeting link the occurrence has from its series. An occurrence cancelled in Google comes back. The connector keeps the change until it lands. If it fails, or its answer is lost, the next run compares each field of the change, as first sent, with the occurrence Google holds now. A field Google holds at the value sent has landed. A field Google still holds at the value the change was made against is sent again, held to the occurrence's version, and an occurrence cancelled in Google still comes back. A field Google changed since keeps Google's value, and the read brings it to the row. A change made to the row since is carried on the run after the first lands. Until the change lands, a read leaves the row alone, even a whole read that finds the occurrence cancelled, while the series still gets its `EXDATE` line for as long as Google holds the occurrence cancelled. If you trash or purge the row before the change lands, nothing is sent, and the occurrence stays as Google holds it. Once the change has landed, an occurrence later cancelled in Google stays cancelled, and a read archives the row. The connector refuses the row, and raises a condition that names it, when:

- The series has no Google ID, or Google no longer has it.
- Marfa may not change the series or the occurrence. See [Events Marfa may not change](#events-marfa-may-not-change).
- The series has no occurrence that starts at `original_starts_at`.
- The series is all day and `original_starts_at` isn't midnight of a date in the series' time zone.
- Another row already holds that occurrence, such as a changed occurrence read from Google. Change that row instead.
- The row is beneath more than one series, or connects to a calendar other than its series' calendar.

If you restore a series row and change its `recurrence` before the next run, the connector first brings the series back as Google held it, and then carries the change as it carries an edit: it sends the row's other fields with the rules and Google's own `EXDATE` lines that the row still holds, and an `EXDATE` added or removed in Marfa cancels or brings back that occurrence. An `EXDATE` added or removed for an occurrence Marfa may not change declines the change, as it does an edit: the series stays back as Google held it, none of the row's changed fields is sent, and the connector raises the condition `declined:<row ID>` and puts back the row's changed fields, including any other field changed in the same edit.

When a restored series row's event is gone from Google for good, the connector makes the series again under the row's ID with its rules and every `EXDATE` line the row holds, so the dates the series skipped stay skipped, and links the row to the new series. This includes the later part of a series that a change to "this and following events" split in Google, whose ID ends in `_R` and the time of the split: once deleted, Google refuses to bring it back. The deleted part stays deleted in Google, so the new series isn't a duplicate. Google refusing to bring back any other series raises a condition, and the restore isn't sent again until the row changes.

### Errors

A rate limit, a server error or no answer from Google leaves the change in Marfa, raises a condition, and sends it again on the next run. A value Google refuses raises a condition that names the row, and the change isn't sent again until the row changes.

### The safety stop

Trashing a row deletes its event in Google, and so does purging a row whose trash wasn't carried. Before it deletes anything, the connector counts, for each calendar, the events Google still holds that the run's trashes and purges would delete. An event that both a trash and a purge would delete counts once. It counts only the deletes it would send: it skips a row whose `editable` is `false`, a calendar that Google answers has left the account's list, and a calendar the account can only read. It also skips an event that Google holds, when it counts, as one Marfa may not change, such as one that gained another guest since Marfa last read it, and a series with a changed occurrence Marfa may not change. A trash of such an event is declined when the connector carries it. A calendar that one listing leaves out while Google still has it is counted, because its events are deleted. If Google can't say whether such a calendar is still there, the run fails and the batch waits. For a row trashed or purged before its create got an answer, it counts the event under the row's ID, if Google holds it. A changed occurrence trashed or purged before its change lands deletes nothing, so it isn't counted. A calendar Google no longer has holds nothing to delete. A row that went into the bin with its series, such as a changed occurrence, isn't counted, because its trash isn't carried; the series' own delete removes its occurrences. The events a calendar holds include the changed occurrences of its series. If one calendar would lose more than 10 events and more than a quarter of its events at once, nothing is carried to Google, the run fails, and the connector raises the condition `deletes-held`, which says how many events would be deleted from which calendar.

To keep the events, restore the trashed rows in Marfa; the next run counts again. A purged row can't be restored. To let the batch through, set `GOOGLE_CALENDAR_CONFIRM_DELETES` to the value the condition names, run once, and remove the setting. The value is the number of events and a short hash of which events they are, such as `11:3f9a0c2b7d41`, so it lets through that batch and no other. A batch that deletes other events, even the same number of them, is held again, and the condition says that the setting names another batch.

## Progress and recovery

The connector keeps a sync token for each calendar, so after the first read it asks Google only for what changed. It saves a calendar's token after that calendar's rows are written. If any event in the calendar can't be read, it keeps no token, raises `events-skipped:<ID>`, and reads the calendar whole on the next run. If Google refuses one calendar, it raises `calendar-refused:<ID>` and reads the others.

If Marfa refuses an event's row, such as a series whose `recurrence` holds an `RDATE` period, more than 1,000 added and removed dates, or more than 40,000 characters, the connector keeps the row as it was. The calendar's token still advances, even when Marfa refuses every event Google listed for the calendar, so refused rows don't hold the calendar back. The kit keeps the refusal for a retry and, on every run until Marfa takes the row, raises its own condition for it: `inbound:["google.calendar.event","<account ID>:<calendar ID>/<event ID>"]`, which holds Marfa's reason. The connector asks Google for the event again 24 hours after the last try, or sooner if the event changes in Google. The kit's retry journal holds at most 128 refusals and 64 KiB across all calendars. When it has no room for another, the calendar's token doesn't advance, and the kit raises `retry-journal-full:calendar:<ID>` until the calendar's progress is saved again.

A condition stands while the run doesn't reach its check, such as when a scope isn't granted or Google refuses the calendar it names.

When Google says a token has expired (`410`), or something that changes how rows are written has changed, such as the calendar's time zone, the connector reads the calendar whole. In a whole read, a row the listing no longer returns is looked up directly, and only an answer of "gone" or "cancelled" archives it. A row whose change from Marfa hasn't landed yet, such as a changed occurrence whose change failed, is left alone until it lands. A lookup that fails keeps the row: if Google refuses it, the connector raises `calendar-refused:<ID>`, and any other failure stops the run.

When a run writes eight or more events of one calendar, the kit finds each changed occurrence's series by listing every `parent-of` connection in the Marfa instance, 500 to a page, including those of other connectors and of people's own items. The first read of a large calendar therefore costs one Marfa request for every 500 `parent-of` connections, or one for each event where that is fewer. After the first read, a run in which no event changed reads none of the event rows from Marfa.

When a read since the last token finds a series, or one of its occurrences, changed in Google, the connector asks Google for the series and its instances, from a day before its start to five years past today or past its start, whichever is later, to find cancelled occurrences. Cancelled occurrences further out stay as the row held them. A change to a series' `recurrence` made in Marfa instead lists the calendar's events, which include every cancelled occurrence of the series in whatever year it falls, so removing an `EXDATE` brings back a cancelled occurrence however far out it is. If Google lists a cancelled occurrence that it then doesn't find by its start, bringing it back waits for a later run.

## Limits

- When the safety stop holds a batch, the whole run fails, so nothing is read until the batch is confirmed, or until restoring trashed rows brings it under the limit.
- A Marfa instance supports one Google account for its Google connectors. A grant for another account fails the run.
- Fixture tests stand in for Google. They don't show how a live account behaves.
