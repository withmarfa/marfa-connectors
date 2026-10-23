import { GraphqlResponseError } from "@octokit/graphql";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { commentsByNode } from "../src/graph.js";
import {
  asInstallation,
  queryNodes,
  type App,
  type Client,
} from "../src/github.js";

let key: string;
let github: GitHubStub;
let app: App;

beforeAll(() => {
  key = appKey();
});

beforeEach(async () => {
  github = await new GitHubStub().start();
  github.appPem = key;
  app = { appId: "12345", privateKey: key, base: github.url };
});

afterEach(async () => {
  await github.stop();
});

function issuesToken() {
  const repository = github.addRepository("someone/tracker");
  const octokit = asInstallation(
    app,
    1,
    { access: "read", repositoryIds: [repository.id] },
    () => undefined,
    new AbortController().signal,
  );
  return { repository, octokit };
}

function failing(errors: Record<string, unknown>[], data: unknown): Client {
  return {
    graphql: () =>
      Promise.reject(
        new GraphqlResponseError({ method: "POST", url: "/graphql" }, {}, {
          data,
          errors,
        } as never),
      ),
  } as unknown as Client;
}

describe("a batch of comments the issues token asks for", () => {
  it("answers the issue comments and names a private repository's discussion comment, which GitHub refuses the token, without taking it for gone", async () => {
    const { repository, octokit } = issuesToken();
    const issue = github.addIssue(repository);
    const first = github.addComment(issue, "First");
    const last = github.addComment(issue, "Last");
    const discussion = github.addDiscussion(repository);
    const asked = github.addDiscussionComment(discussion, "In a discussion");
    const answer = await commentsByNode(octokit, [
      first.node,
      asked.node,
      "IC_unknown",
      last.node,
    ]);
    expect(answer.found.map((one) => one.node)).toEqual([
      first.node,
      last.node,
    ]);
    expect([...answer.refused]).toEqual([asked.node]);
    expect(answer.elsewhere.size).toBe(0);
  });

  it("names a public repository's discussion comment, which GitHub shows as another kind of node, without taking it for gone", async () => {
    const repository = github.addRepository("someone/open", { private: false });
    const octokit = asInstallation(
      app,
      1,
      { access: "read", repositoryIds: [repository.id] },
      () => undefined,
      new AbortController().signal,
    );
    const issue = github.addIssue(repository);
    const one = github.addComment(issue, "One");
    const discussion = github.addDiscussion(repository);
    const asked = github.addDiscussionComment(discussion, "In a discussion");
    const answer = await commentsByNode(octokit, [
      asked.node,
      one.node,
      "IC_unknown",
    ]);
    expect(answer.found.map((comment) => comment.node)).toEqual([one.node]);
    expect(answer.refused.size).toBe(0);
    expect([...answer.elsewhere]).toEqual([asked.node]);
  });

  it("takes a comment that is gone, in either kind of repository, for gone", async () => {
    const { repository, octokit } = issuesToken();
    const discussion = github.addDiscussion(repository);
    const deleted = github.addDiscussionComment(discussion, "Deleted");
    github.removeDiscussionComment(deleted);
    const answer = await commentsByNode(octokit, [deleted.node, "IC_unknown"]);
    expect(answer.found).toEqual([]);
    expect(answer.refused.size).toBe(0);
    expect(answer.elsewhere.size).toBe(0);
  });

  it("answers every comment of a batch with no refusal as before", async () => {
    const { repository, octokit } = issuesToken();
    const issue = github.addIssue(repository);
    const one = github.addComment(issue, "One");
    const answer = await commentsByNode(octokit, [one.node, "IC_unknown"]);
    expect(answer.found.map((comment) => comment.node)).toEqual([one.node]);
    expect(answer.refused.size).toBe(0);
  });
});

describe("a refusal of a query of nodes", () => {
  const forbidden = {
    type: "FORBIDDEN",
    message: "Resource not accessible by integration",
  };

  it("names the node it concerns by its place in the batch", async () => {
    const answer = await queryNodes(
      failing([{ ...forbidden, path: ["nodes", 1] }], {
        nodes: [{ id: "a" }, null, { id: "c" }],
      }),
      "query Q($ids: [ID!]!) { nodes(ids: $ids) { id } }",
      ["a", "b", "c"],
    );
    expect([...answer.refused]).toEqual(["b"]);
    expect(answer.nodes).toEqual([{ id: "a" }, null, { id: "c" }]);
  });

  it("nulls the data of a node refused at any path under it", async () => {
    const answer = await queryNodes(
      failing(
        [
          { ...forbidden, path: ["nodes", 1, "issue"] },
          { type: "NOT_FOUND", message: "gone", path: ["nodes", 2] },
        ],
        { nodes: [{ id: "a" }, { id: "b", issue: null }, null] },
      ),
      "query Q($ids: [ID!]!) { nodes(ids: $ids) { id } }",
      ["a", "b", "c"],
    );
    expect([...answer.refused]).toEqual(["b"]);
    expect(answer.nodes).toEqual([{ id: "a" }, null, null]);
  });

  it("still ends the run for a refusal that names no node", async () => {
    await expect(
      queryNodes(
        failing([forbidden], null),
        "query Q($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        ["a"],
      ),
    ).rejects.toBeInstanceOf(GraphqlResponseError);
    await expect(
      queryNodes(
        failing([{ ...forbidden, path: ["viewer"] }], { nodes: [null] }),
        "query Q($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        ["a"],
      ),
    ).rejects.toBeInstanceOf(GraphqlResponseError);
  });

  it("still ends the run for an error of any other kind beside the refusal", async () => {
    await expect(
      queryNodes(
        failing(
          [
            { ...forbidden, path: ["nodes", 0] },
            { type: "SERVICE_UNAVAILABLE", message: "Try again later" },
          ],
          { nodes: [null] },
        ),
        "query Q($ids: [ID!]!) { nodes(ids: $ids) { id } }",
        ["a"],
      ),
    ).rejects.toBeInstanceOf(GraphqlResponseError);
  });
});
