import { parseArgs } from "node:util";
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

const flags = {
  help: { type: "boolean", short: "h" },
  once: { type: "boolean" },
  setup: { type: "string" },
  every: { type: "string" },
  "look-every": { type: "string" },
} as const;

export function readSchedule(argv: readonly string[]): Schedule {
  const given = flagsOf(argv);
  // The flags, in the order given, name the one shape a schedule can take.
  const shape = given.map((flag) => flag.name).join(" ");
  const first = given[0]?.value;
  if (shape === "help") return { mode: "help" };
  if (shape === "once") return { mode: "once" };
  if (shape === "setup" && first !== undefined && first !== "") {
    return { mode: "setup", file: first };
  }
  if (shape === "every" || shape === "every look-every") {
    const intervalMs = interval(first);
    const lookGiven = given.length === 2;
    const lookMs = lookGiven ? interval(given[1]?.value) : defaultLookMs;
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

/** What was given, or nothing the schedule can use when it does not parse
 *  as flags alone. */
function flagsOf(
  argv: readonly string[],
): { name: string; value: string | undefined }[] {
  try {
    const { tokens } = parseArgs({
      args: [...argv],
      options: flags,
      tokens: true,
    });
    return tokens.map((token): { name: string; value: string | undefined } =>
      token.kind === "option"
        ? { name: token.name, value: token.value }
        : { name: token.kind, value: undefined },
    );
  } catch {
    return [];
  }
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
