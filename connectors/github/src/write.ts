import { GraphqlResponseError } from "@octokit/graphql";
import { RequestError } from "@octokit/request-error";
import {
  LinkTaken,
  Unreachable,
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
  issueOfRest,
  markOf,
  unmarked,
  issueType,
  subIssueOf,
  type RestComment,
  type RestIssue,
} from "./entries.js";
import {
  asApp,
  asInstallation,
  reads,
  type App,
  type Client,
} from "./github.js";
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

function unreachable(error: unknown): string | undefined {
  // The throttling plugin answers GraphQL's limit with a plain error.
  const said = (error as { response?: { data?: { errors?: unknown } } })
    .response?.data?.errors;
  if (
    Array.isArray(said) &&
    said.some((one) => (one as { type?: unknown }).type === "RATE_LIMITED")
  ) {
    return "GitHub's rate limit ran out";
  }
  if (!(error instanceof RequestError)) return undefined;
  if (error.request.url.endsWith("/access_tokens") || error.status === 401) {
    return `the App's installation refused it (${String(error.status)})`;
  }
  const remaining = error.response?.headers["x-ratelimit-remaining"];
  if (
    (error.status === 403 || error.status === 429) &&
    (remaining === "0" || /rate limit/i.test(error.message))
  ) {
    return "GitHub's rate limit ran out";
  }
  return undefined;
}

async function refusedOrWaits(
  error: unknown,
  octokit: Client,
  owner: string,
  repo: string,
): Promise<string> {
  const limit = unreachable(error);
  if (limit !== undefined)
    throw new Unreachable(`${owner}/${repo} waits: ${limit}`);
  const why = refusal(error);
  if (why === undefined) throw error;
  if (!(await reads(octokit, owner, repo))) {
    throw new Unreachable(
      `${owner}/${repo} is out of the App's reach, so the change waits`,
    );
  }
  return why;
}

function allKept(context: Context): Record<string, Kept> {
  const value = context.state.get("repositories");
  return typeof value === "object" && value !== null
    ? (value as Record<string, Kept>)
    : {};
}

function keptOf(context: Context): Record<string, Kept> {
  return Object.fromEntries(
    Object.entries(allKept(context)).filter(([, one]) => one.paused !== true),
  );
}

function unlessPaused(context: Context, name: string | undefined) {
  const found = Object.entries(allKept(context)).find(
    ([, one]) => one.paused === true && one.name === name,
  );
  if (found !== undefined) throw paused(...found);
}

function paused(node: string, kept: Kept): Unreachable {
  return new Unreachable(
    `${kept.name} is left out by GITHUB_REPOSITORIES until it is named again`,
    { scope: node },
  );
}

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
    const kept =
      found === undefined
        ? undefined
        : allKept(context)[found.issue.repository.node];
    if (found !== undefined && kept?.paused === true) {
      throw paused(found.issue.repository.node, kept);
    }
    if (found !== undefined && found.issue.repository.node in keptOf(context)) {
      const [owner = "", repo = ""] = found.issue.repository.name.split("/");
      return { octokit, owner, repo };
    }
  }
  return undefined;
}

const slugs = new Map<string, string>();

async function botOf(app: App, signal: AbortSignal): Promise<string> {
  let slug = slugs.get(app.appId);
  if (slug === undefined) {
    const answer = await asApp(app, signal).request("GET /app");
    slug = (answer.data as { slug?: string } | null)?.slug ?? "";
    slugs.set(app.appId, slug);
  }
  return `${slug}[bot]`;
}

interface Related {
  readonly added: Map<string, Set<string>>;
  readonly removed: Map<string, Set<string>>;
}

function none(): Related {
  return { added: new Map(), removed: new Map() };
}

/** Includes the relations this carry made, whatever a lagging read says. */
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
    new Set(Object.keys(allKept(context))),
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

function closedAt(item: Item): boolean {
  return typeof item.properties["completed_at"] === "string";
}

