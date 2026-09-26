import type { Change, Entry, Item } from "./define.js";
import { Refusal, type BulkResult, type Marfa, type NewRow } from "./marfa.js";
import { cleaned, instant, same, sameInstant } from "./values.js";
import type { Memory } from "./watch.js";

export interface Counts {
  created: number;
  updated: number;
  archived: number;
  unchanged: number;
  skipped: number;
  /** Rows changed on both sides since the two last agreed, decided by the later change. */
  conflicts: number;
}

/** The run was asked to stop, and made no write after it was. */
export class Stopped extends Error {
  override name = "Stopped";
  override message = "stopped before the run finished";
}

/** A link value another row of the type already carries. */
export class LinkTaken extends Error {
  override name = "LinkTaken";
}

interface Row {
  id: string;
  properties: Record<string, unknown>;
  state: string;
  version: number;
  occurred_at: string | undefined;
  /** The natural key, under the connector's own source only. */
  source_id: string | undefined;
  /** The row as the server answered it; absent for one created this run. */
  item: Item | undefined;
}

/** Another writer got there first: the row moved or left since it was read. */
const raced = new Set([
  "version_conflict",
  "ancestor_unavailable",
  "item_not_found",
  "invalid_transition",
]);

/** The write met another made since it read: the server merged or refused. */
const stale = new Set(["version_conflict", "ancestor_unavailable"]);

/**
 * What the server answers about one row: its contents, its size, or a
 * natural key that a row of another type already holds. On an update the
 * other validation codes describe the request rather than the row, so they
 * end the run instead of hiding a request the kit got wrong.
 */
const refusedUpdate = new Set(["invalid_properties", "request_too_large"]);
const refusedCreate = new Set([
  "invalid_properties",
  "validation_error",
  "type_mismatch",
  "request_too_large",
]);

/**
 * A bulk request's bounds, well inside the door's 5000 entries and 16 MiB,
 * so a page is rarely refused for its size; one that is is split in two.
 */
const pageEntries = 500;
const pageBytes = 4 * 1024 * 1024;

