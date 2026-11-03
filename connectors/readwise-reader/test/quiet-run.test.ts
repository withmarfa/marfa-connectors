import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { readerVendor } from "../../../scripts/proof/readwise-reader-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");

quietRun({
  sizes: [20, 420],
  async hold(size) {
    const marfa = await new ScriptedServer("readwise", {
      types: ["readwise.source", "readwise.highlight", "readwise.file"],
      edges: ["excerpt-of", "references", "attached-to"],
    }).start();
    marfa.grants = { metadata_permissions: { types: "write" } };
    const vendor = await readerVendor({ incremental: true });
    // Highlights of one document: a document's content is preserved a few
    // at a time over many runs, and its listing waits while that work is full.
    vendor.documents.set("doc", {
      id: "doc",
      category: "article",
      title: "Document",
      location: "new",
      updated_at: "2026-09-20T09:00:00Z",
    });
    for (let at = 0; at < size; at += 1) {
      vendor.documents.set(`highlight${String(at)}`, {
        id: `highlight${String(at)}`,
        category: "highlight",
        parent_id: "doc",
        content: `Highlight ${String(at)}`,
        updated_at: "2026-09-20T09:00:00Z",
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
