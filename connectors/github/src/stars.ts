import type { EnvDeclaration, Item, RunContext } from "@withmarfa/connector";
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

function whyNot(error: unknown): string {
  if (error instanceof PermissionRequired) return error.message;
  if (rateLimited(error)) return "GitHub's rate limit is spent";
  const code = status(error);
  return code === undefined
    ? error instanceof Error
      ? error.message
      : String(error)
    : `GitHub answered ${String(code)}`;
}

/**
 * What a run knows of the person's stars. A scheduled run with a token lists
 * them; any other run, and one whose listing failed, takes each repository's
 * mark from the row it last wrote, so a read that did not happen never
 * changes a mark.
 */
export class Stars {
  private constructor(
    /** The stars GitHub listed this run, by repository node; absent where
     *  none was listed. */
    private readonly read: ReadonlyMap<string, Star> | undefined,
    private readonly rows: ReadonlyMap<string, Item>,
  ) {}

  static async open(
    context: Context,
    octokit: Client | undefined,
    scheduled: boolean,
  ): Promise<Stars> {
    if (scheduled && octokit !== undefined) {
      try {
        return new Stars(await listStars(octokit), new Map());
      } catch (error) {
        if (context.signal.aborted || status(error) === 401) throw error;
        context.log.condition(
          "stars-unreadable",
          `${whyNot(error)}, so the starred repositories are not listed: their marks stay as the last scheduled run left them, and no repository is archived for losing a star; the other kinds keep syncing`,
        );
      }
    }
    return new Stars(undefined, await rowsOf(context));
  }

  /** The repository as its row should say it: marked from the listing, or
   *  as the row last said. */
  mark(repository: RestRepository): RestRepository {
    if (this.read !== undefined) {
      const star = this.read.get(repository.node_id);
      return {
        ...repository,
        starred: star !== undefined,
        starred_at: star?.at ?? null,
      };
    }
    const row = this.rows.get(repository.node_id)?.properties;
    const starred = row?.["starred"];
    const at = row?.["starred_at"];
    return {
      ...repository,
      ...(typeof starred === "boolean" && { starred }),
      ...(typeof at === "string" && { starred_at: at }),
    };
  }

  starred(node: string): boolean {
    return this.read !== undefined
      ? this.read.has(node)
      : this.rows.get(node)?.properties["starred"] === true;
  }

  /**
   * After a scheduled run has read the repositories it syncs: brings in each
   * starred repository nothing else lists, as a repository row and no more,
   * and settles the rows a lost star leaves. `listed` repositories were
   * written by their own read. A row kept for a repository that is read some
   * other way, such as one paused, only loses its mark; one nothing keeps is
   * archived, and only when `complete` says every listing of the run
   * answered, since one that did not may be why a repository is missing.
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
    const gone: string[] = [];
    const unmarked: string[] = [];
    for (const row of await context.held(repositoryType, {
      state: "active",
    })) {
      const node = linkOf(row);
      if (node === undefined || where.listed.has(node) || read.has(node))
        continue;
      if (where.kept.has(node)) {
        if (
          row.properties["starred"] === true ||
          typeof row.properties["starred_at"] === "string"
        )
          unmarked.push(node);
      } else if (where.complete) {
        gone.push(node);
      }
    }
    if (gone.length > 0) await context.archive(repositoryType, gone);
    if (unmarked.length > 0)
      await context.derive(repositoryType, unmarked, {
        starred: false,
        starred_at: null,
      });
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
