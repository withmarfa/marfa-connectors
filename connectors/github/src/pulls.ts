import { batches, query, type Client } from "./github.js";
import { loginOf } from "./graph.js";
import type { CheckCounts, PullRequest, Related } from "./entries.js";

const issueFields = "id url repository { id }";
const closingFields = `nodes { ${issueFields} } pageInfo { hasNextPage endCursor }`;
const fields = `
  id number title body url isDraft mergedAt closedAt baseRefName headRefName
  state updatedAt createdAt author { login __typename }
  repository { id nameWithOwner }
  closingIssuesReferences(first: 100) { ${closingFields} }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state contexts(first: 0) {
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
    }
  } } } }
`;
interface Page<T> {
  nodes: (T | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface Count {
  state: string;
  count: number;
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
  closedAt: string | null;
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  updatedAt: string;
  createdAt: string;
  author: { login: string; __typename: string } | null;
  repository: { id: string; nameWithOwner: string };
  closingIssuesReferences: Page<Related>;
  commits: {
    nodes: ({
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            checkRunCountsByState: Count[];
            statusContextCountsByState: Count[];
          };
        } | null;
      };
    } | null)[];
  };
}
function counts(values: Count[]): Record<string, number> {
  return Object.fromEntries(
    values
      .filter((one) => one.count > 0)
      .sort((a, b) => (a.state < b.state ? -1 : a.state === b.state ? 0 : 1))
      .map((one) => [one.state, one.count]),
  );
}
function next(page: Page<unknown>, seen: Set<string>): string | undefined {
  if (!page.pageInfo.hasNextPage) return undefined;
  const cursor = page.pageInfo.endCursor;
  if (cursor === null || seen.has(cursor))
    throw new Error("GitHub did not advance its pull request cursor");
  seen.add(cursor);
  return cursor;
}
async function mapped(octokit: Client, node: GraphPR): Promise<PullRequest> {
  let page = node.closingIssuesReferences;
  const closing = new Map<string, Related>();
  const seen = new Set<string>();
  for (;;) {
    for (const one of page.nodes) if (one !== null) closing.set(one.id, one);
    const after = next(page, seen);
    if (after === undefined) break;
    const result = (await query(
      octokit,
      `query ClosingIssues($id: ID!, $after: String!) {
      node(id: $id) { ... on PullRequest { closingIssuesReferences(first: 100, after: $after) { ${closingFields} } } }
    }`,
      { id: node.id, after },
    )) as { node: { closingIssuesReferences: Page<Related> } | null };
    if (result.node === null)
      throw new Error(
        "GitHub no longer shows a pull request while reading its closing issues",
      );
    page = result.node.closingIssuesReferences;
  }
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const checks: CheckCounts | null =
    rollup === null
      ? null
      : {
          state: rollup.state,
          check_runs: counts(rollup.contexts.checkRunCountsByState),
          statuses: counts(rollup.contexts.statusContextCountsByState),
        };
  return {
    node: node.id,
    number: node.number,
    title: node.title,
    body: node.body || null,
    url: node.url,
    prState:
      node.state === "OPEN"
        ? "open"
        : node.state === "MERGED"
          ? "merged"
          : "closed",
    draft: node.isDraft,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    author: loginOf(node.author),
    checks,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    repository: {
      node: node.repository.id,
      name: node.repository.nameWithOwner,
    },
    closingIssues: [...closing.values()],
  };
}
export async function pullRequestsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<PullRequest[]> {
  const found: PullRequest[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const result = (await query(
      octokit,
      `query PullRequests($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on PullRequest { ${fields} } } }`,
      { ids: batch },
    )) as { nodes: (GraphPR | null)[] };
    for (const one of result.nodes)
      if (one?.__typename === "PullRequest")
        found.push(await mapped(octokit, one));
  }
  return found;
}
export async function listPullRequests(
  octokit: Client,
  owner: string,
  name: string,
  since: string,
): Promise<PullRequest[]> {
  const found = new Map<string, PullRequest>();
  for (const states of [["OPEN"], ["CLOSED", "MERGED"]]) {
    let after: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const result = (await query(
        octokit,
        `query PullRequestList($owner: String!, $name: String!, $states: [PullRequestState!]!, $after: String) {
        repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $after, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { __typename ${fields} } pageInfo { hasNextPage endCursor } } }
      }`,
        { owner, name, states, after: after ?? null },
      )) as { repository: { pullRequests: Page<GraphPR> } | null };
      if (result.repository === null)
        throw new Error(
          "GitHub did not return the repository while reading pull requests",
        );
      const page = result.repository.pullRequests;
      let older = false;
      for (const one of page.nodes) {
        if (one === null)
          throw new Error("GitHub returned an incomplete pull request page");
        if (states[0] !== "OPEN" && one.updatedAt < since) {
          older = true;
          continue;
        }
        found.set(one.id, await mapped(octokit, one));
      }
      if (older) break;
      after = next(page, seen);
      if (after === undefined) break;
    }
  }
  return [...found.values()];
}
export async function closedByOf(
  octokit: Client,
  ids: readonly string[],
): Promise<Map<string, Related>> {
  const found = new Map<string, Related>();
  for (const batch of batches([...new Set(ids)])) {
    const result = (await query(
      octokit,
      `query ClosedBy($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Issue {
      id state timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { ${issueFields} } } } } }
    } } }`,
      { ids: batch },
    )) as {
      nodes: ({
        __typename: string;
        id: string;
        state: string;
        timelineItems: {
          nodes: ({
            closer: (Related & { __typename: string }) | null;
          } | null)[];
        };
      } | null)[];
    };
    if (
      result.nodes.length !== batch.length ||
      result.nodes.some((one) => one?.__typename !== "Issue")
    )
      throw new Error("GitHub returned incomplete issue closing events");
    for (const one of result.nodes) {
      if (one?.__typename !== "Issue" || one.state !== "CLOSED") continue;
      const closer = one.timelineItems.nodes[0]?.closer;
      if (closer?.__typename === "PullRequest") found.set(one.id, closer);
    }
  }
  return found;
}
export async function pullNodeOfNumber(
  octokit: Client,
  owner: string,
  name: string,
  number: number,
): Promise<string | undefined> {
  const result = (await query(
    octokit,
    `query PullRequestNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }`,
    { owner, name, number },
  )) as { repository: { pullRequest: { id: string } | null } | null };
  if (result.repository === null)
    throw new Error(
      "GitHub did not return the repository while resolving a pull request",
    );
  return result.repository.pullRequest?.id;
}
