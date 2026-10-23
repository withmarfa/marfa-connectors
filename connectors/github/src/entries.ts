import { createHash } from "node:crypto";
import type { Entry, Item, Target } from "@withmarfa/connector";

/** What the App writes at the end of what a row makes, unseen on GitHub's
 *  page, so a later try finds what an earlier one made whatever changed. */
export function markOf(rowId: string): string {
  const digest = createHash("sha256").update(rowId).digest("hex");
  return `<!-- marfa:${digest.slice(0, 16)} -->`;
}

/** Whether a body ends with the row's mark, as the App writes it: one
 *  quoted anywhere else names nothing. */
export function markedFor(body: string, rowId: string): boolean {
  return body.trimEnd().endsWith(markOf(rowId));
}

export function unmarked(body: string): string {
  return body.replace(/\s*<!-- marfa:[0-9a-f]{16} -->\s*$/, "");
}

function issueBody(body: string | null): string | null {
  const text = body === null ? "" : unmarked(body);
  return text === "" ? null : text;
}

/** The GitHub node id a row is linked by. */
export function linkOf(row: Item): string | undefined {
  const value = row.properties["github_id"];
  return typeof value === "string" ? value : undefined;
}

export const repositoryType = "github.repository";
export const issueType = "github.issue";
export const commentType = "github.comment";
export const pullRequestType = "github.pull_request";
export const discussionType = "github.discussion";
export const childOf = "child-of";
export const inRepository = "github.in-repository";
export const subIssueOf = "github.sub-issue-of";
export const blockedBy = "github.blocked-by";
export const relatesTo = "github.relates-to";
export const duplicateOf = "github.duplicate-of";
export const githubCloses = "github.closes";
export const githubClosedBy = "github.closed-by";
export const inThread = "in-thread";

export interface RestRepository {
  id: number;
  node_id: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  has_issues?: boolean;
  updated_at: string;
}

export interface RestIssue {
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  html_url: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  assignees?: { login: string }[] | null;
  comments: number;
  pull_request?: unknown;
}

export interface RestComment {
  node_id: string;
  body: string | null;
  html_url: string;
  issue_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
}

export interface Discussion {
  node: string;
  number: number;
  title: string;
  body: string;
  url: string;
  open: boolean;
  /** GitHub's `stateReason`, lowercase: resolved, outdated, duplicate or reopened. */
  reason: string | null;
  answered: boolean;
  locked: boolean;
  category: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  repository: { node: string; name: string };
}

/** A comment or reply on a discussion; a reply names the comment it answers. */
export interface DiscussionComment {
  node: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Set where GitHub deleted a comment it keeps for its replies. */
  deleted: boolean;
  author: string | null;
  discussion: string;
  replyTo: string | null;
  repository: { node: string; name: string };
}

export interface Related {
  id: string;
  url: string;
  repository: { id: string };
}

export interface Issue {
  node: string;
  number: number;
  title: string;
  body: string | null;
  open: boolean;
  reason: string | null;
  url: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  labels: string[];
  assignees: string[];
  repository: { node: string; name: string };
}

export interface Relations {
  /** GitHub shows an App no issue in a private repository it is not
   *  installed on, so such a relation is not here at all. */
  parent: Related | null;
  blockedBy: Related[];
  relatesTo: Related[];
  duplicateOf: Related | null;
}

export interface Comment {
  node: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  issue: string;
  repository: { node: string; name: string };
}

export function issueOfRest(
  issue: RestIssue,
  repository: { node: string; name: string },
): Issue {
  return {
    node: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body === "" ? null : issue.body,
    open: issue.state === "open",
    reason: issue.state_reason ?? null,
    url: issue.html_url,
    closedAt: issue.closed_at,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    author: issue.user?.login ?? null,
    labels: issue.labels
      .flatMap((label) =>
        typeof label === "string"
          ? [label]
          : label.name === undefined
            ? []
            : [label.name],
      )
      .sort(),
    assignees: (issue.assignees ?? []).map((one) => one.login).sort(),
    repository,
  };
}

