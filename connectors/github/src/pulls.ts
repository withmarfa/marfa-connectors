import type { Entry, Item, Target } from "@withmarfa/connector";
import {
  type CheckCounts,
  type ClosedByPR,
  githubCloses,
  inRepository,
  pullRequestEntry,
  pullRequestType,
  repositoryType,
  type PullRequest,
  type RestIssue,
} from "./entries.js";
import { batches, query, type Client } from "./github.js";
import { loginOf } from "./graph.js";

/** Minimal context used by PR reading, compatible with RunContext and
 *  ScopedRunContext from @withmarfa/connector. */
export interface PRContext {
  readonly upsert: (type: string, entries: readonly Entry[]) => Promise<void>;
  readonly linked: (
    type: string,
    connection: string,
    target: Target,
  ) => Promise<Item[]>;
  readonly archive: (type: string, ids: readonly string[]) => Promise<void>;
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const relatedIssue = "id url repository { id }";

const pullRequestFields = `
  id number title body url isDraft mergedAt baseRefName headRefName
  state updatedAt createdAt
  author { login __typename }
  repository { id nameWithOwner }
  closingIssuesReferences(first: 25) {
    nodes { ${relatedIssue} }
  }
  closedAtEvent: timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
    nodes { ... on ClosedEvent { createdAt } }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 0) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          }
        }
      }
    }
  }
`;

export const pullRequestsQuery = `query PullRequests($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on PullRequest { ${pullRequestFields} } }
}`;

export const closedByQuery = `query ClosedBy($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      closedByPullRequestsReferences(first: 1, includeClosedPrs: true) {
        nodes { id url }
      }
    }
  }
}`;

const checkPRsQuery = `query CheckPullRequests($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on PullRequest { id } }
}`;

// ─── GraphQL types ────────────────────────────────────────────────────────────

interface GraphCountByState {
  state: string;
  count: number;
}

interface GraphStatusCheckRollup {
  state: string;
  contexts: {
    checkRunCountsByState: GraphCountByState[];
    statusContextCountsByState: GraphCountByState[];
  };
}

interface GraphPR {
  __typename: string;
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  isDraft: boolean;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  updatedAt: string;
  createdAt: string;
  author: { login: string; __typename: string } | null;
  repository: { id: string; nameWithOwner: string };
  closingIssuesReferences: {
    nodes: ({ id: string; url: string; repository: { id: string } } | null)[];
  };
  closedAtEvent: {
    nodes: ({ createdAt: string } | null)[];
  };
  commits: {
    nodes: ({
      commit: { statusCheckRollup: GraphStatusCheckRollup | null };
    } | null)[];
  };
}

interface GraphClosedByIssue {
  __typename: string;
  id: string;
  closedByPullRequestsReferences: {
    nodes: ({ id: string; url: string } | null)[];
  };
}

interface Nodes<T> {
  nodes: (T | null)[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function known<T extends { __typename: string }>(
  nodes: (T | null)[],
  typename: string,
): T[] {
  return nodes.filter(
    (node): node is T => node !== null && node.__typename === typename,
  );
}

function nonZeroCounts(counts: GraphCountByState[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const { state, count } of counts) {
    if (count > 0) result[state] = count;
  }
  return result;
}

function checksOf(node: GraphPR): CheckCounts | null {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  if (rollup === null) return null;
  return {
    state: rollup.state,
    check_runs: nonZeroCounts(rollup.contexts.checkRunCountsByState),
    statuses: nonZeroCounts(rollup.contexts.statusContextCountsByState),
  };
}

function prStateOf(
  state: "OPEN" | "CLOSED" | "MERGED",
): "open" | "closed" | "merged" {
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  return "closed";
}

function prOf(node: GraphPR): PullRequest {
  return {
    node: node.id,
    number: node.number,
    title: node.title,
    body: node.body === "" ? null : node.body,
    url: node.url,
    prState: prStateOf(node.state),
    draft: node.isDraft,
    mergedAt: node.mergedAt,
    closedAt: node.closedAtEvent.nodes[0]?.createdAt ?? null,
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    author: loginOf(node.author),
    checks: checksOf(node),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    repository: {
      node: node.repository.id,
      name: node.repository.nameWithOwner,
    },
    closingIssues: node.closingIssuesReferences.nodes.filter(
      (one): one is { id: string; url: string; repository: { id: string } } =>
        one !== null,
    ),
  };
}

function linkOf(row: Item): string | undefined {
  const value = row.properties["github_id"];
  return typeof value === "string" ? value : undefined;
}

// ─── Public queries ───────────────────────────────────────────────────────────

/** Batch-reads pull request details from GitHub via GraphQL. */
export async function pullRequestsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<PullRequest[]> {
  const found: PullRequest[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, pullRequestsQuery, {
      ids: batch,
    })) as Nodes<GraphPR>;
    for (const node of known(answer.nodes, "PullRequest")) {
      found.push(prOf(node));
    }
  }
  return found;
}

/** Returns the first PR that closed each issue, keyed by issue node id. */
export async function closedByOf(
  octokit: Client,
  ids: readonly string[],
): Promise<Map<string, { id: string; url: string }>> {
  const found = new Map<string, { id: string; url: string }>();
  if (ids.length === 0) return found;
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, closedByQuery, {
      ids: batch,
    })) as Nodes<GraphClosedByIssue>;
    for (const node of known(answer.nodes, "Issue")) {
      const pr = node.closedByPullRequestsReferences.nodes.find(
        (one): one is { id: string; url: string } => one !== null,
      );
      if (pr !== undefined) found.set(node.id, pr);
    }
  }
  return found;
}

