import type { Entry } from "./define.js";
import { Refusal, type BulkResult, type Marfa, type NewRow } from "./marfa.js";
import { cleaned, instant, same, sameInstant } from "./values.js";

export interface Counts {
  created: number;
  updated: number;
  archived: number;
  unchanged: number;
  skipped: number;
}

/** The run was asked to stop, and made no write after it was. */
export class Stopped extends Error {
  override name = "Stopped";
  override message = "stopped before the run finished";
}

interface Row {
  id: string;
  properties: Record<string, unknown>;
  state: string;
  version: number;
  occurred_at: string | undefined;
}

/** Another writer got there first: the row moved or left since it was read. */
const raced = new Set([
  "version_conflict",
  "ancestor_unavailable",
  "item_not_found",
  "invalid_transition",
]);

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

/**
 * The connector's own rows, read once per run, and every write compared
 * with them first: only a new row is created and only a changed one is
 * updated. A trashed row is never written, because a person's bin wins over
 * the vendor.
 */
export class Rows {
  readonly counts: Counts = {
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 0,
    skipped: 0,
  };
  /** Writes that did not land, which hold the run's state where it was. */
  held = 0;
  private rows: Promise<Map<string, Row>> | undefined;

  constructor(
    private readonly marfa: Marfa,
    private readonly type: string,
    private readonly source: string,
    private readonly signal: AbortSignal,
    private readonly refused: (sourceId: string, reason: string) => void,
  ) {}

  async upsert(entries: readonly Entry[]): Promise<void> {
    const rows = await this.load();
    // The last of a repeated key wins, as the vendor's latest word on it.
    const latest = new Map(entries.map((entry) => [entry.source_id, entry]));
    const creates: NewRow[] = [];
    for (const entry of latest.values()) {
      const properties = cleaned(entry.properties);
      const occurredAt = instant(entry.occurred_at);
      const row = rows.get(entry.source_id);
      if (row === undefined) {
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
      this.checkStopped();
      try {
        const item = await this.marfa.update(
          row.id,
          row.version,
          properties,
          occurredAt,
        );
        rows.set(entry.source_id, {
          id: item.id,
          properties: item.properties,
          state: item.state,
          version: item.version,
          occurred_at: item.occurred_at,
        });
        // More than one step means another write landed between the read
        // and this one, and the server merged the two rather than replacing.
        if (item.version === row.version + 1) {
          this.counts.updated += 1;
        } else {
          this.counts.skipped += 1;
          this.held += 1;
        }
      } catch (error) {
        this.absorb(error, entry.source_id, refusedUpdate);
      }
    }
    for (const page of paged(creates)) await this.createPage(page, rows);
  }

  private async createPage(
    page: NewRow[],
    rows: Map<string, Row>,
  ): Promise<void> {
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
      await this.createPage(page.slice(0, half), rows);
      await this.createPage(page.slice(half), rows);
      return;
    }
    for (const result of results) {
      const created = page[result.index];
      if (created !== undefined) this.settle(result, created, rows);
    }
  }

  async archive(sourceIds: readonly string[]): Promise<void> {
    const rows = await this.load();
    for (const sourceId of new Set(sourceIds)) {
      const row = rows.get(sourceId);
      if (row === undefined) continue;
      if (row.state === "trashed") {
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
        this.counts.archived += 1;
      } catch (error) {
        this.absorb(error, sourceId, refusedUpdate);
      }
    }
  }

  /** Read once, however many calls ask for it at once. */
  private load(): Promise<Map<string, Row>> {
    this.rows ??= this.read();
    return this.rows;
  }

  private async read(): Promise<Map<string, Row>> {
    const items = await this.marfa.ownRows(this.type, this.source);
    const rows = new Map<string, Row>();
    for (const item of items) {
      // The type filter also answers types that inherit from this one,
      // whose rows are not this connector's to write.
      if (item.type !== this.type || item.source_id === undefined) continue;
      rows.set(item.source_id, {
        id: item.id,
        properties: item.properties,
        state: item.state,
        version: item.version,
        occurred_at: item.occurred_at,
      });
    }
    return rows;
  }

  private settle(
    result: BulkResult,
    created: NewRow,
    rows: Map<string, Row>,
  ): void {
    if (result.outcome === "created" && result.id !== undefined) {
      rows.set(created.source_id, {
        id: result.id,
        properties: created.properties,
        state: "active",
        version: 1,
        occurred_at: created.occurred_at,
      });
      this.counts.created += 1;
      return;
    }
    if (result.outcome === "skipped") {
      // A row trashed since the read: left alone like any trashed row.
      if (result.id !== undefined) {
        rows.set(created.source_id, {
          id: result.id,
          properties: created.properties,
          state: "trashed",
          version: 0,
          occurred_at: created.occurred_at,
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
        this.refused(sourceId, `${error.code}, ${error.detail}`);
      }
      return;
    }
    throw error;
  }

  private checkStopped(): void {
    if (this.signal.aborted) throw new Stopped();
  }
}
