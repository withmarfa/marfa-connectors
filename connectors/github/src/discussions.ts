import { GraphqlResponseError } from "@octokit/graphql";
import { RequestError } from "@octokit/request-error";
import type { EnvDeclaration, RunContext } from "@withmarfa/connector";
import {
  commentType,
  discussionCommentEntry,
  discussionEntry,
  discussionType,
  inRepository,
  inThread,
  linkOf,
  repositoryType,
  type Discussion,
  type DiscussionComment,
} from "./entries.js";
import { batches, query, reads, type Client } from "./github.js";
import { loginOf } from "./graph.js";

/** A comment cursor asked a little early, so a discussion GitHub shows late
 *  under an earlier time is still read; what comes again is unchanged. */
const overlap = 5 * 60 * 1000;

const discussionFields = `
  id number title body url closed stateReason isAnswered locked
  createdAt updatedAt
  author { login __typename }
  category { name }
  repository { id nameWithOwner }
`;

const commentFields = `
  id body url createdAt updatedAt deletedAt
  author { login __typename }
  replyTo { id }
`;

const whereFields = "discussion { id repository { id nameWithOwner } }";

interface Page<T> {
  nodes: (T | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface Author {
  login: string;
  __typename: string;
}

interface GraphDiscussion {
  __typename?: string;
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  closed: boolean;
  stateReason: string | null;
  isAnswered: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  author: Author | null;
  category: { name: string };
  repository: { id: string; nameWithOwner: string };
}

interface GraphComment {
  __typename?: string;
  id: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  author: Author | null;
  replyTo: { id: string } | null;
  replies?: Page<GraphComment>;
  discussion?: {
    id: string;
    repository: { id: string; nameWithOwner: string };
  };
}

interface Repository {
  node: string;
  name: string;
}

function discussionOf(node: GraphDiscussion): Discussion {
  return {
    node: node.id,
    number: node.number,
    title: node.title,
    body: node.body,
    url: node.url,
    open: !node.closed,
    reason: node.stateReason === null ? null : node.stateReason.toLowerCase(),
    answered: node.isAnswered,
    locked: node.locked,
    category: node.category.name,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    author: loginOf(node.author),
    repository: {
      node: node.repository.id,
      name: node.repository.nameWithOwner,
    },
  };
}

function commentOf(
  node: GraphComment,
  discussion: string,
  repository: Repository,
): DiscussionComment {
  return {
    node: node.id,
    body: node.body,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    deleted: node.deletedAt !== null,
    author: loginOf(node.author),
    discussion,
    replyTo: node.replyTo?.id ?? null,
    repository,
  };
}

function advance(
  page: Page<unknown>,
  seen: Set<string>,
  what: string,
): string | undefined {
  if (!page.pageInfo.hasNextPage) return undefined;
  const cursor = page.pageInfo.endCursor;
  if (cursor === null || seen.has(cursor))
    throw new Error(`GitHub did not advance its ${what} cursor`);
  seen.add(cursor);
  return cursor;
}

/** Why GitHub will not show the App or token a repository's Discussions: the
 *  installation does not hold the permission, or its answer names the
 *  repository as unreadable. Anything else is no refusal and is thrown on. */
export class DiscussionsRefused extends Error {
  override name = "DiscussionsRefused";
}

export function discussionsRefusal(error: unknown): string | undefined {
  if (error instanceof DiscussionsRefused) return error.message;
  if (
    error instanceof RequestError &&
    error.status === 422 &&
    error.request.url.endsWith("/access_tokens")
  )
    return "the App's installation has not accepted the Discussions permission";
  if (
    error instanceof GraphqlResponseError &&
    error.errors?.some((one) => one.type === "FORBIDDEN") === true
  )
    return error.errors.map((one) => one.message).join("; ");
  return undefined;
}

export async function discussionsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<Discussion[]> {
  const found: Discussion[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(
      octokit,
      `query DiscussionNodes($ids: [ID!]!) {
        nodes(ids: $ids) { __typename ... on Discussion { ${discussionFields} } }
      }`,
      { ids: batch },
    )) as { nodes: (GraphDiscussion | null)[] };
    for (const node of answer.nodes)
      if (node?.__typename === "Discussion") found.push(discussionOf(node));
  }
  return found;
}

export async function discussionCommentsByNode(
  octokit: Client,
  ids: readonly string[],
): Promise<DiscussionComment[]> {
  const found: DiscussionComment[] = [];
  for (const batch of batches([...new Set(ids)])) {
    const answer = (await query(
      octokit,
      `query DiscussionCommentNodes($ids: [ID!]!) {
        nodes(ids: $ids) { __typename ... on DiscussionComment { ${commentFields} ${whereFields} } }
      }`,
      { ids: batch },
    )) as { nodes: (GraphComment | null)[] };
    for (const node of answer.nodes) {
      if (
        node?.__typename !== "DiscussionComment" ||
        node.discussion === undefined
      )
        continue;
      found.push(
        commentOf(node, node.discussion.id, {
          node: node.discussion.repository.id,
          name: node.discussion.repository.nameWithOwner,
        }),
      );
    }
  }
  return found;
}

/** Every top-level comment and reply of a discussion, parents before their
 *  replies; none where GitHub no longer shows the discussion. */
export async function commentsOf(
  octokit: Client,
  discussion: { node: string; repository: Repository },
): Promise<DiscussionComment[] | undefined> {
  const found: DiscussionComment[] = [];
  const add = (node: GraphComment): void => {
    found.push(commentOf(node, discussion.node, discussion.repository));
  };
  let after: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const answer = (await query(
      octokit,
      `query DiscussionComments($id: ID!, $after: String) {
        node(id: $id) { ... on Discussion { comments(first: 50, after: $after) {
          nodes { ${commentFields} replies(first: 50) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } }
          pageInfo { hasNextPage endCursor }
        } } }
      }`,
      { id: discussion.node, after },
    )) as { node: { comments?: Page<GraphComment> } | null };
    const page = answer.node?.comments;
    if (page === undefined) return undefined;
    for (const top of page.nodes) {
      if (top === null) continue;
      add(top);
      let replies = top.replies;
      const cursors = new Set<string>();
      while (replies !== undefined) {
        for (const reply of replies.nodes) if (reply !== null) add(reply);
        const next = advance(replies, cursors, "discussion reply");
        if (next === undefined) break;
        const more = (await query(
          octokit,
          `query DiscussionReplies($id: ID!, $after: String) {
            node(id: $id) { ... on DiscussionComment { replies(first: 50, after: $after) {
              nodes { ${commentFields} } pageInfo { hasNextPage endCursor }
            } } }
          }`,
          { id: top.id, after: next },
        )) as { node: { replies?: Page<GraphComment> } | null };
        replies = more.node?.replies;
      }
    }
    after = advance(page, seen, "discussion comment") ?? null;
    if (after === null) return found;
  }
}