/** Returns which of the given PR node ids still exist on GitHub. */
export async function existingPRsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, checkPRsQuery, {
      ids: batch,
    })) as Nodes<{ __typename: string; id: string }>;
    for (const node of answer.nodes) {
      if (node !== null && node.__typename === "PullRequest") found.add(node.id);
    }
  }
  return found;
}

// ─── Repository sync ──────────────────────────────────────────────────────────

/** Reads, upserts and archives pull requests for one repository.
 *
 *  Returns a map from issue node id to its closing PR, so the caller can
 *  include github.closed-by connections when upserting issues.
 *
 *  `restPRItems` — PR-shaped items from the REST issue listing (have
 *  `pull_request` key). These are passed from the same open and closed
 *  pages that already cover issues.
 *
 *  `closedIssueIds` — node ids of closed issues in the listing window,
 *  used to query closedByPullRequestsReferences.
 *
 *  `scope` — numbers (issues and PRs share GitHub's namespace) from the
 *  current listing window, used to decide which held PRs are unlisted.
 *
 *  `synced` — repository node ids in the sync set, used for closing-issue
 *  targets in github.closes connections.
 */
export interface ReadPRsResult {
  /** Closing PR info keyed by issue node id. */
  closedByMap: Map<string, ClosedByPR>;
}

export async function readPullRequests(
  context: PRContext,
  octokit: Client,
  params: {
    repositoryNode: string;
    repositoryName: string;
    restPRItems: readonly RestIssue[];
    closedIssueIds: readonly string[];
    scope: ReadonlySet<number>;
    synced: ReadonlySet<string>;
    hidden: boolean;
  },
): Promise<ReadPRsResult> {
  const {
    repositoryNode,
    repositoryName,
    restPRItems,
    closedIssueIds,
    scope,
    synced,
    hidden,
  } = params;
  const { upsert, linked, archive } = context;

  // 1. Batch-read PR details via GraphQL.
  const prIds = restPRItems.map((pr) => pr.node_id);
  const graphPRs = await pullRequestsByNode(octokit, prIds);

  // Correct any repository mismatch — all these PRs belong to the same repo.
  // (The GraphQL node query returns the PR's own repository, so this is
  //  just a consistency check; in practice they match.)
  for (const pr of graphPRs) {
    if (pr.repository.node !== repositoryNode) {
      pr.repository = { node: repositoryNode, name: repositoryName };
    }
  }

  const syncedPRNodes = new Set(graphPRs.map((pr) => pr.node));

  // 2. Upsert PR entries.
  if (graphPRs.length > 0) {
    await upsert(
      pullRequestType,
      graphPRs.map((pr) => pullRequestEntry(pr, synced, hidden)),
    );
  }

  // 3. Archive PRs that are held but outside the listing window.
  const under = { type: repositoryType, id: repositoryNode };
  const heldRows = await linked(pullRequestType, inRepository, under);
  const unlisted = heldRows.flatMap((row) => {
    const id = linkOf(row);
    if (id === undefined || syncedPRNodes.has(id)) return [];
    const number = row.properties["number"];
    if (typeof number === "number" && scope.has(number)) return [];
    return [id];
  });
  if (unlisted.length > 0) {
    const still = await existingPRsByNode(octokit, unlisted);
    await archive(pullRequestType, unlisted.filter((id) => !still.has(id)));
  }

  // 4. Resolve closed-by for closed issues.
  const closedByRaw = await closedByOf(octokit, closedIssueIds);

  const closedByMap = new Map<string, ClosedByPR>();
  for (const [issueId, pr] of closedByRaw) {
    if (syncedPRNodes.has(pr.id)) {
      closedByMap.set(issueId, { node: pr.id, url: pr.url });
    } else {
      closedByMap.set(issueId, { url: pr.url });
    }
  }

  return { closedByMap };
}

// Re-export connection IDs used by main.ts.
export { githubCloses, pullRequestType };
