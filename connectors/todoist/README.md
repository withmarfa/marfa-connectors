# Todoist

Reads a Todoist account's tasks through the Sync API into `todoist.task` rows at the feed tier, and carries changes made in Marfa back to Todoist.

## What syncs

Every `todoist.task` on the instance syncs, whoever created it and under whatever source. The link between a row and its task is the property `todoist_id`: set from the sync for a task read from Todoist, and from Todoist's answer for a row created in Marfa, which becomes a task there. A task meant to stay in Marfa is a `core.task`, not a `todoist.task`.

What travels back: the title as `content`, the description (an empty one clears Todoist's), the priority (`low` to `urgent` as 1 to 4), the due date (a whole day as the date in the account's timezone, a timed one fixed in UTC, none clearing it), and completion and reopening. Labels, projects and sections do not travel. An archive carries nothing.

A trash in Marfa deletes the task in Todoist; closing it would not do, since Todoist closes a recurring task by moving it to its next occurrence. A restore makes the task again where Todoist no longer has it, as the row was, completed if it was, and links the row to the new task; where Todoist still has it, the restore is carried like an edit. A purge after a trash changes nothing more: it sends the trash's delete again under the same command id, which Todoist takes once, and a trash and a purge made between two runs are one delete.

One Todoist account per instance for two-way sync. A second account's connector would create in its own account any row of the type without a link, and could not tell that account's task from one gone.

## Environment

- `TODOIST_API_TOKEN`: the account's API token, a secret.
- `TODOIST_API_URL`: optional, for a stub of the API; the real one otherwise.

The key and the run are as `template/README.md` says.
