import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { GraphqlResponseError } from "@octokit/graphql";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";
import type { Secret } from "@withmarfa/connector";
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

function client(base: string, signal: AbortSignal, auth?: object): Client {
  const octokit = new Client({
    baseUrl: base,
    request: { signal },
    ...auth,
    throttle: {
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

/** GitHub's hourly limit is the installation's, whichever token spends it. */
const budgets = new Map<string, number>();
const budgetOf = new WeakMap<Client, string>();

export function remaining(octokit: Client): number | undefined {
  const key = budgetOf.get(octokit);
  return key === undefined ? undefined : budgets.get(key);
}

function counted(octokit: Client, key: string): Client {
  budgetOf.set(octokit, key);
  octokit.hook.after("request", (response) => {
    const left = Number(response.headers["x-ratelimit-remaining"]);
    if (Number.isFinite(left)) budgets.set(key, left);
  });
  return octokit;
}

/** What an installation token is minted for: `list` reads only which
 *  repositories the installation holds; `read` and `write` reach issues. */
export type Access = "list" | "read" | "write";

const permissions = {
  list: { metadata: "read" },
  read: { issues: "read", metadata: "read" },
  write: { issues: "write", metadata: "read" },
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
  /** Installation tokens, kept for their hour across runs, as GitHub
   *  answers 304 only to the token that was answered the ETag. */
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
      reach.access !== "read" ||
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
