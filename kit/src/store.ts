import type { Agreement } from "./agreement.js";
import type { Item } from "./define.js";
import type { Marfa } from "./marfa.js";

/** A purge still to carry, with when and why the vendor last refused it. */
export type Purge = Item & { refused?: { at: string; reason?: string } };

export interface Relinked {
  rows: Record<string, { link: string; type: string }>;
  overflowed?: true;
}

export interface Kept {
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

export class Store {
  private readonly read = new Map<string, Agreement | null>();
  private readonly pending = new Map<string, Agreement | null>();
  readonly oversized = new Set<string>();

  constructor(
    private readonly marfa: Marfa,
    private readonly connectorId: string,
    private readonly process: string,
  ) {}

  async load(): Promise<Kept> {
    return keptOf(await this.marfa.connectorState(this.connectorId));
  }

  save(kept: Kept): Promise<void> {
    return this.marfa.putConnectorState(this.connectorId, this.process, {
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
      const found = await this.marfa.findAgreements(this.connectorId, page);
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
    this.pending.set(id, agreement);
  }

  clear(id: string): void {
    this.pending.set(id, null);
  }

  async flush(only?: readonly string[]): Promise<void> {
    const ids = only ?? [...this.pending.keys()];
    const set: { item_id: string; waiting: boolean; record: Agreement }[] = [];
    const clear: string[] = [];
    for (const id of ids) {
      const agreement = this.pending.get(id);
      if (agreement === undefined) continue;
      if (agreement === null) clear.push(id);
      // One the instance would refuse would stop every flush after it; the
      // row is taken as the vendor has it next time.
      else if (Buffer.byteLength(JSON.stringify(agreement)) > recordBytes) {
        this.oversized.add(id);
        clear.push(id);
      } else {
        set.push({
          item_id: id,
          waiting: agreement.waiting !== undefined,
          record: agreement,
        });
      }
    }
    for (
      let at = 0;
      at < Math.max(set.length, clear.length);
      at += perRequest
    ) {
      await this.marfa.writeAgreements(
        this.connectorId,
        this.process,
        set.slice(at, at + perRequest),
        clear.slice(at, at + perRequest),
      );
    }
    for (const id of ids) {
      const agreement = this.pending.get(id);
      if (agreement === undefined) continue;
      this.read.set(id, agreement);
      this.pending.delete(id);
    }
  }
}
