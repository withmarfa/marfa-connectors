import { GraphqlResponseError } from "@octokit/graphql";
import { RequestError } from "@octokit/request-error";
import {
  LinkTaken,
  type Change,
  type EnvDeclaration,
  type Entry,
  type Item,
  type Target,
  type WatchContext,
} from "@withmarfa/connector";
import {
  blockedBy,
  commentEntry,
  commentType,
  inThread,
  inRepository,
  issueEntry,
  issueType,
  subIssueOf,
  type RestComment,
  type RestIssue,
} from "./entries.js";
import { asApp, asInstallation, type App, type Client } from "./github.js";
import {
  commentsByNode,
  deleteComment,
  issuesByNode,
  relate,
  updateComment,
} from "./graph.js";
import type { Kept } from "./read.js";

type Context = WatchContext<EnvDeclaration>;

/** A try's time asked a little early, as GitHub's clock is not ours. */
const margin = 5 * 60 * 1000;

/** The issue states Marfa's status names: closed as completed or not
 *  planned, or open for anything else. */
function wanted(value: unknown): {
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "reopened";
} {
  if (value === "completed") {
    return { state: "closed", state_reason: "completed" };
  }
  if (value === "canceled") {
    return { state: "closed", state_reason: "not_planned" };
  }
  return { state: "open", state_reason: "reopened" };
}

function text(item: Item, field: string): string | undefined {
  const value = item.properties[field];
  return typeof value === "string" ? value : undefined;
}

function list(item: Item, field: string): string[] {
  const value = item.properties[field];
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === "string")
    : [];
}

/**
 * GitHub's refusal of one row, which is a condition rather than the run's
 * failure: forbidden (an archived repository), gone, or invalid.
 */
function refusal(error: unknown): string | undefined {
  if (error instanceof RequestError) {
    return [403, 404, 410, 422].includes(error.status)
      ? `${String(error.status)} ${error.message}`
      : undefined;
  }
  if (
    error instanceof GraphqlResponseError &&
    error.errors?.every((one) =>
      ["NOT_FOUND", "FORBIDDEN", "UNPROCESSABLE"].includes(one.type),
    ) === true
  ) {
    return error.errors.map((one) => one.message).join("; ");
  }
  return undefined;
}

/** The repositories the last run read, by node. */
function keptOf(context: Context): Record<string, Kept> {
  const value = context.state.get("repositories");
  return typeof value === "object" && value !== null
    ? (value as Record<string, Kept>)
    : {};
}

/** A client for the installation holding the repository of that name, and
 *  the repository's node. */
function clientFor(
  context: Context,
  app: App,
  name: string | undefined,
): { octokit: Client; node: string } | undefined {
  const found = Object.entries(keptOf(context)).find(
    ([, repository]) => repository.name === name,
  );
  return found === undefined
    ? undefined
    : {
        octokit: asInstallation(
          app,
          found[1].installation,
          context.secret,
          context.signal,
        ),
        node: found[0],
      };
}

/** A client that reads the issue, where its row may name its repository by
 *  a name since changed: then asked of each installation by the node. */
async function clientOfIssue(
  context: Context,
  app: App,
  item: Item,
): Promise<{ octokit: Client; owner: string; repo: string } | undefined> {
  const name = text(item, "repository");
  const node = text(item, "github_id");
  const known = clientFor(context, app, name);
  if (known !== undefined && name !== undefined) {
    const [owner = "", repo = ""] = name.split("/");
    return { octokit: known.octokit, owner, repo };
  }
  if (node === undefined) return undefined;
  const installations = new Set(
    Object.values(keptOf(context)).map((one) => one.installation),
  );
  for (const installation of installations) {
    const octokit = asInstallation(
      app,
      installation,
      context.secret,
      context.signal,
    );
    const [found] = await issuesByNode(octokit, [node]);
    if (found !== undefined) {
      const [owner = "", repo = ""] = found.issue.repository.name.split("/");
      return { octokit, owner, repo };
    }
  }
  return undefined;
}

const slugs = new Map<string, string>();

/** The login GitHub gives what the App writes, such as `marfa-connectors[bot]`. */
async function botOf(app: App, signal: AbortSignal): Promise<string> {
  let slug = slugs.get(app.appId);
  if (slug === undefined) {
    const answer = await asApp(app, signal).request("GET /app");
    slug = (answer.data as { slug?: string } | null)?.slug ?? "";
    slugs.set(app.appId, slug);
  }
  return `${slug}[bot]`;
}

