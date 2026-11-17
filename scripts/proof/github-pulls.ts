import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createClient,
  type MarfaClient,
  type components,
} from "@withmarfa/client";
import type { ProofServer } from "./server.js";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  edit,
  item,
  registration,
  rowsOf,
  type Item,
} from "./connector.js";
import { appKey, GitHubStub } from "./github-stub.js";

export async function proveGitHubPullRequests(
  url: string,
  admin: MarfaClient,
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
      "comments-on",
      "about",
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
      return result.data.data.map((edge) => edge.to_id);
    };
    const checkRows = async (
      held: Item,
    ): Promise<Record<string, unknown>[]> => {
      const rows: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const { data, error } = await marfa.GET(
          "/items/{id}/tables/{table}/rows",
          {
            params: {
              path: { id: held.id, table: "check_runs" },
              query: { limit: 1000, ...(cursor !== undefined && { cursor }) },
            },
          },
        );
        if (data === undefined)
          throw new Error(`the rows were refused: ${JSON.stringify(error)}`);
        rows.push(...data.data.map((one) => one.values));
        cursor = data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return rows;
    };
    await check(
      "github: a pull request type stored without its table gains it on start, with only metadata types=write",
      async () => {
        const declared = JSON.parse(
          readFileSync(
            resolve(
              import.meta.dirname,
              "../../../connectors/github/src/github.pull_request.json",
            ),
            "utf8",
          ),
        ) as Record<string, unknown>;
        delete declared["tables"];
        const body = declared as components["schemas"]["TypeDefinitionInput"];
        // Another group may have registered the type already: it is put back
        // as it was before it held the table, which takes the admin key.
        const held = await admin.GET("/types/{id}", {
          params: { path: { id: "github.pull_request" } },
        });
        const stored =
          held.data === undefined
            ? await admin.POST("/types", { body })
            : await admin.PUT("/types/{id}", {
                params: { path: { id: "github.pull_request" } },
                body,
              });
        if (stored.data === undefined)
          throw new Error(
            `the type was refused: ${JSON.stringify(stored.error)}`,
          );
        await run();
        const served = await marfa.GET("/types/{id}", {
          params: { path: { id: "github.pull_request" } },
        });
        const columns = Object.keys(
          served.data?.tables?.["check_runs"]?.columns ?? {},
        );
        if (!columns.includes("name") || !columns.includes("completed_at"))
          throw new Error(
            `the stored type holds the columns ${columns.join(", ")}`,
          );
        return "the stored pull request type gained its check_runs table when the connector started, and the pull request imported";
      },
    );
    await check(
      "github: pull requests are read-only tasks with API closing links and check summaries, and unchanged rows retain their versions",
      async () => {
        await run();
        const held = await row("github.pull_request", pr.node);
        const closed = await row("github.issue", issue.node);
        if (
          held.properties["status"] !== "merged" ||
          "pr_state" in held.properties ||
          "draft" in held.properties ||
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
    await check(
      "github: a pull request's checks are rows of its check_runs table: written once, changed, deleted when GitHub drops them, and a refused row is reported while the rest are kept",
      async () => {
        const checked = github.addPullRequest(repo, {
          node: "PR_checks_proof",
          checks: {
            state: "SUCCESS",
            check_runs: { COMPLETED: 2 },
            statuses: { SUCCESS: 1 },
          },
          check_list: [
            {
              id: "CR_proof_build",
              kind: "check_run",
              name: "build",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              url: "https://example.test/build",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:05:00Z",
            },
            {
              id: "CR_proof_lint",
              kind: "check_run",
              name: "lint",
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
            {
              id: "SC_proof_deploy",
              kind: "status",
              name: "ci/deploy",
              status: "SUCCESS",
            },
            {
              id: "CR_proof_long",
              kind: "check_run",
              name: "x".repeat(300),
              status: "QUEUED",
            },
          ],
        });
        await run();
        const held = await row("github.pull_request", checked.node);
        const names = async (): Promise<string> =>
          (await checkRows(held))
            .map((one) => String(one["name"]))
            .sort()
            .join();
        if ((await names()) !== "build,ci/deploy,lint")
          throw new Error(`the table holds ${await names()}`);
        const connector = await registration(marfa, key.id);
        const state = await marfa.GET("/connectors/{id}/state", {
          params: { path: { id: connector.id } },
        });
        if (
          !Object.keys(state.data?.problems ?? {}).includes(
            "table-rows:github.pull_request:check_runs",
          )
        )
          throw new Error("the refused row was not reported");
        const built = (await checkRows(held)).find(
          (one) => one["name"] === "build",
        );
        if (
          built?.["conclusion"] !== "SUCCESS" ||
          built["kind"] !== "check_run" ||
          built["completed_at"] === undefined
        )
          throw new Error(`the build row is ${JSON.stringify(built)}`);
        const [first, second, third] = checked.check_list ?? [];
        if (first === undefined || second === undefined || third === undefined)
          throw new Error("the stub lost its checks");
        // Short names only from here: the long one is no longer listed.
        checked.check_list = [{ ...first, conclusion: "FAILURE" }, third];
        github.edit(checked, { title: "Retitled" });
        await run();
        const after = await checkRows(held);
        if (
          after
            .map((one) => String(one["name"]))
            .sort()
            .join() !== "build,ci/deploy" ||
          after.find((one) => one["name"] === "build")?.["conclusion"] !==
            "FAILURE"
        )
          throw new Error(`the table holds ${JSON.stringify(after)}`);
        const writes = github.writes().length;
        const version = (await item(marfa, held.id)).version;
        await run();
        if (
          (await item(marfa, held.id)).version !== version ||
          (await checkRows(held)).length !== 2 ||
          github.writes().length !== writes
        )
          throw new Error("a run with nothing new changed the rows");
        return "four checks came, the 300-character name was refused and reported while three rows were kept, a changed check was replaced, an unlisted check was deleted, and a repeated run changed nothing, on the real server";
      },
    );
    await check(
      "github: a check that returns to an earlier state is written again, and a row deleted, restored and deleted again is deleted again",
      async () => {
        const returning = github.addPullRequest(repo, {
          node: "PR_checks_return_proof",
          checks: {
            state: "PENDING",
            check_runs: { IN_PROGRESS: 1 },
            statuses: {},
          },
          check_list: [
            {
              id: "CR_return_build",
              kind: "check_run",
              name: "build",
              status: "IN_PROGRESS",
            },
          ],
        });
        await run();
        const held = await row("github.pull_request", returning.node);
        const states = async (): Promise<string> =>
          (await checkRows(held))
            .map((one) => `${String(one["name"])}:${String(one["status"])}`)
            .join();
        const [build] = returning.check_list ?? [];
        if (build === undefined) throw new Error("the stub lost its check");
        const seen: string[] = [];
        for (const status of ["COMPLETED", "IN_PROGRESS"]) {
          returning.check_list = [{ ...build, status }];
          await run();
          seen.push(await states());
        }
        if (seen.join() !== "build:COMPLETED,build:IN_PROGRESS")
          throw new Error(`the row went ${seen.join(", then ")}`);
        const gone: string[] = [];
        for (const listed of [[], [build], []]) {
          returning.check_list = listed;
          await run();
          gone.push(String((await checkRows(held)).length));
        }
        if (gone.join() !== "0,1,0")
          throw new Error(`the table held ${gone.join(", then ")} rows`);
        return "a check went in progress, completed and in progress again, and a check was dropped, listed again and dropped again, each change written on the real server and none replayed from an earlier batch";
      },
    );
  } finally {
    await github.stop();
  }
}