async function relations(
  context: Context,
  octokit: Client,
  item: Item,
  node: string,
  change: Change,
  where: { owner: string; repo: string },
): Promise<Related> {
  const related = none();
  let reached: boolean | undefined;
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
      const otherIn = text(row, "repository");
      if (
        Object.values(allKept(context)).some(
          (one) => one.paused === true && one.name === otherIn,
        )
      ) {
        refused(what, `${String(otherIn)} is left out by GITHUB_REPOSITORIES`);
        continue;
      }
      const why = ours
        ? await relate(octokit, mutation, node, other)
        : await relate(octokit, mutation, other, node);
      if (why === undefined) {
        took(related[side], type, other);
        continue;
      }
      reached ??= await reads(octokit, where.owner, where.repo);
      if (!reached) {
        throw new Unreachable(
          `${where.owner}/${where.repo} is out of the App's reach, so the change waits`,
        );
      }
      refused(what, why);
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

export async function carry(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  return waiting(change, async () => {
    if (change.item.type === issueType) {
      return carryIssue(change, context, app);
    }
    if (change.item.type === commentType) {
      return carryComment(change, context, app);
    }
    return undefined;
  });
}

async function waiting<T>(change: Change, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (error) {
    const why = unreachable(error);
    if (why === undefined) throw error;
    throw new Unreachable(`the change to ${change.item.id} waits: ${why}`);
  }
}

function marked(item: Item): string {
  const body = text(item, "body") ?? "";
  return body === "" ? markOf(item.id) : `${body}\n\n${markOf(item.id)}`;
}

async function linkMade<T extends { node_id: string; body?: string | null }>(
  context: Context,
  item: Item,
  candidates: readonly T[],
): Promise<T | undefined> {
  const mark = markOf(item.id);
  for (const one of candidates) {
    if (!(one.body ?? "").includes(mark)) continue;
    try {
      await context.setLink(item, one.node_id);
      return one;
    } catch (error) {
      if (!(error instanceof LinkTaken)) throw error;
    }
  }
  return undefined;
}

async function issuesMadeSince(
  octokit: Client,
  app: App,
  signal: AbortSignal,
  where: { owner: string; repo: string },
  attempted: string,
): Promise<RestIssue[]> {
  // GitHub takes no idempotency key: find what the first try made.
  const since = new Date(Date.parse(attempted) - margin).toISOString();
  const bot = await botOf(app, signal);
  const listed = (await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    ...where,
    state: "all",
    since,
    sort: "created",
    direction: "asc",
    per_page: 100,
  })) as RestIssue[];
  return listed.filter(
    (issue) =>
      issue.pull_request === undefined &&
      issue.user?.login === bot &&
      issue.created_at >= since,
  );
}

async function commentsMadeSince(
  octokit: Client,
  app: App,
  signal: AbortSignal,
  where: { owner: string; repo: string; issue_number: number },
  attempted: string,
): Promise<RestComment[]> {
  const since = new Date(Date.parse(attempted) - margin).toISOString();
  const bot = await botOf(app, signal);
  const listed = (await octokit.paginate(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { ...where, since, per_page: 100 },
  )) as RestComment[];
  return listed.filter(
    (comment) => comment.user?.login === bot && comment.created_at >= since,
  );
}

// A row in the bin cannot take a link, so what GitHub may have made comes in as its own row.
function binnedUnanswered(context: Context, item: Item): void {
  context.log.condition(
    `unanswered-create-trashed:${item.id}`,
    `${item.id} was trashed before GitHub answered its create; anything GitHub made of it comes in as its own row, which a trash closes or deletes`,
  );
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
  if (node === undefined && change.attempted !== undefined) {
    binnedUnanswered(context, item);
    return undefined;
  }
  unlessPaused(context, text(item, "repository"));
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
  const binned = change.kind === "trashed" || change.kind === "purged";
  const fromBin = change.kind === "restored" && change.was === "trashed";
  if (change.changed.has("status") || fromBin) {
    const state = wanted(item.properties["status"]);
    const held = fromBin
      ? (await issuesByNode(octokit, [node]))[0]?.issue
      : undefined;
    if (fromBin && held === undefined) {
      if (!(await reads(octokit, owner, repo))) {
        throw new Unreachable(
          `${owner}/${repo} is out of the App's reach, so the restore of ${item.id} waits`,
        );
      }
      context.log.condition(
        `issue-gone:${item.id}`,
        `GitHub no longer shows ${owner}/${repo}#${String(number)}, so the restore of ${item.id} is not sent`,
      );
      return undefined;
    }
    const closed = held === undefined ? closedAt(item) : !held.open;
    const reason =
      held === undefined ? item.properties["state_reason"] : held.reason;
    const moving =
      (state.state === "closed") !== closed ||
      (state.state === "closed" && reason !== state.state_reason);
    if (moving) Object.assign(patch, state);
  }
  // A trash only closes an open issue, as not planned: GitHub keeps it.
  if (binned && !closedAt(item)) {
    Object.assign(patch, { state: "closed", state_reason: "not_planned" });
  }
  if (patch["title"] === "") {
    context.log.condition(
      `issue-untitled:${item.id}`,
      `${item.id} has no title, which GitHub requires, so its title is not sent`,
    );
    Reflect.deleteProperty(patch, "title");
  }
  let refused = false;
  if (Object.keys(patch).length > 0) {
    try {
      await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo, issue_number: number, ...patch },
      );
    } catch (error) {
      const why = await refusedOrWaits(error, octokit, owner, repo);
      refused = true;
      context.log.condition(
        `issue-refused:${item.id}`,
        `GitHub refused the change to ${owner}/${repo}#${String(number)} (${why}), so it is not sent`,
      );
    }
  }
  const related = binned
    ? none()
    : await relations(context, octokit, item, node, change, { owner, repo });
  const answer = await answerIssue(context, octokit, node, related);
  if (!refused) {
    dropped(context, item, patch["assignees"] as string[] | undefined, answer);
  }
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
  unlessPaused(context, name);
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
  const made =
    change.attempted === undefined
      ? undefined
      : await linkMade(
          context,
          item,
          await issuesMadeSince(
            octokit,
            app,
            context.signal,
            { owner, repo },
            change.attempted,
          ),
        );
  if (made !== undefined) {
    return placeIssue(change, context, octokit, { owner, repo }, made, true);
  }
  let posted: RestIssue;
  try {
    posted = (
      await octokit.request("POST /repos/{owner}/{repo}/issues", {
        // Never retried blind: a create that landed would be made twice.
        request: { retries: 0 },
        owner,
        repo,
        title,
        body: marked(item),
        labels: list(item, "labels"),
        assignees: list(item, "assignees"),
      })
    ).data as RestIssue;
  } catch (error) {
    const why = await refusedOrWaits(error, octokit, owner, repo);
    context.log.condition(
      `issue-refused:${item.id}`,
      `GitHub refused ${item.id} in ${name} (${why}), so it is not sent`,
    );
    return undefined;
  }
  try {
    await context.setLink(item, posted.node_id);
  } catch (error) {
    if (!(error instanceof LinkTaken)) throw error;
    context.log.condition(`link-taken:${item.id}`, error.message);
    return undefined;
  }
  return placeIssue(change, context, octokit, { owner, repo }, posted, false);
}

