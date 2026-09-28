import {
  held,
  laterThan,
  mark,
  merge,
  sideOf,
  unchangedAtVendor,
  type Agreement,
  type Merged,
} from "./agreement.js";
import type { Entry, Item } from "./define.js";
import { Refusal, type BulkResult, type Marfa, type NewRow } from "./marfa.js";
import type { Store } from "./store.js";
import { cleaned, instant } from "./values.js";

export interface Counts {
  created: number;
  updated: number;
  archived: number;
  unchanged: number;
  skipped: number;
  /** Rows where both sides changed one field, each decided by the later change. */
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

/** What the kit knows of the connector's type. */
export interface Kind {
  readonly type: string;
  readonly source: string;
  /** The property holding the vendor's own id, where the connector declares one. */
  readonly link: string | undefined;
  /** The properties the vendor holds. */
  readonly fields: readonly string[];
  /** The fields Marfa mirrors from the vendor and never carries. */
  readonly readOnly: ReadonlySet<string>;
  /** The connector carries changes back. */
  readonly twoWay: boolean;
}

/** A state change waiting to be carried, beside the fields. */
export const stateKey = "@state";

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

/** The hooks a run hands the rows, to say what it met. */
export interface Hooks {
  refused(sourceId: string, reason: string): void;
  condition(key: string, message: string): void;
}

/**
 * The connector's rows, read once per run: each entry is merged with its row
 * field by field against the agreement, and a trashed row is never written.
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
  /** Rows that took the vendor's values with nothing agreed. */
  seeded = 0;
  /** Rows purged this run, by `link:` and by `key:`, which are not written again. */
  readonly purged = new Set<string>();
  /** Rows this run's reads left with something in Marfa to carry. */
  readonly marked = new Set<string>();
  private loaded: Promise<void> | undefined;
  private readonly byId = new Map<string, Item>();
  private readonly byLink = new Map<string, string>();
  private readonly byKey = new Map<string, string>();
  private readonly linkByRow = new Map<string, string>();

  constructor(
    private readonly marfa: Marfa,
    private readonly kind: Kind,
    private readonly store: Store,
    private readonly signal: AbortSignal,
    private readonly hooks: Hooks,
  ) {}

  /** The row as the run last knew it, in any state. */
  async row(id: string): Promise<Item | undefined> {
    await this.load();
    return this.byId.get(id);
  }

  async upsert(entries: readonly Entry[]): Promise<void> {
    await this.load();
    // The last of a repeated key wins, as the vendor's latest word on it.
    const latest = new Map(entries.map((entry) => [entry.source_id, entry]));
    const matched: [Entry, Item][] = [];
    const creates: [Entry, NewRow][] = [];
    for (const entry of latest.values()) {
      const properties = cleaned(entry.properties);
      const stray = Object.keys(properties).filter(
        (field) => !this.kind.fields.includes(field),
      );
      if (stray.length > 0) {
        this.counts.skipped += 1;
        this.hooks.condition(
          `undeclared:${entry.source_id}`,
          `the entry ${entry.source_id} carries ${stray.join(", ")}, which the connector does not declare among its fields, so it is not written`,
        );
        continue;
      }
      const value = this.linkOf(properties);
      if (this.kind.link !== undefined && value === undefined) {
        this.counts.skipped += 1;
        this.hooks.condition(
          `unlinked:${entry.source_id}`,
          `the entry ${entry.source_id} names no ${this.kind.link}, so it is not written`,
        );
        continue;
      }
      const row = this.find(value, entry.movedFrom, entry.source_id);
      if (row === "elsewhere") {
        this.counts.skipped += 1;
        this.hooks.condition(
          `held-key:${entry.source_id}`,
          `the entry ${entry.source_id} names ${value ?? "no link"}, and a row linked to another of the vendor's items holds its natural key, so it is not written`,
        );
        continue;
      }
      if (row !== undefined) {
        matched.push([entry, row]);
        continue;
      }
      if (
        this.purged.has(`key:${entry.source_id}`) ||
        (value !== undefined && this.purged.has(`link:${value}`)) ||
        (entry.movedFrom !== undefined &&
          this.purged.has(`link:${entry.movedFrom}`))
      ) {
        // A person emptied the bin of the row this run: the purge wins.
        this.counts.skipped += 1;
        continue;
      }
      const occurredAt = instant(entry.occurred_at);
      creates.push([
        entry,
        {
          source_id: entry.source_id,
          properties,
          ...(occurredAt !== undefined && { occurred_at: occurredAt }),
        },
      ]);
    }
    await this.store.fetch(matched.map(([, row]) => row.id));
    for (const [entry, row] of matched) await this.apply(entry, row);
    const made = new Map(creates.map(([entry, row]) => [row, entry]));
    for (const page of paged(creates.map(([, row]) => row))) {
      await this.createPage(page, made);
    }
  }

