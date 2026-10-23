import { createClient } from "@withmarfa/client";
import type { ProofServer } from "./server.js";
import { check } from "./check.js";
import { ConnectorUnderProof, item, rowsOf, type Item } from "./connector.js";
import { appKey, GitHubStub } from "./github-stub.js";

export async function proveGitHubRelations(
  url: string,
  mintKey: ProofServer["mintKey"],
): Promise<void> {
  const github = await new GitHubStub().start();
  github.appPem = appKey();
  try {
    const repo = github.addRepository("someone/relation-proof", {
      node: "R_relation_proof",
    });
    const a = github.addIssue(repo, { node: "I_relation_a" });
    const b = github.addIssue(repo, {
      node: "I_relation_b",
      state: "closed",
      state_reason: "duplicate",
      closed_at: github.now(),
      duplicate_of: a.node,
    });
    const c = github.addIssue(repo, { node: "I_relation_c" });
    a.relates_to = [b.node];
    b.relates_to = [a.node];
    const types = [
      "github.repository",
      "github.issue",
      "github.comment",
      "github.file",
      "github.file.image",
      "github.pull_request",
      "github.discussion",
    ];
    const connections = [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "github.relates-to",
      "github.duplicate-of",
      "attached-to",
      "github.closes",
      "github.closed-by",
      "parent-of",
      "in-thread",
    ];
    const key = await mintKey({
      label: "related issue proof",
      source: "proof-github-relations",
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
        GITHUB_WEBHOOK_SECRET: "github-relation-proof-secret",
        GITHUB_API_URL: github.url,
      });
      const result = await runner.once();
      if (result.code !== 0)
        throw new Error(
          `The connector exited ${String(result.code)}: ${result.output}`,
        );
    };
    const row = async (id: string): Promise<Item> => {
      const found = (await rowsOf(marfa, "github.issue", "github")).get(id);
      if (found === undefined) throw new Error(`No issue for ${id}`);
      return found;
    };
    const edges = async (from: Item, type: string) => {
      const result = await marfa.GET("/items/{id}/edges", {
        params: { path: { id: from.id }, query: { edge_type: type } },
      });
      if (result.data === undefined) throw new Error("Edges were refused");
      return result.data.data;
    };
    const connect = async (from: Item, to: Item, type: string) => {
      const result = await marfa.POST("/edges", {
        body: { source_id: from.id, target_id: to.id, edge_type: type },
      });
      if (!result.response.ok)
        throw new Error("A proof connection was refused");
    };
    const remove = async (id: string) => {
      const result = await marfa.DELETE("/edges/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok)
        throw new Error("A proof connection removal was refused");
    };
    await check(
      "github: related pairs have one canonical edge, duplicates are restored, and unchanged reruns preserve versions",
      async () => {
        await run();
        const low = await row(a.node);
        const high = await row(b.node);
        const other = await row(c.node);
        const canonical = (await edges(low, "github.relates-to"))[0];
        const duplicate = (await edges(high, "github.duplicate-of"))[0];
        if (
          canonical?.target_id !== high.id ||
          (await edges(high, "github.relates-to")).length !== 0 ||
          duplicate?.target_id !== low.id
        )
          throw new Error("Related or duplicate edges were not imported");
        await remove(duplicate.id);
        await connect(high, low, "github.relates-to");
        await run();
        if (
          (await edges(high, "github.duplicate-of"))[0]?.target_id !== low.id ||
          (await edges(high, "github.relates-to")).length !== 0 ||
          (await edges(low, "github.relates-to"))[0]?.id !== canonical.id ||
          github.writes().length !== 0
        )
          throw new Error(
            "Duplicate restoration or redundant reverse-edge cleanup failed",
          );
        await connect(low, other, "github.relates-to");
        await run();
        if (
          !(a.relates_to ?? []).includes(c.node) ||
          github.writes().length !== 1
        )
          throw new Error("A new related link was not carried once");
        const added = (await edges(low, "github.relates-to")).find(
          (edge) => edge.target_id === other.id,
        );
        if (added === undefined) throw new Error("The new relation is missing");
        await remove(added.id);
        await run();
        if (
          (a.relates_to ?? []).includes(c.node) ||
          github.writes().length !== 2
        )
          throw new Error("A relation removal was not carried once");
        const before = await item(marfa, low.id);
        const ids = (await edges(low, "github.relates-to")).map(
          (edge) => edge.id,
        );
        await run();
        if (
          (await item(marfa, low.id)).version !== before.version ||
          JSON.stringify(
            (await edges(low, "github.relates-to")).map((edge) => edge.id),
          ) !== JSON.stringify(ids) ||
          github.writes().length !== 2
        )
          throw new Error("An unchanged relation caused writes");
        return "one canonical edge, read-only duplicate restoration, redundant reverse cleanup, two-way related links and exact no-op versions held on the real server";
      },
    );
  } finally {
    await github.stop();
  }
}
