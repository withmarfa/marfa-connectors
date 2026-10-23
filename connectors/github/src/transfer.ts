import type {
  EnvDeclaration,
  Entry,
  Item,
  RunContext,
} from "@withmarfa/connector";
import { RequestError } from "@octokit/request-error";
import {
  commentEntry,
  commentType,
  inRepository,
  inThread,
  issueType,
  repositoryType,
  type Comment,
  type Issue,
  type Relations,
  type RestComment,
} from "./entries.js";
import { batches, query, status, type Client } from "./github.js";
import { issuesByNode, nodesOfNumbers } from "./graph.js";

/**
 * A transfer gives an issue a new node, number and address, and copies its
 * comments with new nodes and the old times. The Marfa row is the same item,
 * so each place that meets the new issue names the old node in `movedFrom`.
 * Nothing is matched by title: the old address answering 301 to the new
 * issue is the proof.
 *
 * GitHub shows the new issue before it records the transfer, so an issue that
 * may be mid-transfer is not written until it is known to be one or not.
 */

type Context = Pick<RunContext<EnvDeclaration>, "linked" | "known" | "log">;

/** How long GitHub may take to record a transfer on the new issue's
 *  timeline. An issue Marfa has no row for, changed within it and made
 *  earlier than it, with no transfer on its timeline, waits for the next run. */
export const transferWindow = 2 * 60 * 1000;

export interface Address {
  owner: string;
  name: string;
  number: number;
}

export type Asked =
  | { kind: "present" | "deleted" | "missing" }
  | { kind: "moved"; to: Address | undefined };

const transfersQuery = `query Transfers($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      timelineItems(last: 1, itemTypes: [TRANSFERRED_EVENT]) {
        nodes {
          __typename
          ... on TransferredEvent { fromRepository { id nameWithOwner } }
        }
      }
    }
  }
}`;

interface TransferNode {
  __typename: string;
  id: string;
  timelineItems: {
    nodes: ({
      __typename: string;
      fromRepository: { id: string; nameWithOwner: string } | null;
    } | null)[];
  };
}

function linkOf(row: Item): string | undefined {
  const value = row.properties["github_id"];
  return typeof value === "string" ? value : undefined;
}

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const first = Date.parse(a);
  return !Number.isNaN(first) && first === Date.parse(b);
}

/** The issues whose timeline has a transfer, each with where the newest
 *  came from, or null where the token cannot see that repository. */
async function transfersOf(
  octokit: Client,
  ids: readonly string[],
): Promise<Map<string, { id: string; name: string } | null>> {
  const found = new Map<string, { id: string; name: string } | null>();
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, transfersQuery, {
      ids: batch,
    })) as { nodes: (TransferNode | null)[] };
    for (const node of answer.nodes) {
      if (node?.__typename !== "Issue") continue;
      const event = node.timelineItems.nodes[0];
      if (event?.__typename !== "TransferredEvent") continue;
      const from = event.fromRepository;
      found.set(
        node.id,
        from ? { id: from.id, name: from.nameWithOwner } : null,
      );
    }
  }
  return found;
}

function addressOf(location: string | undefined): Address | undefined {
  if (location === undefined) return undefined;
  let path: string;
  try {
    path = new URL(location).pathname;
  } catch {
    return undefined;
  }
  const found = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
  return found === null
    ? undefined
    : {
        owner: found[1] ?? "",
        name: found[2] ?? "",
        number: Number(found[3]),
      };
}

/** What the issue's own address says, asked without following a move. */
export async function askIssue(
  octokit: Client,
  owner: string,
  repo: string,
  number: number,
): Promise<Asked> {
  try {
    const answer = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner, repo, issue_number: number, request: { redirect: "manual" } },
    );
    // Asked not to follow, a move answers its own status.
    const code: number = answer.status;
    return code >= 300 && code < 400
      ? { kind: "moved", to: addressOf(answer.headers.location) }
      : { kind: "present" };
  } catch (error) {
    const code = status(error);
    if (code === 410) return { kind: "deleted" };
    if (code === 301 || code === 302 || code === 307) {
      const header =
        error instanceof RequestError
          ? error.response?.headers.location
          : undefined;
      return {
        kind: "moved",
        to: addressOf(typeof header === "string" ? header : undefined),
      };
    }
    if (code === 404) return { kind: "missing" };
    throw error;
  }
}

/** Whether GitHub changed the issue lately, though it was made well before:
 *  what a transfer does, and an edit to an old issue does too. */
