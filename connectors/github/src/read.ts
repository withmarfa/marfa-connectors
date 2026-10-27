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
  discussionType,
  inRepository,
  issueEntry,
  issueOfRest,
  issueType,
  linkOf,
  pullRequestType,
  pullRequestEntry,
  type PullRequest,
  type ClosedByPR,
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
import {
  discussionsRefusal,
  heldIn,
  readNamedDiscussions,
  syncDiscussions,
} from "./discussions.js";
import {
  listPullRequests,
  pullRequestsByNode,
  withStoredChecks,
  closedByOf,
  pullNodeOfNumber,
  checksUnreadable,
  Rollup,
} from "./pulls.js";
import type { Scope } from "./scope.js";
import { fileNotes, preserveFiles, markFilesPrivate } from "./files.js";
import {
  conditionKeys as notificationConditions,
  readNotifications,
  tokenName,
} from "./notifications.js";
import {
  directoryType,
  forgetFiles,
  repositoryFileType,
  syncFiles,
  takeOutFiles,
  type FilesEntry,
  type Synced,
} from "./repository-files.js";
import { Stars, starsKept, type Reader } from "./stars.js";
import { everywhere, takeUnsettled } from "./unsettled.js";
import {
  askIssue,
  commentsOf,
  duplicateComments,
  follow,
  movedFrom,
  movedComments,
  movedNamed,
  withMovedComments,
  withMoves,
  type Followed,
  type Follower,
  unreadable,
} from "./transfer.js";

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
  /** The time Discussions were last read down to; absent until they are. */
  discussions?: { since: string };
  paused?: boolean;
  /** The repository's visibility as its rows last said it. */
  private?: boolean;
  /** Issues Marfa has no row for that may be mid-transfer, each with when
   *  this read first held it back. */
  waiting?: Record<string, string>;
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

const readPrefixes = [
  "installation-suspended:",
  "installation-lost:",
  "repositories-unmatched:",
  "token-unnarrowed:",
  "repository-lost:",
  "issues-off:",
  "repository-unreadable:",
  "pull-requests-unreadable:",
  "discussions-unreadable:",
  "repository-progress:",
  "unsettled:",
  "issue-missing:",
  "issue-moved:",
  "duplicate:",
  "github-files:",
  "files-unlisted:",
  "files-missing:",
  "files-skipped:",
  "files-unsynced:",
];

