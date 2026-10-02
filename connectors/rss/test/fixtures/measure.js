// Reads one strained document through the built connector's bounded read in
// a process of its own, whose high-water marks start clean, and prints how it
// ended and how much the process grew.
/* global process, TextEncoder, AbortSignal, console */
import { resolve } from "node:path";
import { heavyDocument, sharedDocument } from "./documents.js";

const { readBounded } = await import(
  resolve(import.meta.dirname, "../../dist/parse.js")
);
const text = process.argv[2] === "heavy" ? heavyDocument() : sharedDocument();
const bytes = new TextEncoder().encode(text);
const rss = process.resourceUsage().maxRSS;
const heap = process.memoryUsage().heapUsed;
let outcome;
let held;
try {
  held = await readBounded(
    {
      feed: { url: "https://example.org/rss.xml", key: "k" },
      bytes,
      contentType: null,
      documentUrl: "https://example.org/rss.xml",
    },
    AbortSignal.timeout(60_000),
  );
  outcome = `read ${String(held.entries.length)}`;
} catch (error) {
  outcome = error.name;
}
console.log(
  JSON.stringify({
    outcome,
    heapMiB: (process.memoryUsage().heapUsed - heap) / 1048576,
    rssMiB: (process.resourceUsage().maxRSS - rss) / 1024,
    held: held !== undefined,
  }),
);
