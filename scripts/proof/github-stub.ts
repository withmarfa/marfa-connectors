import { createHash, generateKeyPairSync } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** A key the stub never checks, but in the form a GitHub App's is. */
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
  /** Refuses its tokens, as an uninstalled App's installation does. */
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
  /** Answers 404 though listed, as a repository GitHub hides does. */
  hidden?: boolean;
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
}

interface Asked {
  method: string;
  path: string;
  query: string;
  body?: unknown;
  status: number;
}

/**
 * GitHub, as far as the connector reads and writes it: an App's
 * installations and their tokens, repositories, issues listed with ETags,
 * comments, relations through GraphQL, and the writes a two-way run makes.
 * Its clock moves a second at every write, so `updated_at` orders them.
 */
export class GitHubStub {
  url = "";
  installations: Installation[] = [{ id: 1, login: "someone" }];
  repositories: Repository[] = [];
  issues: Issue[] = [];
  comments: Comment[] = [];
  asked: Asked[] = [];
  /** The code GitHub's redirect carries, good once. */
  manifestCode: string | undefined = "manifest-code";
  appPem = "";
  appWebhookSecret: string | null = "stub-webhook-secret-from-github";
  /** The App's webhook as last set. */
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

  /** A time this many days before the stub's clock, as GitHub writes one. */
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

  /** Changes an issue as a person on GitHub does. */
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
    const parent = issue.parent === null ? undefined : this.issue(issue.parent);
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
      parent_issue_url:
        parent === undefined
          ? null
          : `${this.url}/repos/${this.repositoryOf(parent).owner}/${this.repositoryOf(parent).name}/issues/${String(parent.number)}`,
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
      updated_at: repository.updated_at,
    };
  }

  /** The installation a request's token speaks for. */
  private installationOf(req: IncomingMessage): Installation | undefined {
    const token = /^token ghs_stub_(\d+)_/.exec(
      req.headers.authorization ?? "",
    );
    const id = Number(token?.[1]);
    return this.installations.find((one) => one.id === id && one.lost !== true);
  }

  /** The repository a path names, where the token may read it. */
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
        ...headers,
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    /** A listing's page, answered 304 where its ETag still holds. */
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
    send(404, { message: `the stub knows no ${method} ${path}` });
  }

  private graphIssue(issue: Issue): Record<string, unknown> {
    const repository = this.repositoryOf(issue);
    const related = (node: string): Record<string, unknown> | null => {
      const other = this.issue(node);
      if (other === undefined || other.deleted === true) return null;
      const where = this.repositoryOf(other);
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
      author: { login: issue.user },
      labels: { nodes: issue.labels.map((name) => ({ name })) },
      assignees: { nodes: issue.assignees.map((login) => ({ login })) },
      repository: {
        id: repository.node,
        nameWithOwner: `${repository.owner}/${repository.name}`,
      },
      parent: issue.parent === null ? null : related(issue.parent),
      blockedBy: { nodes: issue.blocked_by.map(related) },
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
        !this.visible(req, issue.repository)
        ? undefined
        : this.graphIssue(issue);
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
            author: { login: comment.user },
            issue: { id: issue.node, repository: { id: repository.node } },
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
    send(200, {
      errors: [{ type: "UNKNOWN", message: `no ${String(operation)}` }],
    });
  }
}

function isMutation(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    /^\s*mutation\b/.test(String((body as { query?: unknown }).query))
  );
}