function mayBeMoving(issue: Issue, now: number): boolean {
  const changed = Date.parse(issue.updatedAt);
  const made = Date.parse(issue.createdAt);
  return (
    !Number.isNaN(changed) &&
    !Number.isNaN(made) &&
    now - changed <= transferWindow &&
    changed - made > transferWindow
  );
}

/** For the issues Marfa has no row for: the old row of each that was
 *  transferred from a repository whose rows it holds, by the issue's creation
 *  time, which a transfer keeps, and then the old address's answer; and those
 *  that may be mid-transfer, which are not written yet: one with no transfer
 *  on its timeline, and one whose timeline shows a transfer from a repository
 *  Marfa holds rows for but whose old address has not yet answered with a
 *  move. An issue that has waited a full window since `firstSeen` is no longer
 *  held back, so a busy issue cannot wait for ever. Title and text are not
 *  used: either may have been edited on one side only. */
export async function movedFrom(
  context: Context,
  octokit: Client,
  issues: readonly Issue[],
  now: number = Date.now(),
  firstSeen: ReadonlyMap<string, string> = new Map(),
): Promise<{ moves: Map<string, string>; waiting: Set<string> }> {
  const moves = new Map<string, string>();
  const waiting = new Set<string>();
  const seen = await context.known(
    issueType,
    issues.map((one) => one.node),
  );
  const fresh = issues.filter((one) => !seen.has(one.node));
  if (fresh.length === 0) return { moves, waiting };
  const events = await transfersOf(
    octokit,
    fresh.map((one) => one.node),
  );
  const holding = (issue: Issue): boolean => {
    const since = Date.parse(firstSeen.get(issue.node) ?? "");
    return (
      mayBeMoving(issue, now) &&
      (Number.isNaN(since) || now - since < transferWindow)
    );
  };
  const claimed = new Set<string>();
  const held = new Map<string, Item[]>();
  for (const issue of fresh) {
    const from = events.get(issue.node);
    if (from === undefined) {
      if (holding(issue)) waiting.add(issue.node);
      continue;
    }
    if (from === null) continue;
    const [owner = "", name = ""] = from.name.split("/");
    let rows = held.get(from.id);
    if (rows === undefined) {
      rows = await context.linked(issueType, inRepository, {
        type: repositoryType,
        id: from.id,
      });
      held.set(from.id, rows);
    }
    for (const row of rows) {
      const link = linkOf(row);
      const number = row.properties["number"];
      if (
        link === undefined ||
        link === issue.node ||
        claimed.has(link) ||
        typeof number !== "number" ||
        !sameInstant(row.occurred_at, issue.createdAt)
      ) {
        continue;
      }
      const asked = await askIssue(octokit, owner, name, number);
      if (asked.kind !== "moved" || !isAt(asked.to, issue)) continue;
      moves.set(issue.node, link);
      claimed.add(link);
      break;
    }
    // The timeline can show the transfer before the old address answers it.
    if (!moves.has(issue.node) && rows.length > 0 && holding(issue)) {
      waiting.add(issue.node);
    }
  }
  return { moves, waiting };
}

/** The old row of each new issue a delivery names together with the old
 *  issue, where the timeline has no transfer event yet: GitHub records it
 *  about when it sends `opened`, so it can be missing. The old address
 *  answering 301 to the new issue is the proof, as for `movedFrom`. An issue
 *  Marfa already has a row for is not a move: that is a duplicate, which
 *  `follow` finds from the old row's side. */
export async function movedNamed(
  context: Pick<RunContext<EnvDeclaration>, "inspect">,
  unseen: readonly string[],
  all: readonly Issue[],
  ask: (repository: string, number: number) => Promise<Asked | undefined>,
): Promise<Map<string, string>> {
  const moves = new Map<string, string>();
  if (unseen.length === 0 || all.length === 0) return moves;
  const held = new Set(
    (
      await context.inspect(issueType, { links: all.map((one) => one.node) })
    ).items.flatMap((row) => linkOf(row) ?? []),
  );
  const read = all.filter((one) => !held.has(one.node));
  if (read.length === 0) return moves;
  const { items } = await context.inspect(issueType, { links: [...unseen] });
  for (const row of items) {
    const link = linkOf(row);
    const number = row.properties["number"];
    const repository = row.properties["repository"];
    if (
      row.state !== "active" ||
      link === undefined ||
      !unseen.includes(link) ||
      typeof number !== "number" ||
      typeof repository !== "string"
    ) {
      continue;
    }
    const asked = await ask(repository, number);
    if (asked?.kind !== "moved") continue;
    const now = read.find(
      (one) =>
        one.node !== link &&
        !moves.has(one.node) &&
        isAt(asked.to, one) &&
        sameInstant(row.occurred_at, one.createdAt),
    );
    if (now !== undefined) moves.set(now.node, link);
  }
  return moves;
}

