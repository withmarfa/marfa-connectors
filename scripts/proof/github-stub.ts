import { createHash, generateKeyPairSync } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export function appKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

export interface Installation {
  id: number;
  login: string;
  suspended?: boolean;
  lost?: boolean;
}

export interface Repository {
  id: number;
  node: string;
  owner: string;
  name: string;
  installation: number;
  description: string | null;
  private: boolean;
  archived: boolean;
  updated_at: string;
  // Answers 404 though listed, as a repository GitHub hides does.
  hidden?: boolean;
  issuesOff?: boolean;
}

export interface Issue {
  id: number;
  node: string;
  number: number;
  repository: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  labels: string[];
  assignees: string[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  parent: string | null;
  blocked_by: string[];
  pull?: boolean;
  deleted?: boolean;
  moved?: boolean;
  app?: boolean;
}

export interface Comment {
  id: number;
  node: string;
  issue: string;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
  app?: boolean;
}

interface Asked {
  method: string;
  path: string;
  query: string;
  body?: unknown;
  status: number;
  version: string | undefined;
}

// The clock moves a second at every write, so `updated_at` orders them.
export class GitHubStub {
  url = "";
  installations: Installation[] = [{ id: 1, login: "someone" }];
  repositories: Repository[] = [];
  issues: Issue[] = [];
  comments: Comment[] = [];
  asked: Asked[] = [];
  manifestCode: string | undefined = "manifest-code";
  appPem = "";
  appWebhookSecret: string | null = "stub-webhook-secret-from-github";
  echoCredentials = false;
  rateRemaining = 4999;
  rateLimited = false;
  appId = 12345;
  appSlug = "marfa-connectors";
  loseNextCreate = false;
  // GitHub answers either limit with 403 or 429; the stub pairs each status
  // with one limit's message.
  writesLimited:
    { left: number; status: 403 | 429; title?: string } | undefined;
  mutationsLimited = 0;
  // GitHub answers NOT_FOUND to a delete it will not do, as for one gone.
  deletesRefused = false;
  hook: Record<string, unknown> | undefined;
  private server: Server | undefined;
  private clock = Math.floor(Date.now() / 1000) * 1000;
  private ids = 1000;
  private tokens = 0;

