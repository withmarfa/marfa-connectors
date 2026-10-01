import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { GraphqlResponseError } from "@octokit/graphql";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";
import type { Secret } from "@withmarfa/connector";

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

const budgets = new WeakMap<Client, number>();

export function remaining(octokit: Client): number | undefined {
  return budgets.get(octokit);
}

function counted(octokit: Client): Client {
  octokit.hook.after("request", (response) => {
    const left = Number(response.headers["x-ratelimit-remaining"]);
    if (Number.isFinite(left)) budgets.set(octokit, left);
  });
  return octokit;
}

const auths = new Map<string, ReturnType<typeof createAppAuth>>();

/** One per App and process, so its installation tokens are cached for
 *  their hour across runs. */
function appAuth(app: App): ReturnType<typeof createAppAuth> {
  const key = `${app.base} ${app.appId}`;
  let auth = auths.get(key);
  if (auth === undefined) {
    auth = createAppAuth({
      appId: app.appId,
      privateKey: app.privateKey,
      request: client(app.base, new AbortController().signal).request,
    });
    auths.set(key, auth);
  }
  return auth;
}

export function anonymous(base: string, signal: AbortSignal): Client {
  return client(base, signal);
}

export function asApp(app: App, signal: AbortSignal): Client {
  return client(app.base, signal, {
    authStrategy: createAppAuth,
    auth: { appId: app.appId, privateKey: app.privateKey },
  });
}

export function asInstallation(
  app: App,
  installationId: number,
  secret: Secret,
  signal: AbortSignal,
): Client {
  const octokit = counted(client(app.base, signal));
  octokit.hook.wrap("request", async (request, options) => {
    const { token } = await appAuth(app)({
      type: "installation",
      installationId,
    });
    secret(token);
    options.headers.authorization = `token ${token}`;
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
