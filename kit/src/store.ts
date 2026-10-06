import type { Agreement } from "./agreement.js";
import { readJournal } from "./inbound-retry.js";
import type { PendingInbound, Item } from "./define.js";
import type { Marfa } from "./marfa.js";

/** A purge still to carry, with when and why the vendor last refused it, and
 *  how many times it has. */
export type Purge = Item & {
  refused?: { at: string; reason?: string; count?: number };
};

/** How many times the vendor may refuse a purge before it is given up. A
 *  refused purge is asked again a day later, so this is about a week. */
export const purgeRefusalLimit = 7;

/** The most the pending purges may take of the saved state, which the
 *  instance caps at 512 KiB, so the rest of it is always kept. */
export const purgeBytes = 128 * 1024;

/** What carrying a purge needs: the row's own fields and its link, never the
 *  rest of its properties, edges or extensions. */
export function purgeOf(item: Item, linkField: string, link: string): Purge {
  const kept: Purge = { ...item, properties: { [linkField]: link } };
  Reflect.deleteProperty(kept, "edges");
  Reflect.deleteProperty(kept, "extensions");
  return kept;
}

export interface Relinked {
  rows: Record<string, { link: string; type: string }>;
  overflowed?: true;
}

export interface Kept {
  inbound?: PendingInbound[];
  state: Record<string, unknown>;
  conditions: Record<string, string>;
  cursor?: string;
  purges?: Purge[];
  /** The link agreed for each row whose own link differs and could not be
   *  put back, which a purge, dropping the agreement, would otherwise lose;
   *  `overflowed` once one was past what is kept. */
  relinked?: Relinked;
}

const perRequest = 500;

