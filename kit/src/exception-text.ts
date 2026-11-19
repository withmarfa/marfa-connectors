const removed = "[removed]";

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
