import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");

// Keep this test when you rewrite the example: give `hold` your vendor's stub
// holding `size` items, and `sizes` two sizes a few hundred rows apart.
quietRun({
  sizes: [20, 420],
  async hold(size) {
    const marfa = await new ScriptedServer("example", {
      types: ["example.item"],
    }).start();
    const items = Array.from({ length: size }, (_, at) => ({
      id: String(at),
      title: `Item ${String(at)}`,
      created: "2026-09-01T10:00:00.000Z",
    }));
    const vendor = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ account: "acct", items }));
    });
    await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`;
    return {
      marfa,
      async run() {
        await run("node", [built, "--once"], {
          env: {
            PATH: process.env["PATH"],
            MARFA_API_URL: marfa.url,
            MARFA_API_KEY: marfa.key,
            EXAMPLE_URL: url,
            EXAMPLE_TOKEN: "example-vendor-token",
          },
        });
      },
      async stop() {
        await marfa.stop();
        vendor.closeAllConnections();
        await new Promise((done) => vendor.close(done));
      },
    };
  },
});