/** The instance's cap on one agreement, serialized. */
const recordBytes = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keptOf(value: unknown): Kept {
  const kept = isRecord(value) ? value : {};
  const state = isRecord(kept["state"]) ? kept["state"] : {};
  const conditions = isRecord(kept["conditions"])
    ? Object.fromEntries(
        Object.entries(kept["conditions"]).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  const cursor = kept["cursor"];
  const purges = Array.isArray(kept["purges"])
    ? kept["purges"].filter(isRecord).map((purge) => purge as unknown as Purge)
    : [];
  const held = isRecord(kept["relinked"]) ? kept["relinked"] : {};
  const relinked: Relinked = {
    rows: Object.fromEntries(
      Object.entries(isRecord(held["rows"]) ? held["rows"] : {}).flatMap(
        ([id, row]) =>
          isRecord(row) &&
          typeof row["link"] === "string" &&
          typeof row["type"] === "string"
            ? [[id, { link: row["link"], type: row["type"] }]]
            : [],
      ),
    ),
    ...(held["overflowed"] === true && { overflowed: true }),
  };
  return {
    state,
    conditions,
    ...(kept["inbound"] !== undefined && {
      inbound: readJournal(kept["inbound"]),
    }),
    ...(typeof cursor === "string" && { cursor }),
    ...(purges.length > 0 && { purges }),
    ...((Object.keys(relinked.rows).length > 0 ||
      relinked.overflowed === true) && { relinked }),
  };
}

function agreementOf(value: unknown): Agreement | undefined {
  if (!isRecord(value)) return undefined;
  const { vendor, marfa, state } = value;
  if (!isRecord(vendor) || !isRecord(marfa)) return undefined;
  if (state !== "active" && state !== "archived" && state !== "trashed") {
    return undefined;
  }
  return value as unknown as Agreement;
}

/** How much of a refusal's reason is kept. */
export const reasonBytes = 200;

export function capBytes(text: string, bytes: number): string {
  let kept = "";
  for (const char of text) {
    if (Buffer.byteLength(kept + char) > bytes) break;
    kept += char;
  }
  return kept;
}

function fits(agreement: Agreement): boolean {
  return Buffer.byteLength(JSON.stringify(agreement)) <= recordBytes;
}

/**
 * The agreement with a refusal's mark and its reason, cut to `reasonBytes`;
 * the reason goes first where both would pass the instance's cap, and
 * nothing is answered where even the mark would, so the mark never costs
 * the row its agreement.
 */
export function withRefusal(
  agreement: Agreement,
  change: string,
  reason: string,
): Agreement | undefined {
  const full: Agreement = {
    ...agreement,
    refused: { change, reason: capBytes(reason, reasonBytes) },
  };
  if (fits(full)) return full;
  const bare: Agreement = { ...agreement, refused: { change } };
  return fits(bare) ? bare : undefined;
}

export class AgreementBlocked extends Error {
  constructor(readonly reason: "agreement-skipped" | "agreement-oversized") {
    super(reason);
  }
}

export class Store {
  private readonly read = new Map<string, Agreement | null>();
  private readonly pending = new Map<string, Agreement | null>();
  readonly oversized = new Set<string>();

  constructor(
    private readonly marfa: Marfa,
    private readonly connectorId: string,
    private readonly process: string,
    private readonly hooks?: {
      changed(id: string): void;
      acknowledged(id: string): void;
      check(): void;
    },
  ) {}

  async load(): Promise<Kept> {
    return keptOf(await this.marfa.connectorState(this.connectorId));
  }

  save(kept: Kept): Promise<void> {
    if (kept.inbound !== undefined) {
      readJournal(kept.inbound);
      if (Buffer.byteLength(JSON.stringify(kept), "utf8") > 512 * 1024)
        throw new Error("inbound retry envelope exceeds 512 KiB");
    }
    return this.marfa.putConnectorState(this.connectorId, this.process, {
      ...(kept.inbound !== undefined && { inbound: kept.inbound }),
      state: kept.state,
      conditions: kept.conditions,
      ...(kept.cursor !== undefined && { cursor: kept.cursor }),
      ...(kept.purges !== undefined && { purges: kept.purges }),
      ...(kept.relinked !== undefined && { relinked: kept.relinked }),
    });
  }

  async fetch(ids: Iterable<string>): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => !this.read.has(id));
    for (let at = 0; at < wanted.length; at += perRequest) {
      const page = wanted.slice(at, at + perRequest);
      const found = await this.marfa.lookupAgreements(this.connectorId, page);
      for (const id of page) this.read.set(id, null);
      for (const row of found) {
        this.read.set(row.item_id, agreementOf(row.record) ?? null);
      }
    }
  }

  waiting(signal: AbortSignal): Promise<string[]> {
    return this.marfa.waitingAgreements(this.connectorId, signal);
  }

  get(id: string): Agreement | undefined {
    const pending = this.pending.get(id);
    if (pending !== undefined) return pending ?? undefined;
    return this.read.get(id) ?? undefined;
  }

  set(id: string, agreement: Agreement): void {
    this.hooks?.changed(id);
    this.pending.set(id, agreement);
  }

  clear(id: string): void {
    this.hooks?.changed(id);
    this.pending.set(id, null);
  }

  async flush(only?: readonly string[], check?: () => void): Promise<void> {
    const snapshot = new Map(
      [...new Set(only ?? this.pending.keys())].flatMap((id) => {
        const agreement = this.pending.get(id);
        return agreement === undefined ? [] : [[id, agreement] as const];
      }),
    );
    // Preflight all prerequisites before writing any batch. An oversized
    // intention remains pending; replacing it with a clear loses recovery.
    let oversized = false;
    for (const [id, agreement] of snapshot) {
      if (agreement !== null && !fits(agreement)) {
        this.oversized.add(id);
        oversized = true;
      } else {
        this.oversized.delete(id);
      }
    }
    if (oversized) throw new AgreementBlocked("agreement-oversized");
    const set = [...snapshot].flatMap(([id, agreement]) =>
      agreement === null
        ? []
        : [
            {
              item_id: id,
              waiting: agreement.waiting !== undefined,
              record: agreement,
            },
          ],
    );
    const clear = [...snapshot].flatMap(([id, agreement]) =>
      agreement === null ? [id] : [],
    );
    let skippedAny = false;
    for (
      let at = 0;
      at < Math.max(set.length, clear.length);
      at += perRequest
    ) {
      this.hooks?.check();
      check?.();
      const writing = set.slice(at, at + perRequest);
      const clearing = clear.slice(at, at + perRequest);
      const ids = new Set([
        ...writing.map((entry) => entry.item_id),
        ...clearing,
      ]);
      const result: unknown = await this.marfa.writeAgreements(
        this.connectorId,
        this.process,
        writing,
        clearing,
      );
      if (
        !isRecord(result) ||
        !Array.isArray(result["skipped"]) ||
        !result["skipped"].every(
          (id) => typeof id === "string" && ids.has(id),
        ) ||
        new Set(result["skipped"]).size !== result["skipped"].length ||
        !Number.isInteger(result["written"]) ||
        !Number.isInteger(result["cleared"])
      ) {
        throw new Error("invalid agreement acknowledgment");
      }
      const skipped = new Set(result["skipped"] as string[]);
      const written = writing.filter(
        (entry) => !skipped.has(entry.item_id),
      ).length;
      const clearable = clearing.filter((id) => !skipped.has(id)).length;
      // cleared counts deleted rows, not accepted clear IDs. A readable row
      // without an agreement correctly acknowledges an idempotent clear as 0.
      if (
        result["written"] !== written ||
        (result["cleared"] as number) < 0 ||
        (result["cleared"] as number) > clearable
      ) {
        throw new Error("invalid agreement acknowledgment counts");
      }
      skippedAny ||= skipped.size > 0;
      for (const id of ids) {
        if (skipped.has(id)) continue;
        const agreement = snapshot.get(id);
        if (agreement === undefined || this.pending.get(id) !== agreement)
          continue;
        this.read.set(id, agreement);
        this.pending.delete(id);
        this.hooks?.acknowledged(id);
      }
    }
    if (skippedAny) throw new AgreementBlocked("agreement-skipped");
  }
}
