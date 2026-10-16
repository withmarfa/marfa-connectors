import { createHash, randomUUID } from "node:crypto";
import { packIdentities, unpackIdentities } from "./checkpoint.js";
import type { CheckpointState, Item, RunContext } from "@withmarfa/connector";
import {
  identity,
  InvalidCursor,
  readerIdentity,
  readerExportPassage,
  mapSource,
  mapHighlight,
  parsePage,
  type ExportClient,
  type ReaderDocument,
  type Source,
  type ReaderEnrichment,
} from "@withmarfa/readwise";
import type { env } from "./config.js";
export type IdentityContext = Pick<
  RunContext<typeof env>,
  "inspect" | "held" | "pendingOutbound"
>;
interface Alias {
  natural: string;
  readwiseId: string;
  sourceId?: number;
  parent?: string | null;
  active?: boolean;
  observed?: string;
}
interface Bridge {
  account: string;
  endpoint: string;
  aliases: Record<string, Alias[]>;
  cursor: string | null;
  seen: string[];
  complete: boolean;
  start?: string;
  lower?: string;
  walk?: string;
}
export interface Resolved {
  canonical: string;
  type: "readwise.source" | "readwise.highlight";
  purged: boolean;
  enrichment: ReaderEnrichment;
  previousProperties?: Readonly<Record<string, unknown>>;
}
const maxBytes = 512 * 1024;
const catalogVersion = "reader-claims-with-walk-evidence";
const fullEvery = 24 * 60 * 60 * 1000;
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value: unknown, max = 512): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return false;
  for (let at = 0; at < value.length; at++)
    if (value.charCodeAt(at) < 32 || value.charCodeAt(at) === 127) return false;
  return true;
}
function exportId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0 &&
    String(Number(value)) === value
  );
}
function validateAliases(
  value: unknown,
  account: string,
): asserts value is Record<string, Alias[]> {
  if (!record(value)) throw new Error("Reader identity aliases are invalid");
  for (const [key, aliases] of Object.entries(value)) {
    const kind = key.startsWith(`${account}:reader-document:`)
      ? "document"
      : "highlight";
    const prefix = `${account}:reader-${kind}:`;
    if (
      !key.startsWith(prefix) ||
      !boundedString(key.slice(prefix.length)) ||
      !Array.isArray(aliases) ||
      aliases.length === 0
    )
      throw new Error("Reader identity aliases are invalid");
    for (const alias of aliases) {
      if (
        !record(alias) ||
        Object.keys(alias).some(
          (field) =>
            ![
              "natural",
              "readwiseId",
              "sourceId",
              "parent",
              "active",
              "observed",
            ].includes(field),
        ) ||
        !boundedString(alias["natural"], 8 * 1024 * 1024) ||
        !exportId(alias["readwiseId"]) ||
        (alias["sourceId"] !== undefined &&
          (typeof alias["sourceId"] !== "number" ||
            !Number.isSafeInteger(alias["sourceId"]) ||
            alias["sourceId"] <= 0)) ||
        (alias["parent"] !== undefined &&
          alias["parent"] !== null &&
          !boundedString(alias["parent"])) ||
        (alias["active"] !== undefined &&
          typeof alias["active"] !== "boolean") ||
        (alias["observed"] !== undefined &&
          (typeof alias["observed"] !== "string" ||
            !/^[a-f0-9]{32}$/.test(alias["observed"]))) ||
        (kind === "document" &&
          (alias["sourceId"] !== undefined ||
            alias["parent"] !== undefined ||
            alias["active"] !== undefined)) ||
        (alias["sourceId"] === undefined) !== (alias["parent"] === undefined)
      )
        throw new Error("Reader identity aliases are invalid");
    }
  }
}
function multipleAliases(aliases: readonly Alias[]): boolean {
  return (
    aliases.some(
      (alias) =>
        alias.observed !== undefined &&
        aliases.some(
          (other) =>
            other !== alias &&
            other.observed === alias.observed &&
            other.natural === alias.natural &&
            other.readwiseId === alias.readwiseId &&
            other.sourceId === alias.sourceId,
        ),
    ) ||
    new Set(aliases.map((alias) => alias.readwiseId)).size > 1 ||
    new Set(
      aliases.flatMap((alias) =>
        alias.sourceId === undefined ? [] : [alias.sourceId],
      ),
    ).size > 1 ||
    new Set(
      aliases.flatMap((alias) =>
        alias.parent === undefined ? [] : [alias.parent],
      ),
    ).size > 1
  );
}
function unpackAliases(
  value: unknown,
  account: string,
): Record<string, Alias[]> {
  const aliases = unpackIdentities(value, "identity aliases");
  validateAliases(aliases, account);
  return aliases;
}
export class ReaderIdentities {
  private readonly existing = new Map<string, Item[]>();
  private readonly pendingCreates: Item[] = [];
  private readonly enriched = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  private readonly exportSources = new Map<number, readonly Source[]>();
  private client?: ExportClient;
  private lifecycleReady: boolean;
  private prepared = false;
  private bridge: Bridge;
  private constructor(
    private readonly account: string,
    private readonly context: IdentityContext,
    private readonly state: CheckpointState,
    endpoint: string,
    stored: unknown,
  ) {
    this.lifecycleReady = state.get("lifecycle-ready") === catalogVersion;
    if (stored === undefined)
      this.bridge = {
        account,
        endpoint,
        aliases: {},
        cursor: null,
        seen: [],
        complete: false,
      };
    else {
      if (
        !record(stored) ||
        Buffer.byteLength(JSON.stringify(stored)) > maxBytes ||
        Object.keys(stored)
          .filter((key) => !["start", "lower", "walk"].includes(key))
          .sort()
          .join(",") !== "account,aliases,complete,cursor,endpoint,seen" ||
        stored["account"] !== account ||
        stored["endpoint"] !== endpoint ||
        !Array.isArray(stored["seen"]) ||
        stored["seen"].length > 4096 ||
        stored["seen"].some(
          (entry) => typeof entry !== "string" || !/^[a-f0-9]{64}$/.test(entry),
        ) ||
        new Set(stored["seen"]).size !== stored["seen"].length ||
        typeof stored["complete"] !== "boolean" ||
        (stored["cursor"] !== null && !boundedString(stored["cursor"])) ||
        (stored["complete"] && stored["cursor"] !== null) ||
        (stored["walk"] !== undefined &&
          (typeof stored["walk"] !== "string" ||
            !/^[a-f0-9]{32}$/.test(stored["walk"]))) ||
        (stored["start"] !== undefined && !timestamp(stored["start"])) ||
        (stored["lower"] !== undefined &&
          (!timestamp(stored["lower"]) || stored["start"] === undefined))
      )
        throw new Error(
          "Reader identity cache does not match this account or endpoint, or is invalid",
        );
      this.bridge = {
        account,
        endpoint,
        aliases: unpackAliases(stored["aliases"], account),
        cursor: stored["cursor"],
        seen: stored["seen"] as string[],
        complete: stored["complete"],
        ...(typeof stored["start"] === "string"
          ? { start: stored["start"] }
          : {}),
        ...(typeof stored["walk"] === "string" ? { walk: stored["walk"] } : {}),
        ...(typeof stored["lower"] === "string"
          ? { lower: stored["lower"] }
          : {}),
      };
    }
  }
  static async load(
    account: string,
    endpoint: string,
    context: IdentityContext,
    state: CheckpointState,
  ): Promise<ReaderIdentities> {
    const result = new ReaderIdentities(
      account,
      context,
      state,
      endpoint,
      state.get("identities"),
    );
    const readerParents = new Map<string, string>();
    for (const type of ["readwise.source", "readwise.highlight"]) {
      for (const row of await context.held(type, {
        state: "any",
        includeUnlinked: true,
      })) {
        if (row.properties["account"] !== account) continue;
        result.addPendingCreate(row);
        const id = row.properties["reader_id"] ?? row.properties["external_id"];
        if (typeof id !== "string" || id === "") continue;
        if (
          type === "readwise.source" &&
          row.properties["reader_managed"] !== true &&
          row.properties["readwise_source"] !== "reader"
        )
          continue;
        const exportId = row.properties["readwise_id"];
        const parentId = row.properties["readwise_source_id"];
        if (
          type === "readwise.highlight" &&
          row.properties["reader_managed"] !== true &&
          (typeof parentId !== "string" || !readerParents.has(parentId))
        )
          continue;
        if (type === "readwise.source" && typeof exportId === "string")
          readerParents.set(exportId, id);
        const key = readerIdentity(
          account,
          type === "readwise.source" ? "document" : "highlight",
          id,
        );
        result.existing.set(key, [...(result.existing.get(key) ?? []), row]);
        if (typeof exportId === "string" && row.source_id) {
          result.alias(
            key,
            {
              natural: row.source_id,
              readwiseId: exportId,
              ...(type === "readwise.highlight" &&
              typeof parentId === "string" &&
              readerParents.has(parentId)
                ? {
                    sourceId: Number(parentId),
                    parent: readerParents.get(parentId) ?? "",
                  }
                : {}),
            },
            row.properties,
          );
        }
      }
    }
    for (const intent of context.pendingOutbound())
      if (!intent.acknowledged && intent.change.kind === "created")
        result.addPendingCreate(intent.change.item);
    return result;
  }
  private addPendingCreate(row: Item): void {
    if (
      row.properties["account"] === this.account &&
      row.properties["reader_create"] === true &&
      row.properties["reader_id"] == null &&
      row.properties["canonical_key"] == null
    )
      this.pendingCreates.push(row);
  }
  private async save(): Promise<void> {
    validateAliases(this.bridge.aliases, this.account);
    // The checkpoint also holds listing progress and content work. Keep only IDs
    // here and compress their repeated account and parent keys to leave room.
    const stored = {
      ...this.bridge,
      aliases: packIdentities(this.bridge.aliases, "identity aliases"),
    };
    if (Buffer.byteLength(JSON.stringify(stored)) > maxBytes)
      throw new Error(
        "Reader identity cache exceeds its bounded capacity; import is paused without discarding identities",
      );
    const saved = await this.state.checkpoint("identities", stored);
    if (!saved.committed)
      throw new Error(`Reader identity cache was not saved: ${saved.reason}`);
  }

