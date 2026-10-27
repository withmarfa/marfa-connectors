import type {
  EnvDeclaration,
  Entry,
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
  "held" | "inspect" | "upsert" | "archive" | "derive" | "log" | "signal"
>;

/** The saved state: the repositories the last complete listing lacked, which
 *  GitHub's offset paging can do to a star that is still there when a star
 *  removed meanwhile shifts the pages, with the setting of the token that
 *  listed them, since two tokens do not list the same stars. A scheduled run
 *  that lists no stars clears it, so the two listings that settle a lost star
 *  are always consecutive. */
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

function whyNot(error: unknown, reading: string): string {
  if (error instanceof PermissionRequired) return error.message;
  if (rateLimited(error)) return limitSpent;
  const code = status(error);
  if (code === 401) return `GitHub rejected ${reading} (401)`;
  return code === undefined
    ? error instanceof Error
      ? error.message
      : String(error)
    : `GitHub answered ${String(code)}`;
}

/** Whether a row is kept for its star alone, which a lost star may archive.
 *  A row another process syncs, and one no run has said of, is only ever
 *  unmarked. */
function starOnly(row: Item | undefined): boolean {
  return row?.properties["synced"] === false;
}

function marked(row: Item | undefined): boolean {
  return (
    row?.properties["starred"] === true ||
    typeof row?.properties["starred_at"] === "string"
  );
}

/** The token a run lists stars with. The notifications token is a classic
 *  token without `repo`, which lists public stars only, so what it does not
 *  list proves nothing of a private repository. */
export interface Reader {
  readonly octokit: Client;
  /** The setting that holds the token, for what is said of it. */
  readonly name: string;
  readonly publicOnly: boolean;
}

/** The repositories the last listing lacked, or none where another token
 *  made that listing. */
function missedOf(value: unknown, by: string): Set<string> {
  if (typeof value !== "object" || value === null) return new Set();
  const { by: was, nodes } = value as { by?: unknown; nodes?: unknown };
  return new Set(
    was === by && Array.isArray(nodes)
      ? nodes.filter((one): one is string => typeof one === "string")
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
    private readonly reader: Reader | undefined,
    private readonly state: State,
    /** Whether this process holds the star fields, which GITHUB_STARS
     *  turns off. */
    private readonly holds: boolean,
  ) {}

  /** The repositories a run saw private, which a token that lists public
   *  stars only cannot say are unstarred. */
  private readonly shielded = new Set<string>();

  /**
   * The held rows are read only to carry marks no listing gave: where a token
   * is set and the listing failed or was not asked for, and where it
   * succeeded, since the rows tell a star missed once from one never made. A
   * run without a token carries no marks. `listing` is whether the run would
   * list the stars: a scheduled run with GITHUB_STARS on.
   */
  static async open(
    context: Context,
    state: State,
    reader: Reader | undefined,
    run: { scheduled: boolean; listing: boolean },
  ): Promise<Stars> {
    let read: Map<string, Star> | undefined;
    if (run.scheduled && run.listing && reader !== undefined) {
      try {
        read = await listStars(reader.octokit);
      } catch (error) {
        // The notifications token has a condition of its own for a refusal;
        // a rejected personal token ends the run.
        if (
          context.signal.aborted ||
          (status(error) === 401 && !reader.publicOnly)
        )
          throw error;
        context.log.condition(
          "stars-unreadable",
          `${whyNot(error, reader.name)}, so the starred repositories are not listed: their marks stay as the last scheduled run left them, and no repository is archived or unmarked for losing a star; the other kinds keep syncing`,
        );
      }
    }
    // A miss counts only towards the next listing, so one that does not happen
    // breaks the count, whether stars are off or the listing failed.
    if (run.scheduled && read === undefined) state.set(missedKey, null);
    const rows = reader === undefined ? new Map() : await rowsOf(context);
    return new Stars(
      read,
      rows,
      read === undefined || reader === undefined
        ? new Set()
        : missedOf(state.get(missedKey), reader.name),
      reader,
      state,
      run.listing,
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
   *  as the row last said, until a second listing lacks it. A process that
   *  holds no star field sends none. */
  mark(repository: RestRepository): RestRepository {
    if (!this.holds) return repository;
    const node = repository.node_id;
    const star = this.read?.get(node);
    if (star !== undefined)
      return { ...repository, starred: true, starred_at: star.at };
    const row = this.rows.get(node)?.properties;
    const shielded = this.reader?.publicOnly === true && repository.private;
    if (shielded && this.read !== undefined && marked(this.rows.get(node)))
      this.shielded.add(node);
    else if (
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
   * paused, only loses its mark, as does one whose row does not say it is
   * kept for its star alone, since another process may sync it under the
   * same source. A star-only row nothing keeps is archived, only when
   * `complete` says every listing of the run answered, since one that did not
   * may be why a repository is missing, only after GitHub's own read of the
   * repository shows it is not hidden by an owner that refuses the token, and
   * only if its row, read again just before, still says it is star-only.
   *
   * A starred row that does not say it is star-only takes only its marks
   * from this run, so the fields its own process writes are left to it.
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
    const entries: Entry[] = [];
    for (const [node, star] of read) {
      if (where.listed.has(node)) continue;
      const row = this.rows.get(node);
      if (row === undefined || starOnly(row))
        entries.push(
          repositoryEntry(
            { ...star.repository, starred: true, starred_at: star.at },
            false,
          ),
        );
      else
        await context.derive(repositoryType, [node], {
          starred: true,
          starred_at: star.at,
        });
    }
    if (entries.length > 0) await context.upsert(repositoryType, entries);
    const lacking = this.lacking();
    const gone: string[] = [];
    const unmarked: string[] = [];
    const doubtful: { node: string; name: string; kept: boolean }[] = [];
    const unresolved = new Set<string>();
    const reasons: string[] = [];
    const publicOnly = this.reader?.publicOnly === true;
    const nameOf = (node: string): string => {
      const name = this.rows.get(node)?.properties["name"];
      return typeof name === "string" ? name : node;
    };
    for (const node of lacking) {
      const kept = where.kept.has(node) || !starOnly(this.rows.get(node));
      if (
        this.shielded.has(node) ||
        (publicOnly && this.rows.get(node)?.properties["private"] === true)
      ) {
        reasons.push(`${nameOf(node)} (private, and it is not listed)`);
      } else if (!this.missed.has(node)) {
        unresolved.add(node);
      } else if (where.listed.has(node)) {
        // Unmarked by its own read, which carried the second miss.
      } else if (kept && !publicOnly) {
        unmarked.push(node);
      } else if (kept || where.complete) {
        doubtful.push({ node, name: nameOf(node), kept });
      } else {
        unresolved.add(node);
      }
    }
    let spent = false;
    for (const { node, name, kept } of doubtful) {
      const why: string | undefined = spent
        ? limitSpent
        : await this.refused(context, name);
      if (why === undefined) {
        (kept ? unmarked : gone).push(node);
      } else {
        unresolved.add(node);
        reasons.push(`${name} (${why})`);
        spent = spent || why === limitSpent;
      }
    }
    if (gone.length > 0) {
      // Another process may have taken the repository up since the rows were
      // read; its row then says so, and it only loses its mark.
      const still = new Set<string>();
      for (const row of (await context.inspect(repositoryType, { links: gone }))
        .items)
        if (row.state === "active" && starOnly(row)) {
          const node = linkOf(row);
          if (node !== undefined) still.add(node);
        }
      for (const node of gone) if (!still.has(node)) unmarked.push(node);
      if (still.size > 0) await context.archive(repositoryType, [...still]);
    }
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
        `the token cannot show that these repositories are no longer starred, so their rows are kept: ${named}${more > 0 ? ` and ${String(more)} more` : ""}. ${
          publicOnly
            ? `${this.reader.name} is a classic token that lists public stars only, and GitHub answers it 404 for a private repository, so neither a missing star nor a 404 shows a private repository is no longer starred`
            : "GitHub leaves a star out of the listing when the owner refuses the token, such as an organization that limits fine-grained tokens by lifetime"
        }`,
      );
    }
    if (this.reader !== undefined)
      this.state.set(missedKey, {
        by: this.reader.name,
        nodes: [...unresolved],
      });
  }

  /** Why the repository's row must stay, or nothing where the token's own
   *  read shows the repository gone, or open to it and not starred. */
  private async refused(
    context: Context,
    name: string,
  ): Promise<string | undefined> {
    const [owner, repo, ...rest] = name.split("/");
    const reader = this.reader;
    if (reader === undefined || !owner || !repo || rest.length > 0)
      return "its row names no repository to read";
    try {
      await reader.octokit.request("GET /repos/{owner}/{repo}", {
        owner,
        repo,
      });
      return undefined;
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (rateLimited(error)) return limitSpent;
      if (status(error) === 404)
        return reader.publicOnly
          ? "GitHub answered 404, which it also says of a private repository"
          : undefined;
      return `${whyNot(error, reader.name)}${status(error) !== undefined && error instanceof Error ? `: ${error.message}` : ""}`;
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