function isAt(to: Address | undefined, issue: Issue): boolean {
  return (
    to?.number === issue.number &&
    `${to.owner}/${to.name}`.toLowerCase() ===
      issue.repository.name.toLowerCase()
  );
}

export function withMoves(
  entries: readonly Entry[],
  moves: ReadonlyMap<string, string>,
): Entry[] {
  return entries.map((entry) => {
    const old = moves.get(entry.source_id);
    return old === undefined ? entry : { ...entry, movedFrom: old };
  });
}

/** Names, on the comments of moved issues, the rows they replace. The copies
 *  keep author, time and text, so those find each one. A row whose text was
 *  edited in Marfa is found by author and time where, once every exact match
 *  is made, it is the only row and the copy the only copy left with that
 *  author and time, so the order of the copies does not matter. A copy that
 *  has no match becomes a row of its own. Where the copy already has a row of
 *  its own as well as the row it replaces, both are kept and a `duplicate:`
 *  condition names them. The rows a copy replaces hang on the issue's own
 *  node unless `oldThreads` says another, as for an issue held twice. */
export async function withMovedComments(
  context: Context,
  entries: readonly Entry[],
  moved: ReadonlySet<string>,
  oldThreads: ReadonlyMap<string, string> = new Map(),
): Promise<Entry[]> {
  if (moved.size === 0) return [...entries];
  const wanted = (entry: Entry): string | undefined => {
    const issue = entry.connections?.[inThread]?.[0]?.id;
    return issue !== undefined && moved.has(issue) ? issue : undefined;
  };
  const threads = new Map<string, Item[]>();
  const copied = new Map<string, Item>();
  for (const issue of new Set(entries.flatMap((one) => wanted(one) ?? []))) {
    const own = new Set(
      entries
        .filter((one) => wanted(one) === issue)
        .map((one) => one.source_id),
    );
    const rows = await context.linked(commentType, inThread, {
      type: issueType,
      id: issue,
    });
    // A row already under a copy's own node is that copy's.
    for (const row of rows) {
      const link = linkOf(row);
      if (link !== undefined && own.has(link)) copied.set(link, row);
    }
    const old = oldThreads.get(issue);
    const replaced =
      old === undefined
        ? rows
        : await context.linked(commentType, inThread, {
            type: issueType,
            id: old,
          });
    threads.set(
      issue,
      replaced.filter((row) => !own.has(linkOf(row) ?? "")),
    );
  }
  const found = new Map<Entry, Item>();
  const take = (entry: Entry, issue: string, row: Item): void => {
    found.set(entry, row);
    threads.set(
      issue,
      (threads.get(issue) ?? []).filter((one) => one !== row),
    );
  };
  const moments = (item: { occurred_at?: string | undefined }): number =>
    Date.parse(item.occurred_at ?? "");
  for (const entry of entries) {
    const issue = wanted(entry);
    if (issue === undefined) continue;
    const exact = (threads.get(issue) ?? []).find(
      (row) =>
        row.properties["from"] === entry.properties["from"] &&
        sameInstant(row.occurred_at, entry.occurred_at) &&
        row.properties["body"] === entry.properties["body"],
    );
    if (exact !== undefined) take(entry, issue, exact);
  }
  // Edited text: by author and time, where exactly one row and one copy of
  // that author and time are left. With more of either, which is which is a
  // guess.
  const groups = new Map<
    string,
    { entries: [Entry, string][]; rows: Item[] }
  >();
  const groupOf = (
    issue: string,
    item: { occurred_at?: string | undefined; properties: object },
  ): string | undefined => {
    const at = moments(item);
    const from = (item.properties as Record<string, unknown>)["from"];
    return Number.isNaN(at)
      ? undefined
      : JSON.stringify([issue, typeof from === "string" ? from : null, at]);
  };
  for (const entry of entries) {
    const issue = wanted(entry);
    if (issue === undefined || found.has(entry)) continue;
    const key = groupOf(issue, entry);
    if (key === undefined) continue;
    const group = groups.get(key) ?? { entries: [], rows: [] };
    group.entries.push([entry, issue]);
    groups.set(key, group);
  }
  for (const [issue, rows] of threads) {
    for (const row of rows) {
      const key = groupOf(issue, row);
      if (key !== undefined) groups.get(key)?.rows.push(row);
    }
  }
  for (const group of groups.values()) {
    const [first] = group.entries;
    const [row] = group.rows;
    if (
      group.entries.length === 1 &&
      group.rows.length === 1 &&
      first !== undefined &&
      row !== undefined
    ) {
      take(first[0], first[1], row);
    }
  }
  const named = new Map<Entry, string>();
  for (const [entry, row] of found) {
    const own = copied.get(entry.source_id);
    const link = linkOf(row);
    if (own === undefined) {
      if (link !== undefined) named.set(entry, link);
      continue;
    }
    context.log.condition(
      `duplicate:${row.id}`,
      `comment ${own.id} copies comment ${row.id}, which its issue's transfer replaced, but both rows exist, so both are kept`,
    );
  }
  return entries.map((entry) => {
    const link = named.get(entry);
    return link === undefined ? entry : { ...entry, movedFrom: link };
  });
}

