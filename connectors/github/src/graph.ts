import type { Comment, Issue, Related, Relations } from "./entries.js";
import { batches, query, type Client } from "./github.js";

const related = "id url repository { id }";

const issueFields = `
  id number title body state stateReason url closedAt createdAt updatedAt
  author { login }
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
    }
  }
}`;

const commentsQuery = `query Comments($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on IssueComment {
      id body url createdAt updatedAt
      author { login }
      issue { id repository { id } }
    }
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
  author: { login: string } | null;
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
}

interface GraphComment {
  __typename: string;
  id: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  issue: { id: string; repository: { id: string } };
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

/** Issues by node id, with their relations; one gone or hidden is left out. */
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
          author: node.author?.login ?? null,
          labels: node.labels.nodes.map((label) => label.name),
          assignees: node.assignees.nodes.map((one) => one.login),
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

/** The relations of issues by node id, and the issues each one blocks. */
export async function relationsOf(
  octokit: Client,
  ids: readonly string[],
): Promise<Map<string, Relations & { blocking: string[] }>> {
  const found = new Map<string, Relations & { blocking: string[] }>();
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
      });
    }
  }
  return found;
}

/** Comments by node id; one gone is left out. */
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
        author: node.author?.login ?? null,
        issue: node.issue.id,
        repository: node.issue.repository.id,
      });
    }
  }
  return found;
}

/** The node ids of a repository's issues by number, fifty to a query. */
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
