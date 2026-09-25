import type { Change, ChangeKind, Item } from "./define.js";
import type { Marfa } from "./marfa.js";
import type { Clock } from "./runtime.js";
import { frames, type Frame } from "./sse.js";
import type { WatchState, Written } from "./state.js";

/** What the read of the log came back with. */
export interface WatchRead {
  /** One per row that changed, each as the log last showed it, in log order. */
  changes: Change[];
  /** Events of the connector's own writes, dropped. */
  own: number;
  /** Where the read reached, to resume from; unchanged where nothing was read. */
  cursor: string | undefined;
  /** The cursor was older than the log keeps, so every row is a change. */
  resync: boolean;
  /** Why the read ended before the head, where it did. */
  incomplete: string | undefined;
}

/**
 * The connector's own writes, by row: the version and state each left. An
 * event that shows a row at exactly that version and state is the
 * connector's own and is not carried back to the vendor. A record is let
 * go once the log shows the row past it, or gone.
 */
export class Memory {
  constructor(readonly written: Record<string, Written>) {}

  remember(id: string, version: number, state: string): void {
    this.written[id] = { version, state };
  }

  /** Whether the event is the connector's own, forgetting what is past. */
  own(kind: ChangeKind, item: Item): boolean {
    const record = this.written[item.id];
    if (record === undefined) return false;
    if (kind === "purged" || item.version > record.version) {
      Reflect.deleteProperty(this.written, item.id);
      return false;
    }
    return item.version === record.version && item.state === record.state;
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
 * A read of the log for the connector's type: from the cursor to the head
 * the stream announces, one change per row, the connector's own writes
 * dropped. The read ends when a frame shows the head reached, or when the
 * stream has gone quiet after announcing it, since the frame that would
 * show the head can be one the credential is never sent. A stream that
 * ends early, by a timeout, a stop or the server's own word, keeps what was
 * read; a cursor the log no longer serves asks for every row instead.
 */
export class Watch {
  constructor(
    private readonly marfa: Marfa,
    private readonly type: string,
    private readonly stored: WatchState,
    private readonly memory: Memory,
    private readonly signal: AbortSignal,
    /** The link field, where the connector declares one. */
    private readonly link: string | undefined,
    private readonly clock: Clock,
    private readonly quietMs: number,
  ) {}

  async read(): Promise<WatchRead> {
    const from = this.stored.cursor ?? "0";
    const latest = new Map<string, Change>();
    let own = 0;
    let head: bigint | undefined;
    let last: string | undefined;
    let resync = false;
    let incomplete: string | undefined;

    // Ended by this read itself once it has what it came for, so the
    // request and its body are released rather than left open.
    const closing = new AbortController();
    const signal = AbortSignal.any([this.signal, closing.signal]);
    try {
      const body = await this.marfa.events(this.type, from, signal);
      for await (const frame of this.paced(frames(body), () => head, closing)) {
        if (frame.event === "stream_cursor") {
          const cursor = parse(frame.data)["cursor"];
          head = typeof cursor === "string" ? BigInt(cursor) : undefined;
          if (head !== undefined && BigInt(from) >= head) break;
          continue;
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
          } else {
            // The latest frame for the row, in the log's order of it. A
            // create of a row the vendor already knows, as a replay from
            // the start of the log shows the connector's own creates once
            // its memory of them is lost, is an update to the vendor.
            latest.delete(item.id);
            latest.set(item.id, {
              kind: kind === "created" && this.linked(item) ? "updated" : kind,
              item,
            });
          }
        }
        if (
          head !== undefined &&
          frame.id !== undefined &&
          BigInt(frame.id) >= head
        ) {
          break;
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
      return {
        changes: await this.everyRow(),
        own,
        cursor: await this.head(),
        resync: true,
        incomplete,
      };
    }
    // Where to resume from: the last frame read; the head, where the read
    // was already at it and read nothing; else where it was.
    const reached =
      last ??
      (head !== undefined && BigInt(from) >= head ? String(head) : undefined);
    return {
      changes: [...latest.values()],
      own,
      cursor: reached ?? this.stored.cursor,
      resync: false,
      incomplete,
    };
  }

  /**
   * The frames as they come, ended by a quiet window once the head is
   * announced: a wait on the next frame races the window, and the window
   * winning is the stream having nothing more to replay.
   */
  private async *paced(
    source: AsyncGenerator<Frame>,
    announced: () => bigint | undefined,
    closing: AbortController,
  ): AsyncGenerator<Frame> {
    try {
      for (;;) {
        const next = source.next();
        let result: IteratorResult<Frame> | "quiet";
        if (announced() === undefined) {
          result = await next;
        } else {
          const settled = new AbortController();
          const window = AbortSignal.any([
            this.signal,
            closing.signal,
            settled.signal,
          ]);
          const quiet = this.clock
            .sleep(this.quietMs, window)
            .then((): Promise<IteratorResult<Frame> | "quiet"> => {
              // Ended by a signal rather than by time: the frame's own
              // wait says what happened.
              return window.aborted ? next : Promise.resolve("quiet");
            });
          result = await Promise.race([next, quiet]);
          settled.abort();
        }
        if (result === "quiet") {
          // The request is ended here, so the wait on the next frame
          // settles and the source can be returned; that it settles by
          // rejecting is nobody's business.
          void next.catch(() => undefined);
          closing.abort();
          return;
        }
        if (result.done) return;
        yield result.value;
      }
    } finally {
      await source.return(undefined).catch(() => undefined);
    }
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
  private async everyRow(): Promise<Change[]> {
    const rows = await this.marfa.ownRows(this.type);
    return rows
      .filter((row) => row.type === this.type)
      .map((item) => ({
        kind:
          item.state === "trashed"
            ? "trashed"
            : this.linked(item)
              ? "updated"
              : "created",
        item,
      }));
  }

  private linked(item: Item): boolean {
    const field = this.link;
    if (field === undefined) return true;
    const value = item.properties[field];
    return typeof value === "string" && value !== "";
  }
}
