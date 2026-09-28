import {
  agreedState,
  held,
  laterThan,
  mark,
  merge,
  sideOf,
  unchangedAtVendor,
  type Agreement,
  type Merged,
} from "./agreement.js";
import type { Entry, Item, Target } from "./define.js";
import {
  Refusal,
  type BulkResult,
  type Marfa,
  type NewRow,
  type Tombstone,
} from "./marfa.js";
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

/** What the kit knows of one of the connector's types. */
export interface Spec {
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
  /** A trashed row comes back on the vendor's change. */
  readonly revive: boolean;
  /** The connection types a row of it is the source of. */
  readonly connections: ReadonlySet<string>;
}

/** In the bin because another row's trash took it there. */
export function cascaded(item: Item): boolean {
  return item.trashed_by_cascade === true;
}

/** The fields a file's bytes are written to. */
const fileFields = ["blob_ref", "mime_type"];

/** A target the vendor named and Marfa lacks: waiting, but nothing to carry. */
export const connectKey = "@connect";

/** Whether anything waiting is Marfa's to carry. */
export function carriable(
  waiting: Readonly<Record<string, string>> | undefined,
): boolean {
  return Object.keys(waiting ?? {}).some((key) => key !== connectKey);
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
const refusedUpdate = new Set([
  "invalid_properties",
  "request_too_large",
  "link_taken",
]);
const refusedCreate = new Set([
  "invalid_properties",
  "validation_error",
  "type_mismatch",
  "request_too_large",
  "link_taken",
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
 * The connector's rows of one type, read as entries name them: each entry is
 * merged with its row field by field against the agreement, and a trashed
 * row is written only where its kind revives.
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
  /** Entries for rows a person purged, remembered, and not written back. */
  remembered = 0;
  /** Rows brought back from the bin by the vendor's change. */
  revived = 0;
  /** Tombstones met this run, by `link:` and by `key:`. */
  private readonly buried = new Map<string, Tombstone>();
  /** What this run has looked up, by `link:` and `key:`. */
  private readonly asked = new Set<string>();
  /** Rows this run's reads left with something in Marfa to carry. */
  readonly marked = new Set<string>();
  /** Rows the vendor's word reached this run: an entry, or an archive. */
  readonly reached = new Set<string>();
  /** The bytes each entry this run carries were uploaded as. */
  private readonly files = new WeakMap<
    Entry,
    { key: string; ref: string; mime: string }
  >();
  /** The connections each entry this run wrote named, by row id. */
  readonly connecting = new Map<
    string,
    Readonly<Record<string, readonly Target[]>>
  >();
  /**
   * On a run for what deliveries named, the keys it may archive: the rest
   * of the vendor was not read, so its silence says nothing.
   */
  archivable: ReadonlySet<string> | undefined;
  private readonly byId = new Map<string, Item>();
  private readonly byLink = new Map<string, string>();
  private readonly byKey = new Map<string, string>();
  private readonly linkByRow = new Map<string, string>();

  constructor(
    private readonly marfa: Marfa,
    private readonly kind: Spec,
    private readonly store: Store,
    private readonly signal: AbortSignal,
    private readonly hooks: Hooks,
  ) {}

  /** The row as the run last knew it, in any state. */
  known(id: string): Item | undefined {
    return this.byId.get(id);
  }

  /** Takes a row read elsewhere in the run, where it is of this type. */
  adopt(item: Item): void {
    if (item.type === this.kind.type) this.index(item);
  }

  /** The rows the vendor's ids name, by link, or by natural key where the type names none. */
  async named(ids: readonly string[]): Promise<Map<string, Item>> {
    const byLink = this.kind.link !== undefined;
    await this.know(byLink ? { links: ids } : { keys: ids });
    const found = new Map<string, Item>();
    for (const id of ids) {
      const row = this.byId.get(
        (byLink ? this.byLink.get(id) : this.byKey.get(id)) ?? "",
      );
      if (row !== undefined) found.set(id, row);
    }
    return found;
  }

  async upsert(entries: readonly Entry[]): Promise<void> {
    // The last of a repeated key wins, as the vendor's latest word on it.
    const latest = new Map(
      entries.map((entry) => [
        entry.source_id,
        entry.movedFrom === "" ? { ...entry, movedFrom: undefined } : entry,
      ]),
    );
    await this.know({
      links: [...latest.values()].flatMap((entry) => [
        ...[this.linkOf(cleaned(entry.properties))].filter(
          (value): value is string => value !== undefined,
        ),
        ...(entry.movedFrom === undefined ? [] : [entry.movedFrom]),
      ]),
      keys: [...latest.keys()],
    });
    const matched: [Entry, Item][] = [];
    const creates: [Entry, NewRow][] = [];
    for (const entry of latest.values()) {
      const properties = cleaned(entry.properties);
      const stray = [
        ...Object.keys(properties).filter(
          (field) => !this.kind.fields.includes(field),
        ),
        ...Object.keys(entry.connections ?? {}).filter(
          (type) => !this.kind.connections.has(type),
        ),
      ];
      if (stray.length > 0) {
        this.counts.skipped += 1;
        this.hooks.condition(
          `undeclared:${entry.source_id}`,
          `the entry ${entry.source_id} carries ${stray.join(", ")}, which the connector does not declare among its fields or its type's connections, so it is not written`,
        );
        continue;
      }
      if (
        entry.file !== undefined &&
        fileFields.some((field) => !this.kind.fields.includes(field))
      ) {
        this.counts.skipped += 1;
        this.hooks.condition(
          `file-fields:${entry.source_id}`,
          `the entry ${entry.source_id} carries a file, and its type's fields do not list ${fileFields.join(" and ")}, so it is not written`,
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
      const buried =
        (value === undefined ? undefined : this.buried.get(`link:${value}`)) ??
        (entry.movedFrom === undefined
          ? undefined
          : this.buried.get(`link:${entry.movedFrom}`)) ??
        this.buried.get(`key:${entry.source_id}`);
      if (
        buried !== undefined &&
        !laterThan(entry.changed_at, buried.settled_at)
      ) {
        // A person purged the row: it comes back only once the vendor
        // changes it after that.
        this.counts.skipped += 1;
        this.remembered += 1;
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
    const made = new Map<NewRow, Entry>();
    for (const [entry, row] of creates) {
      const loaded = await this.uploaded(entry);
      if (loaded === undefined) continue;
      made.set({ ...row, properties: cleaned(loaded.properties) }, loaded);
    }
    for (const page of paged([...made.keys()])) {
      await this.createPage(page, made);
    }
  }

  /**
   * The entry with its row's bytes as last uploaded where the vendor's key
   * for them is unchanged; `fresh` where they must be loaded again.
   */
  private agreedFile(
    entry: Entry,
    agreement: Agreement | undefined,
  ): { entry: Entry; fresh: boolean } {
    if (entry.file === undefined) return { entry, fresh: false };
    const held = agreement?.file;
    if (held?.key !== entry.file.key) return { entry, fresh: true };
    const withFile = {
      ...entry,
      properties: {
        ...entry.properties,
        blob_ref: held.ref,
        mime_type: held.mime,
      },
    };
    this.files.set(withFile, held);
    return { entry: withFile, fresh: false };
  }

  /**
   * The entry with its bytes loaded from the vendor and uploaded, in the
   * run that writes the row, since a blob nothing names is swept. One the
   * vendor would not give is a condition, and the row waits.
   */
  private async uploaded(entry: Entry): Promise<Entry | undefined> {
    const source = entry.file;
    if (source === undefined) return entry;
    this.checkStopped();
    let loaded;
    try {
      loaded = await source.load(this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.counts.skipped += 1;
      this.hooks.condition(
        `file-unloaded:${entry.source_id}`,
        `the file for ${entry.source_id} could not be fetched from the vendor, so its row waits: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const stored = await this.marfa.upload(loaded.bytes, loaded.mime_type);
    const withFile = {
      ...entry,
      properties: {
        ...entry.properties,
        blob_ref: stored.hash,
        mime_type: stored.mime_type,
      },
    };
    this.files.set(withFile, {
      key: source.key,
      ref: stored.hash,
      mime: stored.mime_type,
    });
    return withFile;
  }

  /** The vendor's entry written over the row, where it changed anything. */
  private async apply(given: Entry, found: Item): Promise<void> {
    this.reached.add(found.id);
    let agreement = this.store.get(found.id);
    const agreed = this.agreedFile(given, agreement);
    let entry = agreed.entry;
    if (
      entry.changed_at !== undefined &&
      laterThan(agreement?.changedAt, entry.changed_at)
    ) {
      // Older than what the two sides agreed on: a read that lagged.
      this.counts.skipped += 1;
      return;
    }
    if (found.state === "trashed" && !this.revives(entry, agreement)) {
      this.counts.skipped += 1;
      return;
    }
    let row = found;
    let moved = false;
    if (
      found.state === "trashed" ||
      (found.state === "archived" && agreement?.stateBy === "vendor")
    ) {
      this.checkStopped();
      try {
        row = await this.marfa.transition(found.id, "active");
      } catch (error) {
        this.absorb(error, entry.source_id, refusedUpdate);
        return;
      }
      this.index(row);
      moved = true;
      if (found.state === "trashed") {
        this.revived += 1;
        this.hooks.condition(
          `revived:${found.id}`,
          `the vendor changed ${found.id} while it was in the bin, so it was brought back`,
        );
      }
      if (agreement !== undefined) {
        agreement = { ...agreement, state: "active" };
        Reflect.deleteProperty(agreement, "stateBy");
      }
    }
    if (agreed.fresh) {
      const loaded = await this.uploaded(entry);
      if (loaded === undefined) return;
      entry = loaded;
    }
    if (
      agreement !== undefined &&
      agreement.state !== "active" &&
      row.state === "active" &&
      !this.kind.revive &&
      laterThan(
        entry.changed_at,
        agreement.waiting?.[stateKey] ?? row.updated_at,
      ) &&
      !unchangedAtVendor(agreement, this.kind.fields, entry.properties)
    ) {
      // Where a trash deletes at the vendor, a change there after the restore
      // means it has the row again; where it only closes, the restore reopens.
      const waiting = { ...agreement.waiting };
      Reflect.deleteProperty(waiting, stateKey);
      agreement = { ...agreement, state: "active" };
      Reflect.deleteProperty(agreement, "waiting");
      if (Object.keys(waiting).length > 0) agreement.waiting = waiting;
    } else if (agreement?.stateBy === "cascade" && row.state !== "trashed") {
      // Out of another row's trash, which carried nothing either way.
      agreement = { ...agreement, state: agreedState(row.state) };
      Reflect.deleteProperty(agreement, "stateBy");
    } else if (
      this.kind.twoWay &&
      agreement !== undefined &&
      row.state !== agreement.state &&
      agreement.waiting?.[stateKey] === undefined
    ) {
      // A transition the log has not shown yet: carried this run.
      agreement = {
        ...agreement,
        waiting: { ...agreement.waiting, [stateKey]: row.updated_at },
      };
    }
    for (let attempt = 0; ; attempt += 1) {
      const merged = this.merged(entry, row, agreement);
      if (!merged.write) {
        this.agree(row.id, merged.agreement, entry);
        this.report(row.id, merged);
        if (moved) this.counts.updated += 1;
        else this.counts.unchanged += 1;
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

  /**
   * Whether the vendor's change brings a row back from the bin: only for a
   * kind that revives, once the trash is settled, and never on an entry the
   * vendor already held.
   */
  private revives(entry: Entry, agreement: Agreement | undefined): boolean {
    return (
      this.kind.revive &&
      agreement?.state === "trashed" &&
      agreement.waiting?.[stateKey] === undefined &&
      !unchangedAtVendor(agreement, this.kind.fields, entry.properties)
    );
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
        state: row.state,
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

  /**
   * Records what the two sides now agree on, the link the row is known by,
   * and the connections the entry names, which are written once the run's
   * rows are.
   */
  private agree(id: string, agreement: Agreement, entry: Entry): void {
    const value = this.linkOf(cleaned(entry.properties));
    const was = this.store.get(id);
    const file = this.files.get(entry) ?? was?.file;
    this.store.set(id, {
      ...agreement,
      ...(value !== undefined && { link: value }),
      ...(was?.connections !== undefined && { connections: was.connections }),
      ...(was?.pending !== undefined && { pending: was.pending }),
      ...(file !== undefined && { file }),
    });
    if (carriable(agreement.waiting)) this.marked.add(id);
    if (entry.connections !== undefined) {
      this.connecting.set(id, entry.connections);
    }
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
    await this.know(this.kind.link === undefined ? { keys } : { links: keys });
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
      if (this.archivable !== undefined && !this.archivable.has(key)) {
        this.counts.skipped += 1;
        this.hooks.condition(
          `unhinted:${key}`,
          `${key} was named for archiving by a run for what deliveries named, which did not read it, so it was not archived`,
        );
        continue;
      }
      this.reached.add(row.id);
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
        this.index(await this.marfa.transition(row.id, "archived"));
        const side = sideOf(this.kind.fields, row.properties);
        this.store.set(row.id, {
          vendor: side,
          marfa: side,
          ...agreement,
          state: "archived",
          stateBy: "vendor",
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
    this.checkStopped();
    let written: Item;
    const taken = (error: unknown): unknown => {
      if (!(error instanceof Refusal) || error.code !== "link_taken") {
        return error;
      }
      const holder = error.details["existing_id"];
      return new LinkTaken(
        `the link ${value} is already carried by ${typeof holder === "string" ? holder : "another row"}, so it is not written onto ${item.id}`,
      );
    };
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
        throw taken(error);
      }
      const current = await this.marfa.item(item.id);
      if (current === undefined) {
        throw new Refusal(404, "item_not_found", `${item.id} is gone`);
      }
      try {
        written = await this.marfa.merge(current.id, current.version, {
          [link]: value,
        });
      } catch (again) {
        throw taken(again);
      }
    }
    this.index(written);
    // Only the value sent: what the server merged in beside it is a
    // person's change, still to carry.
    await this.store.fetch([item.id]);
    const agreement = this.store.get(item.id);
    const marked = mark(value);
    const next: Agreement = {
      ...agreement,
      vendor: { ...agreement?.vendor, [link]: marked },
      marfa: { ...agreement?.marfa, [link]: marked },
      state: agreement?.state ?? "active",
      link: value,
    };
    Reflect.deleteProperty(next, "attempted");
    this.store.set(item.id, next);
  }

  /**
   * Looks up the rows the links and natural keys name that this run has
   * neither read nor asked for, in any state, with the tombstones among them.
   */
  private async know(named: {
    links?: readonly string[];
    keys?: readonly string[];
  }): Promise<void> {
    const fresh = (
      prefix: string,
      values: readonly string[] = [],
      held: ReadonlyMap<string, string>,
    ) =>
      [...new Set(values)].filter(
        (value) => !held.has(value) && !this.asked.has(`${prefix}${value}`),
      );
    const learn = (
      prefix: string,
      values: readonly string[],
      found: { data: Item[]; tombstones: Tombstone[] },
    ): void => {
      for (const value of values) this.asked.add(`${prefix}${value}`);
      for (const item of found.data) this.adopt(item);
      for (const tombstone of found.tombstones) {
        this.buried.set(`${prefix}${tombstone.key}`, tombstone);
      }
    };
    const links =
      this.kind.link === undefined
        ? []
        : fresh("link:", named.links, this.byLink);
    if (links.length > 0) {
      learn("link:", links, await this.marfa.lookup(this.kind.type, { links }));
    }
    const keys = fresh("key:", named.keys, this.byKey);
    if (keys.length > 0) {
      learn(
        "key:",
        keys,
        await this.marfa.lookup(this.kind.type, {
          source: this.kind.source,
          source_ids: keys,
        }),
      );
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
