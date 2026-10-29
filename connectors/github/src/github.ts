import { createHash } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { GraphqlResponseError } from "@octokit/graphql";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";
import type { Secret } from "@withmarfa/connector";
import Bottleneck from "bottleneck";
import githubAppJwt from "universal-github-app-jwt";

export const defaultBase = "https://api.github.com";

export const apiVersion = "2026-03-10";

const Client = Octokit.plugin(paginateRest, throttling, retry);
export type Client = InstanceType<typeof Client>;

export interface App {
  readonly appId: string;
  readonly privateKey: string;
  readonly base: string;
}

export interface Personal {
  readonly token: string;
  readonly base: string;
}

export class PermissionRequired extends Error {
  override name = "PermissionRequired";
}

/** Reads `GITHUB_REQUEST_SPACING_MS`: the least time between two writes. */
export function spacingOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new Error(
      "GITHUB_REQUEST_SPACING_MS must be a whole number of milliseconds",
    );
  return Number(value);
}

let spaced:
  | { ms: number; write: Bottleneck.Group; notifications: Bottleneck.Group }
  | undefined;

// The throttle plugin spaces writes, GraphQL requests and the writes that
// notify someone by whole seconds, through limiters it shares across clients.
// A setting replaces them with limiters of its own, shared the same way.
function spacing(ms: number | undefined) {
  if (ms === undefined) return {};
  if (spaced?.ms !== ms) {
    const limiter = (id: string) =>
      new Bottleneck.Group({ id, maxConcurrent: 1, minTime: ms });
    spaced = {
      ms,
      write: limiter("octokit-write"),
      notifications: limiter("octokit-notifications"),
    };
  }
  return { write: spaced.write, notifications: spaced.notifications };
}

function client(base: string, signal: AbortSignal, auth?: object): Client {
  const octokit = new Client({
    baseUrl: base,
    request: { signal },
    ...auth,
    throttle: {
      ...spacing(spacingOf(process.env["GITHUB_REQUEST_SPACING_MS"])),
      onRateLimit: (
        after: number,
        _options: unknown,
        _octokit: unknown,
        count: number,
      ) => after <= 60 && count < 2,
      onSecondaryRateLimit: (
        after: number,
        _options: unknown,
        _octokit: unknown,
        count: number,
      ) => after <= 60 && count < 2,
    },
  });
  // Octokit takes no default headers; unnamed, GitHub serves its oldest.
  octokit.hook.before("request", (options) => {
    options.headers["x-github-api-version"] = apiVersion;
  });
  return octokit;
}

export class RateLimitWaiting extends Error {
  override name = "RateLimitWaiting";
  constructor(resource: string) {
    super(`GitHub's ${resource} rate-limit budget reached the reserve`);
  }
}

export function rateLimited(error: unknown): boolean {
  if (error instanceof RateLimitWaiting) return true;
  const said = (error as { response?: { data?: { errors?: unknown } } } | null)
    ?.response?.data?.errors;
  if (
    Array.isArray(said) &&
    said.some(
      (one) => (one as { type?: unknown } | null)?.type === "RATE_LIMITED",
    )
  )
    return true;
  if (error instanceof GraphqlResponseError)
    return error.errors?.some((one) => one.type === "RATE_LIMITED") === true;
  if (!(error instanceof RequestError) || ![403, 429].includes(error.status))
    return false;
  return (
    error.status === 429 ||
    error.response?.headers["x-ratelimit-remaining"] === "0" ||
    /rate limit/i.test(error.message)
  );
}

type Resource = "core" | "graphql";
const reserve = 500;
const budgets = new Map<
  string,
  Map<Resource, { left: number; reset?: number }>
>();

