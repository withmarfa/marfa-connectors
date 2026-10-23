import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { issueEntry } from "../src/entries.js";
const run = promisify(execFile);
let marfa: ScriptedServer;
let github: GitHubStub;
const key = appKey();
beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types: [
      "github.repository",
      "github.issue",
      "github.comment",
      "github.file",
      "github.file.image",
      "github.pull_request",
      "github.discussion",
      "github.notification",
    ],
    edges: [
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
      "attached-to",
    ],
  }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
  github.appPem = key;
});
afterEach(async () => {
  await marfa.stop();
  await github.stop();
});
async function once(env: Record<string, string> = {}) {
  const result = await run(
    "node",
    [resolve(import.meta.dirname, "../dist/main.js"), "--once"],
    {
      env: {
        PATH: process.env["PATH"],
        MARFA_API_URL: marfa.url,
        MARFA_API_KEY: marfa.key,
        GITHUB_APP_ID: "12345",
        GITHUB_PRIVATE_KEY: key,
        GITHUB_WEBHOOK_SECRET: "test-secret",
        GITHUB_API_URL: github.url,
        ...env,
      },
    },
  );
  return result.stderr;
}
function row(node: string) {
  const found = marfa.rows.find((one) => one.properties["github_id"] === node);
  if (!found) throw new Error(`No row for ${node}`);
  return found;
}
function links(node: string, type: string) {
  return marfa
    .targetsOf(row(node).id, type)
    .map((id) => marfa.byId(id).properties["github_id"]);
}
describe("related and duplicate issues", () => {
  it("stores a symmetric pair once in stable node order, keeps external URLs, and restores duplicate edits", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const outside = github.addRepository("stranger/public", {
      installation: 99,
      private: false,
    });
    const external = github.addIssue(outside);
    const c = github.addIssue(repo, { duplicate_of: external.node });
    a.relates_to = [b.node, external.node];
    b.relates_to = [a.node];
    b.duplicate_of = a.node;
    await once();
    const low = a.node < b.node ? a.node : b.node;
    const high = a.node < b.node ? b.node : a.node;
    expect(links(low, "github.relates-to")).toEqual([high]);
    expect(links(high, "github.relates-to")).toEqual([]);
    expect(row(a.node).properties["related_urls"]).toEqual([
      `https://github.com/stranger/public/issues/${String(external.number)}`,
    ]);
    expect(links(b.node, "github.duplicate-of")).toEqual([a.node]);
    const edge = marfa.edges.find(
      (one) => one.edge_type === "github.duplicate-of",
    );
    if (edge === undefined) throw new Error("No expected edge");
    marfa.removeEdge(edge.id);
    marfa.drawEdge(row(b.node).id, row(c.node).id, "github.duplicate-of");
    marfa.drawEdge(row(a.node).id, row(b.node).id, "github.duplicate-of");
    await once();
    expect(links(b.node, "github.duplicate-of")).toEqual([a.node]);
    expect(links(a.node, "github.duplicate-of")).toEqual([]);
    expect(row(c.node).properties["duplicate_of_url"]).toBe(
      `https://github.com/stranger/public/issues/${String(external.number)}`,
    );
    expect(github.writes()).toEqual([]);
  });
  it("notices related links changing while REST listings answer 304", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const low = a.node < b.node ? a : b;
    const high = a.node < b.node ? b : a;
    await once();
    a.relates_to = [b.node];
    b.relates_to = [a.node];
    await once();
    expect(links(low.node, "github.relates-to")).toEqual([high.node]);
    a.relates_to = [];
    b.relates_to = [];
    await once();
    expect(links(low.node, "github.relates-to")).toEqual([]);
  });
  it("retains prior connections while relationship reads are rate limited", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const low = a.node < b.node ? a : b;
    const high = a.node < b.node ? b : a;
    a.relates_to = [b.node];
    b.relates_to = [a.node];
    await once();
    a.relates_to = [];
    b.relates_to = [];
    github.budget("graphql").remaining = 100;
    await once();
    expect(links(low.node, "github.relates-to")).toEqual([high.node]);
    github.refill("graphql");
    await once();
    expect(links(low.node, "github.relates-to")).toEqual([]);
  });
  it("reads every page of related issues", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const c = github.addIssue(repo);
    a.relates_to = [b.node, c.node];
    b.relates_to = [a.node];
    c.relates_to = [a.node];
    github.relatedPageSize = 1;
    await once();
    const expected = [b.node, c.node].filter((id) => a.node < id);
    expect(links(a.node, "github.relates-to")).toEqual(expected);
    expect(
      github.asked.some(
        (one) =>
          one.path === "/graphql" &&
          (one.body as { query: string }).query.includes("query RelatedIssues"),
      ),
    ).toBe(true);
  });
  it("restores issue relations selected read-only while carrying a comment edit", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const c = github.addIssue(repo);
    a.relates_to = [b.node];
    b.relates_to = [a.node];
    const comment = github.addComment(a, "Before", "marfa-connectors[bot]");
    comment.app = true;
    await once();
    const canonical = marfa.edges.find(
      (one) => one.edge_type === "github.relates-to",
    );
    if (canonical === undefined) throw new Error("No canonical edge");
    marfa.removeEdge(canonical.id);
    marfa.drawEdge(row(a.node).id, row(c.node).id, "github.relates-to");
    marfa.edit(row(comment.node).id, { body: "After" });
    await once({ GITHUB_READ_ONLY: "issue" });
    expect(links(a.node, "github.relates-to")).toEqual([b.node]);
    expect(a.relates_to).toEqual([b.node]);
    expect(c.relates_to ?? []).toEqual([]);
    expect(comment.body).toBe("After");
    const writes = github.writes().length;
    marfa.drawEdge(row(a.node).id, row(c.node).id, "github.relates-to");
    await once();
    expect(a.relates_to).toEqual([b.node, c.node]);
    expect(github.writes().length).toBe(writes + 1);
  });
  it("removes a redundant reverse drawing immediately without writing GitHub", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const low = a.node < b.node ? a : b;
    const high = a.node < b.node ? b : a;
    a.relates_to = [b.node];
    b.relates_to = [a.node];
    await once();
    const canonical = marfa.edges.find(
      (one) => one.edge_type === "github.relates-to",
    );
    if (canonical === undefined) throw new Error("No canonical edge");
    const writes = github.writes().length;
    marfa.drawEdge(row(high.node).id, row(low.node).id, "github.relates-to");
    await once();
    expect(links(low.node, "github.relates-to")).toEqual([high.node]);
    expect(links(high.node, "github.relates-to")).toEqual([]);
    expect(
      marfa.edges
        .filter((one) => one.edge_type === "github.relates-to")
        .map((one) => one.id),
    ).toEqual([canonical.id]);
    expect(github.writes().length).toBe(writes);
    await once();
    expect(
      marfa.edges
        .filter((one) => one.edge_type === "github.relates-to")
        .map((one) => one.id),
    ).toEqual([canonical.id]);
    expect(github.writes().length).toBe(writes);
    marfa.removeEdge(canonical.id);
    await once();
    expect(a.relates_to).toEqual([]);
    expect(b.relates_to).toEqual([]);
    expect(github.writes().length).toBe(writes + 1);
  });
  it("canonicalizes a reverse drawing and restores refused additions", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    const low = a.node < b.node ? a : b;
    const high = a.node < b.node ? b : a;
    await once();
    github.relationsRefused = true;
    marfa.drawEdge(row(low.node).id, row(high.node).id, "github.relates-to");
    expect(await once()).toContain("Relationship refused");
    expect(links(low.node, "github.relates-to")).toEqual([]);
    github.relationsRefused = false;
    marfa.drawEdge(row(high.node).id, row(low.node).id, "github.relates-to");
    await once();
    expect(links(high.node, "github.relates-to")).toEqual([low.node]);
    expect(a.relates_to).toEqual([b.node]);
    expect(b.relates_to).toEqual([a.node]);
    const writes = github.writes().length;
    // Every invocation starts a new connector process with its saved state.
    await once();
    expect(links(low.node, "github.relates-to")).toEqual([high.node]);
    expect(links(high.node, "github.relates-to")).toEqual([]);
    const edges = marfa.edges.map((one) => one.id);
    await once();
    expect(marfa.edges.map((one) => one.id)).toEqual(edges);
    expect(github.writes().length).toBe(writes);
  }, 60_000);
  it("carries a relation add and removal and writes nothing when unchanged", async () => {
    const repo = github.addRepository("someone/tracker");
    const a = github.addIssue(repo);
    const b = github.addIssue(repo);
    await once();
    const low = a.node < b.node ? a : b;
    const high = a.node < b.node ? b : a;
    marfa.drawEdge(row(low.node).id, row(high.node).id, "github.relates-to");
    await once();
    expect(a.relates_to).toEqual([b.node]);
    expect(b.relates_to).toEqual([a.node]);
    const edge = marfa.edges.find(
      (one) => one.edge_type === "github.relates-to",
    );
    if (edge === undefined) throw new Error("No expected edge");
    marfa.removeEdge(edge.id);
    await once();
    expect(a.relates_to).toEqual([]);
    expect(b.relates_to).toEqual([]);
    const versions = marfa.rows.map((one) => one.version);
    const edges = marfa.edges.map((one) => one.id);
    const before = marfa.requests.length;
    const writes = github.writes().length;
    await once();
    expect(github.writes().length).toBe(writes);
    expect(marfa.rows.map((one) => one.version)).toEqual(versions);
    expect(marfa.edges.map((one) => one.id)).toEqual(edges);
    expect(
      marfa.requests
        .slice(before)
        .filter(
          (one) =>
            ["PATCH", "DELETE"].includes(one.method) &&
            /^\/(items|edges)\//.test(one.path),
        ),
    ).toEqual([]);
  });
});

it("maps symmetric links and duplicates onto declared issue connections", () => {
  const entry = issueEntry(
    {
      node: "I_a",
      number: 1,
      title: "Issue",
      body: null,
      open: true,
      reason: null,
      url: "https://github.com/someone/tracker/issues/1",
      closedAt: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      author: "someone",
      labels: [],
      assignees: [],
      repository: { node: "R_1", name: "someone/tracker" },
    },
    {
      parent: null,
      blockedBy: [],
      relatesTo: [
        {
          id: "I_b",
          url: "https://github.com/someone/tracker/issues/2",
          repository: { id: "R_1" },
        },
      ],
      duplicateOf: null,
    },
    new Set(["R_1"]),
  );
  expect(entry.connections?.["github.relates-to"]).toEqual([
    { type: "github.issue", id: "I_b" },
  ]);
});
