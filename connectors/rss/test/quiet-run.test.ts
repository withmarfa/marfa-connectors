import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");

quietRun({
  sizes: [20, 420],
  async hold(size) {
    const marfa = await new ScriptedServer("rss", {
      types: ["rss.entry"],
    }).start();
    const items = Array.from(
      { length: size },
      (_, at) =>
        `<item><title>Entry ${String(at)}</title><guid>${String(at)}</guid><pubDate>Wed, 16 Sep 2026 09:00:00 GMT</pubDate></item>`,
    ).join("");
    // Served whole each time, with no validator, so every run reads it all.
    const feed = createServer((_req, res) => {
      res
        .writeHead(200, { "Content-Type": "application/xml" })
        .end(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`,
        );
    });
    await new Promise<void>((done) => feed.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${String((feed.address() as AddressInfo).port)}/feed.xml`;
    return {
      marfa,
      async run() {
        await run("node", [built, "--once"], {
          env: {
            PATH: process.env["PATH"],
            MARFA_API_URL: marfa.url,
            MARFA_API_KEY: marfa.key,
            RSS_FEEDS: url,
          },
        });
      },
      async stop() {
        await marfa.stop();
        feed.closeAllConnections();
        await new Promise((done) => feed.close(done));
      },
    };
  },
});