function counted(octokit: Client, key: string, guard: boolean): Client {
  let budget = budgets.get(key);
  if (budget === undefined) {
    budget = new Map();
    budgets.set(key, budget);
  }
  const held = budget;
  const resourceOf = (url: string): Resource =>
    /\/graphql(?:[?#]|$)/.test(url) ? "graphql" : "core";
  octokit.hook.before("request", (options) => {
    if (!guard) return;
    const resource = resourceOf(options.url);
    const known = held.get(resource);
    if (known?.reset !== undefined && Date.now() >= known.reset) {
      held.delete(resource);
      return;
    }
    if (known !== undefined && known.left < reserve)
      throw new RateLimitWaiting(resource);
  });
  const count = (headers: Record<string, unknown>, url: string): void => {
    const numeric = (value: unknown): number | undefined => {
      if (
        typeof value !== "number" &&
        (typeof value !== "string" || value.trim() === "")
      )
        return;
      const result = Number(value);
      return Number.isFinite(result) && result >= 0 ? result : undefined;
    };
    const left = numeric(headers["x-ratelimit-remaining"]);
    if (left === undefined) return;
    const resource = headers["x-ratelimit-resource"];
    if (resource !== undefined && resource !== "core" && resource !== "graphql")
      return;
    const reset = numeric(headers["x-ratelimit-reset"]);
    held.set(
      resource === "core" || resource === "graphql"
        ? resource
        : resourceOf(url),
      {
        left,
        ...(reset !== undefined && { reset: reset * 1000 }),
      },
    );
  };
  octokit.hook.after("request", (response, options) => {
    count(response.headers, options.url);
  });
  octokit.hook.error("request", (error, options) => {
    const response = (error as { response?: unknown } | null)?.response;
    if (
      typeof response === "object" &&
      response !== null &&
      "headers" in response
    ) {
      const headers = response.headers;
      if (
        typeof headers === "object" &&
        headers !== null &&
        !Array.isArray(headers)
      )
        count(headers as Record<string, unknown>, options.url);
    }
    throw error;
  });
  return octokit;
}

/** What an installation token is minted for: `list` reads only which
 *  repositories the installation holds; `read` reaches issues and pull
 *  requests, and `write` carries only issues and their comments. The two
 *  Discussions accesses and `contents`, which reads repository files, are
 *  separate so an installation that has not yet accepted one of those
 *  permissions still mints every other token. */
export type Access =
  "list" | "read" | "write" | "discussions" | "discussions-write" | "contents";

const permissions = {
  list: { metadata: "read" },
  read: {
    issues: "read",
    pull_requests: "read",
    checks: "read",
    statuses: "read",
    metadata: "read",
  },
  write: { issues: "write", metadata: "read" },
  discussions: { discussions: "read", metadata: "read" },
  "discussions-write": { discussions: "write", metadata: "read" },
  contents: { contents: "read", metadata: "read" },
} as const;

/** GitHub's cap on the repositories one token can name. */
export const namedAtMost = 500;

export interface Reach {
  readonly access: Access;
  /** Past GitHub's cap, or absent, the token reaches every repository of
   *  the installation. */
  readonly repositoryIds?: readonly number[];
  /** For a read token that only finds where a node sits: where GitHub
   *  refuses to name a repository, as one taken from the installation since
   *  it was recorded, the installation's whole reach instead. */
  readonly orWhole?: boolean;
}

/** How far apart this machine's clock and GitHub's may be before the
 *  connector stops signing rather than trust its correction. */
export const skewAtMost = 10 * 60;

export class ClockSkew extends Error {
  override name = "ClockSkew";
  constructor(seconds: number) {
    super(
      `this machine's clock is ${String(Math.abs(seconds))} seconds ${seconds > 0 ? "behind" : "ahead of"} GitHub's, past the ${String(skewAtMost / 60)} minutes the connector allows for, so nothing is asked of GitHub until it is set right`,
    );
  }
}

interface Signer {
  /** Installation tokens, kept for their hour across runs. */
  readonly cache: TokenCache;
  /** Seconds GitHub's clock runs ahead of ours, as its answers showed. */
  skew: number;
}

/** A minute short of a token's hour, as `@octokit/auth-app`'s own. */
const tokenLife = 59 * 60 * 1000;

class TokenCache {
  private readonly held = new Map<string, { value: string; until: number }>();

  /** Empty where nothing is held, which the library takes for a miss. */
  get(key: string): string {
    const one = this.held.get(key);
    if (one === undefined || one.until <= Date.now()) {
      this.held.delete(key);
      return "";
    }
    return one.value;
  }

  set(key: string, value: string): void {
    this.held.set(key, { value, until: Date.now() + tokenLife });
  }
}

const signers = new Map<string, Signer>();

/** One per App and process, so what it learns of GitHub's clock and the
 *  tokens it mints are kept between runs. */
function signerOf(app: App): Signer {
  const key = `${app.base} ${app.appId}`;
  let signer = signers.get(key);
  if (signer === undefined) {
    signer = { cache: new TokenCache(), skew: 0 };
    signers.set(key, signer);
  }
  return signer;
}

/** Mints under the run's own signal, from the App's shared cache. */
function minterOf(app: App, signal: AbortSignal) {
  const signer = signerOf(app);
  return createAppAuth({
    appId: app.appId,
    createJwt: jwtOf(app, () => signer),
    request: client(app.base, signal).request,
    cache: signer.cache,
  });
}

function adopt(signer: Signer, skew: number): void {
  if (Math.abs(skew) > skewAtMost) throw new ClockSkew(skew);
  signer.skew = skew;
}

/** Signs with what GitHub's clock is known to say; `timeDifference` is the
 *  library's own reading of it, where its hook retried a refused JWT. */
function jwtOf(app: App, signer: () => Signer) {
  return async (appId: string | number, timeDifference?: number) => {
    if (timeDifference !== undefined) adopt(signer(), timeDifference);
    const { token, expiration } = await githubAppJwt({
      id: appId,
      privateKey: app.privateKey,
      now: Math.floor(Date.now() / 1000) + signer().skew,
    });
    return { jwt: token, expiresAt: new Date(expiration * 1000).toISOString() };
  };
}

/** How far GitHub's clock runs ahead of ours, where it refused a JWT for
 *  its times. */
function skewOf(error: unknown): number | undefined {
  if (!(error instanceof RequestError) || error.status !== 401) return;
  if (!/'(?:Expiration time|Issued at)' claim/.test(error.message)) return;
  const date = Date.parse(String(error.response?.headers.date));
  return Number.isNaN(date)
    ? undefined
    : Math.floor((date - Date.now()) / 1000);
}

async function tokenFor(
  app: App,
  installationId: number,
  reach: Reach,
  refresh: boolean,
  signal: AbortSignal,
): Promise<{ token: string; createdAt: string }> {
  const signer = signerOf(app);
  const named = [...(reach.repositoryIds ?? [])].sort((a, b) => a - b);
  const whole = {
    type: "installation" as const,
    installationId,
    permissions: { ...permissions[reach.access] },
    refresh,
  };
  const options: typeof whole & { repositoryIds?: number[] } = {
    ...whole,
    ...(reach.repositoryIds !== undefined &&
      named.length <= namedAtMost && { repositoryIds: named }),
  };
  const mint = minterOf(app, signal);
  const signed = async (asked: typeof options) => {
    try {
      return await mint(asked);
    } catch (error) {
      const skew = skewOf(error);
      if (skew === undefined) throw error;
      adopt(signer, skew);
      return mint(asked);
    }
  };
  try {
    return await signed(options);
  } catch (error) {
    if (
      (reach.access !== "read" && reach.access !== "discussions") ||
      reach.orWhole !== true ||
      status(error) !== 422 ||
      options.repositoryIds === undefined
    ) {
      throw error;
    }
    return signed(whole);
  }
}

export function anonymous(base: string, signal: AbortSignal): Client {
  return client(base, signal);
}

export function asPersonalToken(
  token: string,
  base: string,
  secret: Secret,
  signal: AbortSignal,
  name = "GITHUB_PERSONAL_TOKEN",
): Client {
  secret(token);
  const fingerprint = createHash("sha256").update(token).digest("hex");
  const octokit = counted(
    client(base, signal),
    `${base} personal ${fingerprint}`,
    true,
  );
  octokit.hook.before("request", (options) => {
    secret(token);
    const graph = /\/graphql(?:[?#]|$)/.test(options.url);
    const query = (options as { query?: unknown }).query;
    if (
      !["GET", "HEAD"].includes(options.method) &&
      !(
        graph &&
        typeof query === "string" &&
        /^(?:\s*query\b|\s*\{)/.test(query)
      )
    )
      throw new Error(`${name} is read only; GitHub writes require an App`);
    options.headers.authorization = `Bearer ${token}`;
  });
  octokit.hook.error("request", (error) => {
    if (
      error instanceof RequestError &&
      error.status === 403 &&
      !rateLimited(error)
    ) {
      const required = error.response?.headers["x-accepted-github-permissions"];
      if (typeof required === "string" && required !== "")
        throw new PermissionRequired(
          `${name} needs GitHub permissions ${required}`,
        );
    }
    throw error;
  });
  return octokit;
}

export function asApp(app: App, signal: AbortSignal): Client {
  const signer = signerOf(app);
  return client(app.base, signal, {
    authStrategy: createAppAuth,
    auth: { appId: app.appId, createJwt: jwtOf(app, () => signer) },
  });
}

/** As `@octokit/auth-app` does, a 401 this soon after minting is taken for
 *  GitHub's replication delay and the token tried again. */
const replication = 5000;

export function asInstallation(
  app: App,
  installationId: number,
  reach: Reach,
  secret: Secret,
  signal: AbortSignal,
): Client {
  const octokit = counted(
    client(app.base, signal),
    `${app.base} ${app.appId} ${String(installationId)}`,
    reach.access !== "write" && reach.access !== "discussions-write",
  );
  octokit.hook.wrap("request", async (request, options) => {
    const sign = async (refresh: boolean): Promise<string> => {
      const { token, createdAt } = await tokenFor(
        app,
        installationId,
        reach,
        refresh,
        signal,
      );
      secret(token);
      options.headers.authorization = `token ${token}`;
      return createdAt;
    };
    const createdAt = await sign(false);
    try {
      return await request(options);
    } catch (error) {
      if (status(error) !== 401) throw error;
    }
    if (Date.now() - Date.parse(createdAt) < replication) {
      await new Promise((done) => setTimeout(done, 1000));
      try {
        return await request(options);
      } catch (error) {
        if (status(error) !== 401) throw error;
      }
    }
    // Revoked or expired while cached: the library keeps it for its hour.
    await sign(true);
    return request(options);
  });
  return octokit;
}

export function status(error: unknown): number | undefined {
  return error instanceof RequestError ? error.status : undefined;
}

export interface Page {
  readonly etag: string;
  readonly size: number;
  // Run-length coded: a repository's state must fit the instance's 512 KiB cap.
  readonly numbers: string;
}

export function runsOf(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let at = 0; at < sorted.length;) {
    const first = sorted[at] ?? 0;
    let last = first;
    while (sorted[at + 1] === last + 1) {
      at += 1;
      last += 1;
    }
    at += 1;
    runs.push(
      first === last ? String(first) : `${String(first)}-${String(last)}`,
    );
  }
  return runs.join(",");
}

export function numbersIn(runs: string): number[] {
  if (runs === "") return [];
  return runs.split(",").flatMap((run) => {
    const [first = 0, last = first] = run.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, at) => first + at);
  });
}

const perPage = 100;

export async function pagesOf<T extends { number: number }>(
  octokit: Client,
  route: string,
  parameters: Record<string, string | number>,
  kept: readonly Page[] | undefined,
  keep: (item: T) => boolean,
): Promise<{ changed: T[]; pages: Page[]; fresh: boolean }> {
  const changed: T[] = [];
  const pages: Page[] = [];
  let fresh = false;
  for (let page = 1; ; page += 1) {
    const before = kept?.[page - 1];
    try {
      const answer = await octokit.request(route, {
        ...parameters,
        per_page: perPage,
        page,
        ...(before !== undefined && {
          headers: { "if-none-match": before.etag },
        }),
      });
      const items = answer.data as T[];
      fresh = true;
      changed.push(...items.filter(keep));
      const etag = answer.headers.etag;
      // An empty page is kept too, so an empty listing answers 304 next.
      pages.push({
        etag: typeof etag === "string" ? etag : "",
        size: items.length,
        numbers: runsOf(items.filter(keep).map((item) => item.number)),
      });
      if (items.length < perPage) break;
    } catch (error) {
      if (status(error) !== 304 || before === undefined) throw error;
      pages.push(before);
      if (before.size < perPage) break;
    }
  }
  return { changed, pages, fresh };
}

export async function unlessUnchanged(
  octokit: Client,
  route: string,
  parameters: Record<string, string | number>,
  etag: string | undefined,
): Promise<{ data: unknown; etag: string | undefined } | undefined> {
  try {
    const answer = await octokit.request(route, {
      ...parameters,
      ...(etag !== undefined && { headers: { "if-none-match": etag } }),
    });
    const next = answer.headers.etag;
    return {
      data: answer.data,
      etag: typeof next === "string" ? next : undefined,
    };
  } catch (error) {
    if (status(error) === 304 && etag !== undefined) return undefined;
    throw error;
  }
}

/** GraphQL's answer where some nodes are gone: the rest, and nulls for
 *  those, rather than a failure. */
export async function query(
  octokit: Client,
  text: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await octokit.graphql(text, variables);
  } catch (error) {
    if (
      error instanceof GraphqlResponseError &&
      error.errors?.every((one) => one.type === "NOT_FOUND") === true
    ) {
      return error.data;
    }
    throw error;
  }
}

/** GraphQL's answer to a query of `nodes(ids:)`, in the order asked, with null
 *  for a node that is gone and for a node GitHub refuses the token with
 *  FORBIDDEN, as it does a private repository's Discussions node asked for by
 *  a token without the Discussions permission. A node refused, at any path
 *  under it, is named in `refused` and its data is nulled, so it is never
 *  taken for gone or read in part. A refusal that names no node, such as one
 *  for the whole query, still throws, as does any other error. */
export async function queryNodes(
  octokit: Client,
  text: string,
  ids: readonly string[],
): Promise<{ nodes: unknown[]; refused: Set<string> }> {
  try {
    const answer = await octokit.graphql<{ nodes: unknown[] }>(text, { ids });
    return { nodes: answer.nodes, refused: new Set() };
  } catch (error) {
    if (!(error instanceof GraphqlResponseError)) throw error;
    const data = error.data as { nodes?: unknown } | null;
    if (!Array.isArray(data?.nodes)) throw error;
    const nodes: unknown[] = [...(data.nodes as unknown[])];
    const refused = new Set<string>();
    for (const one of error.errors ?? []) {
      if (one.type === "NOT_FOUND") continue;
      const path: unknown = one.path;
      const [field, at] = Array.isArray(path) ? (path as unknown[]) : [];
      const id = typeof at === "number" ? ids[at] : undefined;
      if (one.type !== "FORBIDDEN" || field !== "nodes" || id === undefined)
        throw error;
      refused.add(id);
      nodes[at as number] = null;
    }
    return { nodes, refused };
  }
}

export function batches<T>(values: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) {
    out.push(values.slice(at, at + size));
  }
  return out;
}

export async function reads(
  octokit: Client,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    return true;
  } catch (error) {
    if ([401, 403, 404, 451].includes(status(error) ?? 0)) return false;
    throw error;
  }
}
