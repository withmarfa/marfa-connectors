import type { EnvDeclaration, Item, RunContext } from "@withmarfa/connector";
import {
  commentEntry,
  commentType,
  inRepository,
  issueEntry,
  issueOfRest,
  issueType,
  repositoryEntry,
  repositoryType,
  type RestComment,
  type RestIssue,
  type RestRepository,
} from "./entries.js";
import {
  asApp,
  asInstallation,
  numbersIn,
  pagesOf,
  status,
  unlessUnchanged,
  type App,
  type Client,
  type Page,
} from "./github.js";
import {
  commentsByNode,
  issuesByNode,
  nodesOfNumbers,
  relationsOf,
} from "./graph.js";

/** How far back a first sync reaches for closed issues. */
export const windowDays = 90;

/** How often a scheduled run asks GitHub about every comment it no longer
 *  lists; issues are asked about whenever their listing changed. */
const checkEvery = 24 * 60 * 60 * 1000;

/** What a run keeps of a repository between runs. */
export interface Kept {
  installation: number;
  name: string;
  open?: Page[];
  closed?: { since: string; pages: Page[] };
  comments?: { since: string; etag?: string };
  checked?: string;
}

type Context = RunContext<EnvDeclaration>;

interface Installation {
  id: number;
  suspended_at?: string | null;
  account?: { login?: string } | null;
}

/** Refused for want of access, rather than for a passing reason such as a
 *  rate limit, which fails the run for the next to take up. */
function lostAccess(error: unknown): boolean {
  const code = status(error);
  if (code === 403) {
    const answer = error as {
      message?: string;
      response?: { headers?: Record<string, unknown> };
    };
    if (
      answer.response?.headers?.["x-ratelimit-remaining"] === "0" ||
      /rate limit/i.test(answer.message ?? "")
    ) {
      return false;
    }
  }
  return code === 401 || code === 403 || code === 404;
}

function keptOf(value: unknown): Record<string, Kept> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, Kept>)
    : {};
}

function numbersOf(pages: readonly Page[] | undefined): number[] {
  return (pages ?? []).flatMap((page) => numbersIn(page.numbers));
}

/** A comment cursor asked a little early, so one GitHub shows late under
 *  an earlier time is still read; what comes again is unchanged. */
const overlap = 5 * 60 * 1000;

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function linkOf(row: Item): string | undefined {
  const value = row.properties["github_id"];
  return typeof value === "string" ? value : undefined;
}

export async function read(context: Context, app: App): Promise<void> {
  const { state, log, secret, signal, upsert } = context;
  const kept = keptOf(state.get("repositories"));
  const installations = (await asApp(app, signal).paginate(
    "GET /app/installations",
  )) as Installation[];
  const clients = new Map<number, Client>();
  const listed = new Map<
    string,
    { repository: RestRepository; installation: number }
  >();
  const answered = new Set<number>();
  for (const installation of installations) {
    const who = installation.account?.login ?? String(installation.id);
    if (installation.suspended_at) {
      log.condition(
        `installation-suspended:${String(installation.id)}`,
        `the App's installation on ${who} is suspended, so its repositories are left as they are`,
      );
      continue;
    }
    const octokit = asInstallation(app, installation.id, secret, signal);
    try {
      const repositories = (await octokit.paginate(
        "GET /installation/repositories",
      )) as RestRepository[];
      clients.set(installation.id, octokit);
      answered.add(installation.id);
      for (const repository of repositories) {
        listed.set(repository.node_id, {
          repository,
          installation: installation.id,
        });
      }
    } catch (error) {
      if (!lostAccess(error)) throw error;
      log.condition(
        `installation-lost:${String(installation.id)}`,
        `the App's installation on ${who} refused it (${String(status(error))}), so its repositories are left as they are`,
      );
    }
  }
  const synced = new Set(listed.keys());
  const next: Record<string, Kept> = {};
  for (const [node, { repository, installation }] of listed) {
    next[node] = { ...kept[node], installation, name: repository.full_name };
  }
  for (const [node, repository] of Object.entries(kept)) {
    if (listed.has(node)) continue;
    if (answered.has(repository.installation)) {
      await takeOut(context, node, repository.name);
      continue;
    }
    next[node] = repository;
    if (!answered.has(repository.installation)) {
      log.condition(
        `repository-lost:${node}`,
        `${repository.name} can no longer be read through the App, so its rows are left as they are`,
      );
    }
  }

  const sync = async (node: string, check: boolean): Promise<void> => {
    const at = listed.get(node);
    const repository = next[node];
    const octokit = at === undefined ? undefined : clients.get(at.installation);
    if (octokit === undefined || repository === undefined) return;
    // GitHub answers each issue of such a repository 410, as if deleted.
    if (at?.repository.has_issues === false) {
      log.condition(
        `issues-off:${node}`,
        `${repository.name} has its issues turned off on GitHub, so its rows are left as they are`,
      );
      return;
    }
    try {
      next[node] = await syncRepository(context, octokit, node, repository, {
        synced,
        check,
      });
    } catch (error) {
      if (!lostAccess(error)) throw error;
      log.condition(
        `repository-unreadable:${node}`,
        `${repository.name} is listed for the App but answered ${String(status(error))}, so its rows are left as they are`,
      );
    }
  };

  await upsert(
    repositoryType,
    [...listed.values()].map(({ repository }) => repositoryEntry(repository)),
  );
  const now = Date.now();
  for (const node of listed.keys()) {
    const checked = next[node]?.checked;
    await sync(
      node,
      checked === undefined || now - Date.parse(checked) >= checkEvery,
    );
  }
  state.set("repositories", next);
}

