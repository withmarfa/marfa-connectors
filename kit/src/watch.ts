import type { Change, ChangeKind, Item } from "./define.js";
import type { Marfa } from "./marfa.js";
import { frames } from "./sse.js";
import type { WatchState, Written } from "./state.js";

/** What the read of the log came back with. */
export interface WatchRead {
  /** One per row that changed, each as the log last showed it, in log order. */
  changes: Change[];
  /** Events of the connector's own writes, dropped. */
  own: number;
  /**
   * Rows the connector wrote from the vendor before its link existed,
   * not carried: the vendor has them, and a create would make a twin.
   * The vendor's entries link them as they come.
   */
  unlinked: number;
  /** Where the read reached, to resume from; unchanged where nothing was read. */
  cursor: string | undefined;
  /** The cursor was older than the log keeps, so every row is a change. */
  resync: boolean;
  /** Why the read ended before the head, where it did. */
  incomplete: string | undefined;
}

/**
 * Where the two sides last agreed, by row: the version and state the
 * connector's own write left, or that a change carried back to the vendor
 * showed. An event that shows a row at exactly that version and state is
 * nothing new to the vendor and is not carried back. A record stands until
 * the next agreement replaces it, and is let go when the row is gone.
 */
export class Memory {
  constructor(readonly written: Record<string, Written>) {}

  remember(
    id: string,
    version: number,
    state: string,
    vendorAt?: string,
  ): void {
    this.written[id] = {
      version,
      state,
      ...(vendorAt !== undefined && { vendorAt }),
    };
  }

  /**
   * The vendor's time on the entry the record's row was last agreed with.
   * An agreement closes what was carried: the vendor's copy has come back.
   */
  agreeVendor(id: string, vendorAt: string | undefined): void {
    const record = this.written[id];
    if (record === undefined) return;
    if (vendorAt === undefined) Reflect.deleteProperty(record, "vendorAt");
    else record.vendorAt = vendorAt;
    Reflect.deleteProperty(record, "carried");
  }

  /** What the row's properties were when a change to it was carried to the vendor. */
  carry(id: string, fingerprint: string): void {
    const record = this.written[id];
    if (record === undefined) return;
    record.carried = fingerprint;
  }

  forget(id: string): void {
    Reflect.deleteProperty(this.written, id);
  }

  /**
   * Whether the event is nothing new to the vendor: the connector's own
   * write, or a frame from before the two sides last agreed. A purge
   * forgets the record; any other event leaves it standing.
   */
  own(kind: ChangeKind, item: Item): boolean {
    const record = this.written[item.id];
    if (record === undefined) return false;
    // A purge carries the version and state the row had, which can be
    // those of a trash the connector carried back; the row is gone all
    // the same.
    if (kind === "purged") {
      Reflect.deleteProperty(this.written, item.id);
      return false;
    }
    // A frame from before the record: a person's change the connector has
    // since written over, or its own earlier write. The log shows it
    // before the write that superseded it, and forgetting the record on
    // it would make that write read as somebody else's.
    if (item.version < record.version) return true;
    if (item.version === record.version && item.state === record.state) {
      return true;
    }
    // Past the record, by a version moved or, at the same version, a state
    // somebody else moved it to: a transition moves no version, so a
    // person's restore after a trash the connector carried back would
    // otherwise read as the connector's own. The record stands all the
    // same: it still says where the two sides last agreed, which the
    // conflict rule reads, until the next agreement replaces it.
    return false;
  }
}

