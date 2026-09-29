import { ConfigurationError } from "./environment.js";

export type Schedule =
  | { mode: "once" }
  /** Runs the connector's setup once, writing what it answers to `file`. */
  | { mode: "setup"; file: string }
  | {
      mode: "every";
      intervalMs: number;
      /** How often, between runs, the connector looks for a waiting
       *  delivery or a change in Marfa to carry back. */
      lookMs: number;
      /** `--look-every` was given, which only a looking connector
       *  may take. */
      lookGiven: boolean;
    };

const units = { s: 1000, m: 60_000, h: 3_600_000 } as const;

const usage =
  "run with --once, or with --every <interval> such as 30s, 15m or 1h, and --look-every <interval> after it to change how often the connector looks between runs, or with --setup <file> to set the connector up with its vendor";

/** Often enough a delivery or edit is acted on in seconds, and cheap. */
export const defaultLookMs = 10_000;

function interval(text: string | undefined): number | undefined {
  const match = /^([1-9]\d*)([smh])$/.exec(text ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

export function readSchedule(argv: readonly string[]): Schedule {
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
  throw new ConfigurationError(`${usage}; got "${argv.join(" ")}"`);
}

/** The wait after `failures` consecutive failures: doubled each
 *  time, at most eight intervals. */
export function backoff(intervalMs: number, failures: number): number {
  if (failures === 0) return intervalMs;
  return intervalMs * Math.min(2 ** failures, 8);
}

export function describeDuration(ms: number): string {
  if (ms % units.h === 0) return `${String(ms / units.h)}h`;
  if (ms % units.m === 0) return `${String(ms / units.m)}m`;
  return `${String(Math.round(ms / 1000))}s`;
}
