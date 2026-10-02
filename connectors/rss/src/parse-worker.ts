import { parentPort, workerData } from "node:worker_threads";
import {
  decodeFeed,
  readFeed,
  TooManyElements,
  TooManyEntries,
} from "./feeds.js";
import type { ParseAnswer, ParseInput } from "./parse.js";

const { feed, bytes, contentType, documentUrl } = workerData as ParseInput;
let answer: ParseAnswer;
try {
  answer = {
    read: readFeed(feed, decodeFeed(bytes, contentType), documentUrl),
  };
} catch (error) {
  answer =
    error instanceof TooManyEntries
      ? { refused: "entries" }
      : error instanceof TooManyElements
        ? { refused: "elements" }
        : { unreadable: true };
}
parentPort?.postMessage(answer);
