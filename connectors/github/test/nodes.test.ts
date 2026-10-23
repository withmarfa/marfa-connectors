import { GraphqlResponseError } from "@octokit/graphql";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { commentsByNode, issuesByNode } from "../src/graph.js";
import {
  asInstallation,
  queryNodes,
  type App,
  type Client,
} from "../src/github.js";
import { pullRequestsByNode } from "../src/pulls.js";

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

describe("a batch of nodes the issues token asks for", () => {
  it("answers the issue comments and names a discussion comment GitHub refuses it, without taking that for gone", async () => {
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
  });

  it("answers the issues and pull requests among nodes of which one is refused", async () => {
    const { repository, octokit } = issuesToken();
    const issue = github.addIssue(repository);
    const discussion = github.addDiscussion(repository);
    const comment = github.addDiscussionComment(discussion, "In a discussion");
    const found = await issuesByNode(octokit, [comment.node, issue.node]);
    expect(found.map((one) => one.issue.node)).toEqual([issue.node]);
    expect(
      await pullRequestsByNode(octokit, [comment.node, discussion.node]),
    ).toEqual([]);
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
    expect(answer.data).toEqual({ nodes: [{ id: "a" }, null, { id: "c" }] });
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
