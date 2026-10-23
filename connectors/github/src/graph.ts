import type {
  Comment,
  Issue,
  Related,
  Relations,
  Transfer,
} from "./entries.js";
import { GraphqlResponseError } from "@octokit/graphql";
import { batches, query, queryNodes, reads, type Client } from "./github.js";

const related = "id url repository { id }";

const transfer = `timelineItems(last: 1, itemTypes: [TRANSFERRED_EVENT]) {
    nodes {
      __typename
      ... on TransferredEvent { fromRepository { id nameWithOwner } }
    }
  }`;

const issueFields = `
  id number title body state stateReason url closedAt createdAt updatedAt
  author { login __typename }
  labels(first: 100) { nodes { name } }
  assignees(first: 100) { nodes { login } }
  repository { id nameWithOwner }
  parent { ${related} }
  blockedBy(first: 50) { nodes { ${related} } }
  relatesTo(first: 100) { nodes { ${related} } pageInfo { hasNextPage endCursor } }
  duplicateOf { ${related} }
  ${transfer}
`;

const issuesQuery = `query Issues($ids: [ID!]!) {
  nodes(ids: $ids) { __typename ... on Issue { ${issueFields} } }
}`;

const relationsQuery = `query Relations($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      parent { ${related} }
      blockedBy(first: 50) { nodes { ${related} } }
  relatesTo(first: 100) { nodes { ${related} } pageInfo { hasNextPage endCursor } }
  duplicateOf { ${related} }
      blocking(first: 50) { nodes { id } }
      subIssues(first: 100) { nodes { id } }
      ${transfer}
    }
  }
}`;

const commentsQuery = `query Comments($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on IssueComment {
      id body url createdAt updatedAt
      author { login __typename }
      issue { id repository { id nameWithOwner } }
    }
  }
}`;

const repositoriesQuery = `query Repositories($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename ... on Repository { id nameWithOwner hasIssuesEnabled hasDiscussionsEnabled }
  }
}`;

const numbersQuery = (count: number): string =>
  `query Numbers($owner: String!, $name: String!${Array.from(
    { length: count },
    (_, at) => `, $n${String(at)}: Int!`,
  ).join("")}) {
  repository(owner: $owner, name: $name) {
    ${Array.from(
      { length: count },
      (_, at) => `i${String(at)}: issue(number: $n${String(at)}) { id }`,
    ).join("\n    ")}
  }
}`;

interface Author {
  login: string;
  __typename: string;
}

/** A bot's login as REST writes it, with its suffix, which GraphQL leaves
 *  off, so a row reads the same whichever answered. */
export function loginOf(author: Author | null): string | null {
  if (author === null) return null;
  return author.__typename === "Bot" ? `${author.login}[bot]` : author.login;
}