export function statusOf(open: boolean, reason: string | null): string {
  if (open) return "pending";
  return reason === "not_planned" || reason === "duplicate"
    ? "canceled"
    : "completed";
}

export function repositoryEntry(repository: RestRepository): Entry {
  return {
    source_id: repository.node_id,
    properties: {
      github_id: repository.node_id,
      name: repository.full_name,
      url: repository.html_url,
      description: repository.description,
      private: repository.private,
      archived_on_github: repository.archived,
    },
    changed_at: repository.updated_at,
  };
}

/** Identifies the pull request that closed an issue. `node` is present when
 *  the PR's repository is synced so a connection can be made; absent when
 *  only its address is known. */
export type ClosedByPR =
  { node: string; url: string } | { node?: undefined; url: string } | null;

/** `hidden` is the repository's visibility: named by every read and by the
 *  answers to writes where the last read recorded it. `closedByPR`, when
 *  given, sets the github.closed-by connection (synced PR) or closed_by_url
 *  (PR outside the synced set). */
export function issueEntry(
  issue: Issue,
  relations: Relations,
  synced: ReadonlySet<string>,
  hidden?: boolean,
  retainedIssues: ReadonlySet<string> = new Set(),
  closedByPR?: ClosedByPR,
): Entry {
  const inside = (one: Related): boolean =>
    synced.has(one.repository.id) || retainedIssues.has(one.id);
  const target = (one: Related): Target => ({ type: issueType, id: one.id });
  const parent = relations.parent;
  const prNode = closedByPR?.node;
  return {
    source_id: issue.node,
    properties: {
      github_id: issue.node,
      title: issue.title,
      body: issueBody(issue.body),
      status: statusOf(issue.open, issue.reason),
      completed_at: issue.open ? null : issue.closedAt,
      url: issue.url,
      number: issue.number,
      repository: issue.repository.name,
      ...(hidden !== undefined && { private: hidden }),
      author: issue.author,
      labels: issue.labels,
      assignees: issue.assignees,
      state_reason: issue.reason,
      github_updated_at: issue.updatedAt,
      parent_url: parent === null || inside(parent) ? null : parent.url,
      related_urls: relations.relatesTo
        .filter((one) => !inside(one))
        .map((one) => one.url)
        .sort(),
      duplicate_of_url:
        relations.duplicateOf === null || inside(relations.duplicateOf)
          ? null
          : relations.duplicateOf.url,
      blocked_by_urls: relations.blockedBy
        .filter((one) => !inside(one))
        .map((one) => one.url),
      ...((closedByPR !== undefined || issue.open) && {
        closed_by_url:
          closedByPR !== null &&
          closedByPR !== undefined &&
          prNode === undefined
            ? closedByPR.url
            : null,
      }),
    },
    occurred_at: issue.createdAt,
    changed_at: issue.updatedAt,
    connections: {
      [inRepository]: [{ type: repositoryType, id: issue.repository.node }],
      [subIssueOf]: parent !== null && inside(parent) ? [target(parent)] : [],
      [blockedBy]: relations.blockedBy.filter(inside).map(target),
      [relatesTo]: relations.relatesTo
        .filter((one) => inside(one) && issue.node < one.id)
        .map(target),
      [duplicateOf]:
        relations.duplicateOf !== null && inside(relations.duplicateOf)
          ? [target(relations.duplicateOf)]
          : [],
      ...((closedByPR !== undefined || issue.open) && {
        [githubClosedBy]:
          prNode === undefined ? [] : [{ type: pullRequestType, id: prNode }],
      }),
    },
  };
}

export interface CheckCounts {
  /** Rollup state from GitHub's StatusCheckRollup. */
  state: string;
  /** Non-zero counts by CheckRunState. */
  check_runs: Record<string, number>;
  /** Non-zero counts by StatusState. */
  statuses: Record<string, number>;
}