/** A repository's discussions, newest change first, down to `since` where
 *  one is given. A repository with Discussions turned off lists none. */
export async function listDiscussions(
  octokit: Client,
  owner: string,
  name: string,
  since?: string,
): Promise<{ enabled: boolean; found: Discussion[] }> {
  const found: Discussion[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const answer = (await query(
      octokit,
      `query DiscussionList($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          hasDiscussionsEnabled
          discussions(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { ${discussionFields} } pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner, name, after },
    )) as {
      repository: {
        hasDiscussionsEnabled: boolean;
        discussions: Page<GraphDiscussion>;
      } | null;
    };
    if (answer.repository === null)
      throw new DiscussionsRefused(
        `GitHub does not show ${owner}/${name} to the token that reads Discussions`,
      );
    if (!answer.repository.hasDiscussionsEnabled)
      return { enabled: false, found: [] };
    const page = answer.repository.discussions;
    let older = false;
    for (const node of page.nodes) {
      if (node === null) continue;
      if (since !== undefined && node.updatedAt < since) {
        older = true;
        break;
      }
      found.push(discussionOf(node));
    }
    if (older) return { enabled: true, found };
    after = advance(page, seen, "discussion") ?? null;
    if (after === null) return { enabled: true, found };
  }
}

export async function discussionCategories(
  octokit: Client,
  owner: string,
  name: string,
): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const answer = (await query(
      octokit,
      `query DiscussionCategories($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          discussionCategories(first: 50, after: $after) {
            nodes { id name } pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner, name, after },
    )) as {
      repository: {
        discussionCategories: Page<{ id: string; name: string }>;
      } | null;
    };
    if (answer.repository === null)
      throw new DiscussionsRefused(
        `GitHub does not show ${owner}/${name} to the token that reads Discussions`,
      );
    const page = answer.repository.discussionCategories;
    for (const node of page.nodes) if (node !== null) found.push(node);
    after = advance(page, seen, "discussion category") ?? null;
    if (after === null) return found;
  }
}

const mutations = {
  create: `mutation CreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) {
      discussion { ${discussionFields} }
    }
  }`,
  update: `mutation UpdateDiscussion($id: ID!, $title: String, $body: String) {
    updateDiscussion(input: {discussionId: $id, title: $title, body: $body}) {
      discussion { ${discussionFields} }
    }
  }`,
  close: `mutation CloseDiscussion($id: ID!, $reason: DiscussionCloseReason) {
    closeDiscussion(input: {discussionId: $id, reason: $reason}) {
      discussion { ${discussionFields} }
    }
  }`,
  reopen: `mutation ReopenDiscussion($id: ID!) {
    reopenDiscussion(input: {discussionId: $id}) {
      discussion { ${discussionFields} }
    }
  }`,
  comment: `mutation AddDiscussionComment($discussionId: ID!, $replyToId: ID, $body: String!) {
    addDiscussionComment(input: {discussionId: $discussionId, replyToId: $replyToId, body: $body}) {
      comment { ${commentFields} ${whereFields} }
    }
  }`,
  edit: `mutation UpdateDiscussionComment($id: ID!, $body: String!) {
    updateDiscussionComment(input: {commentId: $id, body: $body}) {
      comment { ${commentFields} ${whereFields} }
    }
  }`,
  delete: `mutation DeleteDiscussionComment($id: ID!) {
    deleteDiscussionComment(input: {id: $id}) { comment { id } }
  }`,
};

type Closing = "RESOLVED" | "OUTDATED" | "DUPLICATE";

/** A create is never retried blind: one that landed would be made twice. */
const once = { request: { retries: 0 } };

export async function createDiscussion(
  octokit: Client,
  input: {
    repositoryId: string;
    categoryId: string;
    title: string;
    body: string;
  },
): Promise<Discussion> {
  const answer = await octokit.graphql<{
    createDiscussion: { discussion: GraphDiscussion };
  }>(mutations.create, { ...input, ...once });
  return discussionOf(answer.createDiscussion.discussion);
}

export async function updateDiscussion(
  octokit: Client,
  id: string,
  patch: { title?: string; body?: string },
): Promise<Discussion> {
  const answer = await octokit.graphql<{
    updateDiscussion: { discussion: GraphDiscussion };
  }>(mutations.update, { id, ...patch });
  return discussionOf(answer.updateDiscussion.discussion);
}

export async function closeDiscussion(
  octokit: Client,
  id: string,
  reason: Closing,
): Promise<Discussion> {
  const answer = await octokit.graphql<{
    closeDiscussion: { discussion: GraphDiscussion };
  }>(mutations.close, { id, reason });
  return discussionOf(answer.closeDiscussion.discussion);
}

export async function reopenDiscussion(
  octokit: Client,
  id: string,
): Promise<Discussion> {
  const answer = await octokit.graphql<{
    reopenDiscussion: { discussion: GraphDiscussion };
  }>(mutations.reopen, { id });
  return discussionOf(answer.reopenDiscussion.discussion);
}

function answered(node: GraphComment): DiscussionComment {
  if (node.discussion === undefined)
    throw new Error("GitHub's answer named no discussion for the comment");
  return commentOf(node, node.discussion.id, {
    node: node.discussion.repository.id,
    name: node.discussion.repository.nameWithOwner,
  });
}

export async function addDiscussionComment(
  octokit: Client,
  input: { discussionId: string; replyToId?: string; body: string },
): Promise<DiscussionComment> {
  const answer = await octokit.graphql<{
    addDiscussionComment: { comment: GraphComment };
  }>(mutations.comment, { ...input, ...once });
  return answered(answer.addDiscussionComment.comment);
}

export async function updateDiscussionComment(
  octokit: Client,
  id: string,
  body: string,
): Promise<DiscussionComment> {
  const answer = await octokit.graphql<{
    updateDiscussionComment: { comment: GraphComment };
  }>(mutations.edit, { id, body });
  return answered(answer.updateDiscussionComment.comment);
}

/** GraphQL answers NOT_FOUND alike for a comment gone and for one it will
 *  not let the App touch, so it counts as gone only where the comment no
 *  longer reads in a repository that still does. */
export async function deleteDiscussionComment(
  octokit: Client,
  id: string,
  where: { owner: string; repo: string },
): Promise<void> {
  try {
    await octokit.graphql(mutations.delete, { id });
  } catch (error) {
    if (
      error instanceof GraphqlResponseError &&
      error.errors?.every((one) => one.type === "NOT_FOUND") === true &&
      (await discussionCommentsByNode(octokit, [id])).length === 0 &&
      (await reads(octokit, where.owner, where.repo))
    ) {
      return;
    }
    throw error;
  }
}

type Reading = Pick<
  RunContext<EnvDeclaration>,
  "upsert" | "linked" | "archive" | "log"
>;

/** The discussions Marfa holds in a repository, each with the links of the
 *  comments and replies it holds under it. Rows written by this run have no
 *  connection yet, so this is read before anything is written. */
export async function heldIn(
  context: Pick<Reading, "linked">,
  node: string,
): Promise<Map<string, string[]>> {
  const held = new Map<string, string[]>();
  const rows = await context.linked(discussionType, inRepository, {
    type: repositoryType,
    id: node,
  });
  for (const row of rows) {
    const link = linkOf(row);
    if (link === undefined) continue;
    const comments = await context.linked(commentType, inThread, {
      type: discussionType,
      id: link,
    });
    held.set(
      link,
      comments.flatMap((one) => linkOf(one) ?? []),
    );
  }
  return held;
}

function ordered(comments: readonly DiscussionComment[]): DiscussionComment[] {
  // Parents first, so a reply never names a comment the batch lacks yet.
  return [
    ...comments.filter((one) => one.replyTo === null),
    ...comments.filter((one) => one.replyTo !== null),
  ];
}

async function write(
  context: Reading,
  discussions: readonly Discussion[],
  comments: ReadonlyMap<string, readonly DiscussionComment[]>,
  hidden: boolean,
): Promise<void> {
  await context.upsert(
    discussionType,
    discussions.map((one) => discussionEntry(one, hidden)),
  );
  await context.upsert(
    commentType,
    ordered([...comments.values()].flat()).map((one) =>
      discussionCommentEntry(one, hidden),
    ),
  );
}

/** Reads a repository's discussions with every comment and reply, and writes
 *  them. Down to the saved time it lists only what changed; a first read and
 *  the daily check list them all, which also archives what GitHub no longer
 *  returns, a discussion or a comment, once a lookup by its own node agrees.
 *  A new comment may not move its discussion's time, so only that full read
 *  and a delivery find a comment on a discussion otherwise quiet. Returns
 *  the time the next read lists down to. */
export async function syncDiscussions(
  context: Reading,
  octokit: Client,
  where: { node: string; owner: string; name: string; hidden: boolean },
  last: { since: string } | undefined,
  full: boolean,
): Promise<{ since: string } | undefined> {
  const everything = full || last === undefined;
  const started = new Date().toISOString();
  const listing = await listDiscussions(
    octokit,
    where.owner,
    where.name,
    everything
      ? undefined
      : new Date(Date.parse(last.since) - overlap).toISOString(),
  );
  if (!listing.enabled) return last;
  const held = everything ? await heldIn(context, where.node) : undefined;
  const repository = {
    node: where.node,
    name: `${where.owner}/${where.name}`,
  };
  const comments = new Map<string, DiscussionComment[]>();
  for (const one of listing.found) {
    const read = await commentsOf(octokit, {
      node: one.node,
      repository,
    });
    if (read !== undefined) comments.set(one.node, read);
  }
  await write(
    context,
    listing.found.filter((one) => comments.has(one.node)),
    comments,
    where.hidden,
  );
  if (held !== undefined) {
    await archiveGone(context, octokit, held, comments, listing.found);
  }
  return {
    since: listing.found.reduce(
      (latest, one) => (one.updatedAt > latest ? one.updatedAt : latest),
      last?.since ?? started,
    ),
  };
}

async function archiveGone(
  context: Reading,
  octokit: Client,
  held: ReadonlyMap<string, readonly string[]>,
  comments: ReadonlyMap<string, readonly DiscussionComment[]>,
  listed: readonly Discussion[],
): Promise<void> {
  const returned = new Set(listed.map((one) => one.node));
  const absent = [...held.keys()].filter((link) => !returned.has(link));
  const still = new Set(
    (await discussionsByNode(octokit, absent)).map((one) => one.node),
  );
  const goneDiscussions = absent.filter((link) => !still.has(link));
  const goneComments = goneDiscussions.flatMap((link) => held.get(link) ?? []);
  // Only a discussion whose comments were all read has any to be missing.
  const missing: string[] = [];
  for (const [link, read] of comments) {
    const shown = new Set(read.map((one) => one.node));
    for (const comment of held.get(link) ?? [])
      if (!shown.has(comment)) missing.push(comment);
  }
  const alive = new Set(
    (await discussionCommentsByNode(octokit, missing)).map((one) => one.node),
  );
  await context.archive(commentType, [
    ...goneComments,
    ...missing.filter((link) => !alive.has(link)),
  ]);
  await context.archive(discussionType, goneDiscussions);
  if (goneDiscussions.length > 0) {
    context.log.info(
      `${String(goneDiscussions.length)} discussion${goneDiscussions.length === 1 ? "" : "s"} GitHub no longer returns, and their comments, archived`,
    );
  }
}

/** The discussions a delivery named, read with their comments where GitHub
 *  shows them in a synced repository, and archived, with their comments,
 *  where GitHub shows them nowhere, nothing deferred and their repository
 *  still reads. A refusal is left to the scheduled read, which says it
 *  for the repository. Returns those not shown yet because a limit
 *  deferred the look. */
export async function readNamedDiscussions(
  context: Reading,
  ids: ReadonlySet<string>,
  where: {
    listed: ReadonlyMap<
      string,
      { repository: { full_name: string }; installation: number }
    >;
    synced: ReadonlySet<string>;
    clients: ReadonlyMap<number, Client>;
    hidden: (node: string) => boolean;
    deferred: boolean;
  },
): Promise<Set<string>> {
  const unseen = new Set(ids);
  for (const [, octokit] of where.clients) {
    if (unseen.size === 0) return unseen;
    let found: Discussion[];
    try {
      found = await discussionsByNode(octokit, [...unseen]);
    } catch (error) {
      if (discussionsRefusal(error) !== undefined) continue;
      throw error;
    }
    const written: Discussion[] = [];
    const comments = new Map<string, DiscussionComment[]>();
    for (const one of found) {
      unseen.delete(one.node);
      if (!where.synced.has(one.repository.node)) continue;
      const read = await commentsOf(octokit, one);
      if (read === undefined) continue;
      written.push(one);
      comments.set(one.node, read);
    }
    for (const node of new Set(written.map((one) => one.repository.node))) {
      await write(
        context,
        written.filter((one) => one.repository.node === node),
        new Map(
          written
            .filter((one) => one.repository.node === node)
            .map((one) => [one.node, comments.get(one.node) ?? []]),
        ),
        where.hidden(node),
      );
    }
  }
  if (unseen.size === 0) return unseen;
  if (where.deferred) return unseen;
  for (const [node, { repository, installation }] of where.listed) {
    if (!where.synced.has(node)) continue;
    const octokit = where.clients.get(installation);
    if (octokit === undefined) continue;
    const held = await heldIn(context, node);
    const gone = [...held.keys()].filter((link) => unseen.has(link));
    if (gone.length === 0) continue;
    const [owner = "", name = ""] = repository.full_name.split("/");
    if (!(await reads(octokit, owner, name))) {
      context.log.condition(
        `repository-unreadable:${node}`,
        `${repository.full_name} is listed for the App but does not read, so its rows are left as they are`,
      );
      continue;
    }
    await context.archive(
      commentType,
      gone.flatMap((link) => held.get(link) ?? []),
    );
    await context.archive(discussionType, gone);
    for (const link of gone) unseen.delete(link);
  }
  return new Set();
}
