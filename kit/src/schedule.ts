import { ConfigurationError } from "./environment.js";

export type Schedule =
  | { mode: "once" }
  | {
      mode: "every";
      intervalMs: number;
      /** How often, between runs, a connector that reads deliveries looks for one waiting. */
      deliveriesMs: number;
    };

const units = { s: 1000, m: 60_000, h: 3_600_000 } as const;

const usage =
  "run with --once, or with --every <interval> such as 30s, 15m or 1h, and --deliveries-every <interval> after it to change how often waiting deliveries are looked for";

/** Often enough that a delivery is acted on in seconds, and cheap: one short listing. */
export const defaultDeliveriesMs = 10_000;

function interval(text: string | undefined): number | undefined {
  const match = /^([1-9]\d*)([smh])$/.exec(text ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

export function readSchedule(argv: readonly string[]): Schedule {
  if (argv.length === 1 && argv[0] === "--once") return { mode: "once" };
  if (argv[0] === "--every" && (argv.length === 2 || argv.length === 4)) {
    const intervalMs = interval(argv[1]);
    const deliveriesMs =
      argv.length === 2
        ? defaultDeliveriesMs
        : argv[2] === "--deliveries-every"
          ? interval(argv[3])
          : undefined;
    if (intervalMs !== undefined && deliveriesMs !== undefined) {
      return { mode: "every", intervalMs, deliveriesMs };
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
