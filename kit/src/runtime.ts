export interface Clock {
  now(): Date;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** What the kit takes from the process it runs in. */
export interface Runtime {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One log line, without its newline. */
  write(line: string): void;
  readonly clock: Clock;
  /** Called once when the process is asked to stop. */
  onStop(listener: () => void): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    }),
};

export function nodeRuntime(): Runtime {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    write: (line) => {
      process.stderr.write(`${line}\n`);
    },
    clock: systemClock,
    onStop: (listener) => {
      let called = false;
      const once = (): void => {
        if (called) return;
        called = true;
        listener();
      };
      process.once("SIGTERM", once);
      process.once("SIGINT", once);
    },
  };
}
