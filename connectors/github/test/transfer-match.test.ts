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
import {
  movedFrom,
  transferWindow,
  withMovedComments,
} from "../src/transfer.js";

const at = "2026-01-01T00:00:00Z";

function item(properties: Record<string, unknown>, occurred: string): Item {
  return { properties, occurred_at: occurred } as unknown as Item;
}

function found(entries: readonly Entry[]): Record<string, unknown> {
  return Object.fromEntries(
    entries.map((one) => [one.source_id, one.movedFrom]),
  );
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
    const matched = await withMovedComments(
      context as never,
      entries,
      new Set(["NI"]),
    );
    expect(found(matched)).toEqual({ N1: "C1", N2: "C2" });
  });

  it.each([
    ["the copy with a row first", false],
    ["the copy with a row last", true],
  ])(
    "leaves both unmatched where two copies share one row's author and time: %s",
    async (_, reversed) => {
      // One edited row, and two copies by the same author in the same second:
      // either copy could be its.
      const held = [
        item({ github_id: "C1", body: "First, edited", from: "alice" }, at),
      ];
      const context = { linked: () => Promise.resolve(held) };
      const copies = [
        comment("N1", "First", "NI"),
        comment("N2", "Other", "NI"),
      ];
      const entries = reversed ? copies.reverse() : copies;
      const matched = await withMovedComments(
        context as never,
        entries,
        new Set(["NI"]),
      );
      expect(found(matched)).toEqual({ N1: undefined, N2: undefined });
    },
  );

  it("keeps both rows, and says so, where the copy already has a row of its own", async () => {
    const own = {
      id: "ROW-N1",
      properties: { github_id: "N1" },
    } as unknown as Item;
    const old = {
      ...item({ github_id: "C1", body: "First", from: "alice" }, at),
      id: "ROW-C1",
    };
    const raised: Record<string, string> = {};
    const context = {
      linked: () => Promise.resolve([own, old]),
      log: {
        condition: (key: string, message: string) => {
          raised[key] = message;
        },
      },
    };
    const matched = await withMovedComments(
      context as never,
      [comment("N1", "First", "NI")],
      new Set(["NI"]),
    );
    expect(found(matched)).toEqual({ N1: undefined });
    expect(raised["duplicate:ROW-C1"]).toContain("ROW-C1");
    expect(raised["duplicate:ROW-C1"]).toContain("ROW-N1");
  });

  it("leaves a copy alone where two rows could be it", async () => {
    const held = [
      item({ github_id: "C1", body: "One, edited", from: "alice" }, at),
      item({ github_id: "C2", body: "Two, edited", from: "alice" }, at),
    ];
    const context = { linked: () => Promise.resolve(held) };
    const matched = await withMovedComments(
      context as never,
      [comment("N1", "One", "NI")],
      new Set(["NI"]),
    );
    expect(matched[0]?.movedFrom).toBeUndefined();
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
    const { moves } = await movedFrom(
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

describe("an issue that may be mid-transfer", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const iso = (offset: number): string => new Date(now - offset).toISOString();

  function issue(node: string, created: number, updated: number): Issue {
    return {
      node,
      number: 1,
      title: "T",
      body: null,
      open: true,
      reason: null,
      url: "",
      closedAt: null,
      createdAt: iso(created),
      updatedAt: iso(updated),
      author: null,
      labels: [],
      assignees: [],
      repository: { node: "R_target", name: "o/target" },
    };
  }

  /** What the run finds out about the issues, with no transfer on any
   *  timeline and none of them held by a row. */
  async function waiting(
    issues: Issue[],
    options: {
      held?: string[];
      events?: string[];
      firstSeen?: Record<string, string>;
    } = {},
  ): Promise<string[]> {
    const context = {
      known: () => Promise.resolve(new Set(options.held ?? [])),
      linked: () => Promise.resolve([]),
      log: {},
    };
    const octokit = {
      graphql: (_: string, variables: { ids: string[] }) =>
        Promise.resolve({
          nodes: variables.ids.map((id) => ({
            __typename: "Issue",
            id,
            timelineItems: {
              nodes: (options.events ?? []).includes(id)
                ? [{ __typename: "TransferredEvent", fromRepository: null }]
                : [],
            },
          })),
        }),
    };
    const found = await movedFrom(
      context as never,
      octokit as unknown as Client,
      issues,
      now,
      new Map(Object.entries(options.firstSeen ?? {})),
    );
    return [...found.waiting].sort();
  }

  const hour = 60 * 60 * 1000;

  it("waits where it was changed lately though made long before", async () => {
    expect(await waiting([issue("N1", hour, 30_000)])).toEqual(["N1"]);
  });

  it("is written at once where it was made and changed together", async () => {
    expect(await waiting([issue("N1", 30_000, 30_000)])).toEqual([]);
    expect(await waiting([issue("N1", 0, 0)])).toEqual([]);
  });

  it("is written once the window has passed", async () => {
    expect(await waiting([issue("N1", hour, transferWindow + 1_000)])).toEqual(
      [],
    );
  });

  it("holds at the edges of the window", async () => {
    // Changed exactly a window ago still waits; made exactly a window before
    // the change does not.
    expect(await waiting([issue("N1", hour, transferWindow)])).toEqual(["N1"]);
    expect(
      await waiting([issue("N1", transferWindow + 60_000, 60_000)]),
    ).toEqual([]);
    expect(
      await waiting([issue("N1", transferWindow + 60_001, 60_000)]),
    ).toEqual(["N1"]);
  });

  /** An issue whose timeline shows a transfer from a repository Marfa holds
   *  a row of, though the old address still answers 200. */
  async function showing(
    issues: Issue[],
    firstSeen: Record<string, string> = {},
    rows = 1,
  ): Promise<string[]> {
    const context = {
      known: () => Promise.resolve(new Set<string>()),
      linked: () =>
        Promise.resolve(
          Array.from({ length: rows }, (_, index) => ({
            id: `row-${String(index)}`,
            properties: { github_id: `O${String(index)}`, number: 9 },
            occurred_at: issues[0]?.createdAt,
          })),
        ),
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
                  fromRepository: { id: "R_source", nameWithOwner: "o/source" },
                },
              ],
            },
          })),
        }),
      request: () => Promise.resolve({ status: 200, headers: {} }),
    };
    const found = await movedFrom(
      context as never,
      octokit as unknown as Client,
      issues,
      now,
      new Map(Object.entries(firstSeen)),
    );
    expect(found.moves.size).toBe(0);
    return [...found.waiting].sort();
  }

  it("waits where its timeline shows a transfer that no old address confirms yet", async () => {
    expect(await showing([issue("N1", hour, 30_000)])).toEqual(["N1"]);
  });

  it("is written where the transfer is shown from a repository Marfa holds nothing of, or it was not changed lately", async () => {
    expect(await showing([issue("N1", hour, 30_000)], {}, 0)).toEqual([]);
    expect(await showing([issue("N1", hour, transferWindow + 1_000)])).toEqual(
      [],
    );
  });

  it("stops holding back an issue that has waited a full window, whether or not its timeline shows a transfer", async () => {
    const lately = issue("N1", hour, 30_000);
    const first = (offset: number): Record<string, string> => ({
      N1: iso(offset),
    });
    expect(await showing([lately], first(transferWindow - 1_000))).toEqual([
      "N1",
    ]);
    expect(await showing([lately], first(transferWindow))).toEqual([]);
    expect(
      await waiting([lately], { firstSeen: first(transferWindow - 1_000) }),
    ).toEqual(["N1"]);
    expect(
      await waiting([lately], { firstSeen: first(transferWindow) }),
    ).toEqual([]);
  });

  it("is written where its timeline shows a transfer, or Marfa has a row for it", async () => {
    const lately = [issue("N1", hour, 30_000), issue("N2", hour, 30_000)];
    expect(await waiting(lately, { events: ["N1"] })).toEqual(["N2"]);
    expect(await waiting(lately, { held: ["N2"] })).toEqual(["N1"]);
  });
});