function parse(data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The kind of change a frame announces, read from its name and the row's state. */
function kindOf(event: string, item: Item): ChangeKind | undefined {
  switch (event) {
    case "item.created":
      return "created";
    case "item.updated":
      return "updated";
    case "item.deleted":
      return "trashed";
    case "item.restored":
      return "restored";
    case "item.purged":
      return "purged";
    case "item.state_changed":
      if (item.state === "archived") return "archived";
      if (item.state === "trashed") return "trashed";
      return "restored";
    default:
      return undefined;
  }
}

/** A read cut short by a signal or the request timeout. */
function endedEarly(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * A read of the log for the connector's type: from the cursor to the
 * marker the stream sends once its replay is done, one change per row, the
 * connector's own writes dropped. The marker names the position the
 * stream has sent or withheld up to, which the frames alone cannot show,
 * since the stream writes nothing for an event the credential may not
 * see. A stream that ends early, by a timeout, a stop or the server's own
 * word, keeps what was read and resumes from the last id received; a
 * cursor the log no longer serves asks for every row instead.
 */
export class Watch {
  constructor(
    private readonly marfa: Marfa,
    private readonly type: string,
    private readonly stored: WatchState,
    private readonly memory: Memory,
    private readonly signal: AbortSignal,
    /** The link property, where the connector declares one. */
    private readonly link: string | undefined,
    /** The connector's own source, under which its rows carry a natural key. */
    private readonly source: string,
  ) {}

  async read(): Promise<WatchRead> {
    const from = this.stored.cursor ?? "0";
    const latest = new Map<string, Change>();
    let own = 0;
    let unlinked = 0;
    let last: string | undefined;
    let live: string | undefined;
    let resync = false;
    let incomplete: string | undefined;

    // Ended by this read itself once it has what it came for, so the
    // request and its body are released rather than left open.
    const closing = new AbortController();
    const signal = AbortSignal.any([this.signal, closing.signal]);
    try {
      const body = await this.marfa.events(this.type, from, signal);
      for await (const frame of frames(body)) {
        if (frame.event === "stream_cursor") continue;
        if (frame.event === "stream_live") {
          // Null where the server could not say where it was; the last
          // id read then stands.
          const cursor = parse(frame.data)["cursor"];
          live = typeof cursor === "string" ? cursor : undefined;
          break;
        }
        if (frame.event === "catchup_too_old") {
          resync = true;
          break;
        }
        if (frame.event === "stream_incomplete") {
          const reason = parse(frame.data)["reason"];
          incomplete = `the server ended the stream: ${typeof reason === "string" ? reason : "stream_incomplete"}`;
          break;
        }
        if (frame.id !== undefined) last = frame.id;
        const item = parse(frame.data)["item"] as Item | undefined;
        const kind = item === undefined ? undefined : kindOf(frame.event, item);
        // The filter admits the type's subtree; a row of a subtype is not
        // this connector's.
        if (
          item !== undefined &&
          kind !== undefined &&
          item.type === this.type
        ) {
          if (this.memory.own(kind, item)) {
            own += 1;
            latest.delete(item.id);
          } else if (this.predatesLink(kind, item)) {
            unlinked += 1;
            latest.delete(item.id);
          } else {
            // The latest frame for the row, in the log's order of it.
            latest.delete(item.id);
            latest.set(item.id, { kind: this.kindFor(kind, item), item });
          }
        }
      }
    } catch (error) {
      if (!endedEarly(error) || closing.signal.aborted) throw error;
      incomplete = this.signal.aborted
        ? "the read was stopped"
        : "the read timed out";
    } finally {
      closing.abort();
    }

    if (resync) {
      // The head first, then the rows: a change landing between the two is
      // then past the cursor rather than behind it.
      const cursor = await this.head();
      const every = await this.everyRow();
      return {
        changes: every.changes,
        own,
        unlinked: every.unlinked,
        cursor,
        resync: true,
        incomplete,
      };
    }
    // Where to resume from: the position the marker names, which covers
    // the frames this reader was never sent; else the last frame read;
    // else where it was.
    return {
      changes: [...latest.values()],
      own,
      unlinked,
      cursor: live ?? last ?? this.stored.cursor,
      resync: false,
      incomplete,
    };
  }

  /**
   * A row the connector itself wrote from the vendor before its link
   * existed: under its own source with a natural key, and no link value.
   * The vendor has it, so a create would make a twin; the vendor's entry
   * links it as it comes, by the natural key, and a change after that is
   * carried like any other.
   */
  private predatesLink(kind: ChangeKind, item: Item): boolean {
    if (this.link === undefined) return false;
    if (kind !== "created" && kind !== "updated") return false;
    return (
      !this.linked(item) &&
      item.source === this.source &&
      typeof item.source_id === "string"
    );
  }

  /** The head the log stands at now, from a fresh stream's first frame. */
  private async head(): Promise<string | undefined> {
    const closing = new AbortController();
    const signal = AbortSignal.any([this.signal, closing.signal]);
    try {
      const body = await this.marfa.events(this.type, undefined, signal);
      for await (const frame of frames(body)) {
        if (frame.event !== "stream_cursor") continue;
        const cursor = parse(frame.data)["cursor"];
        return typeof cursor === "string" ? cursor : undefined;
      }
      return undefined;
    } finally {
      closing.abort();
    }
  }

  /**
   * Every row of the type as one change, for a read that cannot say what
   * changed: a trashed row is a trash, a row the vendor has not been told
   * about is a create, and the rest are updates.
   */
  private async everyRow(): Promise<{ changes: Change[]; unlinked: number }> {
    const rows = await this.marfa.ownRows(this.type);
    const changes: Change[] = [];
    let unlinked = 0;
    for (const item of rows) {
      if (item.type !== this.type) continue;
      const kind: ChangeKind = item.state === "trashed" ? "trashed" : "updated";
      if (this.predatesLink(kind, item)) {
        unlinked += 1;
        continue;
      }
      changes.push({ kind: this.kindFor(kind, item), item });
    }
    return { changes, unlinked };
  }

  /**
   * The kind a change is handed as. A create and an update are told apart
   * by the link, not by the event: a row the vendor has not been told
   * about is a create to it however it came to change, and a row it knows
   * is an update however the log shows it, as a replay from the start of
   * the log shows the connector's own creates once its memory of them is
   * lost. A transition and a purge keep their kind.
   */
  private kindFor(kind: ChangeKind, item: Item): ChangeKind {
    if (kind !== "created" && kind !== "updated") return kind;
    return this.linked(item) ? "updated" : "created";
  }

  private linked(item: Item): boolean {
    const field = this.link;
    if (field === undefined) return true;
    const value = item.properties[field];
    return typeof value === "string" && value !== "";
  }
}
