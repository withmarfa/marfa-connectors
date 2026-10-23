import type {
  EnvDeclaration,
  Item,
  RunContext,
  State,
} from "@withmarfa/connector";
import {
  linkOf,
  repositoryEntry,
  repositoryType,
  type RestRepository,
} from "./entries.js";
import {
  PermissionRequired,
  rateLimited,
  status,
  type Client,
} from "./github.js";

type Context = Pick<
  RunContext<EnvDeclaration>,
  "held" | "upsert" | "archive" | "derive" | "log" | "signal"
>;

/** The saved state: the repositories the last complete listing lacked, which
 *  GitHub's offset paging can do to a star that is still there when a star
 *  removed meanwhile shifts the pages. */
const missedKey = "stars-missed";

/** The condition for rows kept because GitHub would not say the repository is
 *  gone. */
export const starsKept = "stars-kept";

/** The most repositories one condition names. */
const namedAtMost = 10;

interface Star {
  readonly repository: RestRepository;
  readonly at: string;
}

/** The only media type that gives the time each star was made. */
const starMedia = "application/vnd.github.star+json" as const;

/** Every star of the person the token belongs to, or an error: a listing
 *  that stops partway is never a list of what they starred. */
async function listStars(octokit: Client): Promise<Map<string, Star>> {
  const listing = (await octokit.paginate({
    method: "GET",
    url: "/user/starred",
    per_page: 100,
    headers: { accept: starMedia },
  })) as unknown as {
    starred_at?: unknown;
    repo?: Partial<RestRepository> | null;
  }[];
  const stars = new Map<string, Star>();
  for (const one of listing) {
    const { starred_at: at, repo } = one;
    if (typeof at !== "string" || typeof repo?.node_id !== "string")
      throw new Error("GitHub listed stars without their times");
    stars.set(repo.node_id, { repository: repo as RestRepository, at });
  }
  return stars;
}

const limitSpent = "GitHub's rate limit is spent";

function whyNot(error: unknown): string {
  if (error instanceof PermissionRequired) return error.message;
  if (rateLimited(error)) return limitSpent;
  const code = status(error);
  return code === undefined
    ? error instanceof Error
      ? error.message
      : String(error)
    : `GitHub answered ${String(code)}`;
}

function marked(row: Item | undefined): boolean {
  return (
    row?.properties["starred"] === true ||
    typeof row?.properties["starred_at"] === "string"
  );
}

function missedOf(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((one): one is string => typeof one === "string")
      : [],
  );
}

/**
 * What a run knows of the person's stars. A scheduled run with a token lists
 * them; any other run, and one whose listing failed, takes each repository's
 * mark from the row it last wrote, so a read that did not happen never
 * changes a mark.
 *
 * GitHub pages the listing by offset, so a star removed while it is read
 * shifts the rest and one still there is missed. A repository loses its mark
 * or its row only when two consecutive complete listings both lack it.
 */
export class Stars {
  private constructor(
    /** The stars GitHub listed this run, by repository node; absent where
     *  none was listed. */
    private readonly read: ReadonlyMap<string, Star> | undefined,
    /** The repository rows held, by node; empty where nothing needs them. */
    private readonly rows: ReadonlyMap<string, Item>,
    /** The marked repositories the last complete listing lacked. */
    private readonly missed: ReadonlySet<string>,
    private readonly octokit: Client | undefined,
    private readonly state: State,
  ) {}

  /**
   * The held rows are read only to carry marks no listing gave: where a token
   * is set and the listing failed or was not asked for, and where it
   * succeeded, since the rows tell a star missed once from one never made. A
   * run without a token carries no marks.
   */
  static async open(
    context: Context,
    state: State,
    octokit: Client | undefined,
    scheduled: boolean,
  ): Promise<Stars> {
    let read: Map<string, Star> | undefined;
    if (scheduled && octokit !== undefined) {
      try {
        read = await listStars(octokit);
      } catch (error) {
        if (context.signal.aborted || status(error) === 401) throw error;
        context.log.condition(
          "stars-unreadable",
          `${whyNot(error)}, so the starred repositories are not listed: their marks stay as the last scheduled run left them, and no repository is archived or unmarked for losing a star; the other kinds keep syncing`,
        );
      }
    }
    const rows = octokit === undefined ? new Map() : await rowsOf(context);
    return new Stars(
      read,
      rows,
      read === undefined ? new Set() : missedOf(state.get(missedKey)),
      octokit,
      state,
    );
  }

  /** Whether this run listed the stars. */
  get listed(): boolean {
    return this.read !== undefined;
  }

  /** The marked repositories this listing lacks. */
  private lacking(): Set<string> {
    const lacking = new Set<string>();
    if (this.read === undefined) return lacking;
    for (const [node, row] of this.rows)
      if (marked(row) && !this.read.has(node)) lacking.add(node);
    return lacking;
  }

