import type {
  Entry,
  EnvDeclaration,
  Item,
  RunContext,
  State,
} from "@withmarfa/connector";
import { RequestError } from "@octokit/request-error";
import {
  childOf,
  inRepository,
  repositoryType,
  type RestRepository,
} from "./entries.js";
import {
  PermissionRequired,
  rateLimited,
  status,
  unlessUnchanged,
  type Client,
} from "./github.js";

export const repositoryFileType = "github.repository_file";
export const directoryType = "github.directory";
export const inCollection = "in-collection";

type Context = Pick<
  RunContext<EnvDeclaration>,
  "held" | "upsert" | "archive" | "derive" | "linked" | "log" | "signal"
>;

/** What GITHUB_FILES names in one repository. */
export interface FilesEntry {
  /** As owner/name, lowercase, since GitHub's names ignore case. */
  readonly repository: string;
  /** Paths from the repository's root, without leading or trailing slashes,
   *  each a directory or a Markdown file. */
  readonly paths: readonly string[];
}

const repositoryName = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** The setting's entries, or a start refused with the entry that is wrong. */
export function filesOf(value: string | undefined): FilesEntry[] {
  if (value === undefined) return [];
  const byName = new Map<string, Set<string>>();
  for (const one of value.split(/[\s;]+/).filter((text) => text !== "")) {
    const colon = one.indexOf(":");
    const name = colon < 0 ? "" : one.slice(0, colon).toLowerCase();
    const paths =
      colon < 0
        ? []
        : one
            .slice(colon + 1)
            .split(",")
            .map((path) => path.replace(/^\/+|\/+$/g, ""));
    const wrong =
      !repositoryName.test(name) ||
      paths.length === 0 ||
      paths.some(
        (path) =>
          path === "" ||
          path.includes("\\") ||
          // eslint-disable-next-line no-control-regex
          /[\u0000-\u001f]/.test(path) ||
          path.split("/").some((part) => ["", ".", ".."].includes(part)),
      );
    if (wrong)
      throw new Error(
        `GITHUB_FILES holds ${one}, where each entry is owner/repo:path, with paths set apart by commas and entries by spaces or semicolons, and each path a directory or file in the repository, such as docs or docs/guide.md`,
      );
    const held = byName.get(name) ?? new Set<string>();
    for (const path of paths) held.add(path);
    byName.set(name, held);
  }
  return [...byName].map(([repository, paths]) => ({
    repository,
    paths: [...paths].sort(),
  }));
}

/** Larger files are skipped: a body this long is not a note, and the
 *  instance caps a request well above it. */
export const sizeAtMost = 512 * 1024;

/** File names that say what a file is for rather than what it is about, so
 *  the directory holding one names it better. */
const generic = new Set(["readme", "index", "skill", "agents", "claude"]);

const markdown = /\.(?:md|markdown)$/i;

/** The most files one condition names. */
const namedAtMost = 10;

/** The saved state, by repository node: what the last complete read of the
 *  repository's files saw, so an unchanged branch costs one request. */
const savedKey = "repository-files";

interface Saved {
  readonly etag: string;
  readonly branch: string;
  readonly private: boolean;
  readonly paths: readonly string[];
}

function savedOf(state: State): Record<string, Saved> {
  const value = state.get(savedKey);
  return typeof value === "object" && value !== null
    ? { ...(value as Record<string, Saved>) }
    : {};
}

/** Forgets what was read of a repository taken out of the sync, so its files
 *  are read whole if it comes back. */
