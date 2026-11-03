import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";

const run = promisify(execFile);
const built = resolve(import.meta.dirname, "../dist/main.js");

quietRun({
  sizes: [20, 420],
  async hold(size) {
    const marfa = await new ScriptedServer("github", {
      types: [
        "github.repository",
        "github.issue",
        "github.comment",
        "github.file",
        "github.file.image",
        "github.pull_request",
        "github.discussion",
        "github.notification",
        "github.repository_file",
        "github.directory",
      ],
      edges: [
        "github.in-repository",
        "github.sub-issue-of",
        "github.blocked-by",
        "github.relates-to",
        "github.duplicate-of",
        "attached-to",
        "github.closes",
        "github.closed-by",
        "parent-of",
        "about",
        "references",
        "comments-on",
        "in-thread",
        "in-collection",
      ],
    }).start();
    marfa.grants = {
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    const github = await new GitHubStub().start();
    github.appPem = appKey();
    const repository = github.addRepository("someone/tracker");
    const issues = Array.from({ length: size }, () =>
      github.addIssue(repository),
    );
    // A few relations, so the run asks Marfa what is held under them.
    for (const [at, issue] of issues.entries()) {
      if (at % 10 !== 1) continue;
      const other = issues[at - 1];
      if (other === undefined) continue;
      issue.parent = other.node;
      issue.blocked_by = [other.node];
      issue.relates_to = [other.node];
    }
    return {
      marfa,
      async run() {
        await run("node", [built, "--once"], {
          env: {
            PATH: process.env["PATH"],
            MARFA_API_URL: marfa.url,
            MARFA_API_KEY: marfa.key,
            GITHUB_APP_ID: "12345",
            GITHUB_PRIVATE_KEY: github.appPem,
            GITHUB_WEBHOOK_SECRET: "github-test-webhook-secret",
            ...github.settings,
          },
        });
      },
      async stop() {
        await marfa.stop();
        await github.stop();
      },
    };
  },
});