  /** The repository as its row should say it: marked from the listing, or
   *  as the row last said, until a second listing lacks it. */
  mark(repository: RestRepository): RestRepository {
    const node = repository.node_id;
    const star = this.read?.get(node);
    if (star !== undefined)
      return { ...repository, starred: true, starred_at: star.at };
    const row = this.rows.get(node)?.properties;
    if (
      this.read !== undefined &&
      (!marked(this.rows.get(node)) || this.missed.has(node))
    )
      return { ...repository, starred: false, starred_at: null };
    const starred = row?.["starred"];
    const at = row?.["starred_at"];
    return {
      ...repository,
      ...(typeof starred === "boolean" && { starred }),
      ...(typeof at === "string" && { starred_at: at }),
    };
  }

  /** Whether the repository is starred as far as is known, which keeps its
   *  row when it leaves the sync: whether it is archived is settled after. */
  starred(node: string): boolean {
    return this.read?.has(node) === true || marked(this.rows.get(node));
  }

  /**
   * After a scheduled run has read the repositories it syncs: brings in each
   * starred repository nothing else lists, as a repository row and no more,
   * and settles the rows a lost star leaves, once two listings in a row have
   * lacked the star. `listed` repositories were written by their own read. A
   * row kept for a repository that is read some other way, such as one
   * paused, only loses its mark; one nothing keeps is archived, only when
   * `complete` says every listing of the run answered, since one that did not
   * may be why a repository is missing, and only after GitHub's own read of
   * the repository shows it is not hidden by an owner that refuses the token.
   */
  async settle(
    context: Context,
    where: {
      listed: ReadonlySet<string>;
      kept: ReadonlySet<string>;
      complete: boolean;
    },
  ): Promise<void> {
    const read = this.read;
    if (read === undefined) return;
    const entries = [...read]
      .filter(([node]) => !where.listed.has(node))
      .map(([, star]) =>
        repositoryEntry({
          ...star.repository,
          starred: true,
          starred_at: star.at,
        }),
      );
    if (entries.length > 0) await context.upsert(repositoryType, entries);
    const lacking = this.lacking();
    const gone: string[] = [];
    const unmarked: string[] = [];
    const doubtful: { node: string; name: string }[] = [];
    const unresolved = new Set<string>();
    for (const node of lacking) {
      if (!this.missed.has(node)) {
        unresolved.add(node);
      } else if (where.listed.has(node)) {
        // Unmarked by its own read, which carried the second miss.
      } else if (where.kept.has(node)) {
        unmarked.push(node);
      } else if (where.complete) {
        const name = this.rows.get(node)?.properties["name"];
        doubtful.push({ node, name: typeof name === "string" ? name : node });
      } else {
        unresolved.add(node);
      }
    }
    const reasons: string[] = [];
    let spent = false;
    for (const { node, name } of doubtful) {
      const why: string | undefined = spent
        ? limitSpent
        : await this.refused(context, name);
      if (why === undefined) {
        gone.push(node);
      } else {
        unresolved.add(node);
        reasons.push(`${name} (${why})`);
        spent = spent || why === limitSpent;
      }
    }
    if (gone.length > 0) await context.archive(repositoryType, gone);
    if (unmarked.length > 0)
      await context.derive(repositoryType, unmarked, {
        starred: false,
        starred_at: null,
      });
    if (reasons.length > 0) {
      const named = reasons.slice(0, namedAtMost).join(", ");
      const more = reasons.length - namedAtMost;
      context.log.condition(
        starsKept,
        `the token cannot show that these repositories are no longer starred, so their rows are kept: ${named}${more > 0 ? ` and ${String(more)} more` : ""}. GitHub leaves a star out of the listing when the owner refuses the token, such as an organization that limits fine-grained tokens by lifetime`,
      );
    }
    this.state.set(missedKey, [...unresolved]);
  }

  /** Why the repository's row must stay, or nothing where the token's own
   *  read shows the repository gone, or open to it and not starred. */
  private async refused(
    context: Context,
    name: string,
  ): Promise<string | undefined> {
    const [owner, repo, ...rest] = name.split("/");
    if (this.octokit === undefined || !owner || !repo || rest.length > 0)
      return "its row names no repository to read";
    try {
      await this.octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      return undefined;
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (status(error) === 404) return undefined;
      if (rateLimited(error)) return limitSpent;
      return `${whyNot(error)}${status(error) !== undefined && error instanceof Error ? `: ${error.message}` : ""}`;
    }
  }
}

async function rowsOf(context: Context): Promise<Map<string, Item>> {
  const rows = new Map<string, Item>();
  for (const row of await context.held(repositoryType, { state: "active" })) {
    const node = linkOf(row);
    if (node !== undefined) rows.set(node, row);
  }
  return rows;
}
