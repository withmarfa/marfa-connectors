import type {
  EnvDeclaration,
  Item,
  RunContext,
  ScopedRunContext,
} from "@withmarfa/connector";
import {
  blockedBy,
  relatesTo,
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
  asPersonalToken,
  ClockSkew,
  RateLimitWaiting,
  PermissionRequired,
  namedAtMost,
  rateLimited,
  numbersIn,
  reads,
  pagesOf,
  status,
  unlessUnchanged,
  type App,
  type Personal,
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
import { fileNotes, preserveFiles, markFilesPrivate } from "./files.js";
import { everywhere, takeUnsettled } from "./unsettled.js";

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

type RootContext = RunContext<EnvDeclaration>;
type Context = Omit<RootContext, "state" | "forScope">;

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

const readPrefixes = [
  "installation-suspended:",
  "installation-lost:",
  "repositories-unmatched:",
  "token-unnarrowed:",
  "repository-lost:",
  "issues-off:",
  "repository-unreadable:",
  "repository-progress:",
  "unsettled:",
  "issue-missing:",
  "issue-moved:",
  "github-files:",
];

class Coverage {
  readonly keys = new Set(["unsettled", "rate-limit-reserve", "clock-skew"]);
  readonly prefixes = new Set(readPrefixes);

  readonly exceptKeys = new Set<string>();

  reached(...keys: string[]): void {
    for (const key of keys) {
      this.keys.delete(key);
      this.exceptKeys.add(key);
    }
  }

  retain(context: Context): void {
    // Saved progress can be absent even when a condition stands. Keep unknown
    // identities conservatively; exempt only checks this read actually reached.
    // Issue keys do not carry a repository and current edges cannot identify
    // every old condition, so unobserved issue evidence stays conservative.
    context.log.unreached({
      keys: [...this.keys],
      prefixes: [...this.prefixes],
      exceptKeys: [...this.exceptKeys],
    });
  }
}

export async function read(
  context: RootContext,
  app: App | Personal,
  scope: Scope | undefined,
): Promise<void> {
  const coverage = new Coverage();
  try {
    await readAll(context, app, scope, coverage);
  } catch (error) {
    if ("token" in app && status(error) === 401)
      throw new Error(
        "GitHub rejected GITHUB_PERSONAL_TOKEN (401); existing rows and progress are kept",
        { cause: error },
      );
    if (rateLimited(error)) {
      context.log.condition(
        "rate-limit-reserve",
        "GitHub is rate limited, so unfinished reads wait for the next run",
      );
      if (context.hints !== undefined) throw error;
      return;
    }
    if (!(error instanceof ClockSkew)) throw error;
    context.log.condition("clock-skew", error.message);
    if (context.hints !== undefined) throw error;
  } finally {
    coverage.retain(context);
  }
}

async function readAll(
  context: RootContext,
  app: App | Personal,
  scope: Scope | undefined,
  coverage: Coverage,
): Promise<void> {
  const { state, log, secret, signal } = context;
  const unsettled = takeUnsettled(state);
  if (unsettled.has(everywhere)) {
    log.condition(
      "unsettled",
      "a create GitHub may have made is not found yet, so nothing is read from GitHub this run",
    );
    return;
  }
  coverage.reached("unsettled");
  const kept = keptOf(state.get("repositories"));
  const personal =
    "token" in app
      ? asPersonalToken(app.token, app.base, secret, signal)
      : undefined;
  // Zero groups the personal token's repositories in the shared read plan;
  // it is never sent to GitHub as an installation id.
  const installations: Installation[] =
    "token" in app
      ? [{ id: 0, account: { login: "the personal token" } }]
      : await asApp(app, signal).paginate("GET /app/installations");
  coverage.reached("clock-skew");
  const clients = new Map<number, Client>();
  const listed = new Map<
    string,
    { repository: RestRepository; installation: number }
  >();
  const answered = new Set<number>();
  const deferred = new Set<number>();
  const waiting: string[] = [];
  const outside = new Map<
    string,
    { repository: RestRepository; installation: number }
  >();
  const seen: string[] = [];
  for (const installation of installations) {
    coverage.reached(`installation-suspended:${String(installation.id)}`);
    const who = installation.account?.login ?? String(installation.id);
    if (installation.suspended_at) {
      log.condition(
        `installation-suspended:${String(installation.id)}`,
        `the App's installation on ${who} is suspended, so its repositories are left as they are`,
      );
      continue;
    }
    const lister =
      personal ??
      asInstallation(
        app as App,
        installation.id,
        { access: "list" },
        secret,
        signal,
      );
    try {
      const repositories = (
        personal === undefined
          ? await lister.paginate("GET /installation/repositories")
          : await lister.paginate("GET /user/repos", {
              affiliation: "owner,collaborator,organization_member",
              per_page: 100,
            })
      ) as RestRepository[];
      coverage.reached(`installation-lost:${String(installation.id)}`);
      answered.add(installation.id);
      for (const [node, old] of Object.entries(kept)) {
        if (old.installation === installation.id)
          coverage.reached(`repository-lost:${node}`);
      }
      for (const repository of repositories) {
        coverage.reached(`repository-lost:${repository.node_id}`);
        const assessed =
          kept[repository.node_id] !== undefined ||
          scope === undefined ||
          scope.admits(repository.full_name);
        if (assessed) coverage.reached(`issues-off:${repository.node_id}`);
        if (repository.has_issues === false && assessed) {
          log.condition(
            `issues-off:${repository.node_id}`,
            `${repository.full_name} has its issues turned off on GitHub, so its rows are left as they are, bar the private marker, which follows its visibility`,
          );
        }
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
      if (personal !== undefined && !rateLimited(error)) throw error;
      if (rateLimited(error)) {
        deferred.add(installation.id);
        waiting.push(`${who}'s repositories`);
        log.condition(
          "rate-limit-reserve",
          `GitHub's hourly limit ran low, so ${waiting.join(", ")} wait for the next run`,
        );
        continue;
      }
      if (!lostAccess(error)) throw error;
      log.condition(
        `installation-lost:${String(installation.id)}`,
        `the App's installation on ${who} refused it (${String(status(error))}), so its repositories are left as they are`,
      );
    }
  }
  if (answered.size === installations.length)
    coverage.prefixes.delete("repositories-unmatched:");
  if (scope !== undefined && answered.size === installations.length) {
    for (const one of scope.unmatched(seen)) {
      log.condition(
        `repositories-unmatched:${one}`,
        `GITHUB_REPOSITORIES names ${one}, which ${personal === undefined ? "no installation of the App shows" : "the personal token cannot see"}`,
      );
    }
  }
  const synced = new Set(listed.keys());
  const retained = new Set(
    Object.entries(kept).flatMap(([node, old]) =>
      deferred.has(old.installation) ? [node] : [],
    ),
  );
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
    coverage.reached(`token-unnarrowed:${String(installation)}`);
    if (personal === undefined && repositoryIds.length > namedAtMost) {
      log.condition(
        `token-unnarrowed:${String(installation)}`,
        `GitHub limits a token to ${String(namedAtMost)} named repositories, so the ${String(repositoryIds.length)} synced or paused under installation ${String(installation)} are read with a token that reaches all of its repositories`,
      );
    }
    clients.set(
      installation,
      personal ??
        asInstallation(
          app as App,
          installation,
          { access: "read", repositoryIds },
          secret,
          signal,
        ),
    );
  }
  // Visibility follows immutable repository identity, including restored files
  // whose repository is no longer in saved progress.
  await markFilesPrivate(
    context,
    new Map(
      [...listed.values(), ...outside.values()].map(({ repository }) => [
        repository.node_id,
        { name: repository.full_name, private: repository.private },
      ]),
    ),
    {
      deferred: new Set(
        Object.entries(kept).flatMap(([node, repository]) =>
          deferred.has(repository.installation) ? [node] : [],
        ),
      ),
    },
  );
  // A run for deliveries leaves every cursor as it was: the rest went unread.
  if (context.hints !== undefined) {
    await readNamed(
      context,
      new Map([...listed].filter(([node]) => !unsettled.has(node))),
      clients,
      new Set([...paused, ...unsettled]),
      privacy,
      new Set(
        installations
          .filter((one) => !answered.has(one.id))
          .map((one) => one.id),
      ),
      new Set(outside.keys()),
      retained,
    );
    for (const [node, at] of listed) {
      const client = clients.get(at.installation);
      if (
        client &&
        !paused.has(node) &&
        !unsettled.has(node) &&
        at.repository.has_issues !== false
      )
        await preserveFiles(
          context,
          client,
          {
            id: node,
            name: at.repository.full_name,
            private: at.repository.private,
          },
          {
            reached: (parent) => {
              coverage.reached(`github-files:${parent}`);
            },
          },
        );
    }
    return;
  }
  const save = async (
    scoped: ScopedRunContext<EnvDeclaration>,
    node: string,
    completed?: Kept,
  ): Promise<void> => {
    coverage.reached(`repository-progress:${node}`);
    const acknowledged = keptOf(scoped.state.get("repositories"));
    if (completed === undefined) Reflect.deleteProperty(acknowledged, node);
    else acknowledged[node] = completed;
    const result = await scoped.state.checkpoint("repositories", acknowledged);
    if (!result.committed)
      log.condition(
        `repository-progress:${node}`,
        `${completed?.name ?? kept[node]?.name ?? node} was read but its progress could not be saved (${result.reason}), so it will be read again`,
      );
  };
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
    if (listed.has(node) || deferred.has(repository.installation)) continue;
    const scoped = context.forScope(`repository:${node}`);
    const left = outside.get(node)?.repository;
    if (left !== undefined) {
      if (repository.paused !== true) {
        log.info(
          `${left.full_name} is left out by GITHUB_REPOSITORIES, so its rows are left as they are, bar the private marker, which follows its visibility, and changes made to them wait until it is named again`,
        );
      }
      // Under the name its rows hold, which a rename meanwhile does not change.
      next[node] = await marked(
        scoped,
        node,
        { ...repository, paused: true, id: left.id },
        left.private,
      );
      await save(scoped, node, next[node]);
      continue;
    }
    if (answered.has(repository.installation)) {
      await takeOut(scoped, node, repository.name, personal !== undefined);
      await save(scoped, node);
      continue;
    }
    // Its visibility is no longer known, so its rows say what is safe.
    next[node] = await marked(scoped, node, repository, true);
    if (!answered.has(repository.installation)) {
      log.condition(
        `repository-lost:${node}`,
        `${repository.name} can no longer be read through the App, so its rows are left as they are, bar the private marker, which is set to true since its visibility is not known`,
      );
    }
    await save(scoped, node, next[node]);
  }

  const permissions: string[] = [];
  const sync = async (node: string, check: boolean): Promise<void> => {
    const at = listed.get(node);
    const repository = next[node];
    const octokit = at === undefined ? undefined : clients.get(at.installation);
    if (at === undefined || octokit === undefined || repository === undefined)
      return;
    const scoped = context.forScope(`repository:${node}`);
    await scoped.upsert(repositoryType, [repositoryEntry(at.repository)]);
    // GitHub answers each issue of such a repository 410, as if deleted.
    if (at.repository.has_issues === false) {
      next[node] = await marked(
        scoped,
        node,
        repository,
        privateIn(privacy, node),
      );
      await save(scoped, node, next[node]);
      return;
    }
    try {
      next[node] = await syncRepository(scoped, octokit, node, repository, {
        synced,
        inside: new Set([...synced, ...paused]),
        retainedRepositories: retained,
        privacy,
        check,
      });
      await preserveFiles(
        scoped,
        octokit,
        { id: node, name: repository.name, private: at.repository.private },
        {
          reached: (parent) => {
            coverage.reached(`github-files:${parent}`);
          },
          checkpoint: async (parent) =>
            (await scoped.state.checkpoint("github-files-last", parent))
              .committed,
        },
      );
      coverage.reached(`repository-unreadable:${node}`);
    } catch (error) {
      if (personal !== undefined && status(error) === 401) throw error;
      if (error instanceof PermissionRequired) {
        permissions.push(`${repository.name}: ${error.message}`);
        log.condition(
          `repository-unreadable:${node}`,
          `${repository.name}: ${error.message}; its rows and progress are kept`,
        );
        next[node] = await marked(
          scoped,
          node,
          repository,
          privateIn(privacy, node),
        );
        await save(scoped, node, next[node]);
        return;
      }
      if (!lostAccess(error)) throw error;
      log.condition(
        `repository-unreadable:${node}`,
        `${repository.name} is listed for ${personal === undefined ? "the App" : "the personal token"} but answered ${String(status(error))}, so its rows are left as they are, bar the private marker, which is set to true since its visibility is not known`,
      );
      next[node] = await marked(scoped, node, repository, true);
    }
    await save(scoped, node, next[node]);
  };

  const now = Date.now();
  for (const [node, at] of listed) {
    coverage.reached(`unsettled:${node}`);
    if (unsettled.has(node)) {
      log.condition(
        `unsettled:${node}`,
        `a create GitHub may have made in ${at.repository.full_name} is not found yet, so ${at.repository.full_name} is not read this run`,
      );
      continue;
    }
    const checked = next[node]?.checked;
    try {
      await sync(
        node,
        checked === undefined || now - Date.parse(checked) >= checkEvery,
      );
    } catch (error) {
      if (!rateLimited(error)) throw error;
      waiting.push(at.repository.full_name);
    }
  }
  if (permissions.length > 0 && permissions.length === listed.size)
    throw new Error(permissions.join("; "));
  if (waiting.length > 0) {
    log.condition(
      "rate-limit-reserve",
      `GitHub's hourly limit ran low, so ${waiting.join(", ")} ${waiting.length === 1 && deferred.size === 0 ? "waits" : "wait"} for the next run`,
    );
  }
  if (
    answered.size === installations.length &&
    Object.values(kept).every((repository) =>
      answered.has(repository.installation),
    )
  ) {
    coverage.reached("rate-limit-reserve");
  }
}

