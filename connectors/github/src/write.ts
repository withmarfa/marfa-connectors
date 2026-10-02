import { GraphqlResponseError } from "@octokit/graphql";
import { RequestError } from "@octokit/request-error";
import {
  Declined,
  LinkTaken,
  Refused,
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
  type Comment,
  type Issue,
  type RestComment,
  type RestIssue,
} from "./entries.js";
import {
  asApp,
  asInstallation,
  ClockSkew,
  reads,
  status,
  type App,
  type Client,
} from "./github.js";
import {
  commentsByNode,
  deleteComment,
  issuesByNode,
  relate,
  repositoriesByNode,
  repositoryByNode,
  updateComment,
} from "./graph.js";
import type { Kept } from "./read.js";

type Context = WatchContext<EnvDeclaration>;

/** A try's time asked a little early, as GitHub's clock is not ours. */
const margin = 5 * 60 * 1000;

function wanted(
  value: unknown,
  was?: unknown,
): {
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "duplicate" | "reopened";
} {
  if (value === "completed") {
    return { state: "closed", state_reason: "completed" };
  }
  if (value === "canceled") {
    // Both read as canceled, so a close already stated stays as stated.
    return {
      state: "closed",
      state_reason: was === "duplicate" ? "duplicate" : "not_planned",
    };
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

function refusedApp(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    (error.request.url.endsWith("/access_tokens") || error.status === 401)
  );
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
  if (refusedApp(error)) {
    return `the App's installation refused it (${String(error.status)})`;
  }
  // A create GitHub made before failing answers so too; the next try looks
  // for it first.
  if (error.status >= 500) {
    return `GitHub answered ${String(error.status)}`;
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

/** Throws what GitHub's answer makes of a write it did not take: a wait
 *  for what can pass, a refusal for what will not. */
async function refusedOrWaits(
  error: unknown,
  octokit: Client,
  where: { owner: string; repo: string },
  what: string,
): Promise<never> {
  const { owner, repo } = where;
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
  throw new Refused(`GitHub refused ${what}: ${why}`);
}

/** A create GitHub may have made though it answered a server error, and
 *  does not list yet: the run stops, never reading GitHub's copy into a
 *  twin, and the next looks for it first. Not `Unreachable`, which would
 *  let the run read on. */
function unknownCreate(item: Item, error: unknown): Error {
  return new Error(
    `GitHub answered ${String(status(error))} to the create of ${item.id} and lists nothing it made yet, so the next run looks for it first`,
    { cause: error },
  );
}

function linkRefused(error: unknown): never {
  if (error instanceof LinkTaken) throw new Refused(error.message);
  throw error;
}

function allKept(context: Context): Record<string, Kept> {
  const value = context.state.get("repositories");
  return typeof value === "object" && value !== null
    ? (value as Record<string, Kept>)
    : {};
}

/** An answer names every field the vendor holds, or the next read takes the
 *  missing one for the vendor's change. */
function answerOf(context: Context, comment: Comment): Entry {
  return commentEntry(
    comment,
    allKept(context)[comment.repository.node]?.private,
  );
}

function paused(node: string, kept: Kept): Unreachable {
  return new Unreachable(
    `${kept.name} is left out by GITHUB_REPOSITORIES until it is named again`,
    { scope: node },
  );
}

/** A token that looks things up across the repositories the connector
 *  holds under an installation, paused ones too, reading only. Where one
 *  has no id recorded yet, or GitHub refuses to name one, it reaches the
 *  whole installation instead: it only finds where a node sits, and
 *  `placeIn` refuses anything the connector does not sync. */
function looker(context: Context, app: App, installation: number): Client {
  const held = Object.values(allKept(context)).filter(
    (one) => one.installation === installation,
  );
  const repositoryIds = held.flatMap((one) => one.id ?? []);
  return asInstallation(
    app,
    installation,
    {
      access: "read",
      ...(repositoryIds.length === held.length && { repositoryIds }),
      orWhole: true,
    },
    context.secret,
    context.signal,
  );
}

/** A token for one write, naming by id only the repositories it touches
 *  that are synced and not paused, so a stale or refused repository holds
 *  up only the writes that touch it. */
function writer(context: Context, app: App, nodes: readonly string[]): Client {
  const kept = allKept(context);
  const installation = kept[nodes[0] ?? ""]?.installation;
  const touched = nodes.flatMap((node) => {
    const one = kept[node];
    return one === undefined ||
      one.paused === true ||
      one.installation !== installation
      ? []
      : [one];
  });
  const repositoryIds = touched.flatMap((one) => one.id ?? []);
  if (installation === undefined || repositoryIds.length < touched.length) {
    throw new Unreachable(
      "GitHub's id for the repository is not yet recorded, so the change waits for the next scheduled run",
    );
  }
  return asInstallation(
    app,
    installation,
    { access: "write", repositoryIds },
    context.secret,
    context.signal,
  );
}

interface Place {
  readonly octokit: Client;
  readonly owner: string;
  readonly repo: string;
  readonly repository: { readonly node: string; readonly name: string };
}

/** Where a write lands: a repository GitHub named, which the connector syncs
 *  and has not paused, or the write waits. */
function placeIn(
  context: Context,
  app: App,
  repository: { node: string; name: string },
): Place {
  const kept = allKept(context)[repository.node];
  if (kept?.paused === true) throw paused(repository.node, kept);
  if (kept === undefined) {
    throw new Unreachable(
      `${repository.name} is not a repository the connector syncs, so the changes to what is in it wait`,
      { scope: repository.node },
    );
  }
  const [owner = "", repo = ""] = repository.name.split("/");
  return {
    octokit: writer(context, app, [repository.node]),
    owner,
    repo,
    repository,
  };
}

/** Asked of each installation the sync uses, as a node it cannot see
 *  answers nothing; one that refuses the App is passed over. */
async function seek<T>(
  context: Context,
  app: App,
  ask: (octokit: Client) => Promise<T | undefined>,
): Promise<T | undefined> {
  const installations = new Set(
    Object.values(allKept(context)).map((one) => one.installation),
  );
  for (const installation of installations) {
    let found: T | undefined;
    try {
      found = await ask(looker(context, app, installation));
    } catch (error) {
      if (refusedApp(error)) continue;
      throw error;
    }
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The issue an agreed node id is now, wherever GitHub says it sits, so a
 *  renamed or transferred repository, or a reused name, cannot misroute a
 *  write, and a row's own fields never choose its target. */
async function issueAt(
  context: Context,
  app: App,
  node: string,
): Promise<{ place: Place; issue: Issue } | undefined> {
  const issue = await issueFound(context, app, node);
  return issue === undefined
    ? undefined
    : { place: placeIn(context, app, issue.repository), issue };
}

async function issueFound(
  context: Context,
  app: App,
  node: string,
): Promise<Issue | undefined> {
  return seek(
    context,
    app,
    async (octokit) => (await issuesByNode(octokit, [node]))[0]?.issue,
  );
}

async function commentAt(
  context: Context,
  app: App,
  node: string,
): Promise<{ place: Place; comment: Comment } | undefined> {
  const comment = await seek(
    context,
    app,
    async (octokit) => (await commentsByNode(octokit, [node]))[0],
  );
  return comment === undefined
    ? undefined
    : { place: placeIn(context, app, comment.repository), comment };
}

async function repositoryAt(
  context: Context,
  app: App,
  node: string,
): Promise<Place> {
  const kept = allKept(context)[node];
  if (kept === undefined) {
    throw new Unreachable(
      "a repository the connector does not sync is named, so the changes placed in it wait",
      { scope: node },
    );
  }
  if (kept.paused === true) throw paused(node, kept);
  const found = await repositoryByNode(
    looker(context, app, kept.installation),
    node,
  );
  if (found === undefined) {
    throw new Unreachable(
      `${kept.name} is out of the App's reach, so the changes to it wait`,
      { scope: node },
    );
  }
  return placeIn(context, app, found);
}

/** Tells a target GitHub dropped from one out of the App's reach. A node
 *  that shows under no installation is in none of the synced repositories
 *  once each of them, asked by its own node, still reads; while any does
 *  not, the target may be there, and the change waits. No row's text takes
 *  part, so neither an edited row nor a reused name can settle a change. */
async function goneOrWaits(
  context: Context,
  app: App,
  item: Item,
): Promise<void> {
  const byInstallation = new Map<number, string[]>();
  for (const [node, kept] of Object.entries(allKept(context))) {
    byInstallation.set(kept.installation, [
      ...(byInstallation.get(kept.installation) ?? []),
      node,
    ]);
  }
  for (const [installation, nodes] of byInstallation) {
    let found: Map<string, { name: string; issues: boolean }>;
    try {
      found = await repositoriesByNode(
        looker(context, app, installation),
        nodes,
      );
    } catch (error) {
      if (!refusedApp(error)) throw error;
      found = new Map();
    }
    if (nodes.some((node) => !found.has(node))) {
      throw new Unreachable(
        `GitHub shows the App nothing ${item.id} is linked to, and a repository the connector syncs is out of its reach, so the change waits`,
      );
    }
    // GitHub does not say whether it shows the issues of a repository that
    // turned them off, so one may hold the target.
    const off = [...found.values()].find((one) => !one.issues);
    if (off !== undefined) {
      throw new Unreachable(
        `GitHub shows the App nothing ${item.id} is linked to, and ${off.name} has issues turned off, so the change waits`,
      );
    }
  }
  // Settled, unlike a refusal: the App can no longer find the target, which
  // is no fault of the change, and the daily check or a delivery archives it.
  context.log.condition(
    `target-gone:${item.id}`,
    `GitHub no longer shows what ${item.id} is linked to in any repository the connector syncs, so the change to it is not sent`,
  );
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
    allKept(context)[found.issue.repository.node]?.private,
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

async function relations(
  context: Context,
  app: App,
  item: Item,
  node: string,
  change: Change,
  where: Place,
): Promise<Related> {
  const related = none();
  let reached: boolean | undefined;
  // A change GitHub refused is sent again whole, relations made beside it
  // included, so one already in place is taken as made.
  const [now] = await issuesByNode(where.octokit, [node]);
  const holds = (type: string, other: string): boolean =>
    type === subIssueOf
      ? now?.relations.parent?.id === other
      : (now?.relations.blockedBy ?? []).some((one) => one.id === other);
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
  const takenBack = (what: string, why: string): void => {
    context.log.condition(
      `relation-refused:${item.id}:${what}`,
      `${what} for ${item.id} is not sent to GitHub and is taken back in Marfa, since ${why}`,
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
      const far = await issueFound(context, app, other);
      const kept =
        far === undefined ? undefined : allKept(context)[far.repository.node];
      if (far === undefined) {
        takenBack(what, `GitHub shows the App nothing ${row.id} is linked to`);
        continue;
      }
      if (kept === undefined) {
        takenBack(
          what,
          `${far.repository.name} is not a repository the connector syncs`,
        );
        continue;
      }
      if (kept.paused === true) {
        takenBack(what, `${kept.name} is left out by GITHUB_REPOSITORIES`);
        continue;
      }
      if (holds(type, other) === (side === "added")) {
        took(related[side], type, other);
        continue;
      }
      const both = writer(context, app, [
        where.repository.node,
        far.repository.node,
      ]);
      const why = ours
        ? await relate(both, mutation, node, other)
        : await relate(both, mutation, other, node);
      if (why === undefined) {
        took(related[side], type, other);
        continue;
      }
      reached ??= await reads(where.octokit, where.owner, where.repo);
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
    if (error instanceof ClockSkew) {
      throw new Unreachable(error.message, { scope: "clock" });
    }
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

// A row in the bin cannot take a link, so what GitHub may have made comes in
// as its own row.
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
  const node = text(item, "github_id");
  if (node === undefined) {
    binnedUnanswered(context, item);
    return undefined;
  }
  const found = await issueAt(context, app, node);
  if (found === undefined) {
    await goneOrWaits(context, app, item);
    return undefined;
  }
  const { place, issue } = found;
  const { octokit, owner, repo } = place;
  const { number } = issue;
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
    const closed = !issue.open;
    const reason = issue.reason;
    const state = wanted(item.properties["status"], reason);
    const moving =
      (state.state === "closed") !== closed ||
      (state.state === "closed" && reason !== state.state_reason);
    if (moving) Object.assign(patch, state);
  }
  // A trash only closes an open issue, as not planned: GitHub keeps it.
  if (binned && issue.open) {
    Object.assign(patch, { state: "closed", state_reason: "not_planned" });
  }
  if (patch["title"] === "") {
    throw new Refused(`${item.id} has no title, which GitHub requires`);
  }
  let unsent: unknown;
  if (Object.keys(patch).length > 0) {
    try {
      await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo, issue_number: number, ...patch },
      );
    } catch (error) {
      unsent = error;
    }
  }
  const related = binned
    ? none()
    : await relations(context, app, item, node, change, place);
  if (unsent !== undefined) {
    await refusedOrWaits(
      unsent,
      octokit,
      place,
      `the change to ${owner}/${repo}#${String(number)}`,
    );
  }
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
  const node =
    repository === undefined ? undefined : text(repository, "github_id");
  if (node === undefined) {
    context.log.condition(
      `issue-unplaced:${item.id}`,
      `${item.id} names no repository the App reads, so it is not sent to GitHub; connect it to one with ${inRepository}`,
    );
    return undefined;
  }
  const title = text(item, "title") ?? "";
  if (title === "") {
    throw new Refused(`${item.id} has no title, which GitHub requires`);
  }
  const where = await repositoryAt(context, app, node);
  const { octokit, owner, repo } = where;
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
    return placeIssue(change, context, app, where, made, true);
  }
  let posted: RestIssue;
  const sent = new Date().toISOString();
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
    if ((status(error) ?? 0) >= 500) {
      const landed = await linkMade(
        context,
        item,
        await issuesMadeSince(octokit, app, context.signal, where, sent),
      );
      if (landed !== undefined) {
        return placeIssue(change, context, app, where, landed, true);
      }
      throw unknownCreate(item, error);
    }
    return refusedOrWaits(
      error,
      octokit,
      where,
      `the new issue in ${owner}/${repo}`,
    );
  }
  await context.setLink(item, posted.node_id).catch(linkRefused);
  return placeIssue(change, context, app, where, posted, false);
}

async function placeIssue(
  change: Change,
  context: Context,
  app: App,
  where: Place,
  made: RestIssue,
  found: boolean,
): Promise<Entry | undefined> {
  const { item } = change;
  const { octokit, owner, repo } = where;
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
    try {
      await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        { owner, repo, issue_number: made.number, ...patch },
      );
    } catch (error) {
      await refusedOrWaits(
        error,
        octokit,
        where,
        `the change to ${owner}/${repo}#${String(made.number)}`,
      );
    }
  }
  const related = await relations(
    context,
    app,
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
  if (node === undefined) {
    binnedUnanswered(context, item);
    return undefined;
  }
  const binned = change.kind === "trashed" || change.kind === "purged";
  if (!binned && !change.changed.has("body")) return undefined;
  const found = await commentAt(context, app, node);
  if (found === undefined) {
    await goneOrWaits(context, app, item);
    return undefined;
  }
  const { octokit, owner, repo } = found.place;
  if (found.comment.author !== (await botOf(app, context.signal))) {
    throw new Declined(
      binned
        ? `${item.id} was written on GitHub by someone other than the App, so it stays there though it is in the bin in Marfa`
        : `${item.id} was written on GitHub by someone other than the App, so its edit in Marfa is not sent`,
    );
  }
  try {
    if (binned) {
      await deleteComment(octokit, node, { owner, repo });
      return undefined;
    }
    return answerOf(
      context,
      await updateComment(octokit, node, text(item, "body") ?? ""),
    );
  } catch (error) {
    if (
      binned &&
      error instanceof GraphqlResponseError &&
      error.errors?.every((one) => one.type === "NOT_FOUND") === true
    ) {
      throw new Unreachable(
        `GitHub would not delete ${item.id}, though it still shows it, so its trash waits`,
      );
    }
    return refusedOrWaits(
      error,
      octokit,
      found.place,
      `the change to ${item.id}`,
    );
  }
}

async function createComment(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  const issue = change.connections?.[inThread]?.added[0];
  const issueNode = issue === undefined ? undefined : text(issue, "github_id");
  if (issueNode === undefined) {
    context.log.condition(
      `comment-unplaced:${item.id}`,
      `${item.id} is in no issue's thread the App reads, so it is not sent to GitHub; put it in one with ${inThread}`,
    );
    return undefined;
  }
  const thread = await issueAt(context, app, issueNode);
  if (thread === undefined) {
    await goneOrWaits(context, app, item);
    return undefined;
  }
  const { octokit, owner, repo, repository } = thread.place;
  const { number } = thread.issue;
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
    const sent = new Date().toISOString();
    let linked = false;
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
      if ((status(error) ?? 0) < 500) {
        return refusedOrWaits(
          error,
          octokit,
          thread.place,
          `${item.id} on ${owner}/${repo}#${String(number)}`,
        );
      }
      made = await linkMade(
        context,
        item,
        await commentsMadeSince(
          octokit,
          app,
          context.signal,
          { owner, repo, issue_number: number },
          sent,
        ),
      );
      if (made === undefined) throw unknownCreate(item, error);
      linked = true;
    }
    if (!linked) {
      await context.setLink(item, made.node_id).catch(linkRefused);
    }
  }
  if (unmarked(made.body ?? "") !== body) {
    return answerOf(context, await updateComment(octokit, made.node_id, body));
  }
  // GitHub's own answer, which a read straight after may not show yet.
  return answerOf(context, {
    node: made.node_id,
    body: made.body ?? "",
    url: made.html_url,
    createdAt: made.created_at,
    updatedAt: made.updated_at,
    author: made.user?.login ?? null,
    issue: issueNode,
    repository,
  });
}

export async function remake(
  change: Change,
  context: Context,
  app: App,
): Promise<boolean> {
  const { item } = change;
  if (item.type !== commentType) return false;
  const node = text(item, "github_id");
  if (node === undefined) return false;
  return waiting(change, async () => {
    if ((await commentAt(context, app, node)) !== undefined) return false;
    if (change.unagreed?.has("from") === true) {
      throw new Unreachable(
        `${item.id}'s author in Marfa is not the one GitHub gave, and putting it back failed, so its restore waits`,
      );
    }
    if (text(item, "from") !== (await botOf(app, context.signal))) {
      throw new Declined(
        `${item.id} is gone from GitHub and was written there by someone other than the App, so it is not posted again under the App's name`,
      );
    }
    const made = await createComment(
      { ...change, kind: "created" },
      context,
      app,
    );
    // Not made, the restore waits: `false` would say GitHub still has it.
    if (made === undefined) {
      throw new Unreachable(
        `${item.id} could not be made again on GitHub, so its restore waits`,
      );
    }
    return true;
  });
}