export interface PullRequest {
  node: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  prState: "open" | "closed" | "merged";
  draft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  baseBranch: string;
  headBranch: string;
  author: string | null;
  checks: CheckCounts | null;
  createdAt: string;
  updatedAt: string;
  repository: { node: string; name: string };
  closingIssues: { id: string; url: string; repository: { id: string } }[];
}

export function prStatusOf(prState: "open" | "closed" | "merged"): string {
  if (prState === "open") return "pending";
  if (prState === "merged") return "completed";
  return "canceled";
}

export function pullRequestEntry(
  pr: PullRequest,
  syncedRepositories: ReadonlySet<string>,
  hidden: boolean,
): Entry {
  const closingIssueTargets = pr.closingIssues
    .filter((issue) => syncedRepositories.has(issue.repository.id))
    .map((issue) => ({ type: issueType, id: issue.id }));
  const completedAt =
    pr.prState === "open" ? null : (pr.mergedAt ?? pr.closedAt);
  return {
    source_id: pr.node,
    properties: {
      github_id: pr.node,
      title: pr.title,
      body: pr.body,
      status: prStatusOf(pr.prState),
      completed_at: completedAt,
      url: pr.url,
      number: pr.number,
      repository: pr.repository.name,
      private: hidden,
      author: pr.author,
      pr_state: pr.prState,
      draft: pr.draft,
      merged_at: pr.mergedAt,
      base_branch: pr.baseBranch,
      head_branch: pr.headBranch,
      checks: pr.checks,
      github_updated_at: pr.updatedAt,
    },
    occurred_at: pr.createdAt,
    changed_at: pr.updatedAt,
    connections: {
      [inRepository]: [{ type: repositoryType, id: pr.repository.node }],
      [githubCloses]: closingIssueTargets,
    },
  };
}

export function commentEntry(comment: Comment, hidden?: boolean): Entry {
  return {
    source_id: comment.node,
    properties: {
      github_id: comment.node,
      body: unmarked(comment.body),
      from: comment.author ?? "ghost",
      repository: comment.repository.name,
      ...(hidden !== undefined && { private: hidden }),
      url: comment.url,
    },
    occurred_at: comment.createdAt,
    changed_at: comment.updatedAt,
    connections: {
      [inThread]: [{ type: issueType, id: comment.issue }],
      [inRepository]: [{ type: repositoryType, id: comment.repository.node }],
    },
  };
}

export function discussionEntry(
  discussion: Discussion,
  hidden?: boolean,
): Entry {
  return {
    source_id: discussion.node,
    properties: {
      github_id: discussion.node,
      title: discussion.title,
      body: unmarked(discussion.body),
      number: discussion.number,
      repository: discussion.repository.name,
      ...(hidden !== undefined && { private: hidden }),
      author: discussion.author,
      category: discussion.category,
      status: discussion.open ? "open" : "closed",
      state_reason: discussion.reason,
      answered: discussion.answered,
      locked: discussion.locked,
      url: discussion.url,
      github_updated_at: discussion.updatedAt,
    },
    occurred_at: discussion.createdAt,
    changed_at: discussion.updatedAt,
    connections: {
      [inRepository]: [
        { type: repositoryType, id: discussion.repository.node },
      ],
    },
  };
}

export function discussionCommentEntry(
  comment: DiscussionComment,
  hidden?: boolean,
): Entry {
  return {
    source_id: comment.node,
    properties: {
      github_id: comment.node,
      body: comment.deleted ? "" : unmarked(comment.body),
      from: comment.author ?? "ghost",
      repository: comment.repository.name,
      ...(hidden !== undefined && { private: hidden }),
      url: comment.url,
    },
    occurred_at: comment.createdAt,
    changed_at: comment.updatedAt,
    connections: {
      [inThread]: [{ type: discussionType, id: comment.discussion }],
      [inRepository]: [{ type: repositoryType, id: comment.repository.node }],
      [childOf]:
        comment.replyTo === null
          ? []
          : [{ type: commentType, id: comment.replyTo }],
    },
  };
}
