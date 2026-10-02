import type { Comment, Issue, Related, Relations } from "./entries.js";
import { GraphqlResponseError } from "@octokit/graphql";
import { batches, query, reads, type Client } from "./github.js";

const related = "id url repository { id }";

const issueFields = `
  id number title body state stateReason url closedAt createdAt updatedAt
  author { login __typename }
  labels(first: 100) { nodes { name } }
  assignees(first: 100) { nodes { login } }
  repository { id nameWithOwner }
  parent { ${related} }
  blockedBy(first: 50) { nodes { ${related} } }
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
      blocking(first: 50) { nodes { id } }
      subIssues(first: 100) { nodes { id } }
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
  nodes(ids: $ids) { __typename ... on Repository { id nameWithOwner } }
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
}

interface GraphRelations {
  __typename: string;
  id: string;
  parent: Related | null;
  blockedBy: { nodes: (Related | null)[] };
  blocking: { nodes: ({ id: string } | null)[] };
  subIssues: { nodes: ({ id: string } | null)[] };
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
        },
        relations: {
          parent: node.parent,
          blockedBy: node.blockedBy.nodes.filter(
            (one): one is Related => one !== null,
          ),
        },
      });
    }
  }
  return found;
}

export async function relationsOf(
  octokit: Client,
  ids: readonly string[],
): Promise<
  Map<string, Relations & { blocking: string[]; children: string[] }>
> {
  const found = new Map<
    string,
    Relations & { blocking: string[]; children: string[] }
  >();
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, relationsQuery, {
      ids: batch,
    })) as Nodes<GraphRelations>;
    for (const node of known(answer.nodes, "Issue")) {
      found.set(node.id, {
        parent: node.parent,
        blockedBy: node.blockedBy.nodes.filter(
          (one): one is Related => one !== null,
        ),
        blocking: node.blocking.nodes.flatMap((one) =>
          one === null ? [] : [one.id],
        ),
        children: node.subIssues.nodes.flatMap((one) =>
          one === null ? [] : [one.id],
        ),
      });
    }
  }
  return found;
}

export async function commentsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<Comment[]> {
  const found: Comment[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(octokit, commentsQuery, {
      ids: batch,
    })) as Nodes<GraphComment>;
    for (const node of known(answer.nodes, "IssueComment")) {
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
    }
  }
  return found;
}

export async function repositoryByNode(
  octokit: Client,
  id: string,
): Promise<{ node: string; name: string } | undefined> {
  const answer = (await query(octokit, repositoriesQuery, {
    ids: [id],
  })) as Nodes<{ __typename: string; id: string; nameWithOwner: string }>;
  const [found] = known(answer.nodes, "Repository");
  return found === undefined
    ? undefined
    : { node: found.id, name: found.nameWithOwner };
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
    if (error instanceof GraphqlResponseError) {
      return (
        error.errors?.map((one) => one.message).join("; ") ?? error.message
      );
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
      (await commentsByNode(octokit, [id])).length === 0 &&
      (await reads(octokit, where.owner, where.repo))
    ) {
      return;
    }
    throw error;
  }
}