/** A repository taken out of the App's installation: its rows archived,
 *  back again if it is added again. */
async function takeOut(context: Context, node: string, name: string) {
  const { linked, archive, log } = context;
  const under = { type: repositoryType, id: node };
  const links = (rows: Item[]): string[] =>
    rows.flatMap((row) => linkOf(row) ?? []);
  await archive(
    commentType,
    links(await linked(commentType, inRepository, under)),
  );
  await archive(issueType, links(await linked(issueType, inRepository, under)));
  await archive(repositoryType, [node]);
  log.info(
    `${name} was taken out of the App's installation, and its rows archived`,
  );
}

/**
 * One repository: its issues listed whole, each page asked with its ETag
 * so an unchanged one costs nothing; the comments changed since the last
 * run; and the relations of what changed. A check asks GitHub about each
 * row it no longer lists.
 */
async function syncRepository(
  context: Context,
  octokit: Client,
  node: string,
  repository: Kept,
  options: { synced: ReadonlySet<string>; check: boolean },
): Promise<Kept> {
  const { upsert } = context;
  const [owner = "", name = ""] = repository.name.split("/");
  const started = new Date();
  const windowStart = day(
    new Date(started.getTime() - windowDays * 86_400_000),
  );
  const route = "GET /repos/{owner}/{repo}/issues";
  const listing = { owner, repo: name, sort: "created", direction: "asc" };
  const isIssue = (issue: RestIssue): boolean =>
    issue.pull_request === undefined;
  const open = await pagesOf<RestIssue>(
    octokit,
    route,
    { ...listing, state: "open" },
    repository.open,
    isIssue,
  );
  const closed = await pagesOf<RestIssue>(
    octokit,
    route,
    { ...listing, state: "closed", since: `${windowStart}T00:00:00Z` },
    repository.closed?.since === windowStart
      ? repository.closed.pages
      : undefined,
    isIssue,
  );
  const listed = [...open.changed, ...closed.changed];
  const scope = new Set([...numbersOf(open.pages), ...numbersOf(closed.pages)]);
  const before = new Set([
    ...numbersOf(repository.open),
    ...numbersOf(repository.closed?.pages),
  ]);
  const byNumber = new Map(listed.map((issue) => [issue.number, issue]));
  const at = { node, name: repository.name };

  // Relations, which move no issue's time, asked of every issue that
  // changed, since REST names no parent to an App; and the issues an issue
  // blocks, whose own list of blockers changed with it.
  const relations = await relationsOf(
    octokit,
    listed.map((issue) => issue.node_id),
  );
  const listedNodes = new Set(listed.map((issue) => issue.node_id));
  const around = [...relations.values()].flatMap((one) => [
    ...one.blocking,
    // A child names its parent; it may sit on a page that did not change.
    ...one.children,
    ...(one.parent !== null && options.synced.has(one.parent.repository.id)
      ? [one.parent.id]
      : []),
    ...one.blockedBy
      .filter((other) => options.synced.has(other.repository.id))
      .map((other) => other.id),
  ]);
  const beside = await issuesByNode(
    octokit,
    around.filter((id) => !listedNodes.has(id)),
  );
  await upsert(issueType, [
    ...listed.flatMap((issue) => {
      const found = relations.get(issue.node_id);
      // Gone between the listing and the question: the next run has it.
      if (found === undefined) return [];
      return [issueEntry(issueOfRest(issue, at), found, options.synced)];
    }),
    ...beside
      .filter(({ issue }) => options.synced.has(issue.repository.node))
      .map(({ issue, relations: known }) =>
        issueEntry(issue, known, options.synced),
      ),
  ]);

  // Comments: on the first sync the repository's whole, then those changed
  // since, and all of each issue new to the sync.
  const comments = new Map<string, RestComment>();
  let since = repository.comments?.since ?? started.toISOString();
  let etag = repository.comments?.etag;
  if (repository.comments === undefined) {
    for (const comment of (await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/comments",
      { owner, repo: name, per_page: 100 },
    )) as RestComment[]) {
      comments.set(comment.node_id, comment);
    }
  } else {
    const changed = await changedComments(
      octokit,
      { owner, repo: name },
      repository.comments,
    );
    if (changed !== undefined) {
      for (const comment of changed.comments) {
        comments.set(comment.node_id, comment);
        if (comment.updated_at > since) since = comment.updated_at;
      }
      etag = changed.etag;
    }
    for (const number of scope) {
      if (before.has(number)) continue;
      if ((byNumber.get(number)?.comments ?? 0) === 0) continue;
      for (const comment of (await octokit.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo: name, issue_number: number, per_page: 100 },
      )) as RestComment[]) {
        comments.set(comment.node_id, comment);
      }
    }
  }
  await writeComments(
    context,
    octokit,
    { node, owner, name, scope },
    [...comments.values()],
    new Map(listed.map((issue) => [issue.number, issue.node_id])),
  );

  const kept: Kept = {
    installation: repository.installation,
    name: repository.name,
    open: open.pages,
    closed: { since: windowStart, pages: closed.pages },
    comments: { since, ...(etag !== undefined && { etag }) },
    ...(repository.checked !== undefined && { checked: repository.checked }),
  };
  // A deletion or a move changes the listing, so only then is it asked.
  if (options.check || open.fresh || closed.fresh) {
    await checkIssues(context, octokit, {
      node,
      owner,
      name,
      scope,
      windowStart,
    });
  }
  if (!options.check) return kept;
  await checkComments(context, octokit, { node, owner, name, scope });
  return { ...kept, checked: started.toISOString() };
}