  /** The vendor's entry written over the row, where it changed anything. */
  private async apply(entry: Entry, found: Item): Promise<void> {
    if (found.state === "trashed") {
      this.counts.skipped += 1;
      return;
    }
    let agreement = this.store.get(found.id);
    if (
      entry.changed_at !== undefined &&
      laterThan(agreement?.changedAt, entry.changed_at)
    ) {
      // Older than what the two sides agreed on: a read that lagged.
      this.counts.skipped += 1;
      return;
    }
    if (
      agreement !== undefined &&
      agreement.state !== "active" &&
      found.state === "active" &&
      !unchangedAtVendor(agreement, this.kind.fields, entry.properties)
    ) {
      // A restore waits to be carried. A vendor change from before it can
      // be the vendor's echo of the trash, and is left; a later one means
      // the vendor has the row, so the restore needs nothing more.
      const since = agreement.waiting?.[stateKey] ?? found.updated_at;
      if (!laterThan(entry.changed_at, since)) {
        this.counts.skipped += 1;
        return;
      }
      const waiting = { ...agreement.waiting };
      Reflect.deleteProperty(waiting, stateKey);
      agreement = { ...agreement, state: "active" };
      Reflect.deleteProperty(agreement, "waiting");
      if (Object.keys(waiting).length > 0) agreement.waiting = waiting;
    } else if (
      this.kind.twoWay &&
      agreement !== undefined &&
      found.state !== agreement.state &&
      agreement.waiting?.[stateKey] === undefined
    ) {
      // A transition the log has not shown yet: carried this run.
      agreement = {
        ...agreement,
        waiting: { ...agreement.waiting, [stateKey]: found.updated_at },
      };
    }
    let row = found;
    for (let attempt = 0; ; attempt += 1) {
      const merged = this.merged(entry, row, agreement);
      if (!merged.write) {
        this.agree(row.id, merged.agreement, entry);
        this.report(row.id, merged);
        this.counts.unchanged += 1;
        return;
      }
      this.checkStopped();
      try {
        const written = await this.marfa.update(
          row.id,
          row.version,
          merged.properties,
          merged.occurredAt,
        );
        this.index(written);
        this.agree(row.id, merged.agreement, entry);
        this.report(row.id, merged);
        this.counts.updated += 1;
        return;
      } catch (error) {
        // A field another writer changed since the read collides: read the
        // row as it now stands and merge again, once.
        if (
          attempt === 0 &&
          error instanceof Refusal &&
          error.code === "version_conflict"
        ) {
          const current = await this.marfa.item(row.id);
          if (current !== undefined) {
            this.index(current);
            row = current;
            continue;
          }
        }
        this.absorb(error, entry.source_id, refusedUpdate);
        return;
      }
    }
  }

  private merged(
    entry: Entry,
    row: Item,
    agreement: Agreement | undefined,
  ): Merged {
    const merged = merge({
      fields: this.kind.fields,
      readOnly: (field) => this.kind.readOnly.has(field),
      agreement,
      row: {
        properties: row.properties,
        occurred_at: row.occurred_at,
        updated_at: row.updated_at,
      },
      entry,
    });
    return merged;
  }

  private report(id: string, merged: Merged): void {
    if (merged.seeded.length > 0) this.seeded += 1;
    if (merged.lost.length > 0 || merged.kept.length > 0) {
      this.counts.conflicts += 1;
    }
    if (merged.lost.length > 0) {
      this.hooks.condition(
        `conflict-lost:${id}`,
        `the vendor's change to ${merged.lost.join(", ")} on ${id} is the later one, so the change made in Marfa is not carried back`,
      );
    }
    if (merged.kept.length > 0) {
      this.hooks.condition(
        `conflict-kept:${id}`,
        `the change made in Marfa to ${merged.kept.join(", ")} on ${id} is the later one, so the vendor's is not written and Marfa's is carried back`,
      );
    }
    if (merged.putBack.length > 0) {
      this.hooks.condition(
        `put-back:${id}`,
        `${merged.putBack.join(", ")} on ${id} ${merged.putBack.length === 1 ? "was" : "were"} changed in Marfa and put back from the vendor, which Marfa mirrors`,
      );
    }
  }

