import { ConfigurationError } from "./environment.js";

export type Schedule =
  | { mode: "help" }
  | { mode: "once" }
  | { mode: "setup"; file: string }
  | {
      mode: "every";
      intervalMs: number;
      lookMs: number;
      lookGiven: boolean;
    };

const units = { s: 1000, m: 60_000, h: 3_600_000 } as const;

export const usage =
  "run with --once, or with --every <interval> such as 30s, 15m or 1h, and --look-every <interval> after it to change how often the connector looks between runs, or with --setup <file> to set the connector up with its vendor, or with --help to see this again";

export const defaultLookMs = 10_000;

function interval(text: string | undefined): number | undefined {
  const match = /^([1-9]\d*)([smh])$/.exec(text ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

export function readSchedule(argv: readonly string[]): Schedule {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { mode: "help" };
  }
  if (argv.length === 1 && argv[0] === "--once") return { mode: "once" };
  if (argv.length === 2 && argv[0] === "--setup" && argv[1] !== "") {
    return { mode: "setup", file: argv[1] ?? "" };
  }
  if (argv[0] === "--every" && (argv.length === 2 || argv.length === 4)) {
    const intervalMs = interval(argv[1]);
    const lookGiven = argv.length === 4;
    const lookMs = !lookGiven
      ? defaultLookMs
      : argv[2] === "--look-every"
        ? interval(argv[3])
        : undefined;
    if (intervalMs !== undefined && lookMs !== undefined) {
      return { mode: "every", intervalMs, lookMs, lookGiven };
    }
  }
  throw new ConfigurationError(
    argv.length === 0
      ? `no schedule was given: ${usage}`
      : `${usage}; got "${argv.join(" ")}"`,
  );
}

export function backoff(intervalMs: number, failures: number): number {
  if (failures === 0) return intervalMs;
  return intervalMs * Math.min(2 ** failures, 8);
}

export function describeDuration(ms: number): string {
  if (ms % units.h === 0) return `${String(ms / units.h)}h`;
  if (ms % units.m === 0) return `${String(ms / units.m)}m`;
  return `${String(Math.round(ms / 1000))}s`;
}