/** Comments on issues in the sync, each in its issue's thread. */
async function writeComments(
  context: Context,
  octokit: Client,
  where: {
    node: string;
    owner: string;
    name: string;
    scope: ReadonlySet<number>;
  },
  comments: readonly RestComment[],
  nodes: Map<number, string>,
): Promise<void> {
  const inScope = comments.filter((comment) =>
    where.scope.has(numberOf(comment)),
  );
  const missing = inScope.map(numberOf).filter((number) => !nodes.has(number));
  for (const [number, id] of await nodesOfNumbers(
    octokit,
    where.owner,
    where.name,
    missing,
  )) {
    nodes.set(number, id);
  }
  await context.upsert(
    commentType,
    inScope.flatMap((comment) => {
      const issue = nodes.get(numberOf(comment));
      return issue === undefined
        ? []
        : [
            commentEntry({
              node: comment.node_id,
              body: comment.body ?? "",
              url: comment.html_url,
              createdAt: comment.created_at,
              updatedAt: comment.updated_at,
              author: comment.user?.login ?? null,
              issue,
              repository: {
                node: where.node,
                name: `${where.owner}/${where.name}`,
              },
            }),
          ];
    }),
  );
}

function numberOf(comment: RestComment): number {
  return Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1] ?? Number.NaN);
}

