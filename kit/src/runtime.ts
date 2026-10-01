export interface Clock {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface Runtime {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  write(line: string): void;
  readonly clock: Clock;
  readonly requestTimeoutMs: number;
  onStop(listener: () => void): void;
}

/** The longest delay a timer holds; a longer one fires at once. */
const longestTimer = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const until = Date.now() + ms;
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const wait = (): void => {
        const left = until - Date.now();
        if (left <= 0) {
          done();
          return;
        }
        timer = setTimeout(wait, Math.min(left, longestTimer));
      };
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", done, { once: true });
      wait();
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
    requestTimeoutMs: 60_000,
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