interface RelatedPage {
  nodes: (Related | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function allRelated(
  octokit: Client,
  node: { id: string; relatesTo: RelatedPage },
): Promise<Related[]> {
  let page = node.relatesTo;
  const found = new Map<string, Related>();
  const cursors = new Set<string>();
  for (;;) {
    for (const one of page.nodes) if (one !== null) found.set(one.id, one);
    if (!page.pageInfo.hasNextPage) return [...found.values()];
    const cursor = page.pageInfo.endCursor;
    if (cursor === null || cursors.has(cursor))
      throw new Error("GitHub did not advance its related issues cursor");
    cursors.add(cursor);
    const answer = (await query(
      octokit,
      `query RelatedIssues($id: ID!, $after: String!) {
      node(id: $id) { ... on Issue { relatesTo(first: 100, after: $after) { nodes { ${related} } pageInfo { hasNextPage endCursor } } } }
    }`,
      { id: node.id, after: cursor },
    )) as { node: { relatesTo: RelatedPage } | null };
    if (answer.node === null)
      throw new Error(
        "GitHub no longer shows an issue while reading its related issues",
      );
    page = answer.node.relatesTo;
  }
}

interface TransferPage {
  nodes: ({
    __typename: string;
    fromRepository?: { id: string; nameWithOwner: string } | null;
  } | null)[];
}

function transferOf(page: TransferPage): Transfer | null {
  const event = page.nodes[0];
  if (event?.__typename !== "TransferredEvent") return null;
  const from = event.fromRepository;
  return {
    from: from ? { id: from.id, name: from.nameWithOwner } : null,
  };
}

interface GraphIssue {
  __typename: string;
  id: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  url: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: Author | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  repository: { id: string; nameWithOwner: string };
  parent: Related | null;
  blockedBy: { nodes: (Related | null)[] };
  relatesTo: RelatedPage;
  duplicateOf: Related | null;
  timelineItems: TransferPage;
}

interface GraphRelations {
  __typename: string;
  id: string;
  parent: Related | null;
  blockedBy: { nodes: (Related | null)[] };
  relatesTo: RelatedPage;
  duplicateOf: Related | null;
  blocking: { nodes: ({ id: string } | null)[] };
  subIssues: { nodes: ({ id: string } | null)[] };
  timelineItems: TransferPage;
}

interface GraphComment {
  __typename: string;
  id: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: Author | null;
  issue: { id: string; repository: { id: string; nameWithOwner: string } };
}

interface Nodes<T> {
  nodes: (T | null)[];
}

function known<T extends { __typename: string }>(
  nodes: (T | null)[],
  typename: string,
): T[] {
  return nodes.filter(
    (node): node is T => node !== null && node.__typename === typename,
  );
}

/** GraphQL names its enums in capitals; REST, which the rest follows, not. */
export function reasonOf(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

export async function issuesByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<{ issue: Issue; relations: Relations }[]> {
  const found: { issue: Issue; relations: Relations }[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, issuesQuery, {
      ids: batch,
    })) as Nodes<GraphIssue>;
    for (const node of known(answer.nodes, "Issue")) {
      found.push({
        issue: {
          node: node.id,
          number: node.number,
          title: node.title,
          body: node.body === "" ? null : node.body,
          open: node.state === "OPEN",
          reason: reasonOf(node.stateReason),
          url: node.url,
          closedAt: node.closedAt,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          author: loginOf(node.author),
          labels: node.labels.nodes.map((label) => label.name).sort(),
          assignees: node.assignees.nodes.map((one) => one.login).sort(),
          repository: {
            node: node.repository.id,
            name: node.repository.nameWithOwner,
          },
          transfer: transferOf(node.timelineItems),
        },
        relations: {
          parent: node.parent,
          relatesTo: await allRelated(octokit, node),
          duplicateOf: node.duplicateOf,
          blockedBy: node.blockedBy.nodes.filter(
            (one): one is Related => one !== null,
          ),
        },
      });
    }
  }
  return found;
}

/** What else the relations query reads of an issue: the issues it blocks and
 *  those under it, and its transfer. */
export interface Linked {
  blocking: string[];
  children: string[];
  transfer: Transfer | null;
}

export async function relationsOf(
  octokit: Client,
  ids: readonly string[],
): Promise<Map<string, Relations & Linked>> {
  const found = new Map<string, Relations & Linked>();
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, relationsQuery, {
      ids: batch,
    })) as Nodes<GraphRelations>;
    for (const node of known(answer.nodes, "Issue")) {
      found.set(node.id, {
        parent: node.parent,
        relatesTo: await allRelated(octokit, node),
        duplicateOf: node.duplicateOf,
        blockedBy: node.blockedBy.nodes.filter(
          (one): one is Related => one !== null,
        ),
        blocking: node.blocking.nodes.flatMap((one) =>
          one === null ? [] : [one.id],
        ),
        children: node.subIssues.nodes.flatMap((one) =>
          one === null ? [] : [one.id],
        ),
        transfer: transferOf(node.timelineItems),
      });
    }
  }
  return found;
}

/** The issue comments among the nodes, and the nodes that are not known to be
 *  gone: `refused`, which GitHub would not show the token (a discussion
 *  comment in a private repository, to a token without the Discussions
 *  permission), and `elsewhere`, which it showed as another kind of node (a
 *  discussion comment in a public repository, which any token reads). Both
 *  belong to a read of their discussion, not to this one. */
export async function commentsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<{
  found: Comment[];
  refused: Set<string>;
  elsewhere: Set<string>;
}> {
  const found: Comment[] = [];
  const refused = new Set<string>();
  const elsewhere = new Set<string>();
  for (const batch of batches([...new Set(ids)])) {
    const answer = await queryNodes(octokit, commentsQuery, batch);
    for (const id of answer.refused) refused.add(id);
    (answer.nodes as (GraphComment | null)[]).forEach((node, at) => {
      if (node === null) return;
      if (node.__typename !== "IssueComment") {
        const id = batch[at];
        if (id !== undefined) elsewhere.add(id);
        return;
      }
      found.push({
        node: node.id,
        body: node.body,
        url: node.url,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        author: loginOf(node.author),
        issue: node.issue.id,
        repository: {
          node: node.issue.repository.id,
          name: node.issue.repository.nameWithOwner,
        },
      });
    });
  }
  return { found, refused, elsewhere };
}

export async function repositoriesByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<
  Map<string, { name: string; issues: boolean; discussions: boolean }>
> {
  const found = new Map<
    string,
    { name: string; issues: boolean; discussions: boolean }
  >();
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, repositoriesQuery, {
      ids: batch,
    })) as Nodes<{
      __typename: string;
      id: string;
      nameWithOwner: string;
      hasIssuesEnabled: boolean;
      hasDiscussionsEnabled: boolean;
    }>;
    for (const node of known(answer.nodes, "Repository")) {
      found.set(node.id, {
        name: node.nameWithOwner,
        issues: node.hasIssuesEnabled,
        discussions: node.hasDiscussionsEnabled,
      });
    }
  }
  return found;
}

