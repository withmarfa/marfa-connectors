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
  for (const issue of fresh) {
    const from = events.get(issue.node);
    if (from === undefined) continue;
    const [owner = "", name = ""] = from.name.split("/");
    const rows = await context.linked(issueType, inRepository, {
      type: repositoryType,
      id: from.id,
    });
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
 *  edited in Marfa is found by author and time where that is unambiguous. */
export async function withMovedComments(
  context: Context,
  entries: readonly Entry[],
  moved: ReadonlySet<string>,
): Promise<Entry[]> {
  if (moved.size === 0) return [...entries];
  const threads = new Map<string, Item[]>();
  const result: Entry[] = [];
  for (const entry of entries) {
    const issue = entry.connections?.[inThread]?.[0]?.id;
    if (issue === undefined || !moved.has(issue)) {
      result.push(entry);
      continue;
    }
    const held =
      threads.get(issue) ??
      (await context.linked(commentType, inThread, {
        type: issueType,
        id: issue,
      }));
    threads.set(issue, held);
    if (held.some((row) => linkOf(row) === entry.source_id)) {
      result.push(entry);
      continue;
    }
    const sameAuthorAndTime = held.filter(
      (row) =>
        row.properties["from"] === entry.properties["from"] &&
        sameInstant(row.occurred_at, entry.occurred_at),
    );
    const exact = sameAuthorAndTime.filter(
      (row) => row.properties["body"] === entry.properties["body"],
    );
    const match =
      exact[0] ??
      (sameAuthorAndTime.length === 1 ? sameAuthorAndTime[0] : undefined);
    const link = match === undefined ? undefined : linkOf(match);
    if (match === undefined || link === undefined) {
      result.push(entry);
      continue;
    }
    threads.set(
      issue,
      held.filter((row) => row !== match),
    );
    result.push({ ...entry, movedFrom: link });
  }
  return result;
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

/** The entry for an issue an old address now leads to, where Marfa holds
 *  the old row and nothing yet holds the new issue. None where the new issue
 *  is unreadable, outside the sync, not the same issue, or already a row,
 *  so the caller archives the old row. */
export async function follow(
  context: Context,
  octokit: Client,
  row: Item,
  to: Address,
  how: Follower,
): Promise<{ entry: Entry; issue: Issue } | undefined> {
  const link = linkOf(row);
  if (link === undefined) return undefined;
  const node = (
    await nodesOfNumbers(octokit, to.owner, to.name, [to.number])
  ).get(to.number);
  if (node === undefined) return undefined;
  const found = (await issuesByNode(octokit, [node]))[0];
  if (
    found === undefined ||
    !how.synced.has(found.issue.repository.node) ||
    !sameInstant(row.occurred_at, found.issue.createdAt) ||
    (await context.known(issueType, [node])).has(node)
  ) {
    return undefined;
  }
  return {
    entry: { ...how.entry(found), movedFrom: link },
    issue: found.issue,
  };
}
