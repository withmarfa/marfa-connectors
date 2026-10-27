import { createClient } from "@withmarfa/client";
import type { ProofServer } from "./server.js";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  edit,
  item,
  rowsOf,
  type Item,
} from "./connector.js";
import { appKey, GitHubStub } from "./github-stub.js";

export async function proveGitHubPullRequests(
  url: string,
  mintKey: ProofServer["mintKey"],
): Promise<void> {
  const github = await new GitHubStub().start();
  github.appPem = appKey();
  try {
    const repo = github.addRepository("someone/pull-proof", {
      node: "R_pull_proof",
    });
    const issue = github.addIssue(repo, {
      node: "I_pull_proof",
      state: "closed",
    });
    const pr = github.addPullRequest(repo, {
      node: "PR_pull_proof",
      pr_state: "merged",
      merged_at: github.now(),
      closing_issues: [issue.node],
      checks: {
        state: "SUCCESS",
        check_runs: { COMPLETED: 1 },
        statuses: { SUCCESS: 1 },
      },
    });
    issue.closed_by = pr.node;
    const types = [
      "github.repository",
      "github.issue",
      "github.comment",
      "github.pull_request",
      "github.discussion",
      "github.notification",
      "github.repository_file",
      "github.directory",
      "github.file",
      "github.file.image",
    ];
    const connections = [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "github.relates-to",
      "github.duplicate-of",
      "github.closes",
      "github.closed-by",
      "parent-of",
      "references",
      "in-thread",
      "in-collection",
      "attached-to",
    ];
    const key = await mintKey({
      label: "pull request proof",
      source: "proof-github-pulls",
      sources: ["github"],
      type_permissions: Object.fromEntries(
        types.map((type) => [type, "write"]),
      ),
      edge_permissions: Object.fromEntries(
        connections.map((type) => [type, "write"]),
      ),
      metadata_permissions: { types: "write", edge_types: "write" },
      default_tier: "feed",
    });
    const marfa = createClient({ baseUrl: url, credential: key.key });
    const run = async () => {
      const runner = new ConnectorUnderProof("github", url, key.key, {
        GITHUB_APP_ID: "12345",
        GITHUB_PRIVATE_KEY: github.appPem,
        GITHUB_WEBHOOK_SECRET: "github-pull-proof-secret",
        GITHUB_API_URL: github.url,
      });
      const result = await runner.once();
      if (result.code !== 0)
        throw new Error(
          `The connector exited ${String(result.code)}: ${result.output}`,
        );
    };
    const row = async (type: string, id: string): Promise<Item> => {
      const found = (await rowsOf(marfa, type, "github")).get(id);
      if (found === undefined) throw new Error(`No row for ${id}`);
      return found;
    };
    const targets = async (from: Item, type: string): Promise<string[]> => {
      const result = await marfa.GET("/items/{id}/edges", {
        params: { path: { id: from.id }, query: { edge_type: type } },
      });
      if (result.data === undefined) throw new Error("Edges were refused");
      return result.data.data.map((edge) => edge.target_id);
    };
    await check(
      "github: pull requests are read-only tasks with API closing links and check summaries, and unchanged rows retain their versions",
      async () => {
        await run();
        const held = await row("github.pull_request", pr.node);
        const closed = await row("github.issue", issue.node);
        if (
          held.properties["status"] !== "completed" ||
          (await targets(held, "github.closes")).join() !== closed.id ||
          (await targets(closed, "github.closed-by")).join() !== held.id
        )
          throw new Error(
            "Pull request status or closing links did not import",
          );
        await edit(marfa, held, { title: "Local edit" });
        pr.checks = {
          state: "FAILURE",
          check_runs: { COMPLETED: 1 },
          statuses: { FAILURE: 1 },
        };
        await run();
        const restored = await item(marfa, held.id);
        if (
          restored.properties["title"] !== pr.title ||
          JSON.stringify(restored.properties["checks"]) !==
            JSON.stringify(pr.checks)
        )
          throw new Error("Pull request fields or checks did not converge");
        const writes = github.writes().length;
        await run();
        if (
          (await item(marfa, held.id)).version !== restored.version ||
          github.writes().length !== writes
        )
          throw new Error("Unchanged pull request caused writes");
        return "core.task status, API closing edges, read-only edits, checks changed without updated_at, and exact no-op versions held on the real server";
      },
    );
  } finally {
    await github.stop();
  }
}
