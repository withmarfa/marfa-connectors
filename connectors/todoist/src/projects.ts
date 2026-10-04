import type { Log } from "@withmarfa/connector";
import { inUse, isGone, type SyncAnswer, type TodoistItem } from "./todoist.js";

/** Whether a task's project is in use, where that is known. */
export function placedIn(
  kept: ReadonlySet<string> | undefined,
): (item: TodoistItem) => boolean {
  return (item) =>
    kept === undefined ||
    typeof item.project_id !== "string" ||
    kept.has(item.project_id);
}

export interface Followed {
  /** The projects in use, or `undefined` where no whole list was ever read. */
  inUse: Set<string> | undefined;
  /** Projects archived or deleted since the last run, or no longer listed. */
  gone: Set<string>;
  /** Projects in use now that were not at the last run. */
  back: string[];
  /** The first whole list: every row in a project it leaves out is gone. */
  firstList: boolean;
}

const unlisted =
  "Todoist's list of projects named no Inbox, so it was not taken as whole, and no row was archived for its project";

/**
 * The projects a set of tasks may be placed in: those held, or, where a task
 * names a project not held, the whole list read afresh.
 */
export async function knowing(
  items: readonly TodoistItem[],
  kept: ReadonlySet<string> | undefined,
  listAll: () => Promise<SyncAnswer["projects"]>,
): Promise<ReadonlySet<string> | undefined> {
  if (kept === undefined || items.every(placedIn(kept))) return kept;
  return inUse(await listAll()) ?? kept;
}

// A delta names only the projects that changed, so a project it leaves out
// is unchanged; only a whole list can leave one out for being gone. A shared
// project the account left is no longer listed. A project is gone for its
// rows only when it moves from held to gone: Todoist sends the record of an
// archived project again when it is renamed, and a row a person restored
// since is not archived again.
export async function followProjects(
  answer: SyncAnswer,
  fullSync: boolean,
  prior: ReadonlySet<string> | undefined,
  listAll: () => Promise<SyncAnswer["projects"]>,
  log: Log,
): Promise<Followed> {
  if (!fullSync && prior !== undefined) {
    let now = new Set(prior);
    const gone = new Set<string>();
    const announced = new Set<string>();
    for (const project of answer.projects ?? []) {
      if (isGone(project)) {
        now.delete(project.id);
        announced.add(project.id);
        if (prior.has(project.id)) gone.add(project.id);
      } else now.add(project.id);
    }
    // A task of a project the delta did not name and the run does not hold
    // is in one the account joined or made without a record of it here.
    const strays = answer.items.some(
      (item) =>
        item.is_deleted !== true &&
        typeof item.project_id === "string" &&
        !now.has(item.project_id) &&
        !announced.has(item.project_id),
    );
    if (strays) {
      const listed = inUse(await listAll());
      if (listed === undefined) log.condition("projects-unlisted", unlisted);
      else {
        for (const id of prior) if (!listed.has(id)) gone.add(id);
        now = listed;
      }
    }
    return {
      inUse: now,
      gone,
      back: [...now].filter((id) => !prior.has(id)),
      firstList: false,
    };
  }
  const listed = inUse(fullSync ? answer.projects : await listAll());
  if (listed === undefined) {
    log.condition("projects-unlisted", unlisted);
    return {
      inUse: prior === undefined ? undefined : new Set(prior),
      gone: new Set(),
      back: [],
      firstList: false,
    };
  }
  return {
    inUse: listed,
    gone: new Set([...(prior ?? [])].filter((id) => !listed.has(id))),
    back: [],
    firstList: prior === undefined,
  };
}