  private alias(
    key: string,
    value: Alias,
    properties: Readonly<Record<string, unknown>>,
  ): void {
    const previous = this.bridge.aliases[key] ?? [];
    const matching = (alias: Alias) =>
      alias.natural === value.natural &&
      alias.readwiseId === value.readwiseId &&
      (alias.sourceId === undefined ||
        value.sourceId === undefined ||
        alias.sourceId === value.sourceId);
    const held = previous.filter(matching);
    if (held.length === 0) this.bridge.aliases[key] = [...previous, value];
    else if (value.observed !== undefined) {
      // Parent and status are observations, not identity. A later walk replaces
      // old evidence; disagreeing observations in one walk remain a conflict.
      const current = held.filter((alias) => alias.observed === value.observed);
      const retained = previous.filter((alias) => !matching(alias));
      this.bridge.aliases[key] = [
        ...retained,
        ...current,
        ...(current.some(
          (alias) =>
            alias.parent === value.parent && alias.active === value.active,
        )
          ? []
          : [value]),
      ];
    } else if (!held.some((alias) => alias.observed !== undefined)) {
      const compatible = previous.findIndex(matching);
      previous[compatible] = { ...previous[compatible], ...value };
    }
    this.enriched.set(key, properties);
  }
  async prepare(
    client: ExportClient,
    maxPages: number,
    refresh = false,
  ): Promise<boolean> {
    this.client = client;
    if (
      (this.bridge.complete &&
        (refresh || !this.prepared || !this.lifecycleReady)) ||
      this.bridge.start === undefined ||
      this.bridge.walk === undefined
    ) {
      const previous = this.bridge.start;
      const full =
        refresh ||
        this.bridge.walk === undefined ||
        !this.lifecycleReady ||
        previous === undefined ||
        Date.now() - Date.parse(previous) >= fullEvery ||
        Date.parse(previous) > Date.now();
      await this.setLifecycleReady(false);
      if (full)
        for (const aliases of Object.values(this.bridge.aliases))
          for (const alias of aliases) delete alias.active;
      this.bridge = {
        ...this.bridge,
        cursor: null,
        seen: [],
        complete: false,
        start: new Date().toISOString(),
        walk: randomUUID().replaceAll("-", ""),
      };
      if (full) delete this.bridge.lower;
      // Overlap the prior walk to discover claims added while its pages were read.
      else this.bridge.lower = previous;
      this.prepared = false;
      this.exportSources.clear();
      await this.save();
    }
    if (this.bridge.complete) {
      await this.save();
      return true;
    }
    let restarted = false;
    let fromStart = this.bridge.cursor === null;
    const collected = new Map<number, Source[]>();
    for (let at = 0; at < maxPages; at++) {
      let page;
      try {
        page = parsePage(
          await client.page({
            ...(this.bridge.cursor ? { cursor: this.bridge.cursor } : {}),
            ...(this.bridge.lower ? { updatedAfter: this.bridge.lower } : {}),
          }),
        );
      } catch (error) {
        if (
          !(error instanceof InvalidCursor) ||
          this.bridge.cursor === null ||
          restarted
        )
          throw error;
        await this.setLifecycleReady(false);
        for (const aliases of Object.values(this.bridge.aliases))
          for (const alias of aliases) delete alias.active;
        this.bridge.walk = randomUUID().replaceAll("-", "");
        this.bridge.cursor = null;
        this.bridge.seen = [];
        fromStart = true;
        collected.clear();
        this.exportSources.clear();
        await this.save();
        restarted = true;
        at--;
        continue;
      }
      const walk = this.bridge.walk;
      if (walk === undefined)
        throw new Error("Reader identity walk is unavailable");
      for (const source of page.results) {
        const held = collected.get(source.user_book_id) ?? [];
        held.push(source);
        collected.set(source.user_book_id, held);
        if (source.source !== "reader") continue;
        if (source.external_id) {
          const parent = readerIdentity(
            this.account,
            "document",
            source.external_id,
          );
          this.alias(
            parent,
            {
              natural: identity(this.account, "source", source.user_book_id),
              readwiseId: String(source.user_book_id),
            },
            source.is_deleted ? {} : mapSource(this.account, source).properties,
          );
        }
        for (const highlight of source.highlights) {
          if (!highlight.external_id) continue;
          const key = readerIdentity(
            this.account,
            "highlight",
            highlight.external_id,
          );
          this.alias(
            key,
            {
              natural: identity(this.account, "highlight", highlight.id),
              readwiseId: String(highlight.id),
              observed: walk,
              sourceId: source.user_book_id,
              parent:
                source.external_id === "" ? null : (source.external_id ?? null),
              ...(typeof source.is_deleted === "boolean" &&
              typeof highlight.is_deleted === "boolean"
                ? { active: !source.is_deleted && !highlight.is_deleted }
                : {}),
            },
            highlight.is_deleted
              ? {}
              : mapHighlight(this.account, source.user_book_id, highlight)
                  .properties,
          );
        }
      }
      if (page.nextPageCursor !== null) {
        const digest = createHash("sha256")
          .update(page.nextPageCursor)
          .digest("hex");
        if (this.bridge.seen.includes(digest))
          throw new Error("Readwise export repeated an identity cursor");
        if (this.bridge.seen.length >= 4096)
          throw new Error("Readwise identity cursor history is full");
        this.bridge.seen.push(digest);
      }
      this.bridge.cursor = page.nextPageCursor;
      this.bridge.complete = page.nextPageCursor === null;
      await this.save();
      if (this.bridge.complete) {
        if (fromStart && this.bridge.lower === undefined) {
          for (const [id, sources] of collected)
            this.exportSources.set(id, sources);
        }
        await this.save();
        await this.setLifecycleReady(true);
        this.prepared = true;
        return true;
      }
    }
    return false;
  }
  private async setLifecycleReady(value: boolean): Promise<void> {
    const saved = await this.state.checkpoint(
      "lifecycle-ready",
      value ? catalogVersion : false,
    );
    if (!saved.committed)
      throw new Error(
        `Reader lifecycle evidence was not saved: ${saved.reason}`,
      );
    this.lifecycleReady = value;
  }
  private activeAlias(
    document: ReaderDocument,
    aliases: readonly Alias[],
  ): Alias {
    if (!this.bridge.complete || !this.lifecycleReady || !this.prepared)
      throw new Error("Reader lifecycle identity requires a complete export");
    if (typeof document.parent_id !== "string" || !document.parent_id)
      throw new Error("Reader lifecycle identity requires a verified parent");
    if (
      aliases.some(
        (alias) =>
          typeof alias.active !== "boolean" ||
          typeof alias.parent !== "string" ||
          !alias.parent,
      )
    )
      throw new Error(
        "Reader identity conflict: multiple export IDs have incomplete lifecycle evidence",
      );
    const active = aliases.filter((alias) => alias.active);
    if (active.length !== 1)
      throw new Error(
        "Reader identity conflict: multiple export IDs claim one Reader object",
      );
    const selected = active[0];
    if (selected?.parent !== document.parent_id)
      throw new Error(
        "Reader identity conflict: export parent differs from Reader parent",
      );
    return selected;
  }
  private async sourceEvidence(sourceId: number): Promise<readonly Source[]> {
    const cached = this.exportSources.get(sourceId);
    if (cached !== undefined) return cached;
    if (this.client === undefined)
      throw new Error("Reader export client is unavailable");
    const sources: Source[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = parsePage(
        await this.client.page({ sourceId, ...(cursor ? { cursor } : {}) }),
      );
      sources.push(...page.results);
      if (page.nextPageCursor === null) {
        this.exportSources.set(sourceId, sources);
        return sources;
      }
      if (seen.has(page.nextPageCursor))
        throw new Error("Reader export preservation repeated a cursor");
      if (seen.size >= 4096)
        throw new Error("Reader export preservation cursor history is full");
      seen.add(page.nextPageCursor);
      cursor = page.nextPageCursor;
    }
  }
  private async verifyCurrentAliases(
    document: ReaderDocument,
    aliases: readonly Alias[],
  ): Promise<void> {
    if (
      aliases.some((alias, at) =>
        aliases
          .slice(at + 1)
          .some(
            (other) =>
              alias.natural === other.natural &&
              alias.readwiseId === other.readwiseId &&
              alias.sourceId === other.sourceId,
          ),
      )
    )
      throw new Error(
        "Reader lifecycle identity has conflicting export observations",
      );
    const claims: Alias[] = [];
    for (const sourceId of new Set(aliases.map((alias) => alias.sourceId))) {
      if (sourceId === undefined)
        throw new Error("Reader lifecycle identity lacks its export source");
      const sources = await this.sourceEvidence(sourceId);
      if (sources.length === 0)
        throw new Error("Reader lifecycle export source is unavailable");
      for (const source of sources) {
        if (
          source.user_book_id !== sourceId ||
          source.source !== "reader" ||
          typeof source.is_deleted !== "boolean"
        )
          throw new Error(
            "Reader lifecycle export source identity is unverified",
          );
        for (const highlight of source.highlights) {
          if (highlight.external_id !== document.id) continue;
          if (!source.external_id || typeof highlight.is_deleted !== "boolean")
            throw new Error(
              "Reader lifecycle identity has an unknown parent or status",
            );
          claims.push({
            natural: identity(this.account, "highlight", highlight.id),
            readwiseId: String(highlight.id),
            sourceId,
            parent: source.external_id,
            active: !source.is_deleted && !highlight.is_deleted,
          });
        }
      }
    }
    const same = (a: Alias, b: Alias) =>
      a.natural === b.natural &&
      a.readwiseId === b.readwiseId &&
      a.sourceId === b.sourceId &&
      a.parent === b.parent &&
      a.active === b.active;
    if (
      aliases.some(
        (held) => claims.filter((claim) => same(held, claim)).length !== 1,
      ) ||
      claims.some((claim) => !aliases.some((held) => same(held, claim)))
    )
      throw new Error(
        "Reader lifecycle identity needs complete export reconciliation",
      );
  }
  async resolve(document: ReaderDocument): Promise<Resolved> {
    const kind = document.category === "highlight" ? "highlight" : "document";
    const type =
      kind === "highlight" ? "readwise.highlight" : "readwise.source";
    if (
      this.pendingCreates.some(
        (row) =>
          row.type === type &&
          (kind === "highlight"
            ? typeof document.parent_id === "string" &&
              typeof document.content === "string" &&
              row.properties["reader_parent_id"] === document.parent_id &&
              row.properties["text"] === document.content
            : typeof document.source_url === "string" &&
              row.properties["url"] === document.source_url),
      )
    )
      throw new Error(
        "Reader identity admission is blocked by a pending explicit create; only its outbound confirmation can link the local row",
      );
    const canonical = readerIdentity(this.account, kind, document.id);
    const aliases = this.bridge.aliases[canonical] ?? [];
    const multiple = multipleAliases(aliases);
    if (multiple && kind !== "highlight")
      throw new Error(
        "Reader identity conflict: multiple export IDs claim one Reader object",
      );
    if (multiple && kind === "highlight") {
      if (!this.bridge.complete || !this.lifecycleReady || !this.prepared)
        throw new Error("Reader lifecycle identity requires a complete export");
      try {
        await this.verifyCurrentAliases(document, aliases);
      } catch (error) {
        await this.setLifecycleReady(false);
        throw error;
      }
    }
    const alias = multiple
      ? this.activeAlias(document, aliases)
      : aliases.reduce<Alias | undefined>(
          (previous, value) => ({ ...previous, ...value }),
          undefined,
        );
    if (
      kind === "highlight" &&
      alias?.parent !== undefined &&
      alias.parent !== document.parent_id
    )
      throw new Error(
        "Reader identity conflict: export parent differs from Reader parent",
      );
    let exportText: string | undefined;
    if (kind === "highlight" && alias?.sourceId !== undefined) {
      const sources = await this.sourceEvidence(alias.sourceId);
      try {
        if (multiple) {
          const selected = sources.flatMap((source) =>
            source.highlights
              .filter(
                (highlight) =>
                  source.is_deleted === false &&
                  source.user_book_id === alias.sourceId &&
                  source.external_id === document.parent_id &&
                  source.source === "reader" &&
                  highlight.id === Number(alias.readwiseId) &&
                  highlight.external_id === document.id &&
                  highlight.is_deleted === false,
              )
              .map((highlight) => ({ source, highlight })),
          );
          if (selected.length !== 1)
            throw new Error(
              "Reader lifecycle active alias needs complete export reconciliation",
            );
          const evidence = selected[0];
          if (evidence === undefined)
            throw new Error("Reader lifecycle active alias is unavailable");
          this.enriched.set(
            canonical,
            mapHighlight(
              this.account,
              evidence.source.user_book_id,
              evidence.highlight,
            ).properties,
          );
        }
        exportText = readerExportPassage(sources, {
          sourceId: alias.sourceId,
          highlightId: Number(alias.readwiseId),
          readerId: document.id,
          parentId: document.parent_id,
        });
      } catch (error) {
        if (multiple) await this.setLifecycleReady(false);
        throw error;
      }
      this.exportSources.set(alias.sourceId, sources);
    }
    const linked = await this.context.inspect(type, { links: [canonical] });
    const existing = (this.existing.get(canonical) ?? []).filter(
      (row) =>
        !multiple ||
        row.source_id === alias?.natural ||
        row.properties["canonical_key"] === canonical,
    );
    const naturals = [
      canonical,
      ...(multiple && alias
        ? [alias.natural]
        : aliases.map((value) => value.natural)),
      ...existing.flatMap((row) => (row.source_id ? [row.source_id] : [])),
    ];
    const keyed = await this.context.inspect(type, {
      source_ids: [...new Set(naturals)],
    });
    const candidates = new Map(
      [...existing, ...linked.items, ...keyed.items].map((row) => [
        row.id,
        row,
      ]),
    );
    const purged = linked.tombstones.length > 0 || keyed.tombstones.length > 0;
    if (candidates.size > 1 || (purged && candidates.size > 0))
      throw new Error(
        "Reader identity conflict across existing states or tombstones",
      );
    const row = candidates.values().next().value;
    if (
      row !== undefined &&
      (row.properties["account"] !== this.account || !row.source_id)
    )
      throw new Error(
        "Reader identity conflict: existing identity has a different account or no natural key",
      );
    if (
      multiple &&
      row !== undefined &&
      ((row.source_id !== alias?.natural && row.source_id !== canonical) ||
        (row.properties["readwise_id"] !== undefined &&
          row.properties["readwise_id"] !== alias?.readwiseId))
    )
      throw new Error(
        "Reader canonical holder differs from the verified active alias",
      );
    const properties = {
      ...this.enriched.get(canonical),
      ...row?.properties,
      ...(exportText !== undefined ? { readwise_text: exportText } : {}),
      ...(alias
        ? {
            readwise_id: alias.readwiseId,
            ...(alias.sourceId !== undefined
              ? { readwise_source_id: String(alias.sourceId) }
              : {}),
          }
        : {}),
    };
    return {
      canonical,
      type,
      purged,
      ...(row ? { previousProperties: row.properties } : {}),
      enrichment: { sourceId: row?.source_id ?? canonical, properties },
    };
  }
}
