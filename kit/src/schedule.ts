import { ConfigurationError } from "./environment.js";

export type Schedule = { mode: "once" } | { mode: "every"; intervalMs: number };

const units = { s: 1000, m: 60_000, h: 3_600_000 } as const;

const usage =
  "run with --once, or with --every <interval> such as 30s, 15m or 1h";

export function readSchedule(argv: readonly string[]): Schedule {
  if (argv.length === 1 && argv[0] === "--once") return { mode: "once" };
  if (argv.length === 2 && argv[0] === "--every") {
    const match = /^([1-9]\d*)([smh])$/.exec(argv[1] ?? "");
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const unit = match[2] as keyof typeof units;
      return { mode: "every", intervalMs: Number(match[1]) * units[unit] };
    }
  }
  throw new ConfigurationError(`${usage}; got "${argv.join(" ")}"`);
}

/** The wait after `failures` consecutive failures: doubled each time, at most eight intervals. */
export function backoff(intervalMs: number, failures: number): number {
  if (failures === 0) return intervalMs;
  return intervalMs * Math.min(2 ** failures, 8);
}

export function describeDuration(ms: number): string {
  if (ms % units.h === 0) return `${String(ms / units.h)}h`;
  if (ms % units.m === 0) return `${String(ms / units.m)}m`;
  return `${String(Math.round(ms / 1000))}s`;
}
