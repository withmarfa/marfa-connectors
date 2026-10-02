import { parentPort, workerData } from "node:worker_threads";
import {
  decodeFeed,
  readFeed,
  TooManyElements,
  TooManyEntries,
} from "./feeds.js";
import type { Read } from "./feeds.js";
import { maxResultChars } from "./parse.js";
import type { ParseAnswer, ParseInput } from "./parse.js";

const { feed, bytes, contentType, documentUrl } = workerData as ParseInput;

// Serialized entry by entry against the cap, so a value every entry shares
// is paid for once per entry here, within this worker's heap, and never
// copied out past the cap.
function serialized(read: Read): string | undefined {
  const { entries, ...rest } = read;
  const parts: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const part = JSON.stringify(entry);
    length += part.length + 1;
    if (length > maxResultChars) return undefined;
    parts.push(part);
  }
  const json = `{"entries":[${parts.join(",")}],${JSON.stringify(rest).slice(1)}`;
  return json.length > maxResultChars ? undefined : json;
}

let answer: ParseAnswer;
try {
  const json = serialized(
    readFeed(feed, decodeFeed(bytes, contentType), documentUrl),
  );
  answer = json === undefined ? { refused: "size" } : { read: json };
} catch (error) {
  answer =
    error instanceof TooManyEntries
      ? { refused: "entries" }
      : error instanceof TooManyElements
        ? { refused: "elements" }
        : { unreadable: true };
}
parentPort?.postMessage(answer);
