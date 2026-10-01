import { createHash } from "node:crypto";
import type { Entry, Target } from "@withmarfa/connector";

/** What the App writes at the end of what a row makes, unseen on GitHub's
 *  page, so a later try finds what an earlier one made whatever changed. */
export function markOf(rowId: string): string {
  const digest = createHash("sha256").update(rowId).digest("hex");
  return `<!-- marfa:${digest.slice(0, 16)} -->`;
}

export function unmarked(body: string): string {
  return body.replace(/\s*<!-- marfa:[0-9a-f]{16} -->\s*$/, "");
}

function issueBody(body: string | null): string | null {
  const text = body === null ? "" : unmarked(body);
  return text === "" ? null : text;
}

export const repositoryType = "github.repository";
export const issueType = "github.issue";
export const commentType = "github.comment";
export const inRepository = "github.in-repository";
export const subIssueOf = "github.sub-issue-of";
export const blockedBy = "github.blocked-by";
export const inThread = "in-thread";

export interface RestRepository {
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

export function issueEntry(
  issue: Issue,
  relations: Relations,
  synced: ReadonlySet<string>,
): Entry {
  const inside = (one: Related): boolean => synced.has(one.repository.id);
  const target = (one: Related): Target => ({ type: issueType, id: one.id });
  const parent = relations.parent;
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
      author: issue.author,
      labels: issue.labels,
      assignees: issue.assignees,
      state_reason: issue.reason,
      github_updated_at: issue.updatedAt,
      parent_url: parent === null || inside(parent) ? null : parent.url,
      blocked_by_urls: relations.blockedBy
        .filter((one) => !inside(one))
        .map((one) => one.url),
    },
    occurred_at: issue.createdAt,
    changed_at: issue.updatedAt,
    connections: {
      [inRepository]: [{ type: repositoryType, id: issue.repository.node }],
      [subIssueOf]: parent !== null && inside(parent) ? [target(parent)] : [],
      [blockedBy]: relations.blockedBy.filter(inside).map(target),
    },
  };
}

export function commentEntry(comment: Comment): Entry {
  return {
    source_id: comment.node,
    properties: {
      github_id: comment.node,
      body: unmarked(comment.body),
      from: comment.author ?? "ghost",
      repository: comment.repository.name,
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
