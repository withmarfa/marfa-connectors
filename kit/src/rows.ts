import type { Entry } from "./define.js";
import { Refusal, type BulkResult, type Marfa, type NewRow } from "./marfa.js";
import { cleaned, same, sameInstant } from "./values.js";

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

/** The row itself is what the server refused, not the key or the request. */
const refusedRow = new Set([
  "invalid_properties",
  "validation_error",
  "missing_required_field",
]);

/** Big enough that a first read is a handful of requests, small enough to stay well under the door's cap. */
const createPage = 500;

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
  private rows: Map<string, Row> | undefined;

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
      const row = rows.get(entry.source_id);
      if (row === undefined) {
        creates.push({
          source_id: entry.source_id,
          properties,
          ...(entry.occurred_at !== undefined && {
            occurred_at: entry.occurred_at,
          }),
        });
        continue;
      }
      if (row.state === "trashed") {
        this.counts.skipped += 1;
        continue;
      }
      const timeUnchanged =
        entry.occurred_at === undefined ||
        sameInstant(row.occurred_at, entry.occurred_at);
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
          entry.occurred_at,
        );
        rows.set(entry.source_id, {
          id: item.id,
          properties: item.properties,
          state: item.state,
          version: item.version,
          occurred_at: item.occurred_at,
        });
        this.counts.updated += 1;
      } catch (error) {
        this.absorb(error, entry.source_id);
      }
    }
    for (let start = 0; start < creates.length; start += createPage) {
      this.checkStopped();
      const page = creates.slice(start, start + createPage);
      const results = await this.marfa.create(this.type, this.source, page);
      for (const result of results) {
        const created = page[result.index];
        if (created !== undefined) this.settle(result, created, rows);
      }
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
        this.absorb(error, sourceId);
      }
    }
  }

  private async load(): Promise<Map<string, Row>> {
    if (this.rows !== undefined) return this.rows;
    const items = await this.marfa.ownRows(this.type, this.source);
    const rows = new Map<string, Row>();
    for (const item of items) {
      if (item.source_id === undefined) continue;
      rows.set(item.source_id, {
        id: item.id,
        properties: item.properties,
        state: item.state,
        version: item.version,
        occurred_at: item.occurred_at,
      });
    }
    this.rows = rows;
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
    this.absorb(new Refusal(undefined, code, message), created.source_id);
  }

  /**
   * A refusal that concerns one row is counted and holds the state; any
   * other ends the run, since it would refuse every row after it too.
   */
  private absorb(error: unknown, sourceId: string): void {
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