async function placeIssue(
  change: Change,
  context: Context,
  octokit: Client,
  where: { owner: string; repo: string },
  made: RestIssue,
  found: boolean,
): Promise<Entry | undefined> {
  const { item } = change;
  const patch: Record<string, unknown> = {};
  if (found) {
    const held = issueOfRest(made, { node: "", name: "" });
    const same = (a: readonly string[], b: readonly string[]): boolean =>
      [...a].sort().join("\n") === [...b].sort().join("\n");
    const title = text(item, "title") ?? "";
    const body = text(item, "body") ?? "";
    if (title !== held.title) patch["title"] = title;
    if (body !== unmarked(held.body ?? "")) patch["body"] = body;
    if (!same(list(item, "labels"), held.labels)) {
      patch["labels"] = list(item, "labels");
    }
    if (!same(list(item, "assignees"), held.assignees)) {
      patch["assignees"] = list(item, "assignees");
    }
  }
  const state = wanted(item.properties["status"]);
  if (state.state === "closed" || (found && made.state !== "open")) {
    Object.assign(patch, state);
  }
  if (Object.keys(patch).length > 0) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      ...where,
      issue_number: made.number,
      ...patch,
    });
  }
  const related = await relations(
    context,
    octokit,
    item,
    made.node_id,
    change,
    where,
  );
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
  if (node === undefined && change.attempted !== undefined) {
    binnedUnanswered(context, item);
    return undefined;
  }
  const name = text(item, "repository");
  unlessPaused(context, name);
  const where = clientFor(context, app, name);
  if (where === undefined || node === undefined) {
    context.log.condition(
      `comment-unreachable:${item.id}`,
      `${item.id} is in no repository the App reads, so the change is not sent to GitHub`,
    );
    return undefined;
  }
  try {
    if (change.kind === "trashed" || change.kind === "purged") {
      await deleteComment(where.octokit, node);
      return undefined;
    }
    if (!change.changed.has("body")) return undefined;
    return commentEntry(
      await updateComment(where.octokit, node, text(item, "body") ?? ""),
    );
  } catch (error) {
    const [owner = "", repo = ""] = (name ?? "").split("/");
    const why = await refusedOrWaits(error, where.octokit, owner, repo);
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
  unlessPaused(context, name);
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
  let made =
    change.attempted === undefined
      ? undefined
      : await linkMade(
          context,
          item,
          await commentsMadeSince(
            octokit,
            app,
            context.signal,
            { owner, repo, issue_number: number },
            change.attempted,
          ),
        );
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
            body: marked(item),
          },
        )
      ).data as RestComment;
    } catch (error) {
      const why = await refusedOrWaits(error, octokit, owner, repo);
      context.log.condition(
        `comment-refused:${item.id}`,
        `GitHub refused ${item.id} on ${name}#${String(number)} (${why}), so it is not sent`,
      );
      return undefined;
    }
    try {
      await context.setLink(item, made.node_id);
    } catch (error) {
      if (!(error instanceof LinkTaken)) throw error;
      context.log.condition(`link-taken:${item.id}`, error.message);
      return undefined;
    }
  }
  if (unmarked(made.body ?? "") !== body) {
    return commentEntry(await updateComment(octokit, made.node_id, body));
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

export async function remake(
  change: Change,
  context: Context,
  app: App,
): Promise<boolean> {
  if (change.item.type !== commentType) return false;
  const node = text(change.item, "github_id");
  unlessPaused(context, text(change.item, "repository"));
  const where = clientFor(context, app, text(change.item, "repository"));
  if (where === undefined || node === undefined) return false;
  return waiting(change, async () => {
    if ((await commentsByNode(where.octokit, [node])).length > 0) return false;
    const made = await createComment(
      { ...change, kind: "created" },
      context,
      app,
    );
    // Not made, the restore waits: `false` would say GitHub still has it.
    if (made === undefined) {
      throw new Unreachable(
        `${change.item.id} could not be made again on GitHub, so its restore waits`,
      );
    }
    return true;
  });
}
