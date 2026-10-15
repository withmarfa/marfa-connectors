import type { Entry, Item } from "@withmarfa/connector";
import {
  isReaderManaged,
  mapSource,
  mapHighlight,
  mapReaderSource,
  mapReaderHighlight,
  readerIdentity,
  sourceFields,
  highlightFields,
  type Source,
  type Highlight,
  type ReaderReader,
  type ReaderMapping,
  ReadwiseThrottleError,
  ReadwiseAuthorizationError,
  readerContentRevision,
  type ContentJob,
  type ReaderDocument,
} from "@withmarfa/readwise";

export interface IdentityInspection {
  items: readonly Item[];
  tombstones: readonly { key: string; purged_at: string; settled_at: string }[];
}
export interface SharedContext {
  signal?: AbortSignal;
  inspect(
    type: string,
    query: { links?: readonly string[]; source_ids?: readonly string[] },
  ): Promise<IdentityInspection>;
  held(type: string): Promise<Item[]>;
  log: { condition(key: string, message: string): void };
}
export function highlightsPolicy(
  type: string,
  item: Item | undefined,
  entry?: Entry,
): {
  owned?: boolean;
  fields?: Readonly<Record<string, "observe" | "mirror">>;
  firstAgreement?: "preserve";
} {
  const managed = item !== undefined && isReaderManaged(type, item.properties);
  const incoming =
    entry !== undefined && isReaderManaged(type, entry.properties);
  if (managed && (entry === undefined || !incoming)) return { owned: false };
  if (!managed && !incoming) return {};
  const fields = type === "readwise.source" ? sourceFields : highlightFields;
  // Export enrichment is independent; every Reader value observes local divergence.
  const exportFields = new Set([
    "readwise_id",
    "readwise_source_id",
    "readwise_text",
    "readwise_color",
    "location",
    "location_type",
    "highlighted_at",
    "readwise_created_at",
    "readwise_updated_at",
    "is_favorite",
    "is_discard",
    "external_id",
    "asin",
    "readwise_url",
    "unique_url",
    "readable_title",
    "readwise_source",
    "cover_image_url",
  ]);
  return {
    firstAgreement: "preserve",
    fields: Object.fromEntries(
      fields.map((field) => [
        field,
        exportFields.has(field) ||
        ["canonical_key", "account", "reader_id", "reader_managed"].includes(
          field,
        )
          ? "mirror"
          : "observe",
      ]),
    ),
  };
}
export class SharedRows {
  private readonly fetched = new Map<
    string,
    ReturnType<ReaderReader["document"]>
  >();
  private readonly refreshed = new Set<string>();
  constructor(
    private readonly account: string,
    private readonly context: SharedContext,
    private readonly reader: ReaderReader,
    private readonly preserve?: (job: ContentJob) => Promise<void>,
  ) {}
  private document(id: string) {
    let value = this.fetched.get(id);
    if (value === undefined) {
      value = this.reader.document(id);
      this.fetched.set(id, value);
    }
    return value;
  }
  private async locate(
    type: string,
    entry: Entry,
    external?: string | null,
  ): Promise<Item | "purged" | undefined> {
    const natural = await this.context.inspect(type, {
      source_ids: [entry.source_id],
    });
    const canonical = external
      ? readerIdentity(
          this.account,
          type === "readwise.source" ? "document" : "highlight",
          external,
        )
      : undefined;
    const linked = canonical
      ? await this.context.inspect(type, { links: [canonical] })
      : { items: [], tombstones: [] };
    const items = new Map(
      [...natural.items, ...linked.items].map((item) => [item.id, item]),
    );
    if (
      items.size > 1 ||
      (items.size > 0 &&
        (natural.tombstones.length > 0 || linked.tombstones.length > 0))
    )
      throw new Error(
        "Readwise identity conflict across existing rows or tombstones",
      );
    if (natural.tombstones.length > 0 || linked.tombstones.length > 0)
      return "purged";
    const item = items.values().next().value;
    if (item !== undefined && item.properties["account"] !== this.account)
      throw new Error("Readwise identity conflict across accounts");
    return item;
  }
  private result(mapped: ReaderMapping, existing?: Item): Entry {
    for (const condition of mapped.conditions)
      this.context.log.condition(
        `readwise:${condition}:${mapped.entry.source_id}`,
        `Reader mapping requires attention: ${condition}`,
      );
    if (mapped.textFiles.length > 0 && this.preserve === undefined)
      throw new Error(
        "Reader text requires durable content preservation; the last stored row is retained",
      );
    if (existing?.source_id) mapped.entry.source_id = existing.source_id;
    if (existing !== undefined && mapped.textFiles.length) {
      const properties = { ...mapped.entry.properties };
      for (const file of mapped.textFiles) {
        const previous = existing.properties[file.field];
        if (previous !== undefined) properties[file.field] = previous;
      }
      if (existing.properties["reader_text_files"] !== undefined)
        properties["reader_text_files"] =
          existing.properties["reader_text_files"];
      mapped.entry.properties = properties;
    }
    return mapped.entry;
  }
  private async managed(
    type: string,
    held: Item,
    exportEntry?: Entry,
  ): Promise<Entry> {
    const id = held.properties["reader_id"];
    if (typeof id !== "string")
      throw new Error("Readwise managed row has no Reader ID");
    const document = await this.document(id);
    if (document === undefined)
      throw new Error(
        "Reader did not return the managed row; only Reader's complete reconciliation can confirm deletion",
      );
    const notes: ReaderDocument[] = [];
    const priorNotes = held.properties["reader_notes"];
    if (
      priorNotes !== null &&
      typeof priorNotes === "object" &&
      !Array.isArray(priorNotes)
    )
      for (const noteId of Object.keys(priorNotes)) {
        const note = await this.document(noteId);
        if (note === undefined) continue;
        if (note.category !== "note" || note.parent_id !== id)
          throw new Error(
            "Reader annotation lookup did not verify its original identity",
          );
        notes.push(note);
      }
    const enrichment = {
      notes,
      ...(held.source_id ? { sourceId: held.source_id } : {}),
      properties: { ...held.properties, ...exportEntry?.properties },
    };
    // An export key and passage never replace Reader's established canonical fields.
    if (type === "readwise.highlight" && exportEntry !== undefined)
      enrichment.properties["readwise_text"] = exportEntry.properties["text"];
    const mapped =
      type === "readwise.source"
        ? mapReaderSource(this.account, document, enrichment)
        : mapReaderHighlight(this.account, document, enrichment);
    if (
      this.preserve !== undefined &&
      (type === "readwise.source" || mapped.textFiles.length)
    ) {
      const exportSourceId = Number(
        enrichment.properties["readwise_source_id"],
      );
      const exportHighlightId = Number(enrichment.properties["readwise_id"]);
      const needsExport = mapped.textFiles.some(
        (file) => file.field === "readwise_text",
      );
      if (
        needsExport &&
        (!Number.isSafeInteger(exportSourceId) ||
          exportSourceId <= 0 ||
          !Number.isSafeInteger(exportHighlightId) ||
          exportHighlightId <= 0)
      )
        throw new Error(
          "Reader export-text preservation needs verified export identities",
        );
      await this.preserve({
        id,
        type,
        canonical: String(mapped.entry.properties["canonical_key"]),
        revision: readerContentRevision(document, notes, mapped.textFiles),
        ...(notes.length && { noteIds: notes.map((note) => note.id) }),
        ...(needsExport && { exportSourceId, exportHighlightId }),
      });
    }
    const result = this.result(mapped, held);
    this.refreshed.add(held.id);
    return result;
  }
  async source(source: Source): Promise<Entry | undefined> {
    const entry = mapSource(this.account, source);
    const held = await this.locate(
      "readwise.source",
      entry,
      source.source === "reader" ? source.external_id : undefined,
    );
    if (held === "purged") return undefined;
    return held !== undefined &&
      isReaderManaged("readwise.source", held.properties, this.account)
      ? this.managed("readwise.source", held, entry)
      : entry;
  }
  async highlight(
    source: Source,
    highlight: Highlight,
  ): Promise<Entry | undefined> {
    const entry = mapHighlight(this.account, source.user_book_id, highlight);
    const held = await this.locate(
      "readwise.highlight",
      entry,
      source.source === "reader" ? highlight.external_id : undefined,
    );
    if (held === "purged") return undefined;
    if (
      held !== undefined &&
      isReaderManaged("readwise.highlight", held.properties, this.account)
    )
      return this.managed("readwise.highlight", held, entry);
    // A non-adopted highlight can reference an already adopted parent.
    if (source.source === "reader" && source.external_id) {
      const parent = await this.context.inspect("readwise.source", {
        links: [readerIdentity(this.account, "document", source.external_id)],
      });
      if (
        parent.items.some((item) =>
          isReaderManaged("readwise.source", item.properties, this.account),
        )
      )
        entry.connections = {
          references: [
            {
              type: "readwise.source",
              id: readerIdentity(this.account, "document", source.external_id),
            },
          ],
        };
    }
    return entry;
  }
  async deletion(type: string, natural: string): Promise<string | undefined> {
    const found = await this.context.inspect(type, { source_ids: [natural] });
    const row = found.items[0];
    if (
      row !== undefined &&
      isReaderManaged(type, row.properties, this.account)
    )
      return undefined;
    return typeof row?.properties["canonical_key"] === "string"
      ? row.properties["canonical_key"]
      : natural;
  }
  async retry(
    scope: { upsert(type: string, entries: readonly Entry[]): Promise<void> },
    type: string,
    sourceId: string,
  ): Promise<void> {
    const found = await this.context.inspect(type, { source_ids: [sourceId] });
    const row = found.items[0];
    if (
      row === undefined ||
      !isReaderManaged(type, row.properties, this.account)
    )
      throw new Error(
        "Readwise retry identity no longer resolves to a managed row",
      );
    await scope.upsert(type, [await this.managed(type, row)]);
  }
  async refresh(scope: {
    upsert(type: string, entries: readonly Entry[]): Promise<void>;
    state?: {
      get(key: string): unknown;
      checkpoint(
        key: string,
        value: unknown,
      ): Promise<{ committed: boolean; reason?: string }>;
    };
  }): Promise<void> {
    const rows: { type: string; row: Item }[] = [];
    for (const type of ["readwise.source", "readwise.highlight"])
      for (const row of await this.context.held(type))
        if (isReaderManaged(type, row.properties, this.account))
          rows.push({ type, row });
    rows.sort((a, b) => a.row.id.localeCompare(b.row.id));
    const cursor = scope.state?.get("cursor");
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
      throw new Error("Reader refresh cursor is invalid");
    for (const { type, row } of rows) {
      if (typeof cursor === "string" && row.id.localeCompare(cursor) <= 0)
        continue;
      let entry: Entry | undefined;
      if (!this.refreshed.has(row.id)) {
        try {
          entry = await this.managed(type, row);
        } catch (error) {
          if (
            error instanceof ReadwiseThrottleError ||
            error instanceof ReadwiseAuthorizationError
          )
            throw error;
          this.context.signal?.throwIfAborted();
          this.context.log.condition(
            `readwise:reader-refresh:${row.id}`,
            error instanceof Error ? error.message : "Reader refresh failed",
          );
        }
      }
      if (entry !== undefined) await scope.upsert(type, [entry]);
      const saved = await scope.state?.checkpoint("cursor", row.id);
      if (saved !== undefined && !saved.committed)
        throw new Error(
          `Reader refresh progress was not saved: ${saved.reason ?? "unknown"}`,
        );
    }
    const saved = await scope.state?.checkpoint("cursor", null);
    if (saved !== undefined && !saved.committed)
      throw new Error(
        `Reader refresh completion was not saved: ${saved.reason ?? "unknown"}`,
      );
  }
}