/** The comments changed since the last run, `undefined` where none did. */
async function changedComments(
  octokit: Client,
  where: { owner: string; repo: string },
  last: { since: string; etag?: string },
): Promise<{ comments: RestComment[]; etag: string | undefined } | undefined> {
  const route = "GET /repos/{owner}/{repo}/issues/comments";
  const parameters = {
    ...where,
    sort: "updated" as const,
    direction: "asc" as const,
    since: new Date(Date.parse(last.since) - overlap).toISOString(),
    per_page: 100,
  };
  const first = await unlessUnchanged(octokit, route, parameters, last.etag);
  if (first === undefined) return undefined;
  const comments = [...(first.data as RestComment[])];
  for (let page = 2; comments.length === (page - 1) * 100; page += 1) {
    const more = await octokit.request(route, { ...parameters, page });
    comments.push(...(more.data as RestComment[]));
  }
  return { comments, etag: first.etag };
}

/** What a run for deliveries may archive: only what they named. */
function archivable(context: Context, type: string, links: string[]): string[] {
  const named = context.hints?.get(type);
  return named === undefined ? links : links.filter((link) => named.has(link));
}

/**
 * The issues Marfa holds under the repository that GitHub no longer lists,
 * each asked of GitHub and archived only where it says the issue was
 * deleted or moved away. A closed issue quiet since before the window is
 * outside it, not gone.
 */
async function checkIssues(
  context: Context,
  octokit: Client,
  where: {
    node: string;
    owner: string;
    name: string;
    scope: ReadonlySet<number>;
    windowStart: string;
  },
): Promise<void> {
  const { linked, archive, log } = context;
  const under = { type: repositoryType, id: where.node };
  const gone: string[] = [];
  for (const row of await linked(issueType, inRepository, under)) {
    const number = row.properties["number"];
    const link = linkOf(row);
    if (typeof number !== "number" || link === undefined) continue;
    if (where.scope.has(number)) continue;
    const updated = row.properties["github_updated_at"];
    const quiet = typeof updated === "string" ? updated : "";
    const closed = ["completed", "canceled"].includes(
      String(row.properties["status"]),
    );
    if (closed && quiet < where.windowStart) continue;
    const said = await askIssue(octokit, where.owner, where.name, number);
    if (said === "deleted") gone.push(link);
    else if (said === "moved") {
      gone.push(link);
      log.condition(
        `issue-moved:${link}`,
        `${where.owner}/${where.name}#${String(number)} was moved to another repository, so its row here is archived`,
      );
    } else if (said === "missing") {
      log.condition(
        `issue-missing:${link}`,
        `${where.owner}/${where.name}#${String(number)} answered 404 though its repository reads, so its row is left as it is`,
      );
    }
  }
  await archive(issueType, archivable(context, issueType, gone));
}

/** The comments Marfa holds under the repository that GitHub no longer
 *  lists, archived where GitHub, still reading the repository, says so;
 *  and those in the sync Marfa lacks, which a run missed, written. */
async function checkComments(
  context: Context,
  octokit: Client,
  where: {
    node: string;
    owner: string;
    name: string;
    scope: ReadonlySet<number>;
  },
): Promise<void> {
  const { linked, archive } = context;
  const under = { type: repositoryType, id: where.node };
  const rows = await linked(commentType, inRepository, under);
  const all = (await octokit.paginate(
    "GET /repos/{owner}/{repo}/issues/comments",
    { owner: where.owner, repo: where.name, per_page: 100 },
  )) as RestComment[];
  const held = new Set(rows.flatMap((row) => linkOf(row) ?? []));
  await writeComments(
    context,
    octokit,
    where,
    all.filter((comment) => !held.has(comment.node_id)),
    new Map(),
  );
  const listed = new Set(all.map((comment) => comment.node_id));
  const absent = rows.flatMap((row) => {
    const link = linkOf(row);
    return link === undefined || listed.has(link) ? [] : [link];
  });
  const still = new Set(
    (await commentsByNode(octokit, absent)).map((comment) => comment.node),
  );
  await archive(
    commentType,
    archivable(
      context,
      commentType,
      absent.filter((link) => !still.has(link)),
    ),
  );
}

async function askIssue(
  octokit: Client,
  owner: string,
  repo: string,
  number: number,
): Promise<"present" | "deleted" | "moved" | "missing"> {
  try {
    const answer = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner, repo, issue_number: number, request: { redirect: "manual" } },
    );
    // Asked not to follow, a move answers its own status.
    const code: number = answer.status;
    return code >= 300 && code < 400 ? "moved" : "present";
  } catch (error) {
    const code = status(error);
    if (code === 410) return "deleted";
    if (code === 301 || code === 302 || code === 307) return "moved";
    if (code === 404) return "missing";
    throw error;
  }
}
