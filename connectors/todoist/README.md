# Todoist

Reads a Todoist account's tasks through the Sync API into `todoist.task` rows at the feed tier, and carries changes made in Marfa back to Todoist.

## What syncs

Every `todoist.task` on the instance syncs, whoever created it and under whatever source. The link between a row and its task is the property `todoist_id`: set from the sync for a task read from Todoist, and from Todoist's answer for a row created in Marfa, which becomes a task there. A task meant to stay in Marfa is a `core.task`, not a `todoist.task`.

A full sync, which a first run, a cleared state, a moved timezone and Todoist answering a delta in full each start, lists only open tasks, so it is followed by the tasks completed in the last twelve weeks, and then each row still open in Marfa that neither list names is asked about by id, two hundred a run and the rest on the runs after, with at most two thousand held between runs and the rest asked at the next full sync: a task deleted since is archived, one completed earlier is read as completed, and one Todoist does not answer for the token is left as it is, asked about again each run and named by a condition until it answers or its row is no longer open. A run a change in Marfa starts, with the state lost, keeps no sync token, so the next scheduled run syncs in full. A row already completed in Marfa is not asked about, so one whose task was deleted while the connector was not following stays as it is.

What travels back: the title as `content`, the description (an empty one clears Todoist's), the priority (`low` to `urgent` as 1 to 4), the due date (a whole day as the date in the account's timezone, a timed one fixed in UTC in the task's own timezone, or floating where the task's time was, unless the clocks show that time twice, when it is fixed in the account's timezone, none clearing it; a recurring task keeps its recurrence, with the new date, a whole day or a time, as its next occurrence), and completion and reopening. A row made in Marfa is made in the project and section it names, with its labels, and in the Inbox where it names no project or its project is gone; after that, labels, projects and sections do not travel with an edit. An archive carries nothing. An edit to a row whose task Todoist no longer has is refused, and the sync that brings the deletion archives the row.

A trash in Marfa deletes the task in Todoist; closing it would not do, since Todoist closes a recurring task by moving it to its next occurrence. Todoist deletes a task with its subtasks, so trashing a parent row archives its children's rows when the next sync brings their deletion. A restore, or bringing back a row archived because its task was deleted in Todoist, makes the task again where Todoist no longer has it, as the row was, in its project and section with its labels, in the Inbox where its project is gone and at its project's root where its section is, completed if it was, and links the row to the new task; a recurring task comes back as one task due when the row says, since the row does not hold the recurrence, and a subtask comes back on its own; where Todoist still has it, the restore is carried like an edit. A purge after a trash changes nothing more: it sends the trash's delete again under the same command id, which Todoist takes once, and a trash and a purge made between two runs are one delete.

One Todoist account per instance for two-way sync. A second account's connector would create in its own account any row of the type without a link, and could not tell that account's task from one gone.

## Replacing an older type

`todoist.task` no longer names `comment_count`, which Todoist does not keep current. An instance that registered the type while it did refuses this connector's start, naming the difference, until the type is replaced, from this repository's root with a key holding `schema.write` and write on `todoist.task`:

```sh
marfa types update todoist.task --file connectors/todoist/src/todoist.task.json
```

## Environment

- `TODOIST_API_TOKEN`: the account's API token, a secret.
- `TODOIST_API_URL`: optional, for a stub of the API; the real one otherwise.
- `TODOIST_READ_ONLY`: `true` for a read-only connector, optional. Nothing goes back to Todoist, and a change made in Marfa to a synced field is put back and named. A Todoist token cannot be narrowed to reading, so this is the only guard for a trial against a real account.

The key and the run are as `template/README.md` says.