class Coverage {
  readonly keys = new Set([
    "unsettled",
    "rate-limit-reserve",
    "clock-skew",
    ...notificationConditions,
    "stars-unreadable",
    starsKept,
    checksUnreadable,
  ]);
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

/** The personal token lists the stars; failing that the notifications token,
 *  a classic token without `repo`, which lists public stars only. */
function starReader(
  app: App | Personal,
  personal: Client | undefined,
  notificationsToken: string | undefined,
  secret: RootContext["secret"],
  signal: AbortSignal,
): Reader | undefined {
  if (personal !== undefined)
    return {
      octokit: personal,
      name: "GITHUB_PERSONAL_TOKEN",
      publicOnly: false,
    };
  if (notificationsToken === undefined) return undefined;
  return {
    octokit: asPersonalToken(
      notificationsToken,
      app.base,
      secret,
      signal,
      tokenName,
    ),
    name: tokenName,
    publicOnly: true,
  };
}

export async function read(
  context: RootContext,
  app: App | Personal,
  scope: Scope | undefined,
  notifications: { token: string | undefined; scopeText: string | undefined },
  starsOn = true,
  files: readonly FilesEntry[] = [],
): Promise<void> {
  const coverage = new Coverage();
  try {
    await readAll(
      context,
      app,
      scope,
      coverage,
      notifications.token,
      starsOn,
      files,
    );
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
    // Its own token and budget, so it is read whatever became of the rest.
    if (context.hints === undefined)
      await readNotifications(
        context,
        { ...notifications, base: app.base, scope },
        (...keys) => {
          coverage.reached(...keys);
        },
      );
    coverage.retain(context);
  }
}

async function readAll(
  context: RootContext,
  app: App | Personal,
  scope: Scope | undefined,
  coverage: Coverage,
  notificationsToken: string | undefined,
  starsOn: boolean,
  files: readonly FilesEntry[],
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
  const rollup = new Rollup(log);
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
  // A person who archived or trashed a row has settled a duplicate it was in.
  // This reads every issue and comment row, so a delivery leaves it to the
  // scheduled run.
  if (context.hints === undefined)
    coverage.reached(...(await settledDuplicates(context)));
  const clients = new Map<number, Client>();
  // Discussions are read with their own token, so an installation that has
  // not accepted their permission still reads everything else.
  const discussionClients = new Map<number, Client>();
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
            `${repository.full_name} has its issues turned off on GitHub, so its issues and comments are left as they are, bar the private marker, which follows its visibility`,
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
  // Only a scheduled run lists the stars, and not where GITHUB_STARS turned
  // them off; the rest keep each mark as it was.
  const scheduled = context.hints === undefined;
  const stars = await Stars.open(
    context,
    state,
    starReader(app, personal, notificationsToken, secret, signal),
    { scheduled, listing: starsOn },
  );
  if (scheduled) coverage.reached("stars-unreadable");
  if (scheduled && !starsOn) coverage.reached(starsKept);
  for (const [node, at] of listed)
    listed.set(node, { ...at, repository: stars.mark(at.repository) });
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
    const discussed = [...listed.values()]
      .filter((one) => one.installation === installation)
      .map((one) => one.repository.id);
    if (discussed.length > 0) {
      discussionClients.set(
        installation,
        personal ??
          asInstallation(
            app as App,
            installation,
            { access: "discussions", repositoryIds: discussed },
            secret,
            signal,
          ),
      );
    }
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
      discussionClients,
      rollup,
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
      const retained = await takeOut(
        scoped,
        node,
        repository.name,
        personal !== undefined,
        stars.starred(node),
      );
      forgetFiles(state, node);
      // Kept while a row under it is active, so the next run takes it out
      // again and archives its row once nothing under it is.
      await save(scoped, node, retained ? repository : undefined);
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
  const readDiscussions = async (
    scoped: ScopedRunContext<EnvDeclaration>,
    installation: number,
    node: string,
    repository: Kept,
    check: boolean,
  ): Promise<Kept> => {
    const octokit = discussionClients.get(installation);
    if (octokit === undefined) return repository;
    const [owner = "", name = ""] = repository.name.split("/");
    try {
      const since = await syncDiscussions(
        scoped,
        octokit,
        { node, owner, name, hidden: privateIn(privacy, node) },
        repository.discussions,
        check,
      );
      coverage.reached(`discussions-unreadable:${node}`);
      return since === undefined
        ? repository
        : { ...repository, discussions: since };
    } catch (error) {
      const why = discussionsRefusal(error);
      if (why === undefined) throw error;
      log.condition(
        `discussions-unreadable:${node}`,
        `${repository.name}: GitHub refused its Discussions (${why}), so its discussions and their comments are left as they are; the other kinds keep syncing`,
      );
      return repository;
    }
  };
  const sync = async (node: string, check: boolean): Promise<void> => {
    const at = listed.get(node);
    const repository = next[node];
    const octokit = at === undefined ? undefined : clients.get(at.installation);
    if (at === undefined || octokit === undefined || repository === undefined)
      return;
    const scoped = context.forScope(`repository:${node}`);
    const unreadable = `${at.repository.has_issues === false ? "pull-requests-unreadable" : "repository-unreadable"}:${node}`;
    await scoped.upsert(repositoryType, [repositoryEntry(at.repository, true)]);
    try {
      // GitHub answers each issue of such a repository 410, as if deleted.
      if (at.repository.has_issues === false) {
        const [owner = "", name = ""] = at.repository.full_name.split("/");
        const prs = await listPullRequests(
          octokit,
          owner,
          name,
          day(new Date(Date.now() - windowDays * 86_400_000)),
          rollup,
        );
        await scoped.upsert(
          pullRequestType,
          (await withStoredChecks(scoped, prs)).map((pr) =>
            pullRequestEntry(
              pr,
              new Set([...synced, ...paused]),
              privateIn(privacy, node),
            ),
          ),
        );
        next[node] = await marked(
          scoped,
          node,
          repository,
          privateIn(privacy, node),
        );
        coverage.reached(`pull-requests-unreadable:${node}`);
        next[node] = await readDiscussions(
          scoped,
          at.installation,
          node,
          next[node],
          check,
        );
        await save(scoped, node, next[node]);
        return;
      }
      next[node] = {
        ...(await syncRepository(scoped, octokit, node, repository, {
          synced,
          inside: new Set([...synced, ...paused]),
          retainedRepositories: retained,
          rollup,
          privacy,
          check,
          reached: (keys) => {
            coverage.reached(...keys);
          },
        })),
        ...(repository.discussions !== undefined && {
          discussions: repository.discussions,
        }),
      };
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
      coverage.reached(
        `repository-unreadable:${node}`,
        `pull-requests-unreadable:${node}`,
      );
      next[node] = await readDiscussions(
        scoped,
        at.installation,
        node,
        next[node],
        check,
      );
    } catch (error) {
      if (personal !== undefined && status(error) === 401) throw error;
      if (error instanceof PermissionRequired) {
        permissions.push(`${repository.name}: ${error.message}`);
        log.condition(
          unreadable,
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
        unreadable,
        `${repository.name} is listed for ${personal === undefined ? "the App" : "the personal token"} but answered ${String(status(error))}, so its rows are left as they are, bar the private marker, which is set to true since its visibility is not known`,
      );
      next[node] = await marked(scoped, node, repository, true);
    }
    await save(scoped, node, next[node]);
  };

  // Files are read with their own token, so an installation that has not
  // accepted the Contents permission still reads everything else.
  const filesClients = (): Map<string, Synced> => {
    const named = new Set(files.map((entry) => entry.repository));
    const chosen = [...listed.values()].filter(({ repository }) =>
      named.has(repository.full_name.toLowerCase()),
    );
    const byInstallation = new Map<number, number[]>();
    for (const { repository, installation } of chosen)
      byInstallation.set(installation, [
        ...(byInstallation.get(installation) ?? []),
        repository.id,
      ]);
    const octokits = new Map(
      [...byInstallation].map(([installation, repositoryIds]) => [
        installation,
        personal ??
          asInstallation(
            app as App,
            installation,
            { access: "contents", repositoryIds },
            secret,
            signal,
          ),
      ]),
    );
    return new Map(
      chosen.map(({ repository, installation }) => [
        repository.full_name.toLowerCase(),
        { repository, octokit: octokits.get(installation) },
      ]),
    );
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
  await stars.settle(context, {
    listed: new Set(listed.keys()),
    kept: new Set([...Object.keys(next), ...retained]),
    complete: answered.size === installations.length,
  });
  if (stars.listed) coverage.reached(starsKept);
  if (scheduled && rollup.answered) coverage.reached(checksUnreadable);
  await syncFiles(context, state, files, {
    synced: filesClients(),
    paused: new Set(
      [...paused].flatMap((node) => {
        const name = outside.get(node)?.repository.full_name;
        return name === undefined ? [] : [name.toLowerCase()];
      }),
    ),
    complete: answered.size === installations.length,
    reached: (...keys) => {
      coverage.reached(...keys);
    },
    waiting: (name) => {
      waiting.push(name);
    },
  });
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

/** Takes a repository out of this process: archives the rows this process
 *  holds an agreement for under it. Its own row stays while any row under it
 *  is still active, whoever wrote it, since another process may still sync
 *  it, and while the repository is starred. Answers whether it stayed for a
 *  row, so the caller keeps the repository's progress and takes it out again
 *  once nothing under it is active. */
async function takeOut(
  context: Context,
  node: string,
  name: string,
  personal: boolean,
  starred: boolean,
): Promise<boolean> {
  const { linked, archive, log } = context;
  const under = { type: repositoryType, id: node };
  const links = (rows: Item[]): string[] =>
    rows.flatMap((row) => linkOf(row) ?? []);
  await archive(
    commentType,
    links(await linked(commentType, inRepository, under)),
  );
  await archive(issueType, links(await linked(issueType, inRepository, under)));
  await archive(
    discussionType,
    links(await linked(discussionType, inRepository, under)),
  );
  await archive(
    pullRequestType,
    links(await linked(pullRequestType, inRepository, under)),
  );
  await takeOutFiles(context, node);
  // Read after the archives above, so it is what they left active.
  let remaining = 0;
  for (const type of [
    commentType,
    issueType,
    discussionType,
    pullRequestType,
    repositoryFileType,
    directoryType,
  ]) {
    const rows = await linked(type, inRepository, under, { rows: "all" });
    remaining += rows.filter((row) => row.state === "active").length;
  }
  // A starred repository keeps its row and its `synced`, since another
  // process may still sync it: a lost star then only unmarks it.
  if (!starred && remaining === 0) await archive(repositoryType, [node]);
  const bar = [
    ...(remaining > 0
      ? [
          `${String(remaining)} active ${remaining === 1 ? "row" : "rows"} under it that this process did not archive, which another process may still sync`,
        ]
      : []),
    ...(starred
      ? ["its repository row, which its star keeps"]
      : remaining > 0
        ? ["its repository row, which stays while they are active"]
        : []),
  ];
  log.info(
    `${name} ${personal ? "is no longer listed for the personal token" : "was taken out of the App's installation"}, and its rows archived${bar.length > 0 ? `, bar ${bar.join(", and ")}` : ""}`,
  );
  return remaining > 0;
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
    rollup: Rollup;
    privacy: Privacy;
    check: boolean;
    /** Marks conditions the check ran in full for, so any it did not raise
     *  again are cleared. */
    reached: (keys: readonly string[]) => void;
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
  const prs = await listPullRequests(
    octokit,
    owner,
    name,
    `${windowStart}T00:00:00Z`,
    options.rollup,
  );

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
  const waitedBefore = new Map(Object.entries(repository.waiting ?? {}));
  const around = [
    ...held,
    ...waitedBefore.keys(),
    ...prs.flatMap((pr) =>
      pr.closingIssues
        .filter((one) => options.synced.has(one.repository.id))
        .map((one) => one.id),
    ),
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
  const closedBy = await closedByOf(octokit, [
    ...listed.filter((one) => one.state === "closed").map((one) => one.node_id),
    ...beside.filter((one) => !one.issue.open).map((one) => one.issue.node),
  ]);
  const allPRs = new Map(prs.map((pr) => [pr.node, pr]));
  const closingPRs = [...closedBy.values()].filter(
    (pr) => options.synced.has(pr.repository.id) && !allPRs.has(pr.id),
  );
  for (const pr of await pullRequestsByNode(
    octokit,
    closingPRs.map((pr) => pr.id),
    options.rollup,
  )) {
    if (options.synced.has(pr.repository.node)) allPRs.set(pr.node, pr);
  }
  await upsert(
    pullRequestType,
    (await withStoredChecks(context, [...allPRs.values()])).map((pr) =>
      pullRequestEntry(
        pr,
        options.inside,
        privateIn(options.privacy, pr.repository.node),
      ),
    ),
  );
  const closer = (id: string): ClosedByPR => {
    const pr = closedBy.get(id);
    return pr === undefined
      ? null
      : allPRs.has(pr.id)
        ? { node: pr.id, url: pr.url }
        : { url: pr.url };
  };
  const written = [
    ...listed.map((issue) =>
      issueOfRest(issue, at, relations.get(issue.node_id)?.transfer ?? null),
    ),
    ...beside
      .filter(({ issue }) => options.synced.has(issue.repository.node))
      .map(({ issue }) => issue),
  ];
  // An issue that may be mid-transfer is written by a later run, when GitHub
  // has recorded the transfer, or once it has waited a window.
  const { moves, waiting: moving } = await movedFrom(
    context,
    octokit,
    written,
    started.getTime(),
    waitedBefore,
  );
  await upsert(
    issueType,
    await fileNotes(
      context,
      issueType,
      withMoves(
        [
          ...listed.flatMap((issue) => {
            const found = relations.get(issue.node_id);
            if (found === undefined || moving.has(issue.node_id)) return [];
            return [
              issueEntry(
                issueOfRest(issue, at, found.transfer),
                found,
                options.inside,
                hidden,
                knownTargets,
                closer(issue.node_id),
              ),
            ];
          }),
          ...beside
            .filter(
              ({ issue }) =>
                options.synced.has(issue.repository.node) &&
                !moving.has(issue.node),
            )
            .map(({ issue, relations: known }) =>
              issueEntry(
                issue,
                known,
                options.inside,
                privateIn(options.privacy, issue.repository.node),
                knownTargets,
                closer(issue.node),
              ),
            ),
        ],
        moves,
      ),
    ),
  );
  // The copies of a moved issue's comments keep their old times, so no
  // listing of what changed names them.
  const movedIssues = written.filter((issue) => moves.has(issue.node));
  if (movedIssues.length > 0) {
    await upsert(
      commentType,
      await fileNotes(
        context,
        commentType,
        await movedComments(context, octokit, movedIssues, (repositoryNode) =>
          privateIn(options.privacy, repositoryNode),
        ),
      ),
    );
  }

  // Comments of an issue that waits are read with it, once it is written: the
  // run that lets it go reads them all, as for a new issue.
  const waitingHere = written.filter(
    (one) => moving.has(one.node) && one.repository.node === node,
  );
  const waitingNumbers = new Set(waitingHere.map((one) => one.number));
  const released = written.filter(
    (one) =>
      waitedBefore.has(one.node) &&
      !moving.has(one.node) &&
      !moves.has(one.node) &&
      one.repository.node === node,
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
      if (before.has(number) || waitingNumbers.has(number)) continue;
      if ((byNumber.get(number)?.comments ?? 0) === 0) continue;
      for (const comment of (await octokit.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo: name, issue_number: number, per_page: 100 },
      )) as RestComment[]) {
        comments.set(comment.node_id, comment);
      }
    }
  }
  for (const issue of released) {
    for (const comment of (await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo: name, issue_number: issue.number, per_page: 100 },
    )) as RestComment[]) {
      comments.set(comment.node_id, comment);
    }
  }
  for (const [key, comment] of comments) {
    if (waitingNumbers.has(numberOf(comment))) comments.delete(key);
  }
  const where = {
    node,
    owner,
    name,
    scope: new Set([
      ...[...scope].filter((one) => !waitingNumbers.has(one)),
      ...released.map((one) => one.number),
    ]),
    hidden,
  };
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
    // The next run reads these by node, and writes each as a new issue once
    // it has waited a window.
    ...(waitingHere.length > 0 && {
      waiting: Object.fromEntries(
        waitingHere.map((one) => [
          one.node,
          waitedBefore.get(one.node) ?? started.toISOString(),
        ]),
      ),
    }),
    comments: {
      since,
      ...(etag !== undefined && { etag }),
      ...(full && { full }),
    },
    ...(repository.checked !== undefined && { checked: repository.checked }),
    private: hidden,
  };
  if (options.check || open.fresh || closed.fresh) {
    await checkIssues(
      context,
      octokit,
      { node, owner, name, scope, windowStart },
      options.reached,
      {
        synced: options.synced,
        entry: ({ issue, relations: known }) =>
          issueEntry(
            issue,
            known,
            options.inside,
            privateIn(options.privacy, issue.repository.node),
          ),
        hidden: (repositoryNode) => privateIn(options.privacy, repositoryNode),
      },
    );
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
  for (const type of [
    issueType,
    commentType,
    pullRequestType,
    discussionType,
  ]) {
    const links = (await context.linked(type, inRepository, under)).flatMap(
      (row) => linkOf(row) ?? [],
    );
    await context.derive(type, links, { private: hidden });
  }
  // These have no link: they are held by natural key.
  for (const type of [repositoryFileType, directoryType]) {
    const keys = (await context.linked(type, inRepository, under)).flatMap(
      (row) => (row.source_id === undefined ? [] : [row.source_id]),
    );
    if (keys.length > 0) await context.derive(type, keys, { private: hidden });
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

async function settledDuplicates(context: Context): Promise<string[]> {
  const rows = [
    ...(await context.held(issueType, { state: "any" })),
    ...(await context.held(commentType, { state: "any" })),
  ];
  return rows
    .filter((row) => row.state !== "active")
    .map((row) => `duplicate:${row.id}`);
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
  reached: (keys: readonly string[]) => void,
  follower: Follower,
): Promise<void> {
  const under = { type: repositoryType, id: where.node };
  const rows = await context.linked(issueType, inRepository, under);
  const listed = (row: Item): boolean => {
    const number = row.properties["number"];
    return typeof number === "number" && where.scope.has(number);
  };
  const unlisted = rows.filter((row) => {
    if (typeof row.properties["number"] !== "number" || listed(row))
      return false;
    const updated = row.properties["github_updated_at"];
    const quiet = typeof updated === "string" ? updated : "";
    const closed = ["completed", "canceled"].includes(
      String(row.properties["status"]),
    );
    return !closed || quiet >= where.windowStart;
  });
  await archiveGone(context, octokit, where, unlisted, follower);
  // Every row listed or asked about has been through the whole check, so a
  // condition about one that is no longer raised is gone. A row left out
  // as closed and quiet was not checked, and keeps its conditions.
  const asked = new Set(unlisted);
  const checked = rows.filter((row) => listed(row) || asked.has(row));
  const numbers = new Set(
    checked.flatMap((row) => {
      const number = row.properties["number"];
      return typeof number === "number" ? [number] : [];
    }),
  );
  // A comment of an issue no active row holds raises nothing either.
  const active = new Set(
    rows.flatMap((row) => {
      const number = row.properties["number"];
      return typeof number === "number" ? [number] : [];
    }),
  );
  const comments = (
    await context.linked(commentType, inRepository, under)
  ).filter((row) => {
    // A discussion comment's address names no issue.
    const number = issueNumberOf(row);
    return number !== undefined && (numbers.has(number) || !active.has(number));
  });
  reached([
    ...checked.flatMap((row) => {
      const link = linkOf(row);
      return [
        `duplicate:${row.id}`,
        ...(link === undefined
          ? []
          : [`issue-moved:${link}`, `issue-missing:${link}`]),
      ];
    }),
    ...comments.map((row) => `duplicate:${row.id}`),
  ]);
}

/** Asks GitHub about rows it no longer lists. A row whose issue was
 *  transferred to an issue Marfa has no other row for follows it. With
 *  `archiving` false, only that: the run may not archive these rows, so it
 *  says nothing of archiving them. */
async function archiveGone(
  context: Context,
  octokit: Client,
  where: { owner: string; name: string },
  rows: readonly Item[],
  follower: Follower,
  archiving = true,
): Promise<void> {
  const { log } = context;
  const gone: string[] = [];
  const followed: Extract<Followed, { kind: "followed" }>[] = [];
  for (const row of rows) {
    const number = row.properties["number"];
    const link = linkOf(row);
    if (typeof number !== "number" || link === undefined) continue;
    const said = await askIssue(octokit, where.owner, where.name, number);
    const here = `${where.owner}/${where.name}#${String(number)}`;
    if (said.kind === "deleted") {
      if (archiving) gone.push(link);
    } else if (said.kind === "moved") {
      // GitHub answers an empty address for a move to a repository the
      // token cannot see.
      const next: Followed =
        said.to === undefined
          ? { kind: "away", why: unreadable }
          : await follow(context, octokit, row, link, said.to, follower);
      if (next.kind === "followed") {
        followed.push(next);
        continue;
      }
      if (next.kind === "duplicate") {
        // A person who archived this row has settled it.
        if (row.state !== "active") continue;
        log.condition(
          `duplicate:${row.id}`,
          `${here} was transferred to ${next.issue.repository.name}#${String(next.issue.number)}, which row ${next.other.id}${next.other.state === "active" ? "" : ` (${next.other.state})`} already holds, so row ${row.id} and row ${next.other.id} are both kept`,
        );
        await duplicateComments(
          context,
          octokit,
          next.issue,
          link,
          follower.hidden,
        );
        continue;
      }
      if (!archiving) continue;
      gone.push(link);
      log.condition(
        `issue-moved:${link}`,
        `${here} was moved to ${next.why}, so its row here is archived`,
      );
    } else if (said.kind === "missing" && archiving) {
      log.condition(
        `issue-missing:${link}`,
        `${here} answered 404 though its repository reads, so its row is left as it is`,
      );
    }
  }
  if (followed.length > 0) {
    await context.upsert(
      issueType,
      await fileNotes(
        context,
        issueType,
        followed.map((next) => next.entry),
      ),
    );
    await context.upsert(
      commentType,
      await fileNotes(
        context,
        commentType,
        await movedComments(
          context,
          octokit,
          followed.map((next) => next.issue),
          follower.hidden,
        ),
      ),
    );
  }
  if (archiving) await context.archive(issueType, gone);
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
  // Discussion comments are not in this listing and are checked with their
  // discussions.
  const discussionComments = new Set(
    [...(await heldIn(context, where.node)).values()].flat(),
  );
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
    return link === undefined ||
      listed.has(link) ||
      discussionComments.has(link)
      ? []
      : [link];
  });
  // A comment GitHub refuses the token, or shows as another kind of node, is
  // not proven gone.
  const asked = await commentsByNode(octokit, absent);
  const still = new Set([
    ...asked.found.map((comment) => comment.node),
    ...asked.refused,
    ...asked.elsewhere,
  ]);
  // A comment of an issue that moved, whose row is still active, is not
  // proven gone: its issue's row was kept apart from the issue it became, and
  // its copy is a row of its own.
  const moved = await movedThreads(
    context,
    octokit,
    where,
    rows.filter((row) => absent.includes(linkOf(row) ?? "")),
  );
  await archive(
    commentType,
    absent.filter((link) => !still.has(link) && !moved.has(link)),
  );
}

