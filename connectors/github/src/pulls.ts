import { GraphqlResponseError } from "@octokit/graphql";
import type { EnvDeclaration, RunContext } from "@withmarfa/connector";
import { batches, query, type Client } from "./github.js";
import { loginOf } from "./graph.js";
import {
  pullRequestType,
  type CheckCounts,
  type CheckedPullRequest,
  type PullRequest,
  type Related,
} from "./entries.js";

const issueFields = "id url repository { id }";
const closingFields = `nodes { ${issueFields} } pageInfo { hasNextPage endCursor }`;
const rollupFields = `
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state contexts(first: 0) {
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
    }
  } } } }
`;
function fields(rollup: boolean): string {
  return `
  id number title body url isDraft mergedAt closedAt baseRefName headRefName
  state updatedAt createdAt author { login __typename }
  repository { id nameWithOwner }
  closingIssuesReferences(first: 100) { ${closingFields} }
  ${rollup ? rollupFields : ""}
`;
}

/** The condition for a token that cannot read check results. */
export const checksUnreadable = "checks-unreadable";

/**
 * Whether a run's pull request reads may ask a token for check results. A
 * fine-grained personal token has no Checks permission, and an installation
 * can refuse it too. GitHub then answers every pull request but nulls each
 * one's rollup, with a FORBIDDEN error at that path. Such an answer is used
 * as it is, with those pull requests' `checks` unknown (`undefined`), never
 * empty, and that token is not asked for the rollup again in the run, while
 * other tokens still are. The condition is named once per run. Any other
 * error, including a FORBIDDEN on a pull request or a repository itself,
 * still fails the read.
 */
export class Rollup {
  private readonly refused = new WeakSet<Client>();
  private anyRefused = false;
  private asked = false;

  constructor(
    private readonly log: { condition(key: string, message: string): void },
  ) {}

  /** Whether a read asked for the rollup and no token was refused it, which
   *  clears the condition. */
  get answered(): boolean {
    return this.asked && !this.anyRefused;
  }

  async query(
    octokit: Client,
    text: (rollup: boolean) => string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.refused.has(octokit))
      return query(octokit, text(false), variables);
    try {
      const answer = await octokit.graphql(text(true), variables);
      this.asked = true;
      return answer;
    } catch (error) {
      const refusals = rollupRefusals(error);
      if (refusals === undefined) throw error;
      const data = (error as GraphqlResponseError<unknown>).data;
      if (refusals.length === 0) {
        this.asked = true;
        return data;
      }
      for (const path of refusals) unknownChecks(data, path);
      this.refused.add(octokit);
      if (!this.anyRefused)
        this.log.condition(
          checksUnreadable,
          "GitHub refuses a token the results of checks (a fine-grained personal token has no Checks permission), so the check summary of the pull requests it reads is left as it was",
        );
      this.anyRefused = true;
      return data;
    }
  }
}

/** The paths of the rollups GitHub refused, when every error it gave is a
 *  pull request that is gone (NOT_FOUND) or a refusal (FORBIDDEN) whose path
 *  reaches into a pull request's `commits`, and it still sent data; otherwise
 *  undefined. A refusal of a pull request or a repository itself is never
 *  taken for a refusal of its checks. */
function rollupRefusals(error: unknown): (string | number)[][] | undefined {
  if (!(error instanceof GraphqlResponseError)) return undefined;
  if (error.data === null || typeof error.data !== "object") return undefined;
  const refusals: (string | number)[][] = [];
  for (const one of error.errors ?? []) {
    if (one.type === "NOT_FOUND") continue;
    const path: unknown = one.path;
    if (one.type !== "FORBIDDEN" || !Array.isArray(path)) return undefined;
    const at = path.indexOf("commits");
    if (at < 1) return undefined;
    refusals.push(path.slice(0, at) as (string | number)[]);
  }
  return refusals;
}

/** Drops `commits` from the pull request at `path`, so its checks read as
 *  unknown rather than as a commit with no checks. */
function unknownChecks(data: unknown, path: (string | number)[]): void {
  let node: unknown = data;
  for (const step of path) {
    if (node === null || typeof node !== "object") return;
    node = (node as Record<string | number, unknown>)[step];
  }
  if (node !== null && typeof node === "object")
    delete (node as { commits?: unknown }).commits;
}
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
  commits?: {
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
  const rollup =
    node.commits === undefined
      ? undefined
      : (node.commits.nodes[0]?.commit.statusCheckRollup ?? null);
  const checks: CheckCounts | null | undefined =
    rollup === undefined || rollup === null
      ? rollup
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
/** The pull requests with the check summary their rows hold wherever GitHub
 *  refused it this run, since a write without the field would clear it and
 *  unknown is not none. A pull request with no row yet has none. */
export async function withStoredChecks(
  context: Pick<RunContext<EnvDeclaration>, "inspect">,
  prs: readonly PullRequest[],
): Promise<CheckedPullRequest[]> {
  const unknown = prs.filter((pr) => pr.checks === undefined);
  const stored = new Map<string, CheckCounts>();
  for (const batch of batches(unknown.map((pr) => pr.node))) {
    const { items } = await context.inspect(pullRequestType, { links: batch });
    for (const row of items) {
      const id = row.properties["github_id"];
      const checks = row.properties["checks"];
      if (typeof id === "string" && typeof checks === "object" && checks)
        stored.set(id, checks as CheckCounts);
    }
  }
  return prs.map((pr) => ({
    ...pr,
    checks: pr.checks === undefined ? (stored.get(pr.node) ?? null) : pr.checks,
  }));
}

export async function pullRequestsByNode(
  octokit: Client,
  ids: readonly string[],
  rollup: Rollup,
): Promise<PullRequest[]> {
  const found: PullRequest[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const result = (await rollup.query(
      octokit,
      (checks) =>
        `query PullRequests($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on PullRequest { ${fields(checks)} } } }`,
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
  rollup: Rollup,
): Promise<PullRequest[]> {
  const found = new Map<string, PullRequest>();
  for (const states of [["OPEN"], ["CLOSED", "MERGED"]]) {
    let after: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const result = (await rollup.query(
        octokit,
        (
          checks,
        ) => `query PullRequestList($owner: String!, $name: String!, $states: [PullRequestState!]!, $after: String) {
        repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $after, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { __typename ${fields(checks)} } pageInfo { hasNextPage endCursor } } }
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