/** Relations the change made or removed that GitHub took, by type. */
interface Related {
  readonly added: Map<string, Set<string>>;
  readonly removed: Map<string, Set<string>>;
}

function none(): Related {
  return { added: new Map(), removed: new Map() };
}

/** The issue as GitHub now has it, which the kit takes for GitHub's side,
 *  with the relations this carry made as made, whatever a lagging read says. */
async function answerIssue(
  context: Context,
  octokit: Client,
  node: string,
  related: Related,
): Promise<Entry | undefined> {
  const [found] = await issuesByNode(octokit, [node]);
  if (found === undefined) return undefined;
  const entry = issueEntry(
    found.issue,
    found.relations,
    new Set(Object.keys(keptOf(context))),
  );
  const connections: Record<string, readonly Target[]> = {
    ...entry.connections,
  };
  for (const type of [subIssueOf, blockedBy]) {
    const added = related.added.get(type) ?? new Set<string>();
    const removed = related.removed.get(type) ?? new Set<string>();
    if (added.size === 0 && removed.size === 0) continue;
    const said = new Set((connections[type] ?? []).map((one) => one.id));
    for (const id of removed) said.delete(id);
    // An issue has one parent: the one made replaces any a read still shows.
    if (type === subIssueOf && added.size > 0) said.clear();
    for (const id of added) said.add(id);
    connections[type] = [...said].map((id) => ({ type: issueType, id }));
  }
  return { ...entry, connections };
}

/** Whether the row says GitHub has the issue closed, as its close time does. */
function closedAt(item: Item): boolean {
  return typeof item.properties["completed_at"] === "string";
}

/** Makes or removes each relation the change names; one GitHub refuses is
 *  named, and the answer then shows GitHub's own. */
async function relations(
  context: Context,
  octokit: Client,
  item: Item,
  node: string,
  change: Change,
): Promise<Related> {
  const related = none();
  const took = (
    side: Map<string, Set<string>>,
    type: string,
    id: string,
  ): void => {
    side.set(type, (side.get(type) ?? new Set<string>()).add(id));
  };
  const refused = (what: string, why: string): void => {
    context.log.condition(
      `relation-refused:${item.id}:${what}`,
      `GitHub refused ${what} for ${item.id}: ${why}`,
    );
  };
  const steps: [
    type: string,
    side: "added" | "removed",
    mutation: Parameters<typeof relate>[1],
    ours: boolean,
    what: string,
  ][] = [
    [subIssueOf, "removed", "removeSubIssue", false, "removing its parent"],
    [subIssueOf, "added", "addSubIssue", false, "its parent"],
    [blockedBy, "removed", "removeBlockedBy", true, "removing a blocker"],
    [blockedBy, "added", "addBlockedBy", true, "a blocker"],
  ];
  for (const [type, side, mutation, ours, what] of steps) {
    for (const row of change.connections?.[type]?.[side] ?? []) {
      const other = text(row, "github_id");
      if (other === undefined) continue;
      // A parent holds its sub-issues; a blocked issue its blockers.
      const why = ours
        ? await relate(octokit, mutation, node, other)
        : await relate(octokit, mutation, other, node);
      if (why === undefined) took(related[side], type, other);
      else refused(what, why);
    }
  }
  return related;
}

/** Names an assignee GitHub dropped without a word, as it does one who
 *  cannot be assigned. */
function dropped(
  context: Context,
  item: Item,
  sent: readonly string[] | undefined,
  answer: Entry | undefined,
): void {
  if (sent === undefined || answer === undefined) return;
  const held = answer.properties["assignees"];
  const kept = new Set(Array.isArray(held) ? held : []);
  const missing = sent.filter((login) => !kept.has(login));
  if (missing.length > 0) {
    context.log.condition(
      `assignees-dropped:${item.id}`,
      `GitHub did not assign ${missing.join(", ")} to ${item.id}, who may not be assigned there`,
    );
  }
}

/** Carries a change made in Marfa to GitHub, as the App. */
export async function carry(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  if (change.item.type === issueType) return carryIssue(change, context, app);
  if (change.item.type === commentType) {
    return carryComment(change, context, app);
  }
  return undefined;
}