export function forgetFiles(state: State, node: string): void {
  const saved = savedOf(state);
  if (saved[node] === undefined) return;
  Reflect.deleteProperty(saved, node);
  state.set(savedKey, saved);
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function fileKey(node: string, path: string): string {
  return `${node}:${path}`;
}

/** A directory's key ends in a slash, so it never meets a file's. */
function directoryKey(node: string, path: string): string {
  return `${node}:${path}/`;
}

export function titleOf(path: string): string {
  const stem = baseOf(path).replace(markdown, "");
  const parent = baseOf(parentOf(path));
  return generic.has(stem.toLowerCase()) && parent !== "" ? parent : stem;
}

function encoded(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

interface TreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
  size?: unknown;
}

interface Tree {
  sha?: unknown;
  truncated?: unknown;
  tree?: unknown;
}

interface Blob {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

/** Why GitHub would not give the tree or a blob, for a condition. */
function refusal(error: unknown): string | undefined {
  if (error instanceof PermissionRequired) return error.message;
  if (
    error instanceof RequestError &&
    error.status === 422 &&
    error.request.url.endsWith("/access_tokens")
  )
    return "the App's installation has not accepted the Contents permission";
  const code = status(error);
  return code === undefined ? undefined : `GitHub answered ${String(code)}`;
}

/** Each held row of the type under the repository, by path. */
function heldUnder(
  rows: readonly Item[],
  node: string,
  directory: boolean,
): Map<string, Item> {
  const prefix = `${node}:`;
  const found = new Map<string, Item>();
  for (const row of rows) {
    const key = row.source_id;
    if (key?.startsWith(prefix) !== true) continue;
    const path = key.slice(prefix.length);
    if (directory !== path.endsWith("/")) continue;
    found.set(directory ? path.slice(0, -1) : path, row);
  }
  return found;
}

function decoded(bytes: Buffer): string | undefined {
  try {
    // A byte order mark is dropped, as the decoder does unless told not to.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export interface Synced {
  readonly repository: RestRepository;
  readonly octokit: Client | undefined;
}

export interface FilesRun {
  /** The repositories the run syncs, by lowercase full name. */
  readonly synced: ReadonlyMap<string, Synced>;
  /** The repositories GITHUB_REPOSITORIES pauses, by lowercase full name. */
  readonly paused: ReadonlySet<string>;
  /** Whether every listing of the run answered, without which a repository
   *  missing from it may still be there. */
  readonly complete: boolean;
  readonly reached: (...keys: string[]) => void;
  /** Names a repository whose files wait for GitHub's rate limit. */
  readonly waiting: (name: string) => void;
}

/**
 * Mirrors the Markdown files under the paths GITHUB_FILES names, from each
 * repository's default branch, with a collection for each directory that
 * holds them. GitHub is the source: these kinds are read only, so the kit
 * puts back a change made in Marfa.
 */
export async function syncFiles(
  context: Context,
  state: State,
  entries: readonly FilesEntry[],
  run: FilesRun,
): Promise<void> {
  if (entries.length === 0) return;
  const saved = savedOf(state);
  let files: Item[] | undefined;
  let directories: Item[] | undefined;
  const rows = async () => {
    files ??= await context.held(repositoryFileType, { state: "any" });
    directories ??= await context.held(directoryType, { state: "any" });
    return { files, directories };
  };
  for (const entry of entries) {
    const key = `files-unsynced:${entry.repository}`;
    const at = run.synced.get(entry.repository);
    if (at === undefined) {
      if (!run.complete) continue;
      run.reached(key);
      context.log.condition(
        key,
        run.paused.has(entry.repository)
          ? `GITHUB_FILES names ${entry.repository}, which GITHUB_REPOSITORIES leaves out, so its files are not read and their rows are left as they are`
          : `GITHUB_FILES names ${entry.repository}, which the run does not sync, so none of its files are read`,
      );
      continue;
    }
    run.reached(key);
    if (at.octokit === undefined) continue;
    try {
      const next = await syncRepositoryFiles(
        context,
        at.octokit,
        at.repository,
        entry.paths,
        saved[at.repository.node_id],
        rows,
        run.reached,
      );
      if (next === undefined)
        Reflect.deleteProperty(saved, at.repository.node_id);
      else saved[at.repository.node_id] = next;
    } catch (error) {
      if (context.signal.aborted || !rateLimited(error)) throw error;
      run.waiting(`${at.repository.full_name}'s files`);
    }
  }
  state.set(savedKey, saved);
}

/** Reads one repository's files and writes what changed; returns what to
 *  save, or nothing where the run read the tree but not all of it, so the
 *  next run reads it whole even if the branch is back as it was. */
async function syncRepositoryFiles(
  context: Context,
  octokit: Client,
  repository: RestRepository,
  paths: readonly string[],
  before: Saved | undefined,
  rows: () => Promise<{ files: Item[]; directories: Item[] }>,
  reached: (...keys: string[]) => void,
): Promise<Saved | undefined> {
  const node = repository.node_id;
  const name = repository.full_name;
  const [owner = "", repo = ""] = name.split("/");
  const branch = repository.default_branch ?? "main";
  const unlisted = `files-unlisted:${node}`;
  const same =
    before?.branch === branch &&
    before.private === repository.private &&
    before.paths.join("\n") === paths.join("\n");
  let answer: { data: unknown; etag: string | undefined } | undefined;
  try {
    answer = await unlessUnchanged(
      octokit,
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: branch, recursive: 1 },
      same ? before.etag : undefined,
    );
  } catch (error) {
    if (context.signal.aborted || rateLimited(error)) throw error;
    if (status(error) === 401 && !(error instanceof PermissionRequired))
      throw error;
    const why = refusal(error);
    if (why === undefined) throw error;
    reached(unlisted);
    context.log.condition(
      unlisted,
      `${name}: ${why} for the files of its default branch, ${branch}, so its files are left as they are; the other kinds keep syncing`,
    );
    return before;
  }
  reached(unlisted);
  if (answer === undefined) return before;
  const tree = answer.data as Tree;
  const truncated = tree.truncated === true;
  if (truncated)
    context.log.condition(
      unlisted,
      `${name}: GitHub cut the tree of ${branch} short, so files are added and updated but none is archived, and a moved file may be made anew`,
    );
  const listing = (Array.isArray(tree.tree) ? tree.tree : []) as TreeEntry[];
  const blobs = new Map<string, Blob>();
  const trees = new Set<string>();
  for (const one of listing) {
    if (typeof one.path !== "string") continue;
    if (one.type === "tree") trees.add(one.path);
    else if (one.type === "blob" && typeof one.sha === "string")
      blobs.set(one.path, {
        path: one.path,
        sha: one.sha,
        size: typeof one.size === "number" ? one.size : 0,
      });
  }
  // A path the tree does not hold is missing, unless a cut tree left it out.
  const roots = paths.filter((path) => trees.has(path) || blobs.has(path));
  const missing = truncated
    ? []
    : paths.filter((path) => !roots.includes(path));
  const missingKey = `files-missing:${node}`;
  reached(missingKey);
  if (missing.length > 0)
    context.log.condition(
      missingKey,
      `GITHUB_FILES names ${missing.map((path) => `${name}:${path}`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not on ${branch}, so nothing under ${missing.length === 1 ? "it" : "them"} is archived`,
    );
  const skipped: string[] = [];
  const skippedPaths = new Set<string>();
  const skip = (path: string, why: string) => {
    skipped.push(`${path} (${why})`);
    skippedPaths.add(path);
  };
  const chosen = new Map<string, Blob>();
  for (const blob of blobs.values()) {
    if (!markdown.test(blob.path)) continue;
    if (!roots.some((root) => within(blob.path, root))) continue;
    if (blob.size > sizeAtMost) skip(blob.path, "over 512 KiB");
    else chosen.set(blob.path, blob);
  }
  const held = await rows();
  const everyFile = heldUnder(held.files, node, false);
  const everyDirectory = heldUnder(held.directories, node, true);
  const active = (byPath: Map<string, Item>) =>
    new Map([...byPath].filter(([, row]) => row.state === "active"));
  const heldFiles = active(everyFile);
  const heldDirectories = active(everyDirectory);
  // A skipped file keeps its row, so the directory holding it stays too.
  const included = new Set<string>();
  for (const path of [
    ...chosen.keys(),
    ...[...skippedPaths].filter((path) => heldFiles.has(path)),
  ]) {
    const root = roots
      .filter((one) => trees.has(one) && within(path, one))
      .sort((a, b) => a.length - b.length)[0];
    if (root === undefined) continue;
    for (let at = parentOf(path); within(at, root); at = parentOf(at)) {
      included.add(at);
      if (at === root) break;
    }
  }
  const base = repository.html_url;
  const fileUrl = (path: string) =>
    `${base}/blob/${encoded(branch)}/${encoded(path)}`;
  const directoryUrl = (path: string) =>
    `${base}/tree/${encoded(branch)}/${encoded(path)}`;
  const kept = (path: string) =>
    roots.some((root) => within(path, root)) && !truncated;
  // A file in neither the tree's choice nor its skipped list is gone.
  const vanished = [...heldFiles.keys()].filter(
    (path) => kept(path) && !chosen.has(path) && !skippedPaths.has(path),
  );
  const moves = pairMoves(
    vanished.map((path) => ({
      path,
      sha: heldFiles.get(path)?.properties["blob_sha"],
    })),
    // A path with a row in any state takes its own row back, not another's.
    [...chosen.values()].filter((blob) => !everyFile.has(blob.path)),
  );
  const directoryMoves = pairDirectoryMoves(
    moves,
    (path) => heldDirectories.has(path) && !included.has(path),
    (path) => included.has(path) && !everyDirectory.has(path),
  );
  let complete = !truncated;
  const fileEntries: Entry[] = [];
  for (const blob of chosen.values()) {
    const row = everyFile.get(blob.path);
    const url = fileUrl(blob.path);
    // A row in the bin takes no entry, so its blob is not read.
    if (
      row?.state === "trashed" ||
      (row?.state === "active" &&
        row.properties["blob_sha"] === blob.sha &&
        row.properties["url"] === url)
    )
      continue;
    let body: string | undefined;
    try {
      const answered = await octokit.request(
        "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
        { owner, repo, file_sha: blob.sha },
      );
      const data = answered.data as { content?: unknown; encoding?: unknown };
      if (data.encoding !== "base64" || typeof data.content !== "string")
        throw new Error(`GitHub gave ${blob.path} in no encoding it reads`);
      const bytes = Buffer.from(data.content, "base64");
      if (bytes.length > sizeAtMost) {
        skip(blob.path, "over 512 KiB");
        continue;
      }
      body = decoded(bytes);
      if (body === undefined) {
        skip(blob.path, "not UTF-8 text");
        continue;
      }
    } catch (error) {
      if (context.signal.aborted || rateLimited(error)) throw error;
      // Read again next run, so nothing is archived while it is unread.
      complete = false;
      skip(
        blob.path,
        refusal(error) ??
          (error instanceof Error ? error.message : String(error)),
      );
      continue;
    }
    const directory = parentOf(blob.path);
    fileEntries.push({
      source_id: fileKey(node, blob.path),
      properties: {
        title: titleOf(blob.path),
        body,
        repository: name,
        path: blob.path,
        blob_sha: blob.sha,
        url,
        private: repository.private,
      },
      ...(moves.has(blob.path) && {
        movedFrom: fileKey(node, moves.get(blob.path) ?? ""),
      }),
      connections: {
        [inCollection]: included.has(directory)
          ? [{ type: directoryType, id: directoryKey(node, directory) }]
          : [],
        [inRepository]: [{ type: repositoryType, id: node }],
      },
    });
  }
  const directoryEntries: Entry[] = [...included].sort().map((path) => {
    const parent = parentOf(path);
    return {
      source_id: directoryKey(node, path),
      properties: {
        title: baseOf(path),
        repository: name,
        path,
        url: directoryUrl(path),
        private: repository.private,
      },
      ...(directoryMoves.has(path) && {
        movedFrom: directoryKey(node, directoryMoves.get(path) ?? ""),
      }),
      connections: {
        [childOf]:
          path !== parent && included.has(parent)
            ? [{ type: directoryType, id: directoryKey(node, parent) }]
            : [],
        [inRepository]: [{ type: repositoryType, id: node }],
      },
    };
  });
  if (directoryEntries.length > 0)
    await context.upsert(directoryType, directoryEntries);
  if (fileEntries.length > 0)
    await context.upsert(repositoryFileType, fileEntries);
  const skippedKey = `files-skipped:${node}`;
  reached(skippedKey);
  if (skipped.length > 0) {
    const more = skipped.length - namedAtMost;
    context.log.condition(
      skippedKey,
      `${name}: these files are not synced, and any row they had is left as it is: ${skipped.slice(0, namedAtMost).join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`,
    );
  }
  if (complete) {
    const moved = new Set(moves.values());
    const gone = vanished.filter((path) => !moved.has(path));
    if (gone.length > 0)
      await context.archive(
        repositoryFileType,
        gone.map((path) => fileKey(node, path)),
      );
    const movedDirectories = new Set(directoryMoves.values());
    const empty = [...heldDirectories.keys()].filter(
      (path) =>
        kept(path) && !included.has(path) && !movedDirectories.has(path),
    );
    if (empty.length > 0)
      await context.archive(
        directoryType,
        empty.map((path) => directoryKey(node, path)),
      );
  }
  if (before?.private !== repository.private) {
    const files = [...heldFiles.keys()].map((path) => fileKey(node, path));
    const folders = [...heldDirectories.keys()].map((path) =>
      directoryKey(node, path),
    );
    if (files.length > 0)
      await context.derive(repositoryFileType, files, {
        private: repository.private,
      });
    if (folders.length > 0)
      await context.derive(directoryType, folders, {
        private: repository.private,
      });
  }
  return complete && answer.etag !== undefined
    ? {
        etag: answer.etag,
        branch,
        private: repository.private,
        paths: [...paths],
      }
    : undefined;
}

/** Each new path whose contents a vanished one held, by the path it moved
 *  from; where several share contents, they pair in path order. */
function pairMoves(
  vanished: readonly { path: string; sha: unknown }[],
  arrived: readonly Blob[],
): Map<string, string> {
  const bySha = new Map<string, string[]>();
  for (const one of [...vanished].sort((a, b) => a.path.localeCompare(b.path)))
    if (typeof one.sha === "string")
      bySha.set(one.sha, [...(bySha.get(one.sha) ?? []), one.path]);
  const moves = new Map<string, string>();
  for (const blob of [...arrived].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const from = bySha.get(blob.sha)?.shift();
    if (from !== undefined) moves.set(blob.path, from);
  }
  return moves;
}

/** A directory renamed with its files: each directory a file move leaves
 *  and the one it reaches, where only that pair says so. */
function pairDirectoryMoves(
  moves: ReadonlyMap<string, string>,
  left: (path: string) => boolean,
  arrived: (path: string) => boolean,
): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const [to, from] of moves) {
    let a = parentOf(from);
    let b = parentOf(to);
    while (a !== "" && b !== "" && a !== b) {
      if (left(a) && arrived(b))
        seen.set(b, new Set([...(seen.get(b) ?? []), a]));
      a = parentOf(a);
      b = parentOf(b);
    }
  }
  const sources = new Map<string, number>();
  for (const froms of seen.values())
    for (const from of froms) sources.set(from, (sources.get(from) ?? 0) + 1);
  const pairs = new Map<string, string>();
  for (const [to, froms] of seen) {
    const [from] = froms;
    if (froms.size === 1 && from !== undefined && sources.get(from) === 1)
      pairs.set(to, from);
  }
  return pairs;
}

/** Archives a repository's files and directories, as a repository taken out
 *  of the sync. */
export async function takeOutFiles(
  context: Pick<Context, "linked" | "archive">,
  node: string,
): Promise<void> {
  const under = { type: repositoryType, id: node };
  for (const type of [repositoryFileType, directoryType]) {
    const keys = (await context.linked(type, inRepository, under)).flatMap(
      (row) => (row.source_id === undefined ? [] : [row.source_id]),
    );
    if (keys.length > 0) await context.archive(type, keys);
  }
}
