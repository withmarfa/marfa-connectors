import type { Agreement } from "./agreement.js";
import type { Item } from "./define.js";
import type { Marfa } from "./marfa.js";

/** What the kit keeps for the connector on the instance, beside
 *  the agreements. */
export interface Kept {
  /** The connector's own, such as a sync token. */
  state: Record<string, unknown>;
  /** Lasting conditions by key, as last reported. */
  conditions: Record<string, string>;
  /** Where the read of the log reached. */
  cursor?: string;
  /** Purges read from the log and not yet carried, as the log
   *  last showed each row. */
  purges?: Item[];
}

/** How many agreements one request reads or writes. */
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
    ? kept["purges"].filter(isRecord).map((purge) => purge as unknown as Item)
    : [];
  return {
    state,
    conditions,
    ...(typeof cursor === "string" && { cursor }),
    ...(purges.length > 0 && { purges }),
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

/** The connector's state and each row's agreement, kept on the
 *  instance under the key's own source. */
export class Store {
  /** Read this run; `null` where the instance holds none. */
  private readonly read = new Map<string, Agreement | null>();
  /** Written this run and not yet sent; `null` clears. */
  private readonly pending = new Map<string, Agreement | null>();
  /** Rows whose agreement outgrew the instance's cap and was dropped. */
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
