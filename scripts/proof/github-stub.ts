import {
  createHash,
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
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
  /** Answers 404 to a token that asks for Discussions, as GitHub does for a
   *  token it will not mint, while every other token still mints. */
  discussionsLost?: boolean;
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
  discussionsOff?: boolean;
  /** Category names, in the order GitHub lists them. */
  categories?: string[];
}

export interface Issue {
  id: number;
  node: string;
  number: number;
  repository: string;
  title: string;
  body: string | null;
  bodyHTML?: string;
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
  relates_to?: string[];
  duplicate_of?: string | null;
  closed_by?: string | null;
  pull?: boolean;
  deleted?: boolean;
  moved?: boolean;
  app?: boolean;
  unlisted?: number;
}

export interface PullRequest extends Issue {
  pr_state: "open" | "closed" | "merged";
  draft: boolean;
  merged_at: string | null;
  base_branch: string;
  head_branch: string;
  head_sha: string;
  closing_issues: string[];
  checks: {
    state: string;
    check_runs: Record<string, number>;
    statuses: Record<string, number>;
  } | null;
}

export interface Comment {
  id: number;
  node: string;
  issue: string;
  body: string;
  bodyHTML?: string;
  user: string;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
  app?: boolean;
  unlisted?: number;
}

export interface Discussion {
  id: number;
  node: string;
  number: number;
  repository: string;
  title: string;
  body: string;
  category: string;
  user: string;
  state: "open" | "closed";
  state_reason: string | null;
  answered: boolean;
  locked: boolean;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
  app?: boolean;
  unlisted?: number;
}

export interface DiscussionComment {
  id: number;
  node: string;
  discussion: string;
  /** The node of the comment this one answers; absent for a top-level one. */
  parent: string | null;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
  /** Gone outright, as a deleted comment with no replies is. */
  deleted?: boolean;
  /** Deleted but kept as an empty shell for its replies, as GitHub does. */
  blanked?: boolean;
  app?: boolean;
  unlisted?: number;
}

type Access = "read" | "write";

/** What an installation token reaches: its repositories by node, or every
 *  one of its installation's where unnarrowed, and its permissions. */
interface Grant {
  installation: number;
  repositories: Set<string> | undefined;
  permissions: Record<string, Access>;
}

const defaultCategories = ["General", "Ideas", "Q&A"];

export type Resource = "core" | "graphql";

/** One hourly budget, as GitHub keeps one for each installation and API. */
export interface Budget {
  limit: number;
  remaining: number;
  /** UTC epoch seconds at which the window ends and the budget is whole. */
  reset: number;
}

export interface Asked {
  method: string;
  path: string;
  query: string;
  body?: unknown;
  status: number;
  version: string | undefined;
  /** What the answer said was left of the budget it counted against. */
  remaining?: number;
  /** Whether the answer refused the request for a rate limit. */
  limited?: boolean;
}

// GitHub's clock keeps to real time, as the connector compares it with the
// machine's, and moves a second at every write, so `updated_at` orders them.
export class GitHubStub {
  url = "";
  personalToken: string | undefined;
  personalRepositories: ReadonlySet<string> | undefined;
  personalDenied = new Map<string, string>();
  relationsRefused = false;
  relatedPageSize = 100;
  installations: Installation[] = [{ id: 1, login: "someone" }];
  repositories: Repository[] = [];
  issues: Issue[] = [];
  pulls: PullRequest[] = [];
  pullPageSize = 100;
  closingPageSize = 100;
  missingPullRepository = false;
  comments: Comment[] = [];
  discussions: Discussion[] = [];
  discussionComments: DiscussionComment[] = [];
  /** How many comments or replies one page of a discussion holds. */
  discussionPageSize = 50;
  /** Answers every Discussions query of the personal token as refused. */
  personalNoDiscussions = false;
  /** Answers every Discussions query of the App as FORBIDDEN, though its
   *  token mints: the installation holds the permission, GitHub still says no. */
  discussionsForbidden = false;
  /** Shows a discussion by its node though its repository turned Discussions
   *  off, as GitHub may: it does not say. */
  discussionsOffStillShown = false;
  asked: Asked[] = [];
  manifestCode: string | undefined = "manifest-code";
  /** The App's private key. GitHub holds its public half to check the App's
   *  JWT, and refuses every JWT until a test names the key. */
  appPem = "";
  appWebhookSecret: string | null = "stub-webhook-secret-from-github";
  echoCredentials = false;
  readFailure: string | undefined;
  /** Runs as each request arrives, before it is counted or answered, so a
   *  test can change the world, such as a budget, at a chosen request. */
  onAsked: ((asked: Asked) => void) | undefined;
  appId = 12345;
  appClientId = "Iv1.test";
  appSlug = "marfa-connectors";
  loseNextCreate = false;
  // With `loseNextCreate`, what the create made is missing from the next
  // listing, as one GitHub has not indexed yet.
  listLate = false;
  // GitHub answers either limit with 403 or 429; the stub pairs each status
  // with one limit's message.
  writesLimited:
    { left: number; status: 403 | 429; title?: string } | undefined;
  mutationsLimited = 0;
  // GraphQL errors of a type GitHub gives for a passing fault.
  mutationsFailing = 0;
  // Answers this many listings of a repository's issues or an issue's
  // comments 404, as a repository GitHub hides for a moment.
  listingsFailing = 0;
  pullListsRefused = new Set<string>();
  // GitHub answers NOT_FOUND to a delete it will not do, as for one gone.
  deletesRefused = false;
  hook: Record<string, unknown> | undefined;
  appPermissions: Record<string, Access> = {
    issues: "write",
    pull_requests: "read",
    checks: "read",
    statuses: "read",
    metadata: "read",
    discussions: "write",
  };
  /** Seconds GitHub's clock runs ahead of this machine's. */
  clockAhead = 0;
  /** Requests the tokens answer before GitHub revokes every one of them. */
  revokeAfter: number | undefined;
  private grants = new Map<string, Grant>();
  private budgets = new Map<string, Budget>();
  private server: Server | undefined;
  private clock = Math.floor(Date.now() / 1000) * 1000;
  /** How far behind the machine's clock GitHub's own runs, in milliseconds. */
  private behind = 0;
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