/** Every comment of an issue: the copies of a transfer keep the old times, so
 *  no listing of what changed since names them. */
export async function commentsOf(
  octokit: Client,
  issue: Issue,
): Promise<Comment[]> {
  const [owner = "", repo = ""] = issue.repository.name.split("/");
  const listed = (await octokit.paginate(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { owner, repo, issue_number: issue.number, per_page: 100 },
  )) as RestComment[];
  return listed.map((comment) => ({
    node: comment.node_id,
    body: comment.body ?? "",
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    author: comment.user?.login ?? null,
    issue: issue.node,
    repository: issue.repository,
  }));
}

/** The entries for the comments of issues just rekeyed, each named for the
 *  row it replaces. Written after the issues are, so the rows are found
 *  under the new node. */
export async function movedComments(
  context: Context,
  octokit: Client,
  issues: readonly Issue[],
  hidden: (repository: string) => boolean,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const issue of issues) {
    for (const comment of await commentsOf(octokit, issue)) {
      entries.push(commentEntry(comment, hidden(issue.repository.node)));
    }
  }
  return withMovedComments(
    context,
    entries,
    new Set(issues.map((issue) => issue.node)),
  );
}

/** Raises a condition for each comment of a transferred issue that is a row of
 *  its own and also copies a comment row the old issue's row holds. Writes
 *  nothing. */
export async function duplicateComments(
  context: Context,
  octokit: Client,
  issue: Issue,
  oldLink: string,
  hidden: (repository: string) => boolean,
): Promise<void> {
  const entries = (await commentsOf(octokit, issue)).map((comment) =>
    commentEntry(comment, hidden(issue.repository.node)),
  );
  await withMovedComments(
    context,
    entries,
    new Set([issue.node]),
    new Map([[issue.node, oldLink]]),
  );
}

export interface Follower {
  /** Repositories whose issues the connector writes. */
  synced: ReadonlySet<string>;
  entry: (found: { issue: Issue; relations: Relations }) => Entry;
  hidden: (repository: string) => boolean;
}

export type Followed =
  | { kind: "followed"; entry: Entry; issue: Issue }
  | { kind: "duplicate"; other: Item; issue: Issue }
  | { kind: "away"; why: string };

/** The reason an issue moved out of what the connector reads, for the
 *  condition that says its row is archived. */
export const unreadable = "a repository the App cannot read";

/** The entry for the issue an old address now leads to, naming the old row,
 *  where Marfa holds it. A different row that already holds the new issue's
 *  node means the new issue was written before the move was known, which the
 *  wait for the transfer record is meant to prevent: neither row is touched.
 *  Otherwise where the new issue is, so the caller archives the old row:
 *  unreadable, outside the sync, or not the same issue. */
export async function follow(
  context: Pick<RunContext<EnvDeclaration>, "inspect">,
  octokit: Client,
  row: Item,
  link: string,
  to: Address,
  how: Follower,
): Promise<Followed> {
  const node = (
    await nodesOfNumbers(octokit, to.owner, to.name, [to.number])
  ).get(to.number);
  if (node === undefined) return { kind: "away", why: unreadable };
  const found = (await issuesByNode(octokit, [node]))[0];
  if (found === undefined) return { kind: "away", why: unreadable };
  const there = `${to.owner}/${to.name}#${String(to.number)}`;
  if (!how.synced.has(found.issue.repository.node)) {
    return { kind: "away", why: `${there}, which is not synced` };
  }
  if (!sameInstant(row.occurred_at, found.issue.createdAt)) {
    return { kind: "away", why: `${there}, which is not the same issue` };
  }
  const { items } = await context.inspect(issueType, {
    links: [found.issue.node],
  });
  const other = items.find(
    (one) => linkOf(one) === found.issue.node && one.id !== row.id,
  );
  if (other !== undefined)
    return { kind: "duplicate", other, issue: found.issue };
  return {
    kind: "followed",
    entry: { ...how.entry(found), movedFrom: link },
    issue: found.issue,
  };
}