/** Creates in pages bounded by count and by bytes, in the order given. */
function paged(creates: readonly NewRow[]): NewRow[][] {
  const pages: NewRow[][] = [];
  let page: NewRow[] = [];
  let bytes = 0;
  for (const row of creates) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (
      page.length > 0 &&
      (page.length === pageEntries || bytes + size > pageBytes)
    ) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(row);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function rowOf(item: Item, ownSource: string): Row {
  return {
    id: item.id,
    properties: item.properties,
    state: item.state,
    version: item.version,
    occurred_at: item.occurred_at,
    source_id: item.source === ownSource ? item.source_id : undefined,
    item,
  };
}

/** Which of two changes came later; a side that names no time loses, and a tie is not later. */
function laterThan(
  candidate: string | undefined,
  other: string | undefined,
): boolean {
  if (candidate === undefined) return false;
  if (other === undefined) return true;
  const a = Date.parse(candidate);
  const b = Date.parse(other);
  return !Number.isNaN(a) && (Number.isNaN(b) || a > b);
}

/**
 * A transition the vendor's write proceeds beside whatever the times say:
 * an archive touches no property and asks nothing of the vendor. A
 * restore is met on its own below.
 */
function transition(change: Change): boolean {
  return change.kind === "archived";
}

/** How the rows are found and written back: with nothing carried back, or two-way. */
export interface RowsOptions {
  /** The property holding the vendor's id, where the connector declares one. */
  link: string | undefined;
  /**
   * The versions at which the two sides last agreed, by row: the
   * connector's own writes and the changes it carried back.
   */
  memory: Memory;
  /**
   * Changes read from the log this run, by row id, still to be carried to
   * the vendor. A write that meets one is decided by the later change;
   * the loser leaves the map or is never written. Absent for a connector
   * that carries nothing back.
   */
  pending: Map<string, Change> | undefined;
  refused: (sourceId: string, reason: string) => void;
  conflict: (id: string, message: string) => void;
}

/**
 * The connector's rows, read once per run, and every write compared with
 * them first: only a new row is created and only a changed one is
 * updated. A trashed row is never written, because a person's bin wins over
 * the vendor. With a link, the rows are every row of the type, found by
 * the link first and by the natural key second; without one, the rows
 * under the connector's own source, found by the natural key.
 */
export class Rows {
  readonly counts: Counts = {
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
  };
  /** Writes that did not land, which hold the run's state where it was. */
  held = 0;
  private loaded: Promise<void> | undefined;
  /** By link value, where the connector declares a link. */
  private readonly byLink = new Map<string, Row>();
  /** By natural key, under the connector's own source. */
  private readonly byKey = new Map<string, Row>();
  /** Rows counted as a conflict this run, so one is counted once. */
  private readonly conflicted = new Set<string>();

  constructor(
    private readonly marfa: Marfa,
    private readonly type: string,
    private readonly source: string,
    private readonly signal: AbortSignal,
    private readonly options: RowsOptions,
  ) {}

  async upsert(entries: readonly Entry[]): Promise<void> {
    await this.load();
    // The last of a repeated key wins, as the vendor's latest word on it.
    const latest = new Map(entries.map((entry) => [entry.source_id, entry]));
    const creates: NewRow[] = [];
    for (const entry of latest.values()) {
      const properties = cleaned(entry.properties);
      const occurredAt = instant(entry.occurred_at);
      const row = this.find(entry);
      if (row === undefined) {
        if (this.purged(entry)) {
          // A person emptied the bin of the row: the purge wins, and is
          // carried back rather than undone by a create.
          this.counts.skipped += 1;
          continue;
        }
        creates.push({
          source_id: entry.source_id,
          properties,
          ...(occurredAt !== undefined && { occurred_at: occurredAt }),
        });
        continue;
      }
      if (row.state === "trashed") {
        this.counts.skipped += 1;
        continue;
      }
      const timeUnchanged =
        occurredAt === undefined || sameInstant(row.occurred_at, occurredAt);
      if (same(row.properties, properties) && timeUnchanged) {
        this.counts.unchanged += 1;
        continue;
      }
      if (!this.vendorWins(row, entry)) continue;
      this.checkStopped();
      try {
        const item = await this.marfa.update(
          row.id,
          row.version,
          properties,
          occurredAt,
        );
        this.remember(item);
        // More than one step means another write landed between the read
        // and this one, and the row holds that writer's changes beside this
        // run's.
        if (item.version === row.version + 1) {
          this.counts.updated += 1;
        } else {
          await this.raced(row, entry, properties, occurredAt, item);
        }
      } catch (error) {
        if (
          error instanceof Refusal &&
          stale.has(error.code) &&
          this.options.pending !== undefined
        ) {
          await this.raced(row, entry, properties, occurredAt, undefined);
          continue;
        }
        this.absorb(error, entry.source_id, refusedUpdate);
      }
    }
    for (const page of paged(creates)) await this.createPage(page);
  }

  /** The row an entry names: by its link value, then by its natural key. */
  private find(entry: Entry): Row | undefined {
    const value = this.linkOf(entry.properties);
    if (value !== undefined) {
      const linked = this.byLink.get(value);
      if (linked !== undefined) return linked;
    }
    return this.byKey.get(entry.source_id);
  }

  /** Whether a purge of the entry's row is waiting to be carried back. */
  private purged(entry: Entry): boolean {
    const pending = this.options.pending;
    if (pending === undefined) return false;
    const value = this.linkOf(entry.properties);
    for (const change of pending.values()) {
      if (change.kind !== "purged") continue;
      const { item } = change;
      if (value !== undefined && this.linkOf(item.properties) === value) {
        return true;
      }
      if (item.source === this.source && item.source_id === entry.source_id) {
        return true;
      }
    }
    return false;
  }

  private linkOf(
    properties: Readonly<Record<string, unknown>>,
  ): string | undefined {
    const link = this.options.link;
    if (link === undefined) return undefined;
    const value = properties[link];
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  /**
   * Whether the vendor's entry is written over a row that changed in Marfa
   * since the two sides last agreed. The memory holds that version, from
   * the connector's own writes and the changes it carried back; a row past
   * it has been changed by somebody else since, whether or not the log
   * read showed it, since a read cut short cannot hide a moved version. A
   * row the memory knows nothing of takes the vendor's word. An archive
   * touches no property: the write proceeds and the archive is still
   * carried back. Otherwise the later change wins; the loser is a
   * condition, and where the vendor loses its entry is not written and the
   * row's state is carried back. A trash in Marfa is met before this, as
   * any trashed row is.
   */
  private vendorWins(row: Row, entry: Entry): boolean {
    const pending = this.options.pending;
    if (pending === undefined) return true;
    let change = pending.get(row.id);
    if (change === undefined) {
      const record = this.options.memory.written[row.id];
      if (
        record === undefined ||
        (record.version === row.version && record.state === row.state) ||
        row.item === undefined
      ) {
        return true;
      }
      // What moved is what the row shows: a state the record does not
      // hold is a transition, decided as one; a version moved is an
      // update, decided by the times.
      const kind =
        row.state !== record.state
          ? row.state === "archived"
            ? "archived"
            : "restored"
          : "updated";
      change = { kind, item: row.item };
      pending.set(row.id, change);
    }
    if (transition(change)) return true;
    if (change.kind === "restored") {
      // What the vendor sends after a trash was carried back can be the
      // echo of what the trash did there. An entry from before the restore
      // is left unwritten and nothing is lost: carrying the restore moves
      // the vendor's copy, and a change of the vendor's own comes again
      // with it. A later entry is a change of its own and is written. The
      // restore is carried back either way, since it touches no property.
      return laterThan(entry.changed_at, change.item.updated_at);
    }
    this.conflict(row.id);
    if (laterThan(entry.changed_at, change.item.updated_at)) {
      pending.delete(row.id);
      this.options.conflict(
        row.id,
        `the vendor's change to ${row.id} is the later one, so the change made in Marfa is not carried back`,
      );
      return true;
    }
    this.options.conflict(
      row.id,
      `the change made in Marfa to ${row.id} is the later one, so the vendor's is not written and the row's state is carried back`,
    );
    return false;
  }

  private conflict(id: string): void {
    if (this.conflicted.has(id)) return;
    this.conflicted.add(id);
    this.counts.conflicts += 1;
  }

  /**
   * The write met a change made between the read and the write: merged,
   * where nothing collided, or refused. For a connector that carries
   * nothing back the state is held for a run that reads the row as it now
   * is. For one that does, the later change decides: the vendor's is
   * written again over the row as it now stands, once; or the row is put
   * back as the person left it, where the merge changed it, and its state
   * is carried back to the vendor.
   */
  private async raced(
    row: Row,
    entry: Entry,
    properties: Record<string, unknown>,
    occurredAt: string | undefined,
    merged: Item | undefined,
  ): Promise<void> {
    const pending = this.options.pending;
    if (pending === undefined) {
      this.counts.skipped += 1;
      this.held += 1;
      return;
    }
    const current = await this.marfa.item(row.id);
    if (current === undefined) {
      this.counts.skipped += 1;
      this.held += 1;
      return;
    }
    this.conflict(row.id);
    // When the person's change was made. A refused write left the row as
    // the person wrote it. A merged one moved it a step past that, writing
    // the snapshot of the person's state at its own moment; the person's
    // moment is the one that wrote the snapshot before that. A transition
    // writes a snapshot of its version too, without moving it, so the
    // latest of a version's snapshots is the one that left it.
    const theirs =
      merged === undefined
        ? current.updated_at
        : latestSnapshot(await this.marfa.versions(row.id), merged.version - 2)
            ?.created_at;
    if (laterThan(entry.changed_at, theirs)) {
      this.options.conflict(
        row.id,
        `the vendor's change to ${row.id} is the later one and is written over the change made in Marfa since the read`,
      );
      pending.delete(row.id);
      try {
        const item = await this.marfa.update(
          current.id,
          current.version,
          properties,
          occurredAt,
        );
        this.remember(item);
        this.counts.updated += 1;
      } catch (error) {
        this.absorb(error, entry.source_id, refusedUpdate);
      }
      return;
    }
    this.options.conflict(
      row.id,
      `the change made in Marfa to ${row.id} since the read is the later one, so the vendor's is not written and the row's state is carried back`,
    );
    let standing = current;
    if (merged !== undefined) {
      // Put back whole from the snapshot the merge was applied over, so
      // nothing stays merged property by property.
      const before = latestSnapshot(
        await this.marfa.versions(row.id),
        merged.version - 1,
      );
      if (before !== undefined) {
        try {
          standing = await this.marfa.update(
            current.id,
            current.version,
            before.properties,
            undefined,
          );
          this.remember(standing);
        } catch (error) {
          this.absorb(error, entry.source_id, refusedUpdate);
          return;
        }
      }
    }
    pending.set(standing.id, { kind: "updated", item: standing });
  }

  private async createPage(page: NewRow[]): Promise<void> {
    this.checkStopped();
    let results;
    try {
      results = await this.marfa.create(this.type, this.source, page);
    } catch (error) {
      const first = page[0];
      if (
        !(error instanceof Refusal) ||
        error.status !== 413 ||
        first === undefined
      ) {
        throw error;
      }
      if (page.length === 1) {
        this.absorb(error, first.source_id, refusedCreate);
        return;
      }
      const half = Math.ceil(page.length / 2);
      await this.createPage(page.slice(0, half));
      await this.createPage(page.slice(half));
      return;
    }
    for (const result of results) {
      const created = page[result.index];
      if (created !== undefined) this.settle(result, created);
    }
  }

  /**
   * Archives the rows the keys name: link values with a link, natural keys
   * without.
   */
  async archive(keys: readonly string[]): Promise<void> {
    await this.load();
    for (const key of new Set(keys)) {
      const row =
        this.options.link === undefined
          ? this.byKey.get(key)
          : this.byLink.get(key);
      if (row === undefined) continue;
      if (row.state === "trashed") {
        this.counts.skipped += 1;
        continue;
      }
      // A row a person restored since the two sides last agreed is not
      // put away again on the vendor's word: what the vendor deleted can
      // be the echo of the trash that was carried back, and the restore,
      // still pending, is carried and reinstates the vendor's copy.
      if (this.options.pending?.get(row.id)?.kind === "restored") {
        this.counts.skipped += 1;
        continue;
      }
      if (row.state === "archived") {
        this.counts.unchanged += 1;
        continue;
      }
      this.checkStopped();
      try {
        await this.marfa.archive(row.id);
        row.state = "archived";
        this.options.memory.remember(row.id, row.version, "archived");
        this.counts.archived += 1;
      } catch (error) {
        this.absorb(error, key, refusedUpdate);
      }
    }
  }

  /**
   * Writes the vendor's id onto a row's link property at the version the
   * change showed, once more at the current version if the row moved
   * since. A value another row carries is refused, naming both.
   */
  async setLink(item: Item, value: string): Promise<void> {
    const link = this.options.link;
    if (link === undefined) {
      throw new Error("the connector declares no link property to write");
    }
    await this.load();
    const holder = this.byLink.get(value);
    if (holder !== undefined && holder.id !== item.id) {
      throw new LinkTaken(
        `the link ${value} is already carried by ${holder.id}, so it is not written onto ${item.id}`,
      );
    }
    this.checkStopped();
    let written: Item;
    try {
      written = await this.marfa.merge(item.id, item.version, {
        [link]: value,
      });
    } catch (error) {
      if (!(error instanceof Refusal) || !stale.has(error.code)) throw error;
      const current = await this.marfa.item(item.id);
      if (current === undefined) {
        throw new Refusal(404, "item_not_found", `${item.id} is gone`);
      }
      written = await this.marfa.merge(current.id, current.version, {
        [link]: value,
      });
    }
    this.remember(written);
  }

  /** Read once, however many calls ask for it at once. */
  private load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    const link = this.options.link;
    const items = await this.marfa.ownRows(
      this.type,
      link === undefined ? this.source : undefined,
    );
    for (const item of items) {
      // The type filter also answers types that inherit from this one,
      // whose rows are not this connector's to write.
      if (item.type !== this.type) continue;
      this.index(rowOf(item, this.source));
    }
  }

  private index(row: Row): void {
    if (row.source_id !== undefined) this.byKey.set(row.source_id, row);
    const value = this.linkOf(row.properties);
    if (value !== undefined) this.byLink.set(value, row);
  }

  /** A write of the connector's own, as the rows and the memory now hold it. */
  private remember(item: Item): void {
    this.index(rowOf(item, this.source));
    this.options.memory.remember(item.id, item.version, item.state);
  }

  private settle(result: BulkResult, created: NewRow): void {
    if (result.outcome === "created" && result.id !== undefined) {
      this.index({
        id: result.id,
        properties: created.properties,
        state: "active",
        version: 1,
        occurred_at: created.occurred_at,
        source_id: created.source_id,
        item: undefined,
      });
      this.options.memory.remember(result.id, 1, "active");
      this.counts.created += 1;
      return;
    }
    if (result.outcome === "skipped") {
      // A row trashed since the read: left alone like any trashed row.
      if (result.id !== undefined) {
        this.index({
          id: result.id,
          properties: created.properties,
          state: "trashed",
          version: 0,
          occurred_at: created.occurred_at,
          source_id: created.source_id,
          item: undefined,
        });
      }
      this.counts.skipped += 1;
      return;
    }
    const code = result.error?.code ?? "unknown";
    const message = result.error?.message ?? result.outcome;
    this.absorb(
      new Refusal(undefined, code, message),
      created.source_id,
      refusedCreate,
    );
  }

  /**
   * A refusal that concerns one row is counted and holds the state; any
   * other ends the run, since it would refuse every row after it too.
   */
  private absorb(
    error: unknown,
    sourceId: string,
    refusedRow: ReadonlySet<string>,
  ): void {
    if (
      error instanceof Refusal &&
      (raced.has(error.code) || refusedRow.has(error.code))
    ) {
      this.counts.skipped += 1;
      this.held += 1;
      if (refusedRow.has(error.code)) {
        this.options.refused(sourceId, `${error.code}, ${error.detail}`);
      }
      return;
    }
    throw error;
  }

  private checkStopped(): void {
    if (this.signal.aborted) throw new Stopped();
  }
}

/** The snapshot that left a version, the latest of any it has. */
function latestSnapshot(
  versions: readonly {
    version: number;
    properties: Record<string, unknown>;
    created_at: string;
  }[],
  version: number,
): { properties: Record<string, unknown>; created_at: string } | undefined {
  let found:
    { properties: Record<string, unknown>; created_at: string } | undefined;
  for (const candidate of versions) {
    if (candidate.version !== version) continue;
    if (found === undefined || candidate.created_at > found.created_at) {
      found = candidate;
    }
  }
  return found;
}
