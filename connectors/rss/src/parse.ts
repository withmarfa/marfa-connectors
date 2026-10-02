import { Worker } from "node:worker_threads";
import type { Feed, Read } from "./feeds.js";
import { TooManyElements, TooManyEntries } from "./feeds.js";

/** What a feed's parse may hold. The largest real feed checked, about
 *  20 MiB, parses within 64 MB of heap. */
export const parseLimits = {
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

export const parseTimeoutMs = 30_000;

export class TooHeavy extends Error {
  override name = "TooHeavy";
}

export class TooSlow extends Error {
  override name = "TooSlow";
}

export class Unreadable extends Error {
  override name = "Unreadable";
}

export interface ParseInput {
  feed: Pick<Feed, "url" | "key">;
  bytes: Uint8Array;
  contentType: string | null;
  documentUrl: string;
}

export type ParseAnswer =
  { read: Read } | { refused: "entries" | "elements" } | { unreadable: true };

/**
 * Decodes and reads a feed in a worker whose heap is capped, so a document
 * built to take more memory or time than any real feed ends the worker, not
 * the connector.
 */
export function readBounded(
  input: ParseInput,
  signal: AbortSignal,
): Promise<Read> {
  return new Promise((done, fail) => {
    const worker = new Worker(new URL("./parse-worker.js", import.meta.url), {
      workerData: input,
      resourceLimits: parseLimits,
    });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() => {
        fail(new TooSlow());
      });
    }, parseTimeoutMs);
    const onAbort = (): void => {
      settle(() => {
        fail(
          signal.reason instanceof Error ? signal.reason : new Error("aborted"),
        );
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (answer: ParseAnswer) => {
      settle(() => {
        if ("read" in answer) done(answer.read);
        else if ("refused" in answer) {
          fail(
            answer.refused === "entries"
              ? new TooManyEntries()
              : new TooManyElements(),
          );
        } else fail(new Unreadable());
      });
    });
    worker.once("error", (error: Error & { code?: string }) => {
      settle(() => {
        fail(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new TooHeavy()
            : new Unreadable(),
        );
      });
    });
    worker.once("exit", () => {
      settle(() => {
        fail(new TooHeavy());
      });
    });
  });
}
