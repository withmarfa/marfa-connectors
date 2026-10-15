import { cap } from "./log.js";

/** How many errors deep a cause chain is followed. */
const maxCauses = 5;

const removed = "[removed]";

/** A frame line of a stack: a function and where it ran. */
const frame = /^ {4}at .+(?::\d+:\d+\)?|\((?:<anonymous>|native|index \d+)\))$/;

/** The text after `from` up to the end of the JSON value that opens there,
 *  or to the end of the text when the value is cut short. */
function endOfValue(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return text.length;
}

/**
 * Takes each JSON object or array out of a message. A vendor's refusal often
 * quotes the request it refused or the item it could not take, and what the
 * connector sent or read is a person's. A bracket opens a value only when
 * what follows it can begin one, so `[redacted]` and `[ERR_CODE]` stay.
 */
export function withoutBodies(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const opens =
      char === "{" ||
      (char === "[" &&
        /^\[\s*(?:["{[\d-]|true\b|false\b|null\b)/.test(
          text.slice(at, at + 40),
        ));
    if (!opens) {
      out += char;
      at += 1;
      continue;
    }
    out += removed;
    at = endOfValue(text, at);
  }
  return out;
}

function read(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function textOf(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "";
  }
}

function build(
  error: unknown,
  redact: (text: string) => string,
  depth: number,
  seen: Set<unknown>,
): Error {
  seen.add(error);
  if (!(error instanceof Error)) {
    return new Error(cap(withoutBodies(redact(textOf(error)))));
  }
  const name = redact(textOf(read(error, "name")) || "Error");
  const message = cap(withoutBodies(redact(textOf(read(error, "message")))));
  const stack = textOf(read(error, "stack"));
  const out = new Error(message);
  out.name = name;
  out.stack = [
    `${name}: ${message}`,
    ...redact(stack)
      .split("\n")
      .filter((line) => frame.test(line)),
  ].join("\n");
  const cause = read(error, "cause");
  if (
    cause !== undefined &&
    cause !== null &&
    depth < maxCauses &&
    !seen.has(cause) &&
    (cause instanceof Error || typeof cause === "string")
  ) {
    out.cause = build(cause, redact, depth + 1, seen);
  }
  return out;
}

/**
 * The error to hand an error-tracking service in place of `error`: a fresh
 * error that holds only what a person debugging needs and nothing a failed
 * run could have been carrying.
 *
 * Only the type, the message, the stack's frames and the causes that are
 * errors are copied, so a property such as `body`, `request`, `response` or
 * `details` never leaves, whatever it holds. Every text is redacted with the
 * log's secrets, and a message has its JSON values removed. Item content
 * quoted in a message as prose cannot be told from the message's own words,
 * so it is not removed.
 *
 * Nothing here throws: it runs on the path that reports a failure.
 */
export function reportableError(
  error: unknown,
  redact: (text: string) => string,
): Error {
  try {
    return build(error, redact, 0, new Set());
  } catch {
    return new Error("the error could not be read");
  }
}