export async function repositoryByNode(
  octokit: Client,
  id: string,
): Promise<{ node: string; name: string } | undefined> {
  const found = (await repositoriesByNode(octokit, [id])).get(id);
  return found === undefined ? undefined : { node: id, name: found.name };
}

export async function nodesOfNumbers(
  octokit: Client,
  owner: string,
  name: string,
  numbers: readonly number[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  for (const batch of batches([...new Set(numbers)], 50)) {
    const answer = (await query(octokit, numbersQuery(batch.length), {
      owner,
      name,
      ...Object.fromEntries(
        batch.map((number, at) => [`n${String(at)}`, number]),
      ),
    })) as { repository: Record<string, { id: string } | null> | null };
    batch.forEach((number, at) => {
      const node = answer.repository?.[`i${String(at)}`];
      if (node !== undefined && node !== null) found.set(number, node.id);
    });
  }
  return found;
}

const mutations = {
  addRelatesTo: `mutation AddRelatesTo($issueId: ID!, $other: ID!) {
    addRelatesTo(input: { issueId: $issueId, relatedIssueId: $other }) { issue { id } }
  }`,
  removeRelatesTo: `mutation RemoveRelatesTo($issueId: ID!, $other: ID!) {
    removeRelatesTo(input: { issueId: $issueId, relatedIssueId: $other }) { issue { id } }
  }`,
  addSubIssue: `mutation AddSubIssue($issueId: ID!, $other: ID!) {
    addSubIssue(input: { issueId: $issueId, subIssueId: $other, replaceParent: true }) { issue { id } }
  }`,
  removeSubIssue: `mutation RemoveSubIssue($issueId: ID!, $other: ID!) {
    removeSubIssue(input: { issueId: $issueId, subIssueId: $other }) { issue { id } }
  }`,
  addBlockedBy: `mutation AddBlockedBy($issueId: ID!, $other: ID!) {
    addBlockedBy(input: { issueId: $issueId, blockingIssueId: $other }) { issue { id } }
  }`,
  removeBlockedBy: `mutation RemoveBlockedBy($issueId: ID!, $other: ID!) {
    removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $other }) { issue { id } }
  }`,
};

/** GraphQL's answers for what will not change by asking again. */
export const refusedTypes: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "UNPROCESSABLE",
]);

export async function relate(
  octokit: Client,
  change: keyof typeof mutations,
  issueId: string,
  other: string,
): Promise<string | undefined> {
  try {
    await octokit.graphql(mutations[change], { issueId, other });
    return undefined;
  } catch (error) {
    if (
      error instanceof GraphqlResponseError &&
      error.errors?.every((one) => refusedTypes.has(one.type)) === true
    ) {
      return error.errors.map((one) => one.message).join("; ");
    }
    throw error;
  }
}

const updateCommentMutation = `mutation UpdateComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) {
    issueComment {
      __typename id body url createdAt updatedAt
      author { login __typename }
      issue { id repository { id nameWithOwner } }
    }
  }
}`;

const deleteCommentMutation = `mutation DeleteComment($id: ID!) {
  deleteIssueComment(input: { id: $id }) { clientMutationId }
}`;

export async function updateComment(
  octokit: Client,
  id: string,
  body: string,
): Promise<Comment> {
  const answer = await octokit.graphql<{
    updateIssueComment: { issueComment: GraphComment };
  }>(updateCommentMutation, { id, body });
  const node = answer.updateIssueComment.issueComment;
  return {
    node: node.id,
    body: node.body,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    author: loginOf(node.author),
    issue: node.issue.id,
    repository: {
      node: node.issue.repository.id,
      name: node.issue.repository.nameWithOwner,
    },
  };
}

async function commentIsGone(octokit: Client, id: string): Promise<boolean> {
  const answer = await commentsByNode(octokit, [id]);
  return (
    answer.found.length === 0 &&
    answer.refused.size === 0 &&
    answer.elsewhere.size === 0
  );
}

/** GraphQL answers NOT_FOUND alike for a comment gone and for one it will
 *  not let the App touch, so it counts as gone only where the comment no
 *  longer reads in a repository that still does. */
export async function deleteComment(
  octokit: Client,
  id: string,
  where: { owner: string; repo: string },
): Promise<void> {
  try {
    await octokit.graphql(deleteCommentMutation, { id });
  } catch (error) {
    if (
      error instanceof GraphqlResponseError &&
      error.errors?.every((one) => one.type === "NOT_FOUND") === true &&
      (await commentIsGone(octokit, id)) &&
      (await reads(octokit, where.owner, where.repo))
    ) {
      return;
    }
    throw error;
  }
}
