import { shortestSecret } from "./environment.js";
import type { Clock } from "./runtime.js";

function lowered(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

function spelledAs(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const form = new URLSearchParams({ s: secret }).toString().slice(2);
  return [secret, encoded, lowered(encoded), form, lowered(form)];
}

export type Level = "info" | "warn" | "error";

/** Takes each line the log writes, redacted, without its timestamp. */
export type LineSink = (level: Level, message: string, at: Date) => void;

export class Logger {
  private secrets: string[] = [];
  private sink: LineSink | undefined;

  constructor(
    private readonly write: (line: string) => void,
    private readonly clock: Clock,
    secrets: readonly string[] = [],
  ) {
    this.keep(secrets);
  }

  keep(secrets: readonly string[]): void {
    // One variable may hold several secrets, each able to appear alone.
    // Longest first, so a secret that contains another is replaced whole.
    const spellings = secrets
      .flatMap((secret) => [
        secret,
        ...secret
          .split(/[\s,]+/)
          .filter((part) => part.length >= shortestSecret),
      ])
      .flatMap(spelledAs)
      .filter((spelling) => spelling !== "");
    this.secrets = [...new Set([...this.secrets, ...spellings])].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** Hands every later line to `sink` as well. */
  tee(sink: LineSink): void {
    this.sink = sink;
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets)
      out = out.split(secret).join("[redacted]");
    return out;
  }

  info(message: string): void {
    this.line("info", message);
  }

  warn(message: string): void {
    this.line("warn", message);
  }

  error(message: string): void {
    this.line("error", message);
  }

  private line(level: Level, message: string): void {
    const at = this.clock.now();
    const said = this.redact(message);
    this.write(`${at.toISOString()} ${level} ${said}`);
    this.sink?.(level, said, at);
  }
}

/** One too short to find without redacting ordinary words is refused. */
export function keepSecret(logger: Logger, value: string): void {
  if (value.length < shortestSecret) {
    throw new Error(
      `a secret shorter than ${String(shortestSecret)} characters cannot be kept out of the logs`,
    );
  }
  logger.keep([value]);
}

/** The longest text the server takes in a run's summary or error. */
export const reportCap = 2000;

export function cap(text: string, limit = reportCap): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
