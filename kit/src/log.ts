import { shortestSecret } from "./environment.js";
import type { Clock } from "./runtime.js";

/** Hex escapes in lower case, as some encoders write them. */
function lowered(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/** A secret as it is written, and as a URL or a form may carry it. */
function spelledAs(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const form = new URLSearchParams({ s: secret }).toString().slice(2);
  return [secret, encoded, lowered(encoded), form, lowered(form)];
}

export class Logger {
  private readonly secrets: string[];

  constructor(
    private readonly write: (line: string) => void,
    private readonly clock: Clock,
    secrets: readonly string[] = [],
  ) {
    // One variable may hold several secrets, as a list of private feed
    // addresses does, and each can appear without the others. Longest first,
    // so a secret that contains another is replaced whole.
    const spellings = secrets
      .flatMap((secret) => [
        secret,
        ...secret
          .split(/[\s,]+/)
          .filter((part) => part.length >= shortestSecret),
      ])
      .flatMap(spelledAs);
    this.secrets = [...new Set(spellings)].sort((a, b) => b.length - a.length);
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

  private line(level: string, message: string): void {
    this.write(
      `${this.clock.now().toISOString()} ${level} ${this.redact(message)}`,
    );
  }
}

/** The longest text the server takes in a run's summary or error. */
export const reportCap = 2000;

export function cap(text: string, limit = reportCap): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