  /** Records what the two sides now agree on, and the link the row is known by. */
  private agree(id: string, agreement: Agreement, entry: Entry): void {
    const value = this.linkOf(cleaned(entry.properties));
    this.store.set(id, {
      ...agreement,
      ...(value !== undefined && { link: value }),
    });
    if (agreement.waiting !== undefined) this.marked.add(id);
  }

  /**
   * The row an entry names: by its link, by the link it moved from, then by
   * its natural key, which finds only a row linked to nothing or to the same
   * item; one linked to another is `elsewhere`.
   */
  private find(
    value: string | undefined,
    movedFrom: string | undefined,
    sourceId: string,
  ): Item | "elsewhere" | undefined {
    const byLink = (key: string | undefined): Item | undefined => {
      const id = key === undefined ? undefined : this.byLink.get(key);
      return id === undefined ? undefined : this.byId.get(id);
    };
    const linked = byLink(value) ?? byLink(movedFrom);
    if (linked !== undefined) return linked;
    const id = this.byKey.get(sourceId);
    const keyed = id === undefined ? undefined : this.byId.get(id);
    if (keyed === undefined) return undefined;
    const held = this.linkOf(keyed.properties);
    return held === undefined || held === value ? keyed : "elsewhere";
  }

  linkOf(properties: Readonly<Record<string, unknown>>): string | undefined {
    const link = this.kind.link;
    if (link === undefined) return undefined;
    const value = held(properties, link);
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  private async createPage(
    page: NewRow[],
    made: Map<NewRow, Entry>,
  ): Promise<void> {
    this.checkStopped();
    let results;
    try {
      results = await this.marfa.create(this.kind.type, this.kind.source, page);
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
      await this.createPage(page.slice(0, half), made);
      await this.createPage(page.slice(half), made);
      return;
    }
    for (const result of results) {
      const created = page[result.index];
      if (created === undefined) continue;
      const entry = made.get(created);
      if (entry !== undefined) this.settle(result, created, entry);
    }
  }

  /**
   * Archives the rows the keys name that are active: link values with a
   * link, natural keys without.
   */
  async archive(keys: readonly string[]): Promise<void> {
    await this.load();
    const rows = [...new Set(keys)].flatMap((key) => {
      const id =
        this.kind.link === undefined
          ? this.byKey.get(key)
          : this.byLink.get(key);
      const row = id === undefined ? undefined : this.byId.get(id);
      return row === undefined ? [] : [{ key, row }];
    });
    await this.store.fetch(rows.map(({ row }) => row.id));
    for (const { key, row } of rows) {
      if (row.state === "trashed") {
        this.counts.skipped += 1;
        continue;
      }
      const agreement = this.store.get(row.id);
      // A row a person restored since the two sides last agreed is not
      // put away again on the vendor's word: the restore is carried, and
      // reinstates the vendor's copy.
      if (
        row.state === "active" &&
        agreement !== undefined &&
        agreement.state !== "active"
      ) {
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
        this.index({ ...row, state: "archived" });
        const side = sideOf(this.kind.fields, row.properties);
        this.store.set(row.id, {
          vendor: side,
          marfa: side,
          ...agreement,
          state: "archived",
        });
        this.counts.archived += 1;
      } catch (error) {
        this.absorb(error, key, refusedUpdate);
      }
    }
  }

  /**
   * Puts read-only fields a person changed back to what the kit last wrote,
   * found in the row's versions; one no version still holds waits for the
   * vendor to send it again. Answers the fields put back.
   */
  async putBack(id: string, fields: readonly string[]): Promise<string[]> {
    const row = this.byId.get(id);
    const agreement = this.store.get(id);
    if (row === undefined || agreement === undefined) return [];
    const versions = [...(await this.marfa.versions(id))].reverse();
    const properties: Record<string, unknown> = { ...cleaned(row.properties) };
    const found: string[] = [];
    for (const field of fields) {
      const wanted = agreement.marfa[field] ?? "";
      const holding = versions.find(
        (version) => mark(held(version.properties, field)) === wanted,
      );
      if (holding === undefined) continue;
      const value = held(holding.properties, field);
      if (value === undefined || value === null) {
        Reflect.deleteProperty(properties, field);
      } else properties[field] = value;
      found.push(field);
    }
    if (found.length === 0) return [];
    this.checkStopped();
    try {
      this.index(
        await this.marfa.update(row.id, row.version, properties, undefined),
      );
    } catch (error) {
      this.absorb(error, row.source_id ?? row.id, refusedUpdate);
      return [];
    }
    this.counts.updated += 1;
    this.hooks.condition(
      `put-back:${id}`,
      `${found.join(", ")} on ${id} ${found.length === 1 ? "was" : "were"} changed in Marfa and put back from the vendor, which Marfa mirrors`,
    );
    return found;
  }

  /**
   * Writes the vendor's id onto a row's link property at the version the
   * change showed, once more at the current version if the row moved
   * since. A value another row carries is refused, naming both.
   */
  async setLink(item: Item, value: string): Promise<void> {
    const link = this.kind.link;
    if (link === undefined) {
      throw new Error("the connector declares no link property to write");
    }
    await this.load();
    const holder = this.byLink.get(value);
    if (holder !== undefined && holder !== item.id) {
      throw new LinkTaken(
        `the link ${value} is already carried by ${holder}, so it is not written onto ${item.id}`,
      );
    }
    this.checkStopped();
    let written: Item;
    try {
      written = await this.marfa.merge(item.id, item.version, {
        [link]: value,
      });
    } catch (error) {
      if (
        !(error instanceof Refusal) ||
        (error.code !== "version_conflict" &&
          error.code !== "ancestor_unavailable")
      ) {
        throw error;
      }
      const current = await this.marfa.item(item.id);
      if (current === undefined) {
        throw new Refusal(404, "item_not_found", `${item.id} is gone`);
      }
      written = await this.marfa.merge(current.id, current.version, {
        [link]: value,
      });
    }
    this.index(written);
    // Only the value sent: what the server merged in beside it is a
    // person's change, still to carry.
    const agreement = this.store.get(item.id);
    const marked = mark(value);
    this.store.set(item.id, {
      vendor: { ...agreement?.vendor, [link]: marked },
      marfa: { ...agreement?.marfa, [link]: marked },
      state: agreement?.state ?? "active",
      ...(agreement?.waiting !== undefined && { waiting: agreement.waiting }),
      link: value,
    });
  }

  /** Read once, however many calls ask for it at once. */
  private load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    const items = await this.marfa.ownRows(
      this.kind.type,
      this.kind.link === undefined ? this.kind.source : undefined,
    );
    for (const item of items) {
      // The type filter also answers types that inherit from this one,
      // whose rows are not this connector's to write.
      if (item.type !== this.kind.type) continue;
      this.index(item);
    }
  }

