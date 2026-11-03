import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { readerVendor } from "../../../scripts/proof/readwise-reader-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");

quietRun({
  sizes: [10, 210],
  async hold(size) {
    const marfa = await new ScriptedServer("readwise", {
      types: ["readwise.source", "readwise.highlight", "readwise.file"],
      edges: ["excerpt-of", "references", "attached-to"],
    }).start();
    marfa.grants = { metadata_permissions: { types: "write" } };
    const vendor = await readerVendor({ incremental: true });
    for (let at = 0; at < size; at += 1) {
      vendor.sources.push({
        user_book_id: 1000 + at,
        source: "kindle",
        external_id: `book-${String(at)}`,
        title: `Book ${String(at)}`,
        updated_at: "2026-09-20T09:00:00Z",
        highlights: [
          {
            id: 5000 + at,
            external_id: `highlight-${String(at)}`,
            text: `Highlight ${String(at)}`,
          },
        ],
      });
    }
    return {
      marfa,
      async run() {
        await run("node", [built, "--once"], {
          env: {
            PATH: process.env["PATH"],
            MARFA_API_URL: marfa.url,
            MARFA_API_KEY: marfa.key,
            READWISE_ACCOUNT: "primary",
            READWISE_ACCESS_TOKEN: "reader-fixture-token",
            READWISE_API_URL: `${vendor.base}/v2/`,
            READWISE_READER_API_URL: `${vendor.base}/v3/`,
          },
        });
      },
      async stop() {
        await marfa.stop();
        await vendor.close();
      },
    };
  },
});
