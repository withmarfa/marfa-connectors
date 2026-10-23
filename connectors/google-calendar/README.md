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
| `GOOGLE_CALENDAR_CONFIRM_PURGES`      | Optional. Lets one held batch of deletions through; see [The safety stop](#the-safety-stop).                               |

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
- `changed_at` is Google's `updated` time. `occurred_at` is the event's start.
- An event without a title is named `(No title)`.

## What it carries back

Google is asked for the event before each change, and the change is decided on the event as Google holds it then. Every write sets `sendUpdates=none`, so Google emails nobody, and no write names guests.

| In Marfa                                                       | In Google Calendar                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an event row.                                           | Makes the event on the calendar the row connects to through `google.calendar.in-calendar`, or on the primary calendar when it connects to none. |
| Change `title`, `description`, `place`, `status` or the times. | Changes those fields of the event.                                                                                                              |
| Change the `recurrence` of a series.                           | Changes the series' rules. See [Series](#series).                                                                                               |
| Connect the row to another calendar.                           | Moves the event to that calendar. The row keeps its identity.                                                                                   |
| Trash the row.                                                 | Deletes the event. Deleting a series deletes its occurrences, so the changed occurrences the trash takes with it send nothing of their own.     |
| Restore the row.                                               | Brings the event back. If Google no longer has it, makes it again.                                                                              |
| Purge the row.                                                 | Deletes the event, if the trash before it didn't.                                                                                               |

Fields Google holds and Marfa doesn't change, such as `organizer`, `guests`, `url` and `calendar_id`, are read only: a change to one in Marfa is put back.

`status` takes `confirmed` or `tentative`. Any other value is refused; trash the row to delete the event.

The times are carried as the row holds them. An all-day event is written as its dates in its own time zone, so a row whose `starts_at` is midnight in Los Angeles is written as that day in Los Angeles. A switch between timed and all-day clears the form Google held before.

### Making an event

A row made in Marfa becomes an event whose Google ID is made from the row's ID. If the answer to the create is lost, the next run sends the same create, Google answers that it already holds that ID, and the connector links the row to the event the first try made. Until the row is linked, a read doesn't make a second row for that event.

The connector refuses to make an event on a calendar the account can only read, and raises a condition that names the row.

### When both sides change

Each change sends only the fields changed in Marfa that differ from Google's event, held to Google's version of the event (its `etag`) that Marfa last read. If Google changed the event since, the change waits: the next read brings Google's change, and the kit decides between the two field by field. A field changed on one side only keeps that change.

### Events Marfa may not change

A change to an event whose `editable` is `false` isn't sent. The connector puts the fields changed in Marfa back to Google's values and raises the condition `declined:<row ID>`, with the reason. A trash of such a row leaves the event in Google. The same happens when Google refuses a change because the account isn't the organizer.

### Series

A change to a series' `recurrence` sends the rules it holds, and keeps Google's own `EXDATE` lines that the row still holds. The `EXDATE` lines the connector adds for cancelled occurrences are never sent as rules. Instead:

- An `EXDATE` added in Marfa cancels that occurrence in Google.
- An `EXDATE` removed in Marfa brings that cancelled occurrence back.

A changed occurrence's row changes that occurrence alone. A series can't stop repeating from Marfa: a `recurrence` with no rules left is refused. An occurrence can't move to another calendar on its own, because Google moves a whole series.

### Errors

A rate limit, a server error or no answer from Google leaves the change in Marfa, raises a condition, and sends it again on the next run. A value Google refuses raises a condition that names the row, and the change isn't sent again until the row changes.

### The safety stop

Before it deletes anything for purged rows, the connector counts, for each calendar, the events Google still holds that the purges would delete. If one calendar would lose more than 10 events and more than a quarter of its events at once, nothing is carried to Google, the run fails, and the connector raises the condition `purges-held` with the numbers.

To let that batch through, set `GOOGLE_CALENDAR_CONFIRM_PURGES` to the number of events the condition names, run once, and remove the setting. A different number holds the batch again.

## Progress and recovery

The connector keeps a sync token for each calendar, so after the first read it asks Google only for what changed. It saves a calendar's token after that calendar's rows are written. If any event in the calendar can't be read, it keeps no token, raises `events-skipped:<ID>`, and reads the calendar whole on the next run. If Google refuses one calendar, it raises `calendar-refused:<ID>` and reads the others.

If Marfa refuses an event's row, such as a series whose `recurrence` holds an `RDATE` period, more than 1,000 added and removed dates, or more than 40,000 characters, the connector keeps the row as it was. The calendar's token still advances, even when Marfa refuses every event Google listed for the calendar, so refused rows don't hold the calendar back. The kit keeps the refusal for a retry and, on every run until Marfa takes the row, raises its own condition for it: `inbound:["google.calendar.event","<account ID>:<calendar ID>/<event ID>"]`, which holds Marfa's reason. The connector asks Google for the event again 24 hours after the last try, or sooner if the event changes in Google. The kit's retry journal holds at most 128 refusals and 64 KiB across all calendars. When it has no room for another, the calendar's token doesn't advance, and the kit raises `retry-journal-full:calendar:<ID>` until the calendar's progress is saved again.

A condition stands while the run doesn't reach its check, such as when a scope isn't granted or Google refuses the calendar it names.

When Google says a token has expired (`410`), or something that changes how rows are written has changed, such as the calendar's time zone, the connector reads the calendar whole. In a whole read, a row the listing no longer returns is looked up directly, and only an answer of "gone" or "cancelled" archives it. A lookup that fails keeps the row: if Google refuses it, the connector raises `calendar-refused:<ID>`, and any other failure stops the run.

When a run writes eight or more events of one calendar, the kit finds each changed occurrence's series by listing every `parent-of` connection in the Marfa instance, 500 to a page, including those of other connectors and of people's own items. The first read of a large calendar therefore costs one Marfa request for every 500 `parent-of` connections, or one for each event where that is fewer. After the first read, a run in which no event changed reads none of the event rows from Marfa.

For a change to a series, the connector asks Google for the series and its instances, from a day before its start to five years past today or past its start, whichever is later, to find cancelled occurrences. Cancelled occurrences further out stay as they were.

## Limits

- The safety stop counts purges only. Trashing many rows in Marfa deletes their events without it; restoring the rows brings the events back.
- A row made in Marfa is always made as an event of its own, even when you put it beneath a series: Marfa can't make a changed occurrence. Change a single occurrence in Google Calendar, or cancel it from the series row with an `EXDATE`.
- When the safety stop holds a batch, the whole run fails, so nothing is read until the batch is confirmed or the purges are no longer pending.
- A Marfa instance supports one Google account for its Google connectors. A grant for another account fails the run.
- Fixture tests stand in for Google. They don't show how a live account behaves.