  private index(item: Item): void {
    this.byId.set(item.id, item);
    if (item.source === this.kind.source && item.source_id !== undefined) {
      this.byKey.set(item.source_id, item.id);
    }
    const value = this.linkOf(item.properties);
    // A row relinked gives up the value it carried, or an entry under the
    // old value would still find it.
    const before = this.linkByRow.get(item.id);
    if (before !== undefined && before !== value) this.byLink.delete(before);
    if (value !== undefined) {
      this.byLink.set(value, item.id);
      this.linkByRow.set(item.id, value);
    } else {
      this.linkByRow.delete(item.id);
    }
  }

  private settle(result: BulkResult, created: NewRow, entry: Entry): void {
    if (result.outcome === "created" && result.id !== undefined) {
      const now = new Date().toISOString();
      this.index({
        id: result.id,
        type: this.kind.type,
        state: "active",
        properties: created.properties,
        source: this.kind.source,
        source_id: created.source_id,
        version: 1,
        created_at: now,
        updated_at: now,
        occurred_at: created.occurred_at ?? now,
      } as Item);
      const merged = merge({
        fields: this.kind.fields,
        readOnly: () => true,
        agreement: undefined,
        row: {
          properties: created.properties,
          occurred_at: created.occurred_at,
          updated_at: undefined,
        },
        entry,
      });
      this.agree(result.id, merged.agreement, entry);
      this.counts.created += 1;
      return;
    }
    if (result.outcome === "skipped") {
      // A row trashed since the read: left alone like any trashed row.
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
        this.hooks.refused(sourceId, `${error.code}, ${error.detail}`);
      }
      return;
    }
    throw error;
  }

  private checkStopped(): void {
    if (this.signal.aborted) throw new Stopped();
  }
}
