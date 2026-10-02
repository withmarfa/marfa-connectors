import type { EnvDeclaration, Item, RunContext } from "@withmarfa/connector";
import {
  blockedBy,
  commentEntry,
  commentType,
  inRepository,
  issueEntry,
  issueOfRest,
  issueType,
  repositoryEntry,
  repositoryType,
  subIssueOf,
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
  ClockSkew,
  namedAtMost,
  remaining,
  numbersIn,
  reads,
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
import type { Scope } from "./scope.js";

export const windowDays = 90;

const checkEvery = 24 * 60 * 60 * 1000;

export interface Kept {
  installation: number;
  name: string;
  /** GitHub's repository id, which a token names; absent until a
   *  scheduled run records it. */
  id?: number;
  open?: Page[];
  closed?: { since: string; pages: Page[] };
  /** `full` where the listing's first page was full last time, whose
   *  ETag then cannot say nothing lies past it. */
  comments?: { since: string; etag?: string; full?: boolean };
  checked?: string;
  paused?: boolean;
  /** The repository's visibility as its rows last said it. */
  private?: boolean;
}

type Context = RunContext<EnvDeclaration>;

interface Installation {
  id: number;
  suspended_at?: string | null;
  account?: { login?: string } | null;
}

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

const reserve = 500;

type Privacy = ReadonlyMap<string, boolean>;

/** A repository the read did not list is taken as private, so a row never
 *  claims more openness than was seen. */
function privateIn(privacy: Privacy, node: string): boolean {
  return privacy.get(node) ?? true;
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

export async function read(
  context: Context,
  app: App,
  scope: Scope | undefined,
): Promise<void> {
  try {
    await readAll(context, app, scope);
  } catch (error) {
    if (!(error instanceof ClockSkew)) throw error;
    context.log.condition("clock-skew", error.message);
  }
}

async function readAll(
  context: Context,
  app: App,
  scope: Scope | undefined,
): Promise<void> {
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
  const outside = new Map<
    string,
    { repository: RestRepository; installation: number }
  >();
  const seen: string[] = [];
  for (const installation of installations) {
    const who = installation.account?.login ?? String(installation.id);
    if (installation.suspended_at) {
      log.condition(
        `installation-suspended:${String(installation.id)}`,
        `the App's installation on ${who} is suspended, so its repositories are left as they are`,
      );
      continue;
    }
    const lister = asInstallation(
      app,
      installation.id,
      { access: "list" },
      secret,
      signal,
    );
    try {
      const repositories = (await lister.paginate(
        "GET /installation/repositories",
      )) as RestRepository[];
      answered.add(installation.id);
      for (const repository of repositories) {
        seen.push(repository.full_name);
        if (scope !== undefined && !scope.admits(repository.full_name)) {
          outside.set(repository.node_id, {
            repository,
            installation: installation.id,
          });
          continue;
        }
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
  if (scope !== undefined && answered.size === installations.length) {
    for (const one of scope.unmatched(seen)) {
      log.condition(
        `repositories-unmatched:${one}`,
        `GITHUB_REPOSITORIES names ${one}, which no installation of the App shows`,
      );
    }
  }
  const synced = new Set(listed.keys());
  const privacy: Privacy = new Map(
    [...listed].map(([node, { repository }]) => [node, repository.private]),
  );
  const paused = new Set(
    [...outside.keys()].filter((node) => kept[node] !== undefined),
  );
  // A paused repository is reached for reading, so relations to its
  // issues, which its rows still hold, stay.
  const reached = new Map<number, number[]>();
  for (const { repository, installation } of [
    ...listed.values(),
    ...[...paused].flatMap((node) => outside.get(node) ?? []),
  ]) {
    reached.set(installation, [
      ...(reached.get(installation) ?? []),
      repository.id,
    ]);
  }
  for (const [installation, repositoryIds] of reached) {
    if (repositoryIds.length > namedAtMost) {
      log.condition(
        `token-unnarrowed:${String(installation)}`,
        `GitHub limits a token to ${String(namedAtMost)} named repositories, so the ${String(repositoryIds.length)} synced or paused under installation ${String(installation)} are read with a token that reaches all of its repositories`,
      );
    }
    clients.set(
      installation,
      asInstallation(
        app,
        installation,
        { access: "read", repositoryIds },
        secret,
        signal,
      ),
    );
  }
  // A run for deliveries leaves every cursor as it was: the rest went unread.
  if (context.hints !== undefined) {
    await readNamed(context, listed, clients, paused, privacy);
    return;
  }
  const next: Record<string, Kept> = {};
  for (const [node, { repository, installation }] of listed) {
    next[node] = {
      ...kept[node],
      installation,
      name: repository.full_name,
      id: repository.id,
    };
    Reflect.deleteProperty(next[node], "paused");
  }
  for (const [node, repository] of Object.entries(kept)) {
    if (listed.has(node)) continue;
    const left = outside.get(node)?.repository;
    if (left !== undefined) {
      if (repository.paused !== true) {
        log.info(
          `${left.full_name} is left out by GITHUB_REPOSITORIES, so its rows are left as they are, bar the private marker, which follows its visibility, and changes made to them wait until it is named again`,
        );
      }
      // Under the name its rows hold, which a rename meanwhile does not change.
      next[node] = await marked(
        context,
        node,
        { ...repository, paused: true },
        left.private,
      );
      continue;
    }
    if (answered.has(repository.installation)) {
      await takeOut(context, node, repository.name);
      continue;
    }
    // Its visibility is no longer known, so its rows say what is safe.
    next[node] = await marked(context, node, repository, true);
    if (!answered.has(repository.installation)) {
      log.condition(
        `repository-lost:${node}`,
        `${repository.name} can no longer be read through the App, so its rows are left as they are, bar the private marker, which is set to true since its visibility is not known`,
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
        `${repository.name} has its issues turned off on GitHub, so its rows are left as they are, bar the private marker, which follows its visibility`,
      );
      next[node] = await marked(
        context,
        node,
        repository,
        privateIn(privacy, node),
      );
      return;
    }
    try {
      next[node] = await syncRepository(context, octokit, node, repository, {
        synced,
        inside: new Set([...synced, ...paused]),
        privacy,
        check,
      });
    } catch (error) {
      if (!lostAccess(error)) throw error;
      log.condition(
        `repository-unreadable:${node}`,
        `${repository.name} is listed for the App but answered ${String(status(error))}, so its rows are left as they are, bar the private marker, which is set to true since its visibility is not known`,
      );
      next[node] = await marked(context, node, repository, true);
    }
  };

  await upsert(
    repositoryType,
    [...listed.values()].map(({ repository }) => repositoryEntry(repository)),
  );
  const now = Date.now();
  const waiting: string[] = [];
  for (const [node, at] of listed) {
    const octokit = clients.get(at.installation);
    const left = octokit === undefined ? undefined : remaining(octokit);
    if (left !== undefined && left < reserve) {
      waiting.push(at.repository.full_name);
      continue;
    }
    const checked = next[node]?.checked;
    await sync(
      node,
      checked === undefined || now - Date.parse(checked) >= checkEvery,
    );
  }
  if (waiting.length > 0) {
    log.condition(
      "rate-limit-reserve",
      `GitHub's hourly limit ran low, so ${waiting.join(", ")} ${waiting.length === 1 ? "waits" : "wait"} for the next run`,
    );
  }
  state.set("repositories", next);
}

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

async function syncRepository(
  context: Context,
  octokit: Client,
  node: string,
  repository: Kept,
  options: {
    synced: ReadonlySet<string>;
    inside: ReadonlySet<string>;
    privacy: Privacy;
    check: boolean;
  },
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
  const hidden = privateIn(options.privacy, node);

  // Relations, which move no issue's time, asked of every issue that
  // changed, since REST names no parent to an App; and the issues an issue
  // blocks, whose own list of blockers changed with it.
  const relations = await relationsOf(
    octokit,
    listed.map((issue) => issue.node_id),
  );
  const listedNodes = new Set(listed.map((issue) => issue.node_id));
  // A child detached, or an issue no longer blocked, names nothing on
  // GitHub's side of what changed: ask about those Marfa holds under it.
  const held: string[] = [];
  if (repository.comments !== undefined) {
    for (const issue of listed) {
      const under = { type: issueType, id: issue.node_id };
      for (const connection of [subIssueOf, blockedBy]) {
        for (const row of await context.linked(issueType, connection, under)) {
          const link = linkOf(row);
          if (link !== undefined) held.push(link);
        }
      }
    }
  }
  const around = [
    ...held,
    ...[...relations.values()].flatMap((one) => [
      ...one.blocking,
      ...one.children,
      ...(one.parent !== null && options.synced.has(one.parent.repository.id)
        ? [one.parent.id]
        : []),
      ...one.blockedBy
        .filter((other) => options.synced.has(other.repository.id))
        .map((other) => other.id),
    ]),
  ];
  const beside = await issuesByNode(
    octokit,
    around.filter((id) => !listedNodes.has(id)),
  );
  await upsert(issueType, [
    ...listed.flatMap((issue) => {
      const found = relations.get(issue.node_id);
      if (found === undefined) return [];
      return [
        issueEntry(issueOfRest(issue, at), found, options.inside, hidden),
      ];
    }),
    ...beside
      .filter(({ issue }) => options.synced.has(issue.repository.node))
      .map(({ issue, relations: known }) =>
        issueEntry(
          issue,
          known,
          options.inside,
          privateIn(options.privacy, issue.repository.node),
        ),
      ),
  ]);

  const comments = new Map<string, RestComment>();
  let since = repository.comments?.since ?? started.toISOString();
  let etag = repository.comments?.etag;
  let full = repository.comments?.full ?? false;
  if (repository.comments === undefined) {
    let began: string | undefined;
    for (const comment of await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/comments",
      { owner, repo: name, per_page: 100 },
      (response) => {
        began ??= response.headers.date;
        return response.data as RestComment[];
      },
    )) {
      comments.set(comment.node_id, comment);
    }
    // GitHub's own clock, which this machine's may run ahead of.
    const at = began === undefined ? Number.NaN : Date.parse(began);
    if (!Number.isNaN(at)) since = new Date(at).toISOString();
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
      full = changed.full;
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
  const where = { node, owner, name, scope, hidden };
  const wrote = await writeComments(
    context,
    octokit,
    where,
    [...comments.values()],
    new Map(listed.map((issue) => [issue.number, issue.node_id])),
  );
  if (repository.comments !== undefined && repository.private !== hidden) {
    await markRows(context, node, hidden);
  }

  const kept: Kept = {
    installation: repository.installation,
    name: repository.name,
    ...(repository.id !== undefined && { id: repository.id }),
    open: open.pages,
    closed: { since: windowStart, pages: closed.pages },
    comments: {
      since,
      ...(etag !== undefined && { etag }),
      ...(full && { full }),
    },
    ...(repository.checked !== undefined && { checked: repository.checked }),
    private: hidden,
  };
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
  await checkComments(context, octokit, where, wrote);
  return { ...kept, checked: started.toISOString() };
}

async function writeComments(
  context: Context,
  octokit: Client,
  where: {
    node: string;
    owner: string;
    name: string;
    scope: ReadonlySet<number>;
    hidden: boolean;
  },
  comments: readonly RestComment[],
  nodes: Map<number, string>,
): Promise<Set<string>> {
  const outside = comments.filter(
    (comment) => !where.scope.has(numberOf(comment)),
  );
  const held =
    outside.length === 0
      ? new Set<string>()
      : new Set(
          (
            await context.linked(commentType, inRepository, {
              type: repositoryType,
              id: where.node,
            })
          ).flatMap((row) => linkOf(row) ?? []),
        );
  const inScope = comments.filter(
    (comment) =>
      where.scope.has(numberOf(comment)) || held.has(comment.node_id),
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
  const entries = inScope.flatMap((comment) => {
    const issue = nodes.get(numberOf(comment));
    return issue === undefined
      ? []
      : [
          commentEntry(
            {
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
            },
            where.hidden,
          ),
        ];
  });
  await context.upsert(commentType, entries);
  return new Set(entries.map((entry) => entry.source_id));
}

async function marked(
  context: Context,
  node: string,
  repository: Kept,
  hidden: boolean,
): Promise<Kept> {
  if (repository.private !== hidden) await markRows(context, node, hidden);
  return { ...repository, private: hidden };
}

/** Rows read before the field existed, or before the repository changed
 *  its visibility, are not listed again, so each one held is told. */
async function markRows(
  context: Context,
  node: string,
  hidden: boolean,
): Promise<void> {
  const under = { type: repositoryType, id: node };
  for (const type of [issueType, commentType]) {
    const links = (await context.linked(type, inRepository, under)).flatMap(
      (row) => linkOf(row) ?? [],
    );
    await context.derive(type, links, { private: hidden });
  }
}

function numberOf(comment: RestComment): number {
  return Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1] ?? Number.NaN);
}

async function changedComments(
  octokit: Client,
  where: { owner: string; repo: string },
  last: { since: string; etag?: string; full?: boolean },
): Promise<
  | { comments: RestComment[]; etag: string | undefined; full: boolean }
  | undefined
> {
  const route = "GET /repos/{owner}/{repo}/issues/comments";
  const parameters = {
    ...where,
    sort: "updated" as const,
    direction: "asc" as const,
    since: new Date(Date.parse(last.since) - overlap).toISOString(),
    per_page: 100,
  };
  const first = await unlessUnchanged(
    octokit,
    route,
    parameters,
    last.full === true ? undefined : last.etag,
  );
  if (first === undefined) return undefined;
  const comments = [...(first.data as RestComment[])];
  const full = comments.length === 100;
  for (let page = 2; comments.length === (page - 1) * 100; page += 1) {
    const more = await octokit.request(route, { ...parameters, page });
    comments.push(...(more.data as RestComment[]));
  }
  return { comments, etag: first.etag, full };
}

// A closed issue quiet since before the window is outside it, not gone.
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
  const under = { type: repositoryType, id: where.node };
  const unlisted = (
    await context.linked(issueType, inRepository, under)
  ).filter((row) => {
    const number = row.properties["number"];
    if (typeof number !== "number" || where.scope.has(number)) return false;
    const updated = row.properties["github_updated_at"];
    const quiet = typeof updated === "string" ? updated : "";
    const closed = ["completed", "canceled"].includes(
      String(row.properties["status"]),
    );
    return !closed || quiet >= where.windowStart;
  });
  await archiveGone(context, octokit, where, unlisted);
}

async function archiveGone(
  context: Context,
  octokit: Client,
  where: { owner: string; name: string },
  rows: readonly Item[],
): Promise<void> {
  const { log } = context;
  const gone: string[] = [];
  for (const row of rows) {
    const number = row.properties["number"];
    const link = linkOf(row);
    if (typeof number !== "number" || link === undefined) continue;
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
  await context.archive(issueType, gone);
}

async function checkComments(
  context: Context,
  octokit: Client,
  where: {
    node: string;
    owner: string;
    name: string;
    scope: ReadonlySet<number>;
    hidden: boolean;
  },
  written: ReadonlySet<string>,
): Promise<void> {
  const { linked, archive } = context;
  const under = { type: repositoryType, id: where.node };
  const rows = await linked(commentType, inRepository, under);
  const all = (await octokit.paginate(
    "GET /repos/{owner}/{repo}/issues/comments",
    { owner: where.owner, repo: where.name, per_page: 100 },
  )) as RestComment[];
  // Rows this run wrote have no connection to the repository until it ends.
  const held = new Set([
    ...rows.flatMap((row) => linkOf(row) ?? []),
    ...written,
  ]);
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
    absent.filter((link) => !still.has(link)),
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

async function readNamed(
  context: Context,
  listed: ReadonlyMap<
    string,
    { repository: RestRepository; installation: number }
  >,
  every: ReadonlyMap<number, Client>,
  paused: ReadonlySet<string>,
  privacy: Privacy,
): Promise<void> {
  const { hints, upsert, log } = context;
  const clients = new Map(
    [...every].filter(
      ([, octokit]) => (remaining(octokit) ?? reserve) >= reserve,
    ),
  );
  if (clients.size < every.size) {
    log.condition(
      "rate-limit-reserve",
      "GitHub's hourly limit ran low, so what deliveries named in some repositories waits for the next scheduled run",
    );
  }
  const synced = new Set(
    [...listed].flatMap(([node, { installation }]) =>
      clients.has(installation) ? [node] : [],
    ),
  );
  const issues = new Map<string, { issue: Issue; relations: Relations }>();
  const comments = new Map<string, Comment>();
  // What GitHub shows anywhere is not gone, though outside the sync.
  const shown = new Set<string>();
  const namedComments = [...(hints?.get(commentType) ?? [])];
  const namedIssues = new Set(hints?.get(issueType) ?? []);
  for (const octokit of clients.values()) {
    const wanted = namedComments.filter((id) => !comments.has(id));
    for (const comment of await commentsByNode(octokit, wanted)) {
      shown.add(comment.node);
      if (!synced.has(comment.repository.node)) continue;
      comments.set(comment.node, comment);
      namedIssues.add(comment.issue);
    }
  }
  const ask = async (ids: readonly string[]): Promise<void> => {
    for (const octokit of clients.values()) {
      const wanted = ids.filter((id) => !issues.has(id));
      for (const found of await issuesByNode(octokit, wanted)) {
        shown.add(found.issue.node);
        if (synced.has(found.issue.repository.node)) {
          issues.set(found.issue.node, found);
        }
      }
    }
  };
  await ask([...namedIssues]);
  await ask(
    [...issues.values()]
      .flatMap(({ relations }) => [
        ...(relations.parent === null ? [] : [relations.parent]),
        ...relations.blockedBy,
      ])
      .filter((one) => synced.has(one.repository.id))
      .map((one) => one.id),
  );
  const touched = new Set([
    ...[...issues.values()].map(({ issue }) => issue.repository.node),
    ...[...comments.values()].map((comment) => comment.repository.node),
  ]);
  await upsert(
    repositoryType,
    [...touched].flatMap((node) => {
      const at = listed.get(node);
      return at === undefined ? [] : [repositoryEntry(at.repository)];
    }),
  );
  await upsert(
    issueType,
    [...issues.values()].map(({ issue, relations }) =>
      issueEntry(
        issue,
        relations,
        new Set([...synced, ...paused]),
        privateIn(privacy, issue.repository.node),
      ),
    ),
  );
  await upsert(
    commentType,
    [...comments.values()].map((comment) =>
      commentEntry(comment, privateIn(privacy, comment.repository.node)),
    ),
  );

  const unseenIssues = new Set([...namedIssues].filter((id) => !shown.has(id)));
  const unseenComments = new Set(namedComments.filter((id) => !shown.has(id)));
  for (const [node, { repository, installation }] of listed) {
    if (unseenIssues.size === 0 && unseenComments.size === 0) return;
    const octokit = clients.get(installation);
    if (octokit === undefined || repository.has_issues === false) continue;
    const under = { type: repositoryType, id: node };
    const held = (rows: Item[], unseen: Set<string>): Item[] =>
      rows.filter((row) => {
        const link = linkOf(row);
        return link !== undefined && unseen.delete(link);
      });
    const issueRows =
      unseenIssues.size === 0
        ? []
        : held(
            await context.linked(issueType, inRepository, under),
            unseenIssues,
          );
    const commentRows =
      unseenComments.size === 0
        ? []
        : held(
            await context.linked(commentType, inRepository, under),
            unseenComments,
          );
    if (issueRows.length === 0 && commentRows.length === 0) continue;
    const [owner = "", name = ""] = repository.full_name.split("/");
    if (!(await reads(octokit, owner, name))) {
      log.condition(
        `repository-unreadable:${node}`,
        `${repository.full_name} is listed for the App but does not read, so its rows are left as they are`,
      );
      continue;
    }
    await archiveGone(context, octokit, { owner, name }, issueRows);
    await context.archive(
      commentType,
      commentRows.flatMap((row) => linkOf(row) ?? []),
    );
  }
}
