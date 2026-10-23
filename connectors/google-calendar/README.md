# Google Calendar

Reads the calendars and events of a Google account into Marfa. This connector only reads: it never changes anything in Google Calendar. It signs in through the shared [Google sign-in](../../shared/google/README.md), so it uses the same OAuth client and refresh token as any other Google connector.

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

Nothing is written back to Google yet. `editable` and `uneditable_reason` record whether a later change from Marfa could be carried. `editable` is `false` when:

- The account can only read the calendar.
- Google reserves the event kind.
- The event is locked.
- Someone else organizes the event, even if guests can modify it.
- The event has any guest other than the account.

### Other fields

- `organizer` is an object with `email` and `name`.
- `guests` is a list of objects with `email`, `name`, `response`, and `optional`, `self`, `organizer` or `resource` where true.
- `changed_at` is Google's `updated` time. `occurred_at` is the event's start.
- An event without a title is named `(No title)`.

## Progress and recovery

The connector keeps a sync token for each calendar, so after the first read it asks Google only for what changed. It saves a calendar's token after that calendar's rows are written. If any event in the calendar can't be read, it keeps no token, raises `events-skipped:<ID>`, and reads the calendar whole on the next run. If Google refuses one calendar, it raises `calendar-refused:<ID>` and reads the others.

If Marfa refuses an event's row, such as a series whose `recurrence` holds an `RDATE` period, more than 1,000 added and removed dates, or more than 40,000 characters, the connector keeps the row as it was and raises `row-refused:<calendar ID>/<event ID>`, naming the event. The calendar's token still advances, so one refused row doesn't hold the calendar back. The kit keeps the refusal for a retry: the connector asks Google for the event again 24 hours after the last try, or sooner if the event changes in Google, and the condition clears once Marfa takes the row.

A condition stands while the run doesn't reach its check, such as when a scope isn't granted or Google refuses the calendar it names.

When Google says a token has expired (`410`), or something that changes how rows are written has changed, such as the calendar's time zone, the connector reads the calendar whole. In a whole read, a row the listing no longer returns is looked up directly, and only an answer of "gone" or "cancelled" archives it. A lookup that fails keeps the row: if Google refuses it, the connector raises `calendar-refused:<ID>`, and any other failure stops the run.

A run that writes eight or more events has the kit find each changed occurrence's series by listing every `parent-of` connection in the Marfa instance, 500 to a page, including those of other connectors and of people's own items. The first read of a large calendar therefore costs one Marfa request for every 500 `parent-of` connections, or one for each event where that is fewer. After the first read, a run in which no event changed reads none of the event rows from Marfa.

For a change to a series, the connector asks Google for the series and its instances, from a day before its start to five years past today or past its start, whichever is later, to find cancelled occurrences. Cancelled occurrences further out stay as they were.

## Limits

- Everything is read only. Nothing in Marfa changes Google Calendar.
- A Marfa instance supports one Google account for its Google connectors. A grant for another account fails the run.
- Fixture tests stand in for Google. They don't show how a live account behaves.
