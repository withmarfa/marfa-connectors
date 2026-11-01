import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { TodoistStub } from "../../../scripts/proof/todoist-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");
const token = "todoist-test-token-value";

quietRun({
  sizes: [20, 420],
  async hold(size) {
    const marfa = await new ScriptedServer("todoist", {
      types: ["todoist.task"],
    }).start();
    const todoist = await new TodoistStub(token).start();
    todoist.put(
      ...Array.from({ length: size }, (_, at) =>
        todoist.task(String(1000 + at)),
      ),
    );
    return {
      marfa,
      async run() {
        await run("node", [built, "--once"], {
          env: {
            PATH: process.env["PATH"],
            MARFA_API_URL: marfa.url,
            MARFA_API_KEY: marfa.key,
            TODOIST_API_TOKEN: token,
            TODOIST_API_URL: todoist.url,
          },
        });
      },
      async stop() {
        await marfa.stop();
        await todoist.close();
      },
    };
  },
});
