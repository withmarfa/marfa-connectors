import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./log.js";

export interface Stored {
  /** The connector's own, such as a sync token. */
  state: Record<string, unknown>;
  /** Lasting conditions by key, as last reported. */
  conditions: Record<string, string>;
}

function empty(): Stored {
  return { state: {}, conditions: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One small file per connector, and a cache: losing it costs a full read of
 * the vendor and never a duplicate row, because every write is compared with
 * the rows the server already holds, trashed ones included.
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
    // Named apart, since two processes sharing the directory may both write.
    const partial = `${this.path}.${randomUUID()}.partial`;
    await writeFile(partial, `${JSON.stringify(stored, null, 2)}\n`);
    await rename(partial, this.path);
  }
}
