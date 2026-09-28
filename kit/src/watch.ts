import type { Item } from "./define.js";
import type { Edge, Marfa } from "./marfa.js";
import { frames } from "./sse.js";

/** One frame the log holds for a row: the row as it then stood. */
export interface Frame {
  readonly item: Item;
}

/** A row the log named since the cursor, with every frame it holds for it. */
export interface Seen {
  /** In log order; the last is the row as the log last showed it. */
  readonly frames: Frame[];
  /** The row is gone from the instance. */
  readonly purged: boolean;
}

/** What the read of the log came back with. */
export interface LogRead {
  /** By row id, in the order of each row's latest frame. */
  readonly rows: Map<string, Seen>;
  /**
   * Rows whose connections of the connector's types changed, by source row
   * id, with the time first seen; what a purge took is left out.
   */
  readonly connected: Map<string, string>;
  /** Where the read reached, to resume from; unchanged where nothing was read. */
  readonly cursor: string | undefined;
  /** The cursor was older than the log keeps, so every row was listed instead. */
  readonly resync: boolean;
  /** Why the read ended before the head, where it did. */
  readonly incomplete: string | undefined;
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

const edgeEvents = new Set(["edge.created", "edge.deleted"]);

const itemEvents = new Set([
  "item.created",
  "item.updated",
  "item.deleted",
  "item.restored",
  "item.purged",
  "item.state_changed",
]);

/** A read cut short by a signal or the request timeout. */
function endedEarly(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function furthest(...cursors: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const cursor of cursors) {
    if (cursor === undefined || !/^\d+$/.test(cursor)) continue;
    if (best === undefined || BigInt(cursor) > BigInt(best)) best = cursor;
  }
  return best;
}

/**
 * The log for the connector's types from the cursor to the stream's live
 * marker, whose position covers frames this reader was never sent.
 */
export class Watch {
  private readonly types: ReadonlySet<string>;

  constructor(
    private readonly marfa: Marfa,
    types: readonly string[],
    private readonly cursor: string | undefined,
    private readonly signal: AbortSignal,
    private readonly connections: ReadonlySet<string> = new Set(),
  ) {
    this.types = new Set(types);
  }

  async read(): Promise<LogRead> {
    const rows = new Map<string, Seen>();
    const connected = new Map<string, string>();
    let last: string | undefined;
    let live: string | undefined;
    let resync = false;
    let incomplete: string | undefined;

    // With no cursor kept, the rows are compared whole: a replay from the
    // log's start would carry again what it still holds, purges included.
    if (this.cursor === undefined) resync = true;
    else {
      // Ended by this read once it has what it came for, so the request and
      // its body are released rather than left open.
      const closing = new AbortController();
      const signal = AbortSignal.any([this.signal, closing.signal]);
      try {
        const body = await this.marfa.events(
          [...this.types],
          this.cursor,
          signal,
          this.connections.size > 0,
        );
        for await (const frame of frames(body)) {
          if (frame.event === "stream_cursor") continue;
          if (frame.event === "stream_live") {
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
          if (edgeEvents.has(frame.event)) {
            const data = parse(frame.data);
            const edge = data["edge"] as Edge | undefined;
            if (
              edge !== undefined &&
              this.connections.has(edge.edge_type) &&
              data["purged_with"] === undefined &&
              !connected.has(edge.source_id)
            ) {
              connected.set(edge.source_id, edge.updated_at);
            }
            continue;
          }
          if (!itemEvents.has(frame.event)) continue;
          const item = parse(frame.data)["item"] as Item | undefined;
          // The filter admits each type's subtree; a row of a subtype is not
          // this connector's.
          if (item === undefined || !this.types.has(item.type)) continue;
          const seen = rows.get(item.id) ?? { frames: [], purged: false };
          seen.frames.push({ item });
          // In the order of each row's latest frame.
          rows.delete(item.id);
          rows.set(item.id, {
            frames: seen.frames,
            purged: frame.event === "item.purged",
          });
        }
      } catch (error) {
        if (!endedEarly(error) || closing.signal.aborted) throw error;
        incomplete = this.signal.aborted
          ? "the read was stopped"
          : "the read timed out";
      } finally {
        closing.abort();
      }
    }

    if (resync) {
      // The head first, then the rows: a change landing between the two is
      // then past the cursor rather than behind it.
      const cursor = await this.head();
      const listed = new Map<string, Seen>();
      const every = new Map<string, string>();
      for (const type of this.types) {
        for (const item of await this.marfa.ownRows(type)) {
          if (item.type !== type) continue;
          listed.set(item.id, { frames: [{ item }], purged: false });
          if (this.connections.size > 0) every.set(item.id, item.updated_at);
        }
      }
      return {
        rows: listed,
        connected: every,
        cursor,
        resync: true,
        incomplete,
      };
    }
    // The furthest of the marker's position, the last frame read and where
    // the read began: a marker behind the cursor, from a reset log, would otherwise repeat what was read.
    return {
      rows,
      connected,
      cursor: furthest(live, last, this.cursor),
      resync: false,
      incomplete,
    };
  }

  /** The head the log stands at now, from a fresh stream's first frame. */
  private async head(): Promise<string | undefined> {
    const closing = new AbortController();
    const signal = AbortSignal.any([this.signal, closing.signal]);
    try {
      const body = await this.marfa.events(
        [...this.types],
        undefined,
        signal,
        false,
      );
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
}
