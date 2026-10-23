import type { IncomingMessage } from "node:http";
import type { Budget, Repository } from "./github-stub.js";

/** What a thread concerns. GitHub names the subject by its API address, which
 *  the stub builds from these. */
export interface Subject {
  type: string;
  title: string;
  number?: number;
  sha?: string;
}

export interface Thread {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  last_read_at: string | null;
  subject: Subject;
  repository: Repository;
}

type Send = (
  status: number,
  data?: unknown,
  headers?: Record<string, string>,
) => void;

const paths: Record<string, string> = {
  Issue: "issues",
  PullRequest: "pulls",
  Discussion: "discussions",
  Commit: "commits",
};

/** GitHub's notifications for the person a classic token names. They answer
 *  only a classic token with the `notifications` scope, say when they last
 *  changed, and say how often they may be polled. */
export class NotificationsStub {
  /** The classic token the listing accepts. */
  token: string | undefined;
  /** The scopes that token holds, as `X-OAuth-Scopes` says. */
  scopes = ["notifications"];
  /** `X-Poll-Interval`; GitHub sends 60 and may raise it under load. */
  pollInterval: number | undefined = 60;
  /** GitHub's page size for this listing is at most 50. */
  pageSize = 50;
  /** Answers the next listings with this status and message, as GitHub does
   *  for a request it will not take. */
  failing: { status: number; message: string; page?: number } | undefined;
  threads: Thread[] = [];
  private modified = Math.floor(Date.now() / 1000) * 1000;
  private ids = 26_000_000_000;

  /** The listing changes at least a second after its last change, so a client
   *  holding the last `Last-Modified` always sees a later change as one. */
  private touch(): string {
    this.modified = Math.max(
      this.modified + 1000,
      Math.floor(Date.now() / 1000) * 1000,
    );
    return new Date(this.modified).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  add(
    repository: Repository,
    subject: Subject,
    fields: Partial<Pick<Thread, "reason" | "unread" | "last_read_at">> = {},
  ): Thread {
    this.ids += 1;
    const made: Thread = {
      id: String(this.ids),
      reason: "subscribed",
      unread: true,
      last_read_at: null,
      ...fields,
      updated_at: this.touch(),
      subject,
      repository,
    };
    this.threads.push(made);
    return made;
  }

  change(
    thread: Thread,
    fields: Partial<Pick<Thread, "reason" | "unread" | "last_read_at">>,
  ): void {
    Object.assign(thread, fields, { updated_at: this.touch() });
  }

  /** GitHub no longer lists a thread marked done, or one older than it keeps. */
  remove(thread: Thread): void {
    this.threads = this.threads.filter((one) => one !== thread);
    this.touch();
  }

  handles(path: string): boolean {
    return path === "/notifications";
  }

  private rest(thread: Thread, base: string): Record<string, unknown> {
    const { subject, repository } = thread;
    const root = `${base}/repos/${repository.owner}/${repository.name}`;
    const tail = paths[subject.type];
    const at = subject.number ?? subject.sha;
    return {
      id: thread.id,
      unread: thread.unread,
      reason: thread.reason,
      updated_at: thread.updated_at,
      last_read_at: thread.last_read_at,
      subject: {
        title: subject.title,
        url:
          tail === undefined || at === undefined
            ? null
            : `${root}/${tail}/${String(at)}`,
        latest_comment_url: null,
        type: subject.type,
      },
      repository: {
        id: repository.id,
        node_id: repository.node,
        name: repository.name,
        full_name: `${repository.owner}/${repository.name}`,
        private: repository.private,
        html_url: `https://github.com/${repository.owner}/${repository.name}`,
      },
      url: `${base}/notifications/threads/${thread.id}`,
      subscription_url: `${base}/notifications/threads/${thread.id}/subscription`,
    };
  }

  serve(
    req: IncomingMessage,
    url: URL,
    base: string,
    answer: { budget: Budget; send: Send; limit: () => void },
  ): void {
    const { budget, send, limit } = answer;
    if (
      this.token === undefined ||
      req.headers.authorization !== `Bearer ${this.token}`
    ) {
      send(401, { message: "Bad credentials" });
      return;
    }
    if (!this.scopes.includes("notifications")) {
      send(
        403,
        { message: "Resource not accessible by personal access token" },
        {
          "x-oauth-scopes": this.scopes.join(", "),
          "x-accepted-oauth-scopes": "notifications, repo",
        },
      );
      return;
    }
    const headers: Record<string, string> = {
      "x-oauth-scopes": this.scopes.join(", "),
      "x-accepted-oauth-scopes": "notifications, repo",
      ...(this.pollInterval !== undefined && {
        "x-poll-interval": String(this.pollInterval),
      }),
    };
    if (!(budget.remaining > 0)) {
      limit();
      return;
    }
    const at = Number(url.searchParams.get("page") ?? "1");
    if (
      this.failing !== undefined &&
      (this.failing.page === undefined || this.failing.page === at)
    ) {
      budget.remaining -= 1;
      send(this.failing.status, { message: this.failing.message }, headers);
      return;
    }
    const since = Date.parse(req.headers["if-modified-since"] ?? "");
    // As GitHub does for every page of the listing, and without spending the
    // limit.
    if (!Number.isNaN(since) && since >= this.modified) {
      send(304, undefined, headers);
      return;
    }
    budget.remaining -= 1;
    const size = Math.min(
      Number(url.searchParams.get("per_page") ?? this.pageSize),
      this.pageSize,
    );
    const all = this.threads
      .filter((one) => url.searchParams.get("all") === "true" || one.unread)
      .sort(
        (a, b) =>
          b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
      );
    const last = Math.max(1, Math.ceil(all.length / size));
    const link = (page: number, rel: string): string =>
      `<${base}/notifications?${new URLSearchParams({
        ...Object.fromEntries(url.searchParams),
        page: String(page),
      }).toString()}>; rel="${rel}"`;
    send(
      200,
      all.slice((at - 1) * size, at * size).map((one) => this.rest(one, base)),
      {
        ...headers,
        "last-modified": new Date(this.modified).toUTCString(),
        ...(at < last && {
          link: `${link(at + 1, "next")}, ${link(last, "last")}`,
        }),
      },
    );
  }
}
