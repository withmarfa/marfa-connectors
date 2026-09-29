import type { EnvDeclaration, Item, RunContext } from "@withmarfa/connector";
import {
  commentEntry,
  commentType,
  inRepository,
  issueEntry,
  issueOfRest,
  issueType,
  noRelations,
  related,
  repositoryEntry,
  repositoryType,
  webAddress,
  type Comment,
  type Issue,
  type Relations,
  type RestComment,
  type RestIssue,
  type RestRepository,
} from "./entries.js";
import {
  asApp,
  asInstallation,
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

/** Refused for want of access, rather than for a passing reason. */
function lostAccess(error: unknown): boolean {
  const code = status(error);
  if (code === 403) {
    const headers = (
      error as { response?: { headers?: Record<string, unknown> } }
    ).response?.headers;
    if (headers?.["x-ratelimit-remaining"] === "0") return false;
  }
  return code === 401 || code === 403 || code === 404;
}

function keptOf(value: unknown): Record<string, Kept> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, Kept>)
    : {};
}

function numbersOf(pages: readonly Page[] | undefined): number[] {
  return (pages ?? []).flatMap((page) => page.numbers);
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function linkOf(row: Item): string | undefined {
  const value = row.properties["github_id"];
  return typeof value === "string" ? value : undefined;
}

export async function read(context: Context, app: App): Promise<void> {
  const { hints, state, log, secret, signal, upsert } = context;
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
    if (hints === undefined && answered.has(repository.installation)) {
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

  if (hints === undefined) {
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
  } else {
    const named = [...(hints.get(repositoryType) ?? [])].filter((node) =>
      listed.has(node),
    );
    await upsert(
      repositoryType,
      named.flatMap((node) => {
        const at = listed.get(node);
        return at === undefined ? [] : [repositoryEntry(at.repository)];
      }),
    );
    for (const node of named) await sync(node, true);
    await readNamed(context, [...clients.values()], synced);
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

/** What the hints name, fetched by node: each comment's issue beside it. */
async function readNamed(
  context: Context,
  clients: readonly Client[],
  synced: ReadonlySet<string>,
): Promise<void> {
  const { hints, upsert } = context;
  const commentIds = [...(hints?.get(commentType) ?? [])];
  const issueIds = new Set(hints?.get(issueType) ?? []);
  const comments = new Map<string, Comment>();
  const issues = new Map<string, { issue: Issue; relations: Relations }>();
  for (const octokit of clients) {
    for (const comment of await commentsByNode(octokit, commentIds)) {
      if (!synced.has(comment.repository)) continue;
      comments.set(comment.node, comment);
      issueIds.add(comment.issue);
    }
    for (const found of await issuesByNode(octokit, [...issueIds])) {
      if (synced.has(found.issue.repository.node)) {
        issues.set(found.issue.node, found);
      }
    }
  }
  await upsert(
    issueType,
    [...issues.values()].map(({ issue, relations }) =>
      issueEntry(issue, relations, synced),
    ),
  );
  await upsert(commentType, [...comments.values()].map(commentEntry));
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
  const { upsert, hints } = context;
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

  // Relations, which move no issue's time: those it names, and the issues
  // an issue blocks, whose own list of blockers changed with it.
  const relations = await relationsOf(
    octokit,
    listed.filter(related).map((issue) => issue.node_id),
  );
  const listedNodes = new Set(listed.map((issue) => issue.node_id));
  const around = [...relations.values()].flatMap((one) => [
    ...one.blocking,
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
      if (related(issue) && found === undefined) return [];
      const known = found ?? noRelations;
      return [
        issueEntry(
          issueOfRest(issue, at),
          {
            ...known,
            parentUrl:
              known.parent === null && issue.parent_issue_url
                ? webAddress(issue.parent_issue_url)
                : null,
          },
          options.synced,
        ),
      ];
    }),
    ...beside
      .filter(({ issue }) => options.synced.has(issue.repository.node))
      .map(({ issue, relations: known }) =>
        issueEntry(issue, known, options.synced),
      ),
  ]);

  // Comments: those changed since the last run, and all of each issue new
  // to the sync, as on the first.
  const comments = new Map<string, RestComment>();
  let since = repository.comments?.since ?? started.toISOString();
  let etag = repository.comments?.etag;
  if (repository.comments !== undefined) {
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
  }
  for (const number of scope) {
    if (before.has(number) && repository.comments !== undefined) continue;
    if ((byNumber.get(number)?.comments ?? 0) === 0) continue;
    const all = (await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo: name, issue_number: number, per_page: 100 },
    )) as RestComment[];
    for (const comment of all) comments.set(comment.node_id, comment);
  }
  const numberOf = (comment: RestComment): number =>
    Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1] ?? Number.NaN);
  const inScope = [...comments.values()].filter((comment) =>
    scope.has(numberOf(comment)),
  );
  const nodes = new Map(listed.map((issue) => [issue.number, issue.node_id]));
  const missing = inScope.map(numberOf).filter((number) => !nodes.has(number));
  for (const [number, id] of await nodesOfNumbers(
    octokit,
    owner,
    name,
    missing,
  )) {
    nodes.set(number, id);
  }
  await upsert(
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
              repository: node,
            }),
          ];
    }),
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
  await checkComments(context, octokit, { node, owner, name });
  return hints === undefined
    ? { ...kept, checked: started.toISOString() }
    : kept;
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
    since: last.since,
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
        `${where.owner}/${where.name}#${String(number)} was moved to another repository, so its row is archived; it arrives there as a new one`,
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
 *  lists, archived where GitHub, still reading the repository, says so. */
async function checkComments(
  context: Context,
  octokit: Client,
  where: { node: string; owner: string; name: string },
): Promise<void> {
  const { linked, archive } = context;
  const under = { type: repositoryType, id: where.node };
  const rows = await linked(commentType, inRepository, under);
  if (rows.length === 0) return;
  const listed = new Set(
    (
      (await octokit.paginate("GET /repos/{owner}/{repo}/issues/comments", {
        owner: where.owner,
        repo: where.name,
        per_page: 100,
      })) as RestComment[]
    ).map((comment) => comment.node_id),
  );
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
