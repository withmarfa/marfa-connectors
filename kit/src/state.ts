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
 * One small file per connector. Losing it costs a full read of the vendor
 * and never a duplicate row, because every write is compared with the rows
 * the server already holds.
 */
export class StateFile {
  private readonly path: string;

  constructor(
    private readonly dir: string,
    name: string,
    private readonly logger: Logger,
  ) {
    this.path = join(dir, `${name}.json`);
  }

  async load(): Promise<Stored> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      this.logger.warn(`the state file could not be read, so this run starts from nothing: ${String(error)}`);
      return empty();
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed["state"]) && isRecord(parsed["conditions"])) {
        return {
          state: parsed["state"],
          conditions: Object.fromEntries(
            Object.entries(parsed["conditions"]).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        };
      }
    } catch {
      // Reported below with the shape problem, as one condition.
    }
    this.logger.warn("the state file is not one this kit wrote, so this run starts from nothing");
    return empty();
  }

  /** Replaced whole by a rename, so a reader never sees half a file. */
  async save(stored: Stored): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const partial = `${this.path}.${String(process.pid)}.partial`;
    await writeFile(partial, `${JSON.stringify(stored, null, 2)}\n`);
    await rename(partial, this.path);
  }
}
