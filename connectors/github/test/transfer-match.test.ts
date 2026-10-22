import type { Entry, Item } from "@withmarfa/connector";
import { describe, expect, it } from "vitest";
import {
  inRepository,
  inThread,
  issueType,
  repositoryType,
  type Issue,
} from "../src/entries.js";
import type { Client } from "../src/github.js";
import { movedFrom, withMovedComments } from "../src/transfer.js";

const at = "2026-01-01T00:00:00Z";

function item(properties: Record<string, unknown>, occurred: string): Item {
  return { properties, occurred_at: occurred } as unknown as Item;
}

function comment(node: string, body: string, issue: string): Entry {
  return {
    source_id: node,
    properties: { github_id: node, body, from: "alice" },
    occurred_at: at,
    connections: { [inThread]: [{ type: issueType, id: issue }] },
  };
}

describe("matching the comments of a moved issue", () => {
  // Two comments by one author in one second, the first edited in Marfa.
  const rows = (): Item[] => [
    item({ github_id: "C1", body: "First, edited", from: "alice" }, at),
    item({ github_id: "C2", body: "Second", from: "alice" }, at),
  ];
  const copies = (): Entry[] => [
    comment("N1", "First", "NI"),
    comment("N2", "Second", "NI"),
  ];

  it.each([
    ["first copy first", false],
    ["last copy first", true],
  ])("does not depend on the order of the copies: %s", async (_, reversed) => {
    const held = rows();
    const context = {
      linked: () => Promise.resolve(held),
    };
    const entries = reversed ? copies().reverse() : copies();
    const found = await withMovedComments(
      context as never,
      entries,
      new Set(["NI"]),
    );
    expect(
      Object.fromEntries(found.map((one) => [one.source_id, one.movedFrom])),
    ).toEqual({ N1: "C1", N2: "C2" });
  });

  it("leaves a copy alone where two rows could be it", async () => {
    const held = [
      item({ github_id: "C1", body: "One, edited", from: "alice" }, at),
      item({ github_id: "C2", body: "Two, edited", from: "alice" }, at),
    ];
    const context = { linked: () => Promise.resolve(held) };
    const found = await withMovedComments(
      context as never,
      [comment("N1", "One", "NI")],
      new Set(["NI"]),
    );
    expect(found[0]?.movedFrom).toBeUndefined();
  });
});

describe("finding the rows of transferred issues", () => {
  it("lists the rows of one source repository once", async () => {
    const issue = (node: string, number: number, created: string): Issue => ({
      node,
      number,
      title: "T",
      body: null,
      open: true,
      reason: null,
      url: "",
      closedAt: null,
      createdAt: created,
      updatedAt: created,
      author: null,
      labels: [],
      assignees: [],
      repository: { node: "R_target", name: "o/target" },
    });
    const fresh = [
      issue("N1", 11, "2026-01-01T00:00:00Z"),
      issue("N2", 12, "2026-01-02T00:00:00Z"),
      issue("N3", 13, "2026-01-03T00:00:00Z"),
    ];
    const rows = [1, 2, 3].map((number) =>
      item(
        { github_id: `O${String(number)}`, number },
        `2026-01-0${String(number)}T00:00:00Z`,
      ),
    );
    let listings = 0;
    const context = {
      known: () => Promise.resolve(new Set<string>()),
      linked: (type: string, connection: string, target: { id: string }) => {
        expect(type).toBe(issueType);
        expect(connection).toBe(inRepository);
        expect(target).toEqual({ type: repositoryType, id: "R_source" });
        listings += 1;
        return Promise.resolve(rows);
      },
      log: {},
    };
    const octokit = {
      graphql: (_: string, variables: { ids: string[] }) =>
        Promise.resolve({
          nodes: variables.ids.map((id) => ({
            __typename: "Issue",
            id,
            timelineItems: {
              nodes: [
                {
                  __typename: "TransferredEvent",
                  fromRepository: {
                    id: "R_source",
                    nameWithOwner: "o/source",
                  },
                },
              ],
            },
          })),
        }),
      request: (_: string, parameters: { issue_number: number }) =>
        Promise.resolve({
          status: 301,
          headers: {
            location: `https://api.github.test/repos/o/target/issues/${String(parameters.issue_number + 10)}`,
          },
        }),
    };
    const moves = await movedFrom(
      context as never,
      octokit as unknown as Client,
      fresh,
    );
    expect(Object.fromEntries(moves)).toEqual({
      N1: "O1",
      N2: "O2",
      N3: "O3",
    });
    expect(listings).toBe(1);
  });
});