  /** A second on from the last, and never behind the machine's own time less
   *  `behind`, so a long run does not leave what is made far in the past. */
  now(): string {
    this.clock = Math.max(this.clock + 1000, this.wall());
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** GitHub's own clock, which every answer's Date header tells, run this
   *  far behind the machine's. */
  runBehind(milliseconds: number): void {
    this.behind = milliseconds;
    this.clock = this.wall();
  }

  /** GitHub's time, never before a time it has already given. */
  private current(): number {
    this.clock = Math.max(this.clock, this.wall());
    return this.clock;
  }

  private wall(): number {
    return Math.floor((Date.now() - this.behind) / 1000) * 1000;
  }

  ago(days: number): string {
    return new Date(this.current() - days * 86_400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }

  /** The budget an installation has for an API (installation 0 is the App
   *  itself, which signs with a JWT), whole until requests spend it. */
  budget(resource: Resource, installation = 1): Budget {
    const key = `${String(installation)} ${resource}`;
    let held = this.budgets.get(key);
    if (held === undefined) {
      held = { limit: 5000, remaining: 5000, reset: this.windowEnd() };
      this.budgets.set(key, held);
    }
    return held;
  }

  /** Spends the budget, as GitHub does when a client has used it all. */
  exhaust(resource: Resource, installation = 1): void {
    this.budget(resource, installation).remaining = 0;
  }

  /** Makes the budget whole again, in a fresh hour. */
  refill(resource: Resource, installation = 1): void {
    const held = this.budget(resource, installation);
    held.remaining = held.limit;
    held.reset = this.windowEnd();
  }

  private windowEnd(): number {
    return Math.floor(Date.now() / 1000) + 3600;
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

  addPullRequest(
    repository: Repository,
    fields: Partial<PullRequest> = {},
  ): PullRequest {
    const issue = this.addIssue(repository, { pull: true });
    const pr = Object.assign(
      issue,
      {
        node: `PR_${String(issue.id)}`,
        pr_state: "open" as const,
        draft: false,
        merged_at: null,
        base_branch: "main",
        head_branch: "change",
        head_sha: "abc123",
        closing_issues: [],
        checks: null,
      },
      fields,
    ) as PullRequest;
    pr.state = pr.pr_state === "open" ? "open" : "closed";
    this.pulls.push(pr);
    return pr;
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

  addDiscussion(
    repository: Repository,
    fields: Partial<Discussion> = {},
  ): Discussion {
    const id = this.ids++;
    const at = this.now();
    const number =
      Math.max(
        0,
        ...this.discussions
          .filter((one) => one.repository === repository.node)
          .map((one) => one.number),
      ) + 1;
    const made: Discussion = {
      id,
      node: `D_${String(id)}`,
      number,
      repository: repository.node,
      title: `Discussion ${String(number)}`,
      body: "",
      category: (repository.categories ?? defaultCategories)[0] ?? "General",
      user: "someone",
      state: "open",
      state_reason: null,
      answered: false,
      locked: false,
      created_at: at,
      updated_at: at,
      ...fields,
    };
    this.discussions.push(made);
    return made;
  }

  /** A new comment does not move its discussion's time here: GitHub does not
   *  say that it does, and the connector must not depend on it. */
  addDiscussionComment(
    discussion: Discussion,
    body: string,
    user = "someone",
    parent: DiscussionComment | null = null,
  ): DiscussionComment {
    const id = this.ids++;
    const at = this.now();
    const made: DiscussionComment = {
      id,
      node: `DC_${String(id)}`,
      discussion: discussion.node,
      parent: parent?.node ?? null,
      body,
      user,
      created_at: at,
      updated_at: at,
    };
    this.discussionComments.push(made);
    return made;
  }

  editDiscussionComment(comment: DiscussionComment, body: string): void {
    comment.body = body;
    comment.updated_at = this.now();
  }

  editDiscussion(discussion: Discussion, fields: Partial<Discussion>): void {
    Object.assign(discussion, fields, { updated_at: this.now() });
  }

  /** Removes a comment as GitHub does: outright when nothing answers it,
   *  else as a blank shell its replies hang from. */
  removeDiscussionComment(comment: DiscussionComment): void {
    const answered = this.discussionComments.some(
      (one) => one.parent === comment.node && one.deleted !== true,
    );
    if (answered) {
      comment.blanked = true;
      comment.body = "";
    } else {
      comment.deleted = true;
    }
  }

  discussion(node: string): Discussion | undefined {
    return this.discussions.find((one) => one.node === node);
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

  /** Counts a listing against what is still to be left out of them. */
  private listed(one: { unlisted?: number }): boolean {
    if ((one.unlisted ?? 0) <= 0) return true;
    one.unlisted = (one.unlisted ?? 0) - 1;
    return false;
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

  /** The token's installation, unless GitHub has lost it. */
  private installationOf(req: IncomingMessage): Installation | undefined {
    const grant = this.grantOf(req);
    return this.installations.find(
      (one) => one.id === grant?.installation && one.lost !== true,
    );
  }

  private grantOf(req: IncomingMessage): Grant | undefined {
    const token = /^(?:token|bearer) (\S+)$/i.exec(
      req.headers.authorization ?? "",
    )?.[1];
    return token === undefined ? undefined : this.grants.get(token);
  }

  private reaches(req: IncomingMessage, repository: Repository): boolean {
    if (this.isPersonal(req))
      return (
        this.personalRepositories === undefined ||
        this.personalRepositories.has(repository.node)
      );
    const grant = this.grantOf(req);
    return (
      repository.installation === this.installationOf(req)?.id &&
      (grant?.repositories === undefined ||
        grant.repositories.has(repository.node))
    );
  }

  private allows(
    req: IncomingMessage,
    wanted: Access,
    scope: "issues" | "discussions" = "issues",
  ): boolean {
    if (this.isPersonal(req))
      return (
        wanted === "read" && (scope === "issues" || !this.personalNoDiscussions)
      );
    if (scope === "discussions" && this.discussionsForbidden) return false;
    const held = this.grantOf(req)?.permissions[scope];
    return held === "write" || held === wanted;
  }

  private isPersonal(req: IncomingMessage): boolean {
    return (
      this.personalToken !== undefined &&
      req.headers.authorization === `Bearer ${this.personalToken}`
    );
  }

  /** Why GitHub would refuse the App's JWT, if it would: it checks the
   *  signature against the App's public key, then judges the claims by its
   *  own clock. */
  private jwtRefusal(req: IncomingMessage): string | undefined {
    const undecodable = "A JSON web token could not be decoded";
    const jwt = /^bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const [head, body, signature, ...rest] = (jwt ?? "").split(".");
    if (
      head === undefined ||
      body === undefined ||
      signature === undefined ||
      rest.length > 0
    ) {
      return undecodable;
    }
    let header: { alg?: unknown };
    let claims: { iss?: unknown; iat?: unknown; exp?: unknown };
    try {
      header = JSON.parse(
        Buffer.from(head, "base64url").toString("utf8"),
      ) as typeof header;
      claims = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as typeof claims;
      const signed = createVerify("RSA-SHA256")
        .update(`${head}.${body}`)
        .verify(createPublicKey(this.appPem), signature, "base64url");
      if (header.alg !== "RS256" || !signed) return undecodable;
    } catch {
      return undecodable;
    }
    if (![String(this.appId), this.appClientId].includes(String(claims.iss))) {
      return undecodable;
    }
    const now = Math.floor(Date.now() / 1000) + this.clockAhead;
    const exp = typeof claims.exp === "number" ? claims.exp : 0;
    const iat = typeof claims.iat === "number" ? claims.iat : 0;
    if (exp <= now) {
      return "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires";
    }
    if (iat > now + 60) {
      return "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued";
    }
    if (exp > now + 600) {
      return "'Expiration time' claim ('exp') is too far in the future";
    }
    return undefined;
  }

  private mint(
    installation: Installation,
    body: unknown,
  ): { token: string } | { refused: string } {
    const asked = (body ?? {}) as {
      repositories?: string[];
      repository_ids?: number[];
      permissions?: Record<string, Access>;
    };
    const own = this.repositories.filter(
      (one) => one.installation === installation.id,
    );
    let repositories: Set<string> | undefined;
    if (
      asked.repositories !== undefined ||
      asked.repository_ids !== undefined
    ) {
      const named = [
        ...(asked.repositories ?? []).map((name) =>
          own.find((one) => one.name === name),
        ),
        ...(asked.repository_ids ?? []).map((id) =>
          own.find((one) => one.id === id),
        ),
      ];
      if (named.length > 500 || named.some((one) => one === undefined)) {
        return {
          refused:
            "There is at least one repository that does not exist or is not accessible to the parent installation.",
        };
      }
      repositories = new Set(named.map((one) => one?.node ?? ""));
    }
    const permissions = asked.permissions ?? this.appPermissions;
    for (const [name, level] of Object.entries(permissions)) {
      const held = this.appPermissions[name];
      if (held === undefined || (level === "write" && held !== "write")) {
        return {
          refused:
            "The permissions requested are not granted to this installation.",
        };
      }
    }
    this.tokens += 1;
    const token = `ghs_stub_${String(installation.id)}_${String(this.tokens)}_tokenvalue`;
    this.grants.set(token, {
      installation: installation.id,
      repositories,
      permissions: { ...permissions, metadata: "read" },
    });
    return { token };
  }

  private readable(
    req: IncomingMessage,
    owner: string,
    name: string,
  ): Repository | undefined {
    return this.repositories.find(
      (one) =>
        one.owner === owner &&
        one.name === name &&
        this.reaches(req, one) &&
        one.hidden !== true,
    );
  }

  private visible(req: IncomingMessage, node: string): boolean {
    const repository = this.repositories.find((one) => one.node === node);
    return (
      repository !== undefined &&
      this.reaches(req, repository) &&
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
    this.onAsked?.(asked);
    const method = req.method ?? "GET";
    const path = url.pathname;
    const resource: Resource = path === "/graphql" ? "graphql" : "core";
    const asApp = path === "/app" || path.startsWith("/app/");
    // The App signs with a JWT and has a budget of its own.
    const budget = this.budget(
      resource,
      asApp ? 0 : (this.installationOf(req)?.id ?? 0),
    );
    if (Date.now() / 1000 >= budget.reset) {
      budget.remaining = budget.limit;
      budget.reset = this.windowEnd();
    }
    const send = (
      status: number,
      data?: unknown,
      headers: Record<string, string> = {},
    ): void => {
      asked.status = status;
      asked.remaining = budget.remaining;
      res.writeHead(status, {
        "content-type": "application/json",
        date: new Date(this.current() + this.clockAhead * 1000).toUTCString(),
        "x-ratelimit-limit": String(budget.limit),
        "x-ratelimit-remaining": String(budget.remaining),
        "x-ratelimit-used": String(budget.limit - budget.remaining),
        "x-ratelimit-reset": String(budget.reset),
        "x-ratelimit-resource": resource,
        ...headers,
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    // GitHub's primary limit is a 403 on REST and an error under a 200 on
    // GraphQL, and a secondary limit comes with the seconds to wait. The
    // documentation does not name the GraphQL error's type; the connector
    // reads `RATE_LIMITED`.
    const limit = (secondary: boolean, status: 403 | 429 = 403): void => {
      asked.limited = true;
      const headers = secondary ? { "retry-after": "1" } : {};
      if (resource === "graphql") {
        send(
          200,
          {
            data: null,
            errors: [
              { type: "RATE_LIMITED", message: "API rate limit exceeded" },
            ],
          },
          headers,
        );
      } else {
        send(
          status,
          {
            message: secondary
              ? status === 403
                ? "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
                : "API rate limit exceeded"
              : "API rate limit exceeded for installation",
          },
          headers,
        );
      }
    };
    const page = (all: unknown[]): void => {
      const size = Number(url.searchParams.get("per_page") ?? "30");
      const at = Number(url.searchParams.get("page") ?? "1");
      const slice = all.slice((at - 1) * size, at * size);
      // The page and the media type change GitHub's ETag as its documentation
      // says. A probe with user tokens, not installation tokens, showed that
      // the scheme word changes it too and that the token does not.
      const etag = `"${createHash("sha256")
        .update(
          JSON.stringify([
            req.headers.authorization?.split(" ")[0],
            req.headers.accept,
            slice,
          ]),
        )
        .digest("hex")}"`;
      const held = (req.headers["if-none-match"] ?? "")
        .split(",")
        .map((one) => one.trim().replace(/^W\//, ""));
      if (held.includes("*") || held.includes(etag)) {
        // An authorized request answered 304 costs nothing against the limit.
        if (req.headers.authorization !== undefined) budget.remaining += 1;
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
    let match: RegExpExecArray | null;
    if (!asApp && req.headers.authorization !== undefined) {
      const grant = this.grantOf(req);
      if (grant === undefined && !this.isPersonal(req)) {
        send(401, { message: "Bad credentials" });
        return;
      }
      if (this.revokeAfter !== undefined && (this.revokeAfter -= 1) < 0) {
        this.revokeAfter = undefined;
        this.grants.clear();
        send(401, { message: "Bad credentials" });
        return;
      }
      const wanted: Access =
        path === "/graphql"
          ? isMutation(body)
            ? "write"
            : "read"
          : method === "GET"
            ? "read"
            : "write";
      const scope = /^\s*(?:query|mutation)\s+\w*Discussion/.test(
        String((body as { query?: unknown } | undefined)?.query),
      )
        ? "discussions"
        : "issues";
      if (
        (path === "/graphql" || /^\/repos\/[^/]+\/[^/]+\/./.test(path)) &&
        !this.allows(req, wanted, scope)
      ) {
        if (path === "/graphql") {
          send(200, {
            data: null,
            errors: [
              {
                type: "FORBIDDEN",
                message: this.isPersonal(req)
                  ? "Resource not accessible by personal access token"
                  : "Resource not accessible by integration",
              },
            ],
          });
        } else {
          send(403, { message: "Resource not accessible by integration" });
        }
        return;
      }
    }
    if (asApp) {
      const refusal = this.jwtRefusal(req);
      if (refusal !== undefined) {
        send(401, { message: refusal });
        return;
      }
    }
    if (this.isPersonal(req)) {
      const at = /^\/repos\/([^/]+)\/([^/]+)\/.+/.exec(path);
      const repository =
        at === null
          ? undefined
          : this.repositories.find(
              (one) => one.owner === at[1] && one.name === at[2],
            );
      const required =
        repository === undefined
          ? undefined
          : this.personalDenied.get(repository.node);
      if (required !== undefined) {
        send(
          403,
          { message: "Resource not accessible by personal access token" },
          { "x-accepted-github-permissions": required },
        );
        return;
      }
    }
    // A refused request is not counted, and a spent budget refuses the rest.
    if (!(budget.remaining > 0)) {
      limit(false);
      return;
    }
    budget.remaining -= 1;
    if (
      this.listingsFailing > 0 &&
      method === "GET" &&
      /^\/repos\/[^/]+\/[^/]+\/issues(\/\d+\/comments)?$/.test(path)
    ) {
      this.listingsFailing -= 1;
      send(404, { message: "Not Found" });
      return;
    }
    if (method === "GET" && path === "/user/repos") {
      if (!this.isPersonal(req)) send(401, { message: "Bad credentials" });
      else
        page(
          this.repositories
            .filter((one) => this.reaches(req, one) && one.hidden !== true)
            .map((one) => this.restRepository(one)),
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
      if (
        installation === undefined ||
        installation.lost === true ||
        (installation.discussionsLost === true &&
          (body as { permissions?: Record<string, unknown> } | null)
            ?.permissions?.["discussions"] !== undefined)
      ) {
        send(404, { message: "Not Found" });
        return;
      }
      const minted = this.mint(installation, body);
      if ("refused" in minted) {
        send(422, { message: minted.refused });
        return;
      }
      send(201, {
        token: minted.token,
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
        id: this.appId,
        slug: "marfa-sync-test",
        html_url: "https://github.com/apps/marfa-sync-test",
        pem: this.appPem,
        webhook_secret: this.appWebhookSecret,
        client_id: this.appClientId,
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
        .filter((one) => this.reaches(req, one))
        .map((one) => this.restRepository(one));
      send(200, { total_count: repositories.length, repositories });
      return;
    }
    if (method === "POST" && path === "/graphql") {
      this.graphql(
        req,
        body as { query: string; variables: Record<string, unknown> },
        send,
        limit,
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
      // Observed against GitHub, which honors direction though its
      // documentation says it is ignored without sort.
      const direction = url.searchParams.get("direction") === "desc" ? -1 : 1;
      const all = this.comments
        .filter((one) => {
          const issue = this.issue(one.issue);
          return (
            !one.deleted &&
            issue?.repository === repository.node &&
            (since === null || one.updated_at >= since)
          );
        })
        .sort(
          (a, b) =>
            direction *
            (sort === "updated"
              ? a.updated_at.localeCompare(b.updated_at) || a.id - b.id
              : a.id - b.id),
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
          .filter(
            (one) =>
              one.issue === issue.node && !one.deleted && this.listed(one),
          )
          .map((one) => this.restComment(one)),
      );
      return;
    }
    if (
      (match = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/pulls$/.exec(
        path,
      )) &&
      method === "GET"
    ) {
      const repository = this.readable(req, match[1] ?? "", match[2] ?? "");
      if (repository === undefined) {
        send(404, { message: "Not Found" });
        return;
      }
      page(
        this.pulls
          .filter(
            (pr) =>
              pr.repository === repository.node && pr.head_sha === match?.[3],
          )
          .map((pr) => ({ node_id: pr.node, number: pr.number })),
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
      if (
        repository?.name === this.readFailure &&
        this.readFailure !== undefined
      ) {
        send(422, { message: "Repository listing failed" });
        return;
      }
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
              (since === null || one.updated_at >= since) &&
              this.listed(one),
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
      limit(true, limited.status);
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
    const created = (held: { unlisted?: number }, made: unknown): void => {
      if (this.loseNextCreate) {
        this.loseNextCreate = false;
        if (this.listLate) held.unlisted = 1;
        this.listLate = false;
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
      created(made, this.restIssue(made));
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
      created(made, this.restComment(made));
      return true;
    }
    return false;
  }

  private mutate(
    req: IncomingMessage,
    operation: string | undefined,
    variables: Record<string, unknown>,
    send: (status: number, data?: unknown) => void,
    limit: (secondary: boolean) => void,
  ): boolean {
    const issue = (key: string): Issue | undefined => {
      const found = this.issue(String(variables[key]));
      return found !== undefined && this.visible(req, found.repository)
        ? found
        : undefined;
    };
    if (this.mutationsFailing > 0) {
      this.mutationsFailing -= 1;
      send(200, {
        data: null,
        errors: [{ type: "SERVICE_UNAVAILABLE", message: "Try again later" }],
      });
      return true;
    }
    if (this.mutationsLimited > 0) {
      this.mutationsLimited -= 1;
      limit(true);
      return true;
    }
    if (this.mutateDiscussion(req, operation, variables, send)) return true;
    const one = issue("issueId");
    const other = issue("other");
    const relations = [
      "AddSubIssue",
      "RemoveSubIssue",
      "AddBlockedBy",
      "RemoveBlockedBy",
      "AddRelatesTo",
      "RemoveRelatesTo",
    ];
    if (operation !== undefined && relations.includes(operation)) {
      if (this.relationsRefused) {
        send(200, refusal("Relationship refused"));
        return true;
      }
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
      } else if (operation === "AddRelatesTo") {
        one.relates_to = [...new Set([...(one.relates_to ?? []), other.node])];
        other.relates_to = [
          ...new Set([...(other.relates_to ?? []), one.node]),
        ];
      } else if (operation === "RemoveRelatesTo") {
        one.relates_to = (one.relates_to ?? []).filter(
          (node) => node !== other.node,
        );
        other.relates_to = (other.relates_to ?? []).filter(
          (node) => node !== one.node,
        );
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
            bodyHTML: comment.bodyHTML ?? "",
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

  private repositoryByNode(node: string): Repository {
    const found = this.repositories.find((one) => one.node === node);
    if (found === undefined) throw new Error(`no repository ${node}`);
    return found;
  }

  private seesDiscussion(
    req: IncomingMessage,
    discussion: Discussion,
  ): boolean {
    const repository = this.repositoryByNode(discussion.repository);
    return (
      discussion.deleted !== true &&
      (repository.discussionsOff !== true || this.discussionsOffStillShown) &&
      (this.visible(req, repository.node) || !repository.private)
    );
  }

  private graphDiscussion(discussion: Discussion): Record<string, unknown> {
    const repository = this.repositoryByNode(discussion.repository);
    return {
      __typename: "Discussion",
      id: discussion.node,
      number: discussion.number,
      title: discussion.title,
      body: discussion.body,
      url: `${this.address(repository)}/discussions/${String(discussion.number)}`,
      closed: discussion.state === "closed",
      stateReason:
        discussion.state_reason === null
          ? null
          : discussion.state_reason.toUpperCase(),
      isAnswered: discussion.answered,
      locked: discussion.locked,
      createdAt: discussion.created_at,
      updatedAt: discussion.updated_at,
      author: this.author(discussion.user),
      category: { name: discussion.category },
      repository: {
        id: repository.node,
        nameWithOwner: `${repository.owner}/${repository.name}`,
      },
    };
  }

  private graphDiscussionComment(
    comment: DiscussionComment,
  ): Record<string, unknown> {
    const discussion = this.discussion(comment.discussion);
    if (discussion === undefined) throw new Error("no discussion");
    const repository = this.repositoryByNode(discussion.repository);
    return {
      __typename: "DiscussionComment",
      id: comment.node,
      body: comment.body,
      url: `${this.address(repository)}/discussions/${String(discussion.number)}#discussioncomment-${String(comment.id)}`,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      deletedAt: comment.blanked === true ? comment.updated_at : null,
      author: comment.blanked === true ? null : this.author(comment.user),
      replyTo: comment.parent === null ? null : { id: comment.parent },
      discussion: {
        id: discussion.node,
        repository: {
          id: repository.node,
          nameWithOwner: `${repository.owner}/${repository.name}`,
        },
      },
    };
  }

  private cut(all: unknown[], after: unknown): Record<string, unknown> {
    const at = Number(after ?? 0);
    const size = this.discussionPageSize;
    return {
      nodes: all.slice(at, at + size),
      pageInfo: {
        hasNextPage: all.length > at + size,
        endCursor: String(at + size),
      },
    };
  }

  private repliesOf(comment: DiscussionComment): DiscussionComment[] {
    return this.discussionComments.filter(
      (one) =>
        one.parent === comment.node && one.deleted !== true && this.listed(one),
    );
  }

  private discussionQuery(
    req: IncomingMessage,
    operation: string | undefined,
    variables: Record<string, unknown>,
    send: (status: number, data?: unknown) => void,
    nodes: (ids: unknown, find: (id: string) => unknown) => unknown[],
    withComments: boolean,
  ): boolean {
    if (!operation?.includes("Discussion")) return false;
    const shown = (one: Discussion): Record<string, unknown> => ({
      ...this.graphDiscussion(one),
      ...(withComments && { comments: this.commentsPage(one, 0) }),
    });
    if (operation === "DiscussionsSwitch") {
      const repository = this.repositories.find(
        (one) =>
          one.owner === variables["owner"] &&
          one.name === variables["name"] &&
          this.visible(req, one.node),
      );
      send(200, {
        data: {
          repository:
            repository === undefined
              ? null
              : { hasDiscussionsEnabled: repository.discussionsOff !== true },
        },
      });
      return true;
    }
    if (
      operation === "DiscussionList" ||
      operation === "DiscussionCategories"
    ) {
      const repository = this.repositories.find(
        (one) =>
          one.owner === variables["owner"] &&
          one.name === variables["name"] &&
          this.visible(req, one.node),
      );
      if (repository === undefined) {
        send(200, { data: { repository: null } });
        return true;
      }
      if (operation === "DiscussionCategories") {
        send(200, {
          data: {
            repository: {
              discussionCategories: this.cut(
                (repository.categories ?? defaultCategories).map((name) => ({
                  id: `CAT_${repository.node}_${name}`,
                  name,
                })),
                variables["after"],
              ),
            },
          },
        });
        return true;
      }
      const all = this.discussions
        .filter(
          (one) =>
            one.repository === repository.node &&
            one.deleted !== true &&
            this.listed(one),
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const page = this.cut(
        repository.discussionsOff === true ? [] : all,
        variables["after"],
      );
      send(200, {
        data: {
          repository: {
            hasDiscussionsEnabled: repository.discussionsOff !== true,
            discussions: {
              ...page,
              nodes: (page["nodes"] as Discussion[]).map(shown),
            },
          },
        },
      });
      return true;
    }
    if (operation === "DiscussionNodes") {
      send(200, {
        data: {
          nodes: nodes(variables["ids"], (id) => {
            const found = this.discussion(id);
            return found === undefined || !this.seesDiscussion(req, found)
              ? undefined
              : shown(found);
          }),
        },
      });
      return true;
    }
    if (operation === "DiscussionCommentNodes") {
      send(200, {
        data: {
          nodes: nodes(variables["ids"], (id) => {
            const found = this.discussionComments.find(
              (one) => one.node === id,
            );
            const discussion =
              found === undefined
                ? undefined
                : this.discussion(found.discussion);
            return found === undefined ||
              found.deleted === true ||
              discussion === undefined ||
              !this.seesDiscussion(req, discussion)
              ? undefined
              : this.graphDiscussionComment(found);
          }),
        },
      });
      return true;
    }
    if (operation === "DiscussionComments") {
      const discussion = this.discussion(String(variables["id"]));
      if (discussion === undefined || !this.seesDiscussion(req, discussion)) {
        send(200, { data: { node: null } });
        return true;
      }
      send(200, {
        data: {
          node: { comments: this.commentsPage(discussion, variables["after"]) },
        },
      });
      return true;
    }
    if (operation === "DiscussionReplies") {
      const parent = this.discussionComments.find(
        (one) => one.node === variables["id"],
      );
      const discussion =
        parent === undefined ? undefined : this.discussion(parent.discussion);
      if (
        parent === undefined ||
        discussion === undefined ||
        !this.seesDiscussion(req, discussion)
      ) {
        send(200, { data: { node: null } });
        return true;
      }
      send(200, {
        data: {
          node: { replies: this.repliesPage(parent, variables["after"]) },
        },
      });
      return true;
    }
    return false;
  }

  private commentsPage(
    discussion: Discussion,
    after: unknown,
  ): Record<string, unknown> {
    const top = this.discussionComments.filter(
      (one) =>
        one.discussion === discussion.node &&
        one.parent === null &&
        one.deleted !== true &&
        this.listed(one),
    );
    const page = this.cut(top, after);
    return {
      ...page,
      nodes: (page["nodes"] as DiscussionComment[]).map((one) => ({
        ...this.graphDiscussionComment(one),
        replies: this.repliesPage(one, 0),
      })),
    };
  }

  private repliesPage(
    comment: DiscussionComment,
    after: unknown,
  ): Record<string, unknown> {
    const page = this.cut(this.repliesOf(comment), after);
    return {
      ...page,
      nodes: (page["nodes"] as DiscussionComment[]).map((one) =>
        this.graphDiscussionComment(one),
      ),
    };
  }

  private mutateDiscussion(
    req: IncomingMessage,
    operation: string | undefined,
    variables: Record<string, unknown>,
    send: (status: number, data?: unknown) => void,
  ): boolean {
    if (!operation?.includes("Discussion")) return false;
    const bot = `${this.appSlug}[bot]`;
    const discussionOf = (key: string): Discussion | undefined => {
      const found = this.discussion(String(variables[key]));
      return found !== undefined && this.seesDiscussion(req, found)
        ? found
        : undefined;
    };
    const commentOf = (key: string): DiscussionComment | undefined => {
      const found = this.discussionComments.find(
        (one) => one.node === variables[key] && one.deleted !== true,
      );
      const discussion =
        found === undefined ? undefined : this.discussion(found.discussion);
      return discussion !== undefined && this.seesDiscussion(req, discussion)
        ? found
        : undefined;
    };
    const lose = (made: { unlisted?: number }): boolean => {
      if (!this.loseNextCreate) return false;
      this.loseNextCreate = false;
      if (this.listLate) made.unlisted = 1;
      this.listLate = false;
      send(502, { message: "Server Error" });
      return true;
    };
    if (operation === "CreateDiscussion") {
      const repository = this.repositories.find(
        (one) => one.node === variables["repositoryId"],
      );
      const name = String(variables["categoryId"]).replace(
        `CAT_${String(variables["repositoryId"])}_`,
        "",
      );
      if (
        repository === undefined ||
        !this.visible(req, repository.node) ||
        repository.discussionsOff === true ||
        !(repository.categories ?? defaultCategories).includes(name)
      ) {
        send(200, notFound);
        return true;
      }
      const made = this.addDiscussion(repository, {
        title: String(variables["title"]),
        body: String(variables["body"]),
        category: name,
        user: bot,
        app: true,
      });
      if (lose(made)) return true;
      send(200, {
        data: { createDiscussion: { discussion: this.graphDiscussion(made) } },
      });
      return true;
    }
    if (
      operation === "UpdateDiscussion" ||
      operation === "CloseDiscussion" ||
      operation === "ReopenDiscussion"
    ) {
      const discussion = discussionOf("id");
      if (discussion === undefined) {
        send(200, notFound);
        return true;
      }
      if (operation === "UpdateDiscussion") {
        const next: Partial<Discussion> = {};
        if (typeof variables["title"] === "string") {
          next.title = variables["title"];
        }
        if (typeof variables["body"] === "string")
          next.body = variables["body"];
        this.editDiscussion(discussion, next);
      } else if (operation === "CloseDiscussion") {
        this.editDiscussion(discussion, {
          state: "closed",
          state_reason: String(variables["reason"]).toLowerCase(),
        });
      } else {
        this.editDiscussion(discussion, {
          state: "open",
          state_reason: "reopened",
        });
      }
      const field = operation.charAt(0).toLowerCase() + operation.slice(1);
      send(200, {
        data: { [field]: { discussion: this.graphDiscussion(discussion) } },
      });
      return true;
    }
    if (operation === "AddDiscussionComment") {
      const discussion = discussionOf("discussionId");
      const parent =
        variables["replyToId"] === undefined || variables["replyToId"] === null
          ? null
          : commentOf("replyToId");
      if (discussion === undefined || parent === undefined) {
        send(200, notFound);
        return true;
      }
      const made = this.addDiscussionComment(
        discussion,
        String(variables["body"]),
        bot,
        parent,
      );
      made.app = true;
      if (lose(made)) return true;
      send(200, {
        data: {
          addDiscussionComment: { comment: this.graphDiscussionComment(made) },
        },
      });
      return true;
    }
    const comment = commentOf("id");
    if (comment === undefined) {
      send(200, notFound);
      return true;
    }
    if (operation === "UpdateDiscussionComment") {
      comment.body = String(variables["body"]);
      comment.updated_at = this.now();
      send(200, {
        data: {
          updateDiscussionComment: {
            comment: this.graphDiscussionComment(comment),
          },
        },
      });
      return true;
    }
    if (operation === "DeleteDiscussionComment") {
      this.removeDiscussionComment(comment);
      send(200, {
        data: { deleteDiscussionComment: { comment: { id: comment.node } } },
      });
      return true;
    }
    return false;
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
      bodyHTML: issue.bodyHTML ?? "",
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
      relatesTo: {
        nodes: (issue.relates_to ?? [])
          .map(related)
          .filter((one) => one !== null)
          .slice(0, this.relatedPageSize),
        pageInfo: {
          hasNextPage:
            (issue.relates_to ?? []).map(related).filter((one) => one !== null)
              .length > this.relatedPageSize,
          endCursor: String(this.relatedPageSize),
        },
      },
      duplicateOf:
        issue.duplicate_of == null ? null : related(issue.duplicate_of),
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

  private graphPull(
    pr: PullRequest,
    sees: (repository: Repository) => boolean,
    after = 0,
  ): Record<string, unknown> {
    const repository = this.repositoryOf(pr);
    const closing = pr.closing_issues.flatMap((id) => {
      const issue = this.issue(id);
      if (issue === undefined || issue.deleted === true) return [];
      const where = this.repositoryOf(issue);
      return sees(where)
        ? [
            {
              id: issue.node,
              url: `${this.address(where)}/issues/${String(issue.number)}`,
              repository: { id: where.node },
            },
          ]
        : [];
    });
    const rollup =
      pr.checks === null
        ? null
        : {
            state: pr.checks.state,
            contexts: {
              checkRunCountsByState: Object.entries(pr.checks.check_runs).map(
                ([state, count]) => ({ state, count }),
              ),
              statusContextCountsByState: Object.entries(
                pr.checks.statuses,
              ).map(([state, count]) => ({ state, count })),
            },
          };
    return {
      __typename: "PullRequest",
      id: pr.node,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      url: `${this.address(repository)}/pull/${String(pr.number)}`,
      state: pr.pr_state.toUpperCase(),
      isDraft: pr.draft,
      mergedAt: pr.merged_at,
      closedAt: pr.closed_at,
      baseRefName: pr.base_branch,
      headRefName: pr.head_branch,
      updatedAt: pr.updated_at,
      createdAt: pr.created_at,
      author: this.author(pr.user),
      repository: {
        id: repository.node,
        nameWithOwner: `${repository.owner}/${repository.name}`,
      },
      closingIssuesReferences: {
        nodes: closing.slice(after, after + this.closingPageSize),
        pageInfo: {
          hasNextPage: closing.length > after + this.closingPageSize,
          endCursor: String(after + this.closingPageSize),
        },
      },
      commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
    };
  }

  private graphql(
    req: IncomingMessage,
    body: { query: string; variables: Record<string, unknown> },
    send: (status: number, data?: unknown) => void,
    limit: (secondary: boolean) => void,
  ): void {
    const operation = /^\s*(query|mutation)\s+(\w+)/.exec(body.query)?.[2];
    if (this.installationOf(req) === undefined && !this.isPersonal(req)) {
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
        // Whether GitHub shows an issue whose repository turned issues off
        // is not documented; the stand-in takes the stricter answer.
        this.repositoryOf(issue).issuesOff === true ||
        // GitHub shows an App a public repository's issues, installed or not.
        (!this.visible(req, issue.repository) &&
          this.repositoryOf(issue).private)
        ? undefined
        : this.graphIssue(
            issue,
            (where) => !where.private || this.visible(req, where.node),
          );
    };
    const seesPull = (where: Repository): boolean =>
      !where.private || this.visible(req, where.node);
    if (operation === "PullRequests") {
      send(200, {
        data: {
          nodes: nodes(body.variables["ids"], (id) => {
            const pr = this.pulls.find(
              (one) => one.node === id && one.deleted !== true,
            );
            return pr === undefined || !seesPull(this.repositoryOf(pr))
              ? undefined
              : this.graphPull(pr, seesPull);
          }),
        },
      });
      return;
    }
    if (operation === "ClosingIssues") {
      const pr = this.pulls.find(
        (one) => one.node === body.variables["id"] && one.deleted !== true,
      );
      send(200, {
        data: {
          node:
            pr === undefined || !seesPull(this.repositoryOf(pr))
              ? null
              : this.graphPull(pr, seesPull, Number(body.variables["after"])),
        },
      });
      return;
    }
    if (operation === "PullRequestList" || operation === "PullRequestNumber") {
      const repository = this.repositories.find(
        (one) =>
          one.owner === body.variables["owner"] &&
          one.name === body.variables["name"] &&
          this.visible(req, one.node),
      );
      if (repository === undefined || this.missingPullRepository) {
        send(200, { data: { repository: null } });
        return;
      }
      if (
        operation === "PullRequestList" &&
        this.pullListsRefused.has(repository.node)
      ) {
        send(403, { message: "Resource not accessible by integration" });
        return;
      }
      if (operation === "PullRequestNumber") {
        const pr = this.pulls.find(
          (one) =>
            one.repository === repository.node &&
            one.number === body.variables["number"] &&
            one.deleted !== true,
        );
        send(200, {
          data: {
            repository: {
              pullRequest: pr === undefined ? null : { id: pr.node },
            },
          },
        });
        return;
      }
      const states = body.variables["states"] as string[];
      const all = this.pulls
        .filter(
          (one) =>
            one.repository === repository.node &&
            one.deleted !== true &&
            states.includes(one.pr_state.toUpperCase()),
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const after = Number(body.variables["after"] ?? 0);
      send(200, {
        data: {
          repository: {
            pullRequests: {
              nodes: all
                .slice(after, after + this.pullPageSize)
                .map((pr) => this.graphPull(pr, seesPull)),
              pageInfo: {
                hasNextPage: all.length > after + this.pullPageSize,
                endCursor: String(after + this.pullPageSize),
              },
            },
          },
        },
      });
      return;
    }
    if (operation === "ClosedBy") {
      send(200, {
        data: {
          nodes: nodes(body.variables["ids"], (id) => {
            const issue = this.issue(id);
            if (issue === undefined || !seesPull(this.repositoryOf(issue)))
              return undefined;
            const pr = this.pulls.find((one) => one.node === issue.closed_by);
            return {
              __typename: "Issue",
              id: issue.node,
              state: issue.state.toUpperCase(),
              timelineItems: {
                nodes: [
                  {
                    closer:
                      pr !== undefined && seesPull(this.repositoryOf(pr))
                        ? {
                            __typename: "PullRequest",
                            id: pr.node,
                            url: `${this.address(this.repositoryOf(pr))}/pull/${String(pr.number)}`,
                            repository: { id: pr.repository },
                          }
                        : null,
                  },
                ],
              },
            };
          }),
        },
      });
      return;
    }
    if (
      operation === "Issues" ||
      operation === "Relations" ||
      operation === "FileIssues"
    ) {
      const data = { nodes: nodes(body.variables["ids"], issueNode) };
      send(200, { data, ...(errors.length > 0 && { errors }) });
      return;
    }
    if (operation === "RelatedIssues") {
      const issue = this.issue(String(body.variables["id"]));
      if (issue === undefined) {
        send(200, notFound);
        return;
      }
      const full = this.graphIssue(
        issue,
        (where) => !where.private || this.visible(req, where.node),
      );
      const saved = this.relatedPageSize;
      this.relatedPageSize = Number.MAX_SAFE_INTEGER;
      const all = this.graphIssue(
        issue,
        (where) => !where.private || this.visible(req, where.node),
      )["relatesTo"] as { nodes: unknown[] };
      this.relatedPageSize = saved;
      const after = Number(body.variables["after"]);
      send(200, {
        data: {
          node: {
            ...full,
            relatesTo: {
              nodes: all.nodes.slice(after, after + saved),
              pageInfo: {
                hasNextPage: all.nodes.length > after + saved,
                endCursor: String(after + saved),
              },
            },
          },
        },
      });
      return;
    }
    if (operation === "Comments" || operation === "FileComments") {
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
                hasIssuesEnabled: repository.issuesOff !== true,
                hasDiscussionsEnabled: repository.discussionsOff !== true,
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
    if (
      this.discussionQuery(
        req,
        operation,
        body.variables,
        send,
        nodes,
        body.query.includes("comments("),
      )
    ) {
      return;
    }
    if (this.mutate(req, operation, body.variables, send, limit)) return;
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