async function carryIssue(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  if (change.kind === "created") return createIssue(change, context, app);
  const number = item.properties["number"];
  const node = text(item, "github_id");
  const where = await clientOfIssue(context, app, item);
  if (where === undefined || typeof number !== "number" || node === undefined) {
    context.log.condition(
      `issue-unreachable:${item.id}`,
      `${item.id} is in no repository the App reads, so the change is not sent to GitHub`,
    );
    return undefined;
  }
  const { octokit, owner, repo } = where;
  const patch: Record<string, unknown> = {};
  for (const field of ["title", "body"] as const) {
    if (change.changed.has(field)) patch[field] = text(item, field) ?? "";
  }
  for (const field of ["labels", "assignees"] as const) {
    if (change.changed.has(field)) patch[field] = list(item, field);
  }
  // A state is sent only where it moves: an open issue stays open for a
  // status GitHub has no word for, such as in progress.
  if (change.changed.has("status")) {
    const state = wanted(item.properties["status"]);
    const moving =
      (state.state === "closed") !== closedAt(item) ||
      (state.state === "closed" &&
        item.properties["state_reason"] !== state.state_reason);
    if (moving) Object.assign(patch, state);
  } else if (change.kind === "restored" && change.was === "trashed") {
    // Out of the bin reopens what the trash closed; out of archive, nothing.
    Object.assign(patch, { state: "open", state_reason: "reopened" });
  }
  // A trash only closes, as not planned: GitHub keeps the issue.
  if (change.kind === "trashed" || change.kind === "purged") {
    Object.assign(patch, { state: "closed", state_reason: "not_planned" });
  }
  if (patch["title"] === "") {
    context.log.condition(
      `issue-untitled:${item.id}`,
      `${item.id} has no title, which GitHub requires, so its title is not sent`,
    );
    Reflect.deleteProperty(patch, "title");
  }
  if (Object.keys(patch).length > 0) {
    try {
      await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo, issue_number: number, ...patch },
      );
    } catch (error) {
      const why = refusal(error);
      if (why === undefined) throw error;
      context.log.condition(
        `issue-refused:${item.id}`,
        `GitHub refused the change to ${owner}/${repo}#${String(number)} (${why}), so it is not sent`,
      );
      return answerIssue(context, octokit, node, none());
    }
  }
  const related =
    change.kind === "trashed" || change.kind === "purged"
      ? none()
      : await relations(context, octokit, item, node, change);
  const answer = await answerIssue(context, octokit, node, related);
  dropped(context, item, patch["assignees"] as string[] | undefined, answer);
  return answer;
}

async function createIssue(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  const repository = change.connections?.[inRepository]?.added[0];
  const name = repository === undefined ? undefined : text(repository, "name");
  const where = clientFor(context, app, name);
  if (where === undefined || name === undefined) {
    context.log.condition(
      `issue-unplaced:${item.id}`,
      `${item.id} names no repository the App reads, so it is not sent to GitHub; connect it to one with ${inRepository}`,
    );
    return undefined;
  }
  const title = text(item, "title") ?? "";
  if (title === "") {
    context.log.condition(
      `issue-untitled:${item.id}`,
      `${item.id} has no title, which GitHub requires, so it is not sent`,
    );
    return undefined;
  }
  const { octokit } = where;
  const [owner = "", repo = ""] = name.split("/");
  let made: RestIssue | undefined;
  if (change.attempted !== undefined) {
    // GitHub takes no idempotency key: find what the first try made.
    const since = new Date(Date.parse(change.attempted) - margin).toISOString();
    const bot = await botOf(app, context.signal);
    const listed = (await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      state: "all",
      since,
      sort: "created",
      direction: "asc",
      per_page: 100,
    })) as RestIssue[];
    made = listed.find(
      (issue) =>
        issue.pull_request === undefined &&
        issue.title === title &&
        issue.user?.login === bot &&
        issue.created_at >= since,
    );
  }
  if (made === undefined) {
    try {
      made = (
        await octokit.request("POST /repos/{owner}/{repo}/issues", {
          // Never retried blind: a create that landed would be made twice.
          request: { retries: 0 },
          owner,
          repo,
          title,
          body: text(item, "body") ?? "",
          labels: list(item, "labels"),
          assignees: list(item, "assignees"),
        })
      ).data as RestIssue;
    } catch (error) {
      const why = refusal(error);
      if (why === undefined) throw error;
      context.log.condition(
        `issue-refused:${item.id}`,
        `GitHub refused ${item.id} in ${name} (${why}), so it is not sent`,
      );
      return undefined;
    }
  }
  const state = wanted(item.properties["status"]);
  if (state.state === "closed") {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: made.number,
      ...state,
    });
  }
  try {
    await context.setLink(item, made.node_id);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    context.log.condition(`link-taken:${item.id}`, error.message);
    return undefined;
  }
  const related = await relations(context, octokit, item, made.node_id, change);
  const answer = await answerIssue(context, octokit, made.node_id, related);
  dropped(context, item, list(item, "assignees"), answer);
  return answer;
}

