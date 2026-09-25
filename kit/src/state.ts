import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./log.js";

/** A write of the connector's own, as the log will show it. */
export interface Written {
  version: number;
  state: string;
}

/**
 * The kit's own section of the file, for a connector that carries changes
 * back to its vendor: where its read of the log reached, and the writes it
 * made, so their events are known as its own and not carried back.
 */
export interface WatchState {
  cursor?: string;
  written: Record<string, Written>;
}

export interface Stored {
  /** The connector's own, such as a sync token. */
  state: Record<string, unknown>;
  /** Lasting conditions by key, as last reported. */
  conditions: Record<string, string>;
  watch: WatchState;
}

function empty(): Stored {
  return { state: {}, conditions: {}, watch: { written: {} } };
}

function isWritten(value: unknown): value is Written {
  return (
    isRecord(value) &&
    typeof value["version"] === "number" &&
    typeof value["state"] === "string"
  );
}

/** The watch section as the kit wrote it, or empty where the file has none. */
function watchOf(value: unknown): WatchState {
  if (!isRecord(value)) return { written: {} };
  const cursor = value["cursor"];
  const written = isRecord(value["written"]) ? value["written"] : {};
  return {
    ...(typeof cursor === "string" && { cursor }),
    written: Object.fromEntries(
      Object.entries(written).filter((entry): entry is [string, Written] =>
        isWritten(entry[1]),
      ),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One small file per connector, and a cache: losing it costs a full read of
 * the vendor and never a duplicate row, because every write is compared with
 * the rows the server already holds, trashed ones included. For a connector
 * that carries changes back, losing it also costs one replay of the log:
 * every row is offered to the vendor once more, the ones it already knows
 * as updates, which a vendor that compares first takes as nothing new; and
 * the connector's own writes in that replay read as anybody's, so a row
 * the vendor has since changed is decided by the times, and a vendor that
 * names none loses that one round.
 */
export class StateFile {
  private readonly path: string;

  /**
   * Named for the key's own source, which no other live key holds: two
   * accounts' processes may share one directory, and two processes under
   * one key share one account's state.
   */
  constructor(
    private readonly dir: string,
    keySource: string,
    private readonly logger: Logger,
  ) {
    this.path = join(dir, `${encodeURIComponent(keySource)}.json`);
  }

  async load(): Promise<Stored> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      this.logger.warn(
        `the state file could not be read, so this run starts from nothing: ${String(error)}`,
      );
      return empty();
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        isRecord(parsed) &&
        isRecord(parsed["state"]) &&
        isRecord(parsed["conditions"])
      ) {
        return {
          state: parsed["state"],
          conditions: Object.fromEntries(
            Object.entries(parsed["conditions"]).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
          watch: watchOf(parsed["watch"]),
        };
      }
    } catch {
      // Said below in the one warning for any file this kit did not write.
    }
    this.logger.warn(
      "the state file is not one this kit wrote, so this run starts from nothing",
    );
    return empty();
  }

  /** Replaced whole by a rename, so a reader never sees half a file. */
  async save(stored: Stored): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // The watch section only where there is one: a connector that carries
    // nothing back has no cursor and no writes to remember.
    const { watch, ...rest } = stored;
    const empty =
      watch.cursor === undefined && Object.keys(watch.written).length === 0;
    const written = empty ? rest : { ...rest, watch };
    // Named apart, since two processes sharing the directory may both write.
    const partial = `${this.path}.${randomUUID()}.partial`;
    await writeFile(partial, `${JSON.stringify(written, null, 2)}\n`);
    await rename(partial, this.path);
  }
}