  async start(): Promise<this> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  ago(days: number): string {
    return new Date(this.clock - days * 86_400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }

  addRepository(name: string, fields: Partial<Repository> = {}): Repository {
    const id = this.ids++;
    const [owner = "someone", repo = name] = name.includes("/")
      ? name.split("/")
      : ["someone", name];
    const made: Repository = {
      id,
      node: `R_${String(id)}`,
      owner,
      name: repo,
      installation: 1,
      description: null,
      private: true,
      archived: false,
      updated_at: this.now(),
      ...fields,
    };
    this.repositories.push(made);
    return made;
  }

  addIssue(repository: Repository, fields: Partial<Issue> = {}): Issue {
    const id = this.ids++;
    const at = this.now();
    const number =
      Math.max(
        0,
        ...this.issues
          .filter((one) => one.repository === repository.node)
          .map((one) => one.number),
      ) + 1;
    const made: Issue = {
      id,
      node: `I_${String(id)}`,
      number,
      repository: repository.node,
      title: `Issue ${String(number)}`,
      body: null,
      state: "open",
      state_reason: null,
      labels: [],
      assignees: [],
      user: "someone",
      created_at: at,
      updated_at: at,
      closed_at: null,
      parent: null,
      blocked_by: [],
      ...fields,
    };
    this.issues.push(made);
    return made;
  }

  addComment(issue: Issue, body: string, user = "someone"): Comment {
    const id = this.ids++;
    const at = this.now();
    const made: Comment = {
      id,
      node: `IC_${String(id)}`,
      issue: issue.node,
      body,
      user,
      created_at: at,
      updated_at: at,
    };
    this.comments.push(made);
    // A new comment moves its issue's time, as GitHub's does.
    issue.updated_at = at;
    return made;
  }

  edit(issue: Issue, fields: Partial<Issue>): void {
    Object.assign(issue, fields, { updated_at: this.now() });
  }

  editComment(comment: Comment, body: string): void {
    comment.body = body;
    comment.updated_at = this.now();
  }

  repositoryOf(issue: Issue): Repository {
    const found = this.repositories.find(
      (one) => one.node === issue.repository,
    );
    if (found === undefined)
      throw new Error(`no repository ${issue.repository}`);
    return found;
  }

  issue(node: string): Issue | undefined {
    return this.issues.find((one) => one.node === node);
  }

  writes(): Asked[] {
    return this.asked.filter(
      (one) =>
        one.method !== "GET" &&
        !one.path.endsWith("/access_tokens") &&
        !(one.path === "/graphql" && !isMutation(one.body)),
    );
  }

  private address(repository: Repository): string {
    return `https://github.com/${repository.owner}/${repository.name}`;
  }

  private restIssue(issue: Issue): Record<string, unknown> {
    const repository = this.repositoryOf(issue);
    const blocking = this.issues.filter(
      (one) => !one.deleted && one.blocked_by.includes(issue.node),
    ).length;
    return {
      id: issue.id,
      node_id: issue.node,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.state_reason,
      html_url: `${this.address(repository)}/issues/${String(issue.number)}`,
      closed_at: issue.closed_at,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      user: { login: issue.user },
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      comments: this.comments.filter(
        (one) => one.issue === issue.node && !one.deleted,
      ).length,
      ...(issue.pull === true && { pull_request: {} }),
      performed_via_github_app: issue.app === true ? { id: this.appId } : null,
      issue_dependencies_summary: {
        blocked_by: issue.blocked_by.length,
        total_blocked_by: issue.blocked_by.length,
        blocking,
        total_blocking: blocking,
      },
      sub_issues_summary: {
        total: this.issues.filter((one) => one.parent === issue.node).length,
      },
    };
  }

  private restComment(comment: Comment): Record<string, unknown> {
    const issue = this.issue(comment.issue);
    const repository =
      issue === undefined ? undefined : this.repositoryOf(issue);
    const base =
      repository === undefined
        ? ""
        : `/repos/${repository.owner}/${repository.name}`;
    return {
      id: comment.id,
      node_id: comment.node,
      body: comment.body,
      html_url: `${repository === undefined ? "" : this.address(repository)}/issues/${String(issue?.number ?? 0)}#issuecomment-${String(comment.id)}`,
      issue_url: `${this.url}${base}/issues/${String(issue?.number ?? 0)}`,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      user: { login: comment.user },
      performed_via_github_app:
        comment.app === true ? { id: this.appId } : null,
    };
  }

  private restRepository(repository: Repository): Record<string, unknown> {
    return {
      id: repository.id,
      node_id: repository.node,
      full_name: `${repository.owner}/${repository.name}`,
      html_url: this.address(repository),
      description: repository.description,
      private: repository.private,
      archived: repository.archived,
      has_issues: repository.issuesOff !== true,
      updated_at: repository.updated_at,
    };
  }

  private installationOf(req: IncomingMessage): Installation | undefined {
    const token = /^token ghs_stub_(\d+)_/.exec(
      req.headers.authorization ?? "",
    );
    const id = Number(token?.[1]);
    return this.installations.find((one) => one.id === id && one.lost !== true);
  }

  private readable(
    req: IncomingMessage,
    owner: string,
    name: string,
  ): Repository | undefined {
    const installation = this.installationOf(req);
    return this.repositories.find(
      (one) =>
        one.owner === owner &&
        one.name === name &&
        one.installation === installation?.id &&
        one.hidden !== true,
    );
  }

  private visible(req: IncomingMessage, node: string): boolean {
    const installation = this.installationOf(req);
    const repository = this.repositories.find((one) => one.node === node);
    return (
      repository !== undefined &&
      repository.installation === installation?.id &&
      repository.hidden !== true
    );
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const asked: Asked = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body,
      status: 200,
      version: req.headers["x-github-api-version"] as string | undefined,
    };
    this.asked.push(asked);
    const send = (
      status: number,
      data?: unknown,
      headers: Record<string, string> = {},
    ): void => {
      asked.status = status;
      res.writeHead(status, {
        "content-type": "application/json",
        "x-ratelimit-remaining": String(this.rateRemaining),
        ...headers,
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    const page = (all: unknown[]): void => {
      const size = Number(url.searchParams.get("per_page") ?? "30");
      const at = Number(url.searchParams.get("page") ?? "1");
      const slice = all.slice((at - 1) * size, at * size);
      const etag = `W/"${createHash("sha1").update(JSON.stringify(slice)).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        send(304, undefined, { etag });
        return;
      }
      const next = at * size < all.length;
      send(200, slice, {
        etag,
        ...(next && {
          link: `<${this.url}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(at + 1) }).toString()}>; rel="next"`,
        }),
      });
    };
    const method = req.method ?? "GET";
    const path = url.pathname;
    let match: RegExpExecArray | null;
    if (this.rateLimited && path.startsWith("/repos/")) {
      send(
        403,
        { message: "API rate limit exceeded for installation" },
        { "x-ratelimit-remaining": "0" },
      );
      return;
    }

    if (method === "GET" && path === "/app") {
      send(200, { id: this.appId, slug: this.appSlug });
      return;
    }
    if (method === "GET" && path === "/app/installations") {
      send(
        200,
        this.installations.map((one) => ({
          id: one.id,
          account: { login: one.login },
          suspended_at: one.suspended === true ? this.now() : null,
        })),
      );
      return;
    }
    if (
      method === "POST" &&
      (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))
    ) {
      const installation = this.installations.find(
        (one) => one.id === Number(match?.[1]),
      );
      if (installation === undefined || installation.lost === true) {
        send(404, { message: "Not Found" });
        return;
      }
      this.tokens += 1;
      send(201, {
        token: `ghs_stub_${String(installation.id)}_${String(this.tokens)}_tokenvalue`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return;
    }
    if (
      method === "POST" &&
      (match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))
    ) {
      if (match[1] !== this.manifestCode) {
        send(404, { message: "Not Found" });
        return;
      }
      this.manifestCode = undefined;
      send(201, {
        id: 424242,
        slug: "marfa-sync-test",
        html_url: "https://github.com/apps/marfa-sync-test",
        pem: this.appPem,
        webhook_secret: this.appWebhookSecret,
        client_id: "Iv1.test",
        client_secret: "client-secret-value",
      });
      return;
    }
    if (method === "PATCH" && path === "/app/hook/config") {
      this.hook = body as Record<string, unknown>;
      send(200, { url: this.hook["url"], content_type: "json" });
      return;
    }
    if (method === "GET" && path === "/installation/repositories") {
      const installation = this.installationOf(req);
      if (installation === undefined) {
        send(401, { message: "Bad credentials" });
        return;
      }
      const repositories = this.repositories
        .filter((one) => one.installation === installation.id)
        .map((one) => this.restRepository(one));
      send(200, { total_count: repositories.length, repositories });
      return;
    }
    if (method === "POST" && path === "/graphql") {
      this.graphql(
        req,
        body as { query: string; variables: Record<string, unknown> },
        send,
      );
      return;
    }
    if (
      (match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)) &&
      method === "GET"
    ) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      if (repository === undefined) send(404, { message: "Not Found" });
      else send(200, this.restRepository(repository));
      return;
    }
    if (
      (match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments$/.exec(path)) &&
      method === "GET"
    ) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      if (repository === undefined) {
        send(404, { message: "Not Found" });
        return;
      }
      const since = url.searchParams.get("since");
      const sort = url.searchParams.get("sort") ?? "created";
      const all = this.comments
        .filter((one) => {
          const issue = this.issue(one.issue);
          return (
            !one.deleted &&
            issue?.repository === repository.node &&
            (since === null || one.updated_at >= since)
          );
        })
        .sort((a, b) =>
          sort === "updated"
            ? a.updated_at.localeCompare(b.updated_at) || a.id - b.id
            : a.id - b.id,
        )
        .map((one) => this.restComment(one));
      page(all);
      return;
    }
    if (
      (match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(
        path,
      )) &&
      method === "GET"
    ) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      const issue = this.issues.find(
        (one) =>
          one.repository === repository?.node &&
          one.number === Number(match?.[3]),
      );
      if (repository === undefined || issue === undefined) {
        send(404, { message: "Not Found" });
        return;
      }
      page(
        this.comments
          .filter((one) => one.issue === issue.node && !one.deleted)
          .map((one) => this.restComment(one)),
      );
      return;
    }
    if (
      (match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path)) &&
      method === "GET"
    ) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      const issue = this.issues.find(
        (one) =>
          one.repository === repository?.node &&
          one.number === Number(match?.[3]),
      );
      if (repository === undefined || issue === undefined) {
        send(404, { message: "Not Found" });
      } else if (repository.issuesOff === true) {
        send(410, { message: "Issues are disabled for this repo" });
      } else if (issue.deleted === true) {
        send(410, { message: "This issue was deleted" });
      } else if (issue.moved === true) {
        send(
          301,
          { message: "Moved Permanently" },
          {
            location: `${this.url}/repositories/0/issues/1`,
          },
        );
      } else {
        send(200, this.restIssue(issue));
      }
      return;
    }
    if (
      (match = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path)) &&
      method === "GET"
    ) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      if (this.echoCredentials) {
        send(500, { message: `broken for ${req.headers.authorization ?? ""}` });
        return;
      }
      if (repository === undefined) {
        send(404, { message: "Not Found" });
        return;
      }
      const state = url.searchParams.get("state") ?? "open";
      const since = url.searchParams.get("since");
      page(
        this.issues
          .filter(
            (one) =>
              one.repository === repository.node &&
              !one.deleted &&
              !one.moved &&
              (state === "all" || one.state === state) &&
              (since === null || one.updated_at >= since),
          )
          .sort((a, b) => a.id - b.id)
          .map((one) => this.restIssue(one)),
      );
      return;
    }
    const limited = this.writesLimited;
    if (
      limited !== undefined &&
      limited.left > 0 &&
      method !== "GET" &&
      (limited.title === undefined ||
        (body as { title?: unknown } | undefined)?.title === limited.title) &&
      path.startsWith("/repos/")
    ) {
      limited.left -= 1;
      send(
        limited.status,
        {
          message:
            limited.status === 403
              ? "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
              : "API rate limit exceeded",
        },
        { "retry-after": "1" },
      );
      return;
    }
    if (this.write(req, method, path, body, send)) return;
    send(404, { message: `the stub knows no ${method} ${path}` });
  }

  private write(
    req: IncomingMessage,
    method: string,
    path: string,
    body: unknown,
    send: (status: number, data?: unknown) => void,
  ): boolean {
    const fields = (body ?? {}) as Record<string, unknown>;
    const bot = `${this.appSlug}[bot]`;
    // GitHub refuses writes to an archived repository, and a label past 50.
    const refused = (repository: Repository | undefined): boolean => {
      if (repository?.archived === true) {
        send(403, { message: "Repository was archived so is read-only." });
        return true;
      }
      const labels = fields["labels"];
      if (
        Array.isArray(labels) &&
        labels.some((name) => String(name).length > 50)
      ) {
        send(422, { message: "Validation Failed" });
        return true;
      }
      return false;
    };
    const created = (made: unknown): void => {
      if (this.loseNextCreate) {
        this.loseNextCreate = false;
        send(502, { message: "Server Error" });
        return;
      }
      send(201, made);
    };
    const issueAt = (match: RegExpExecArray): Issue | undefined => {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      return this.issues.find(
        (one) =>
          one.repository === repository?.node &&
          one.number === Number(match[3]),
      );
    };
    let match = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    if (method === "POST" && match !== null) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      if (repository === undefined) {
        send(404, { message: "Not Found" });
        return true;
      }
      if (refused(repository)) return true;
      const body = fields["body"];
      const made = this.addIssue(repository, {
        title: String(fields["title"]),
        body: typeof body === "string" && body !== "" ? body : null,
        labels: (fields["labels"] as string[] | undefined) ?? [],
        assignees: (fields["assignees"] as string[] | undefined) ?? [],
        user: bot,
        app: true,
      });
      created(this.restIssue(made));
      return true;
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (method === "PATCH" && match !== null) {
      const issue = issueAt(match);
      if (issue === undefined) {
        send(404, { message: "Not Found" });
        return true;
      }
      if (issue.deleted === true) {
        send(410, { message: "This issue was deleted" });
        return true;
      }
      if (refused(this.repositoryOf(issue))) return true;
      const next: Partial<Issue> = {};
      if (typeof fields["title"] === "string") next.title = fields["title"];
      if (typeof fields["body"] === "string") {
        next.body = fields["body"] === "" ? null : fields["body"];
      }
      if (Array.isArray(fields["labels"])) {
        next.labels = fields["labels"] as string[];
      }
      if (Array.isArray(fields["assignees"])) {
        // GitHub drops a login it cannot assign, without a word.
        next.assignees = (fields["assignees"] as string[]).filter(
          (login) => login !== "nobody-here",
        );
      }
      if (fields["state"] === "closed" && issue.state !== "closed") {
        next.state = "closed";
        next.closed_at = this.now();
      }
      if (fields["state"] === "open" && issue.state !== "open") {
        next.state = "open";
        next.closed_at = null;
      }
      if (typeof fields["state_reason"] === "string") {
        next.state_reason = fields["state_reason"];
      }
      this.edit(issue, next);
      send(200, this.restIssue(issue));
      return true;
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (method === "POST" && match !== null) {
      const issue = issueAt(match);
      if (issue === undefined) {
        send(404, { message: "Not Found" });
        return true;
      }
      if (refused(this.repositoryOf(issue))) return true;
      const made = this.addComment(issue, String(fields["body"]), bot);
      made.app = true;
      created(this.restComment(made));
      return true;
    }
    return false;
  }

  private mutate(
    req: IncomingMessage,
    operation: string | undefined,
    variables: Record<string, unknown>,
    send: (status: number, data?: unknown) => void,
  ): boolean {
    const issue = (key: string): Issue | undefined => {
      const found = this.issue(String(variables[key]));
      return found !== undefined && this.visible(req, found.repository)
        ? found
        : undefined;
    };
    if (this.mutationsLimited > 0) {
      this.mutationsLimited -= 1;
      send(200, {
        data: null,
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      });
      return true;
    }
    const one = issue("issueId");
    const other = issue("other");
    const relations = [
      "AddSubIssue",
      "RemoveSubIssue",
      "AddBlockedBy",
      "RemoveBlockedBy",
    ];
    if (operation !== undefined && relations.includes(operation)) {
      if (one === undefined || other === undefined) {
        send(200, notFound);
        return true;
      }
      if (operation === "AddSubIssue") {
        if (this.repositoryOf(one).owner !== this.repositoryOf(other).owner) {
          send(
            200,
            refusal("A sub-issue must belong to the same owner as its parent"),
          );
          return true;
        }
        other.parent = one.node;
      } else if (operation === "RemoveSubIssue") {
        if (other.parent === one.node) other.parent = null;
      } else if (operation === "AddBlockedBy") {
        if (one.blocked_by.length >= 50) {
          send(200, refusal("An issue may be blocked by at most 50 issues"));
          return true;
        }
        if (!one.blocked_by.includes(other.node)) {
          one.blocked_by.push(other.node);
        }
      } else {
        one.blocked_by = one.blocked_by.filter((node) => node !== other.node);
      }
      send(200, { data: { [operation]: { issue: { id: one.node } } } });
      return true;
    }
    if (operation !== "UpdateComment" && operation !== "DeleteComment") {
      return false;
    }
    const comment = this.comments.find(
      (found) => found.node === variables["id"] && found.deleted !== true,
    );
    const commentIssue =
      comment === undefined ? undefined : this.issue(comment.issue);
    if (
      comment === undefined ||
      commentIssue === undefined ||
      !this.visible(req, commentIssue.repository)
    ) {
      send(200, notFound);
      return true;
    }
    if (operation === "DeleteComment") {
      if (this.deletesRefused) {
        send(200, notFound);
        return true;
      }
      comment.deleted = true;
      send(200, { data: { deleteIssueComment: { clientMutationId: null } } });
      return true;
    }
    this.editComment(comment, String(variables["body"]));
    const repository = this.repositoryOf(commentIssue);
    send(200, {
      data: {
        updateIssueComment: {
          issueComment: {
            __typename: "IssueComment",
            id: comment.node,
            body: comment.body,
            url: `${this.address(repository)}/issues/${String(commentIssue.number)}#issuecomment-${String(comment.id)}`,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            author: this.author(comment.user),
            issue: {
              id: commentIssue.node,
              repository: {
                id: repository.node,
                nameWithOwner: `${repository.owner}/${repository.name}`,
              },
            },
          },
        },
      },
    });
    return true;
  }

  /** GraphQL names a bot by its login without the suffix REST gives it. */
  private author(login: string): { login: string; __typename: string } {
    return login.endsWith("[bot]")
      ? { login: login.slice(0, -"[bot]".length), __typename: "Bot" }
      : { login, __typename: "User" };
  }

  private graphIssue(
    issue: Issue,
    sees: (repository: Repository) => boolean,
  ): Record<string, unknown> {
    const repository = this.repositoryOf(issue);
    const related = (node: string): Record<string, unknown> | null => {
      const other = this.issue(node);
      if (other === undefined || other.deleted === true) return null;
      const where = this.repositoryOf(other);
      if (!sees(where)) return null;
      return {
        id: other.node,
        url: `${this.address(where)}/issues/${String(other.number)}`,
        repository: { id: where.node },
      };
    };
    return {
      __typename: "Issue",
      id: issue.node,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state === "open" ? "OPEN" : "CLOSED",
      stateReason: issue.state_reason?.toUpperCase() ?? null,
      url: `${this.address(repository)}/issues/${String(issue.number)}`,
      closedAt: issue.closed_at,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      author: this.author(issue.user),
      labels: { nodes: issue.labels.map((name) => ({ name })) },
      assignees: { nodes: issue.assignees.map((login) => ({ login })) },
      repository: {
        id: repository.node,
        nameWithOwner: `${repository.owner}/${repository.name}`,
      },
      parent: issue.parent === null ? null : related(issue.parent),
      blockedBy: {
        nodes: issue.blocked_by.map(related).filter((one) => one !== null),
      },
      subIssues: {
        nodes: this.issues
          .filter((one) => !one.deleted && one.parent === issue.node)
          .map((one) => related(one.node))
          .filter((one) => one !== null),
      },
      blocking: {
        nodes: this.issues
          .filter((one) => !one.deleted && one.blocked_by.includes(issue.node))
          .map((one) => ({ id: one.node })),
      },
    };
  }

  private graphql(
    req: IncomingMessage,
    body: { query: string; variables: Record<string, unknown> },
    send: (status: number, data?: unknown) => void,
  ): void {
    const operation = /^\s*(query|mutation)\s+(\w+)/.exec(body.query)?.[2];
    if (this.installationOf(req) === undefined) {
      send(401, { message: "Bad credentials" });
      return;
    }
    const errors: { type: string; message: string }[] = [];
    const nodes = (ids: unknown, find: (id: string) => unknown): unknown[] =>
      (ids as string[]).map((id) => {
        const found = find(id);
        if (found === undefined) {
          errors.push({
            type: "NOT_FOUND",
            message: `Could not resolve to a node with the global id of '${id}'`,
          });
          return null;
        }
        return found;
      });
    const issueNode = (id: string): unknown => {
      const issue = this.issue(id);
      return issue === undefined ||
        issue.deleted === true ||
        // GitHub shows an App a public repository's issues, installed or not.
        (!this.visible(req, issue.repository) &&
          this.repositoryOf(issue).private)
        ? undefined
        : this.graphIssue(
            issue,
            (where) => !where.private || this.visible(req, where.node),
          );
    };
    if (operation === "Issues" || operation === "Relations") {
      const data = { nodes: nodes(body.variables["ids"], issueNode) };
      send(200, { data, ...(errors.length > 0 && { errors }) });
      return;
    }
    if (operation === "Comments") {
      const data = {
        nodes: nodes(body.variables["ids"], (id) => {
          const comment = this.comments.find((one) => one.node === id);
          const issue =
            comment === undefined ? undefined : this.issue(comment.issue);
          if (
            comment === undefined ||
            comment.deleted === true ||
            issue === undefined ||
            !this.visible(req, issue.repository)
          ) {
            return undefined;
          }
          const repository = this.repositoryOf(issue);
          return {
            __typename: "IssueComment",
            id: comment.node,
            body: comment.body,
            url: `${this.address(repository)}/issues/${String(issue.number)}#issuecomment-${String(comment.id)}`,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            author: this.author(comment.user),
            issue: {
              id: issue.node,
              repository: {
                id: repository.node,
                nameWithOwner: `${repository.owner}/${repository.name}`,
              },
            },
          };
        }),
      };
      send(200, { data, ...(errors.length > 0 && { errors }) });
      return;
    }
    if (operation === "Repositories") {
      const data = {
        nodes: nodes(body.variables["ids"], (id) => {
          const repository = this.repositories.find((one) => one.node === id);
          return repository === undefined ||
            (!this.visible(req, id) && repository.private)
            ? undefined
            : {
                __typename: "Repository",
                id,
                nameWithOwner: `${repository.owner}/${repository.name}`,
              };
        }),
      };
      send(200, { data, ...(errors.length > 0 && { errors }) });
      return;
    }
    if (operation === "Numbers") {
      const repository = this.repositories.find(
        (one) =>
          one.owner === body.variables["owner"] &&
          one.name === body.variables["name"] &&
          this.visible(req, one.node),
      );
      const found: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body.variables)) {
        if (!key.startsWith("n")) continue;
        const issue = this.issues.find(
          (one) => one.repository === repository?.node && one.number === value,
        );
        found[`i${key.slice(1)}`] =
          issue === undefined ? null : { id: issue.node };
      }
      send(200, {
        data: { repository: repository === undefined ? null : found },
      });
      return;
    }
    if (this.mutate(req, operation, body.variables, send)) return;
    send(200, {
      errors: [{ type: "UNKNOWN", message: `no ${String(operation)}` }],
    });
  }
}

function refusal(message: string): {
  errors: { type: string; message: string }[];
} {
  return { errors: [{ type: "UNPROCESSABLE", message }] };
}

const notFound = {
  data: null,
  errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }],
};

function isMutation(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    /^\s*mutation\b/.test(String((body as { query?: unknown }).query))
  );
}