async function carryComment(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  if (change.kind === "created") return createComment(change, context, app);
  const node = text(item, "github_id");
  const where = clientFor(context, app, text(item, "repository"));
  if (where === undefined || node === undefined) {
    context.log.condition(
      `comment-unreachable:${item.id}`,
      `${item.id} is in no repository the App reads, so the change is not sent to GitHub`,
    );
    return undefined;
  }
  try {
    // Comments follow the ordinary rule: a trash deletes on GitHub.
    if (change.kind === "trashed" || change.kind === "purged") {
      await deleteComment(where.octokit, node);
      return undefined;
    }
    if (!change.changed.has("body")) return undefined;
    return commentEntry(
      await updateComment(where.octokit, node, text(item, "body") ?? ""),
    );
  } catch (error) {
    const why = refusal(error);
    if (why === undefined) throw error;
    context.log.condition(
      `comment-refused:${item.id}`,
      `GitHub refused the change to ${item.id} (${why}), so it is not sent`,
    );
    return undefined;
  }
}

async function createComment(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  const issue = change.connections?.[inThread]?.added[0];
  const name = issue === undefined ? undefined : text(issue, "repository");
  const number = issue?.properties["number"];
  const issueNode = issue === undefined ? undefined : text(issue, "github_id");
  const where = clientFor(context, app, name);
  if (
    where === undefined ||
    name === undefined ||
    typeof number !== "number" ||
    issueNode === undefined
  ) {
    context.log.condition(
      `comment-unplaced:${item.id}`,
      `${item.id} is in no issue's thread the App reads, so it is not sent to GitHub; put it in one with ${inThread}`,
    );
    return undefined;
  }
  const { octokit } = where;
  const [owner = "", repo = ""] = name.split("/");
  const body = text(item, "body") ?? "";
  let made: RestComment | undefined;
  if (change.attempted !== undefined) {
    const since = new Date(Date.parse(change.attempted) - margin).toISOString();
    const bot = await botOf(app, context.signal);
    const listed = (await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: number, since, per_page: 100 },
    )) as RestComment[];
    made = listed.find(
      (comment) =>
        comment.body === body &&
        comment.user?.login === bot &&
        comment.created_at >= since,
    );
  }
  if (made === undefined) {
    try {
      made = (
        await octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            request: { retries: 0 },
            owner,
            repo,
            issue_number: number,
            body,
          },
        )
      ).data as RestComment;
    } catch (error) {
      const why = refusal(error);
      if (why === undefined) throw error;
      context.log.condition(
        `comment-refused:${item.id}`,
        `GitHub refused ${item.id} on ${name}#${String(number)} (${why}), so it is not sent`,
      );
      return undefined;
    }
  }
  try {
    await context.setLink(item, made.node_id);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    context.log.condition(`link-taken:${item.id}`, error.message);
    return undefined;
  }
  // GitHub's own answer, which a read straight after may not show yet.
  return commentEntry({
    node: made.node_id,
    body: made.body ?? "",
    url: made.html_url,
    createdAt: made.created_at,
    updatedAt: made.updated_at,
    author: made.user?.login ?? null,
    issue: issueNode,
    repository: { node: where.node, name },
  });
}

/**
 * Makes a restored comment again where GitHub no longer has it, in its
 * issue's thread; an issue is never deleted by a trash, so it is reopened
 * by `carry` instead.
 */
export async function remake(
  change: Change,
  context: Context,
  app: App,
): Promise<boolean> {
  if (change.item.type !== commentType) return false;
  const node = text(change.item, "github_id");
  const where = clientFor(context, app, text(change.item, "repository"));
  if (where === undefined || node === undefined) return false;
  if ((await commentsByNode(where.octokit, [node])).length > 0) return false;
  const made = await createComment(
    { ...change, kind: "created" },
    context,
    app,
  );
  return made !== undefined;
}