/** The comment rows, of those given, that belong to an active issue row whose
 *  address answers a move. */
async function movedThreads(
  context: Context,
  octokit: Client,
  where: { node: string; owner: string; name: string },
  commentRows: readonly Item[],
): Promise<Set<string>> {
  const kept = new Set<string>();
  if (commentRows.length === 0) return kept;
  const issues = await issuesOfComments(
    context,
    { type: repositoryType, id: where.node },
    commentRows,
  );
  for (const issue of issues) {
    const number = issue.properties["number"];
    if (typeof number !== "number") continue;
    const said = await askIssue(octokit, where.owner, where.name, number);
    if (said.kind !== "moved") continue;
    for (const row of commentRows) {
      const link = linkOf(row);
      if (link !== undefined && issueNumberOf(row) === number) kept.add(link);
    }
  }
  return kept;
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

/** The number of the issue a comment row's address belongs to. */
function issueNumberOf(row: Item): number | undefined {
  const url = row.properties["url"];
  const found =
    typeof url === "string"
      ? /\/(?:issues|pull)\/(\d+)#issuecomment-/.exec(url)
      : null;
  return found?.[1] === undefined ? undefined : Number(found[1]);
}

/** The active rows of the issues that hold these comment rows, found by the
 *  number in each comment's address, other than those already asked about. */
async function issuesOfComments(
  context: Context,
  under: { type: string; id: string },
  commentRows: readonly Item[],
  asked: ReadonlySet<string | undefined> = new Set(),
): Promise<Item[]> {
  const numbers = new Set(
    commentRows.flatMap((row) => issueNumberOf(row) ?? []),
  );
  return (await context.linked(issueType, inRepository, under)).filter(
    (row) =>
      row.state === "active" &&
      numbers.has(Number(row.properties["number"])) &&
      !asked.has(linkOf(row)),
  );
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
  discussionClients: ReadonlyMap<number, Client>,
  rollup: Rollup,
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
  const prs = new Map<string, PullRequest>();
  // What GitHub shows anywhere is not gone, though outside the sync.
  const shown = new Set<string>();
  // Named comments the issue read was refused or found to be a discussion's.
  const notIssueComments = new Set<string>();
  const notApplied = new Set<string>();
  const namedComments = [...(hints?.get(commentType) ?? [])];
  const namedIssues = new Set(hints?.get(issueType) ?? []);
  const pullHints = [...(hints?.get(pullRequestType) ?? [])];
  const namedPRs = new Set<string>();
  const neededPRs = new Set<string>();
  let closingReadIncomplete = false;
  for (const hint of pullHints) {
    const resolved = /^(number|commit):([^:]+):(.+)$/.exec(hint);
    if (resolved === null) {
      namedPRs.add(hint);
      continue;
    }
    const [, kind, repoId, value] = resolved;
    const at = repoId === undefined ? undefined : listed.get(repoId);
    if (at === undefined) {
      if (deferred.size === 0 || (repoId !== undefined && excluded.has(repoId)))
        shown.add(hint);
      continue;
    }
    const client = clients.get(at.installation);
    if (client === undefined) continue;
    const [owner = "", name = ""] = at.repository.full_name.split("/");
    const ids = await attempt(at.installation, async (): Promise<string[]> => {
      if (kind === "number") {
        const id = await pullNodeOfNumber(client, owner, name, Number(value));
        return id === undefined ? [] : [id];
      }
      const associated = (await client.paginate(
        "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
        { owner, repo: name, commit_sha: value ?? "", per_page: 100 },
      )) as { node_id: string }[];
      return associated.map((pr) => pr.node_id);
    });
    if (ids !== undefined) {
      shown.add(hint);
      for (const id of ids) namedPRs.add(id);
    }
  }
  const askPRs = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) neededPRs.add(id);
    for (const [installation, octokit] of clients) {
      const wanted = ids.filter((id) => !prs.has(id));
      for (const pr of (await attempt(installation, () =>
        pullRequestsByNode(octokit, wanted, rollup),
      )) ?? []) {
        shown.add(pr.node);
        if (synced.has(pr.repository.node)) prs.set(pr.node, pr);
        else if (!excluded.has(pr.repository.node)) notApplied.add(pr.node);
      }
    }
  };
  await askPRs([...namedPRs]);

  for (const [installation, octokit] of clients) {
    const wanted = namedComments.filter((id) => !comments.has(id));
    const asked = await attempt(installation, () =>
      commentsByNode(octokit, wanted),
    );
    // A discussion comment is not an issue's, and the token that reads issues
    // may not show it: it is not gone, but only the read of its discussion
    // counts it as read.
    for (const id of [...(asked?.refused ?? []), ...(asked?.elsewhere ?? [])])
      notIssueComments.add(id);
    for (const comment of asked?.found ?? []) {
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
  await ask([
    ...namedIssues,
    ...[...prs.values()].flatMap((pr) =>
      pr.closingIssues
        .filter((one) => synced.has(one.repository.id))
        .map((one) => one.id),
    ),
  ]);
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
  const closers = new Map<
    string,
    { id: string; url: string; repository: { id: string } }
  >();
  const closingRead = new Set(
    [...issues.values()]
      .filter((one) => one.issue.open)
      .map((one) => one.issue.node),
  );
  for (const [installation, client] of clients) {
    const ids = [...issues.values()]
      .filter(
        (one) =>
          !one.issue.open &&
          listed.get(one.issue.repository.node)?.installation === installation,
      )
      .map((one) => one.issue.node);
    const answer = await attempt(installation, () => closedByOf(client, ids));
    if (answer === undefined) {
      closingReadIncomplete ||= ids.length > 0;
      continue;
    }
    for (const id of ids) closingRead.add(id);
    for (const [id, closer] of answer) closers.set(id, closer);
  }
  await askPRs(
    [...closers.values()]
      .filter((one) => synced.has(one.repository.id))
      .map((one) => one.id),
  );
  const heldPRs = await context.known(
    pullRequestType,
    [...closers.values()].map((one) => one.id),
  );
  const closerOf = (id: string): ClosedByPR | undefined => {
    if (!closingRead.has(id)) return undefined;
    const closer = closers.get(id);
    return closer === undefined
      ? null
      : prs.has(closer.id) || heldPRs.has(closer.id)
        ? { node: closer.id, url: closer.url }
        : { url: closer.url };
  };
  const knownTargets = await retainedTargets(
    context,
    [...issues.values()].map((one) => one.relations),
    retainedRepositories,
  );
  const installationOf = new Map(
    [...listed.values()].map(({ repository, installation }) => [
      repository.full_name.toLowerCase(),
      installation,
    ]),
  );
  // A delivery that names an old issue as well as the new one shows the move
  // at once, though the new issue's timeline may not yet.
  const moves = await movedNamed(
    context,
    [...namedIssues].filter((id) => !shown.has(id)),
    [...issues.values()].map(({ issue }) => issue),
    async (repository, number) => {
      const installation = installationOf.get(repository.toLowerCase());
      const client =
        installation === undefined ? undefined : clients.get(installation);
      if (installation === undefined || client === undefined) return undefined;
      const [owner = "", name = ""] = repository.split("/");
      return attempt(installation, () => askIssue(client, owner, name, number));
    },
  );
  // Issues that cannot be written yet because a rate limit stopped a check
  // that says whether they are a transfer, or the copy of a moved issue's
  // comments: written by a later run.
  const stalled = new Set<string>();
  const stall = (node: string): void => {
    stalled.add(node);
    issues.delete(node);
    moves.delete(node);
    for (const [key, comment] of comments) {
      if (comment.issue === node) comments.delete(key);
    }
  };
  const checked = new Set<number>();
  for (const [installation, client] of clients) {
    const mine = [...issues.values()]
      .map(({ issue }) => issue)
      .filter(
        (issue) =>
          listed.get(issue.repository.node)?.installation === installation,
      );
    if (mine.length === 0) continue;
    const found = await attempt(installation, () =>
      movedFrom(
        context,
        client,
        mine.filter((one) => !moves.has(one.node)),
      ),
    );
    if (found !== undefined) checked.add(installation);
    for (const [fresh, old] of found?.moves ?? []) moves.set(fresh, old);
    // An issue that may be mid-transfer is written by a later run: the
    // `transferred` delivery that follows it, or the schedule.
    for (const node of found?.waiting ?? []) {
      issues.delete(node);
      for (const [key, comment] of comments) {
        if (comment.issue === node) comments.delete(key);
      }
    }
    for (const issue of mine.filter((one) => moves.has(one.node))) {
      const copies = await attempt(installation, () =>
        commentsOf(client, issue),
      );
      if (copies === undefined) {
        stall(issue.node);
        continue;
      }
      for (const comment of copies) comments.set(comment.node, comment);
    }
  }
  // An installation whose check did not complete, or left before it, leaves
  // its new issues for the next run, and so a moved issue whose comments were
  // not read.
  const unchecked = [...issues.values()]
    .map(({ issue }) => issue)
    .filter(
      (issue) =>
        !checked.has(listed.get(issue.repository.node)?.installation ?? -1),
    );
  const have =
    unchecked.length === 0
      ? new Set<string>()
      : await context.known(
          issueType,
          unchecked.map((issue) => issue.node),
        );
  for (const issue of unchecked) {
    if (moves.has(issue.node) || !have.has(issue.node)) stall(issue.node);
  }
  const touched = new Set([
    ...[...issues.values()].map(({ issue }) => issue.repository.node),
    ...[...comments.values()].map((comment) => comment.repository.node),
    ...[...prs.values()].map((pr) => pr.repository.node),
  ]);
  await upsert(
    repositoryType,
    [...touched].flatMap((node) => {
      const at = listed.get(node);
      return at === undefined ? [] : [repositoryEntry(at.repository, true)];
    }),
  );
  await upsert(
    pullRequestType,
    (await withStoredChecks(context, [...prs.values()])).map((pr) =>
      pullRequestEntry(
        pr,
        new Set([...synced, ...paused]),
        privateIn(privacy, pr.repository.node),
      ),
    ),
  );
  await upsert(
    issueType,
    await fileNotes(
      context,
      issueType,
      withMoves(
        [...issues.values()].map(({ issue, relations }) =>
          issueEntry(
            issue,
            relations,
            new Set([...synced, ...paused]),
            privateIn(privacy, issue.repository.node),
            knownTargets,
            closerOf(issue.node),
          ),
        ),
        moves,
      ),
    ),
  );
  await upsert(
    commentType,
    await fileNotes(
      context,
      commentType,
      await withMovedComments(
        context,
        [...comments.values()].map((comment) =>
          commentEntry(comment, privateIn(privacy, comment.repository.node)),
        ),
        new Set(moves.keys()),
      ),
    ),
  );

  const namedDiscussions = new Set(hints?.get(discussionType) ?? []);
  let unseenDiscussions = new Set<string>();
  if (namedDiscussions.size > 0) {
    const read = await readNamedDiscussions(context, namedDiscussions, {
      listed,
      synced,
      clients: new Map(
        [...discussionClients].filter(([installation]) =>
          clients.has(installation),
        ),
      ),
      hidden: (node) => privateIn(privacy, node),
      deferred: deferred.size > 0,
    });
    unseenDiscussions = read.unseen;
    // A discussion comment is none of an issue's: what its discussion's read
    // settled is not judged again as one.
    for (const link of read.handled) shown.add(link);
  }

  const unfinished = (): void => {
    if (
      deferred.size > 0 &&
      (closingReadIncomplete ||
        unseenDiscussions.size > 0 ||
        stalled.size > 0 ||
        [
          ...neededIssues,
          ...namedComments,
          ...neededPRs,
          ...pullHints.filter((id) => /^(number|commit):/.test(id)),
        ].some((id) => !shown.has(id) || notApplied.has(id)))
    )
      throw new RateLimitWaiting("unfinished delivery reads");
  };
  if (deferred.size > 0) {
    unfinished();
    return;
  }
  const unseenIssues = new Set([...namedIssues].filter((id) => !shown.has(id)));
  const unseenComments = new Set(
    namedComments.filter((id) => !shown.has(id) && !notIssueComments.has(id)),
  );
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
    // A transfer copies a comment, so the old one is gone with the issue's
    // old address answering 301. Ask it, so the row follows the copy before
    // it is archived with an edit waiting.
    const owners =
      commentRows.length === 0
        ? []
        : await issuesOfComments(
            context,
            under,
            commentRows,
            new Set(issueRows.map((row) => linkOf(row))),
          );
    const [owner = "", name = ""] = repository.full_name.split("/");
    await attempt(installation, async () => {
      if (!(await reads(octokit, owner, name))) {
        log.condition(
          `repository-unreadable:${node}`,
          `${repository.full_name} is listed for the App but does not read, so its rows are left as they are`,
        );
        return;
      }
      const follower: Follower = {
        synced,
        entry: ({ issue, relations }) =>
          issueEntry(
            issue,
            relations,
            new Set([...synced, ...paused]),
            privateIn(privacy, issue.repository.node),
          ),
        hidden: (repositoryNode) => privateIn(privacy, repositoryNode),
      };
      await archiveGone(context, octokit, { owner, name }, issueRows, follower);
      // The delivery did not name these issues, so the run may follow them
      // and may not archive them.
      await archiveGone(
        context,
        octokit,
        { owner, name },
        owners,
        follower,
        false,
      );
      await context.archive(
        commentType,
        commentRows.flatMap((row) => linkOf(row) ?? []),
      );
    });
  }
  unfinished();
}