async function takeOut(
  context: Context,
  node: string,
  name: string,
  personal = false,
) {
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
    `${name} ${personal ? "is no longer listed for the personal token" : "was taken out of the App's installation"}, and its rows archived`,
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
    retainedRepositories: ReadonlySet<string>;
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

  // Neutral links need not alter REST data or its ETag. Poll the issues on
  // unchanged pages too, so installations without webhooks still converge.
  const unchanged = await issuesByNode(octokit, [
    ...(
      await nodesOfNumbers(
        octokit,
        owner,
        name,
        [...scope].filter((number) => !byNumber.has(number)),
      )
    ).values(),
  ]);
  // Reverse relationships can name older issues outside the listing window.
  const relations = await relationsOf(octokit, [
    ...listed.map((issue) => issue.node_id),
    ...unchanged.map((one) => one.issue.node),
  ]);
  const listedNodes = new Set([
    ...listed.map((issue) => issue.node_id),
    ...unchanged.map((one) => one.issue.node),
  ]);
  // A child detached, or an issue no longer blocked, names nothing on
  // GitHub's side of what changed: ask about those Marfa holds under it.
  const held: string[] = [];
  if (repository.comments !== undefined) {
    for (const id of listedNodes) {
      const under = { type: issueType, id };
      for (const connection of [subIssueOf, blockedBy, relatesTo]) {
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
      ...[
        ...one.blockedBy,
        ...one.relatesTo,
        ...(one.duplicateOf === null ? [] : [one.duplicateOf]),
      ]
        .filter((other) => options.synced.has(other.repository.id))
        .map((other) => other.id),
    ]),
  ];
  const beside = [
    ...unchanged,
    ...(await issuesByNode(
      octokit,
      around.filter((id) => !listedNodes.has(id)),
    )),
  ];
  const canonicalSources = new Map<string, Relations>([
    ...relations,
    ...beside
      .filter(({ issue }) => options.synced.has(issue.repository.node))
      .map(({ issue, relations: known }) => [issue.node, known] as const),
  ]);
  await readRelatedSources(
    context,
    canonicalSources,
    options.synced,
    async (ids) => {
      for (const found of await issuesByNode(octokit, ids)) {
        if (!options.synced.has(found.issue.repository.node)) continue;
        beside.push(found);
        canonicalSources.set(found.issue.node, found.relations);
      }
    },
  );
  const knownTargets = await retainedTargets(
    context,
    [...relations.values(), ...beside.map((one) => one.relations)],
    options.retainedRepositories,
  );
  await upsert(
    issueType,
    await fileNotes(context, issueType, [
      ...listed.flatMap((issue) => {
        const found = relations.get(issue.node_id);
        if (found === undefined) return [];
        return [
          issueEntry(
            issueOfRest(issue, at),
            found,
            options.inside,
            hidden,
            knownTargets,
          ),
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
            knownTargets,
          ),
        ),
    ]),
  );

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
  await context.upsert(
    commentType,
    await fileNotes(context, commentType, entries),
  );
  return new Set(entries.map((entry) => entry.source_id));
}

async function marked(
  context: Context,
  node: string,
  repository: Kept,
  hidden: boolean,
): Promise<Kept> {
  await markFilesPrivate(
    context,
    new Map([[node, { name: repository.name, private: hidden }]]),
    { complete: false },
  );
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

async function retainedTargets(
  context: Context,
  relations: readonly Relations[],
  repositories: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const candidates = relations
    .flatMap((one) => [
      ...(one.parent === null ? [] : [one.parent]),
      ...one.blockedBy,
      ...one.relatesTo,
      ...(one.duplicateOf === null ? [] : [one.duplicateOf]),
    ])
    .filter((one) => repositories.has(one.repository.id))
    .map((one) => one.id);
  return context.known(issueType, [...new Set(candidates)]);
}

async function readRelatedSources(
  context: Context,
  known: Map<string, Relations>,
  synced: ReadonlySet<string>,
  read: (ids: string[]) => Promise<void>,
): Promise<void> {
  const asked = new Set(known.keys());
  const checked = new Set<string>();
  for (;;) {
    const wanted = new Set<string>();
    for (const [node, relations] of known) {
      if (checked.has(node)) continue;
      checked.add(node);
      for (const other of relations.relatesTo) {
        if (other.id < node && synced.has(other.repository.id))
          wanted.add(other.id);
      }
      // A removed pair is absent from GitHub, but its canonical source
      // still holds the connection in Marfa and must be refreshed.
      for (const row of await context.linked(issueType, relatesTo, {
        type: issueType,
        id: node,
      })) {
        const source = linkOf(row);
        if (source !== undefined && source < node) wanted.add(source);
      }
    }
    const ids = [...wanted].filter((id) => !asked.has(id));
    if (ids.length === 0) return;
    for (const id of ids) asked.add(id);
    await read(ids);
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
  initiallyDeferred: ReadonlySet<number>,
  excluded: ReadonlySet<string>,
  retainedRepositories: ReadonlySet<string>,
): Promise<void> {
  const { hints, upsert, log } = context;
  const clients = new Map(every);
  const deferred = new Set(initiallyDeferred);
  const attempt = async <T>(
    installation: number,
    act: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await act();
    } catch (error) {
      if (!rateLimited(error)) throw error;
      deferred.add(installation);
      clients.delete(installation);
      log.condition(
        "rate-limit-reserve",
        `GitHub's limit ran low for installation ${String(installation)}, so unfinished deliveries wait for the next run`,
      );
      return undefined;
    }
  };
  const synced = new Set(
    [...listed].flatMap(([node, { installation }]) =>
      clients.has(installation) ? [node] : [],
    ),
  );
  const issues = new Map<string, { issue: Issue; relations: Relations }>();
  const comments = new Map<string, Comment>();
  // What GitHub shows anywhere is not gone, though outside the sync.
  const shown = new Set<string>();
  const notApplied = new Set<string>();
  const namedComments = [...(hints?.get(commentType) ?? [])];
  const namedIssues = new Set(hints?.get(issueType) ?? []);
  for (const [installation, octokit] of clients) {
    const wanted = namedComments.filter((id) => !comments.has(id));
    for (const comment of (await attempt(installation, () =>
      commentsByNode(octokit, wanted),
    )) ?? []) {
      shown.add(comment.node);
      if (!synced.has(comment.repository.node)) {
        if (!excluded.has(comment.repository.node))
          notApplied.add(comment.node);
        continue;
      }
      comments.set(comment.node, comment);
      namedIssues.add(comment.issue);
    }
  }
  const neededIssues = new Set(namedIssues);
  const ask = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) neededIssues.add(id);
    for (const [installation, octokit] of clients) {
      const wanted = ids.filter((id) => !issues.has(id));
      for (const found of (await attempt(installation, () =>
        issuesByNode(octokit, wanted),
      )) ?? []) {
        shown.add(found.issue.node);
        if (
          !synced.has(found.issue.repository.node) &&
          !excluded.has(found.issue.repository.node)
        )
          notApplied.add(found.issue.node);
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
        ...relations.relatesTo,
        ...(relations.duplicateOf === null ? [] : [relations.duplicateOf]),
      ])
      .filter((one) => synced.has(one.repository.id))
      .map((one) => one.id),
  );
  const canonicalSources = new Map(
    [...issues].map(([id, found]) => [id, found.relations]),
  );
  await readRelatedSources(context, canonicalSources, synced, async (ids) => {
    await ask(ids);
    for (const [id, found] of issues) canonicalSources.set(id, found.relations);
  });
  const knownTargets = await retainedTargets(
    context,
    [...issues.values()].map((one) => one.relations),
    retainedRepositories,
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
    await fileNotes(
      context,
      issueType,
      [...issues.values()].map(({ issue, relations }) =>
        issueEntry(
          issue,
          relations,
          new Set([...synced, ...paused]),
          privateIn(privacy, issue.repository.node),
          knownTargets,
        ),
      ),
    ),
  );
  await upsert(
    commentType,
    await fileNotes(
      context,
      commentType,
      [...comments.values()].map((comment) =>
        commentEntry(comment, privateIn(privacy, comment.repository.node)),
      ),
    ),
  );

  const unfinished = (): void => {
    if (
      deferred.size > 0 &&
      [...neededIssues, ...namedComments].some(
        (id) => !shown.has(id) || notApplied.has(id),
      )
    )
      throw new RateLimitWaiting("unfinished delivery reads");
  };
  if (deferred.size > 0) {
    unfinished();
    return;
  }
  const unseenIssues = new Set([...namedIssues].filter((id) => !shown.has(id)));
  const unseenComments = new Set(namedComments.filter((id) => !shown.has(id)));
  for (const [node, { repository, installation }] of listed) {
    if (unseenIssues.size === 0 && unseenComments.size === 0) break;
    if (deferred.size > 0) break;
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
    await attempt(installation, async () => {
      if (!(await reads(octokit, owner, name))) {
        log.condition(
          `repository-unreadable:${node}`,
          `${repository.full_name} is listed for the App but does not read, so its rows are left as they are`,
        );
        return;
      }
      await archiveGone(context, octokit, { owner, name }, issueRows);
      await context.archive(
        commentType,
        commentRows.flatMap((row) => linkOf(row) ?? []),
      );
    });
  }
  unfinished();
}
