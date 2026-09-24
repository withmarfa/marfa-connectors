import type { Clock } from "./runtime.js";

export class Logger {
  private readonly secrets: string[];

  constructor(
    private readonly write: (line: string) => void,
    private readonly clock: Clock,
    secrets: readonly string[] = [],
  ) {
    // Longest first, so a secret that contains another is replaced whole.
    this.secrets = [...secrets].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
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

  private line(level: string, message: string): void {
    this.write(`${this.clock.now().toISOString()} ${level} ${this.redact(message)}`);
  }
}

/** The longest text the server takes in a run's summary or error. */
export const reportCap = 2000;

export function cap(text: string): string {
  return text.length <= reportCap ? text : `${text.slice(0, reportCap - 1)}…`;
}
