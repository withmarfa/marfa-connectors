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
 */

type Context = Pick<RunContext<EnvDeclaration>, "linked" | "known" | "log">;

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

/** Where the newest transfer of each issue came from, for those whose
 *  timeline has one and names a repository the token can see. */
async function transfersOf(
  octokit: Client,
  ids: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  const found = new Map<string, { id: string; name: string }>();
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, transfersQuery, {
      ids: batch,
    })) as { nodes: (TransferNode | null)[] };
    for (const node of answer.nodes) {
      if (node?.__typename !== "Issue") continue;
      const from = node.timelineItems.nodes[0]?.fromRepository;
      if (from) {
        found.set(node.id, { id: from.id, name: from.nameWithOwner });
      }
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

/** The old row of each new issue Marfa has not seen that was transferred
 *  from a repository whose rows it holds, by the issue's creation time, which
 *  a transfer keeps, and then the old address's answer. Title and text are
 *  not used: either may have been edited on one side only. */
export async function movedFrom(
  context: Context,
  octokit: Client,
  issues: readonly Issue[],
): Promise<Map<string, string>> {
  const moves = new Map<string, string>();
  const seen = await context.known(
    issueType,
    issues.map((one) => one.node),
  );
  const fresh = issues.filter((one) => !seen.has(one.node));
  if (fresh.length === 0) return moves;
  const events = await transfersOf(
    octokit,
    fresh.map((one) => one.node),
  );
  const claimed = new Set<string>();
  const held = new Map<string, Item[]>();
  for (const issue of fresh) {
    const from = events.get(issue.node);
    if (from === undefined) continue;
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
  }
  return moves;
}

/** The old row of each new issue a delivery names together with the old
 *  issue, where the timeline has no transfer event yet: GitHub records it
 *  about when it sends `opened`, so it can be missing. The old address
 *  answering 301 to the new issue is the proof, as for `movedFrom`. */
export async function movedNamed(
  context: Pick<RunContext<EnvDeclaration>, "inspect">,
  unseen: readonly string[],
  read: readonly Issue[],
  ask: (repository: string, number: number) => Promise<Asked | undefined>,
): Promise<Map<string, string>> {
  const moves = new Map<string, string>();
  if (unseen.length === 0 || read.length === 0) return moves;
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
 *  keep author, time and text, so those find each one; a row whose text was
 *  edited in Marfa is found by author and time where it is the only one left
 *  once every exact match is made, so the order of the copies does not
 *  matter. */
export async function withMovedComments(
  context: Context,
  entries: readonly Entry[],
  moved: ReadonlySet<string>,
): Promise<Entry[]> {
  if (moved.size === 0) return [...entries];
  const wanted = (entry: Entry): string | undefined => {
    const issue = entry.connections?.[inThread]?.[0]?.id;
    return issue !== undefined && moved.has(issue) ? issue : undefined;
  };
  const threads = new Map<string, Item[]>();
  for (const issue of new Set(entries.flatMap((one) => wanted(one) ?? []))) {
    const own = new Set(
      entries
        .filter((one) => wanted(one) === issue)
        .map((one) => one.source_id),
    );
    // A row already under a copy's own node is that copy's.
    threads.set(
      issue,
      (
        await context.linked(commentType, inThread, {
          type: issueType,
          id: issue,
        })
      ).filter((row) => !own.has(linkOf(row) ?? "")),
    );
  }
  const found = new Map<Entry, string>();
  const take = (entry: Entry, issue: string, row: Item): void => {
    const link = linkOf(row);
    if (link === undefined) return;
    found.set(entry, link);
    threads.set(
      issue,
      (threads.get(issue) ?? []).filter((one) => one !== row),
    );
  };
  const candidates = (entry: Entry, issue: string): Item[] =>
    (threads.get(issue) ?? []).filter(
      (row) =>
        row.properties["from"] === entry.properties["from"] &&
        sameInstant(row.occurred_at, entry.occurred_at),
    );
  for (const entry of entries) {
    const issue = wanted(entry);
    if (issue === undefined) continue;
    const exact = candidates(entry, issue).find(
      (row) => row.properties["body"] === entry.properties["body"],
    );
    if (exact !== undefined) take(entry, issue, exact);
  }
  for (const entry of entries) {
    const issue = wanted(entry);
    if (issue === undefined || found.has(entry)) continue;
    const only = candidates(entry, issue);
    const [row] = only;
    if (only.length === 1 && row !== undefined) take(entry, issue, row);
  }
  return entries.map((entry) => {
    const link = found.get(entry);
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

export interface Follower {
  /** Repositories whose issues the connector writes. */
  synced: ReadonlySet<string>;
  entry: (found: { issue: Issue; relations: Relations }) => Entry;
  hidden: (repository: string) => boolean;
}

export type Followed =
  | { kind: "followed"; entry: Entry; issue: Issue }
  | { kind: "away"; why: string };

/** The reason an issue moved out of what the connector reads, for the
 *  condition that says its row is archived. */
export const unreadable = "a repository the App cannot read";

/** The entry for the issue an old address now leads to, naming the old row,
 *  where Marfa holds it. A row already under the new issue's node is no
 *  obstacle: the kit merges the two, or keeps both and says why. Otherwise
 *  where the new issue is, so the caller archives the old row: unreadable,
 *  outside the sync, or not the same issue. */
export async function follow(
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
  return {
    kind: "followed",
    entry: { ...how.entry(found), movedFrom: link },
    issue: found.issue,
  };
}
