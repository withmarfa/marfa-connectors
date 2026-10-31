import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GROUPS,
  parseShard,
  setupStatements,
  shardOf,
  unmeasuredSeconds,
} from "../proof/shards.js";

const root = resolve(import.meta.dirname, "../..");
const proof = join(root, "scripts", "proof");

const names = (groups: readonly { name: string }[]) =>
  groups.map((group) => group.name);
const weight = (group: { seconds?: number }) =>
  group.seconds ?? unmeasuredSeconds;
const load = (groups: readonly { seconds?: number }[]) =>
  groups.reduce((sum, group) => sum + weight(group), 0);

describe("the split of the proof into shards", () => {
  it.each([1, 2, 3, 4, 5, 8])(
    "gives every group to exactly one of %i shards, whatever its place in the list",
    (count) => {
      const all = Array.from({ length: count }, (_, at) =>
        names(shardOf(GROUPS, at + 1, count)),
      );
      expect(all.flat().sort()).toEqual(names(GROUPS).sort());
      expect(new Set(all.flat()).size).toBe(GROUPS.length);
    },
  );

  it("keeps the order the groups run in within a shard", () => {
    const order = names(GROUPS);
    for (let at = 1; at <= 3; at++) {
      const mine = names(shardOf(GROUPS, at, 3));
      expect(mine).toEqual(order.filter((name) => mine.includes(name)));
    }
  });

  it("gives the same shards however the list is ordered, as every shard's process must agree", () => {
    const reversed = [...GROUPS].reverse();
    for (let at = 1; at <= 3; at++) {
      expect(names(shardOf(reversed, at, 3)).sort()).toEqual(
        names(shardOf(GROUPS, at, 3)).sort(),
      );
    }
  });

  it("weighs a group with no measured time, so a new one lands in exactly one shard", () => {
    const added = [...GROUPS, { name: "new-group" }] as const;
    const all = [1, 2, 3].map((at) => names(shardOf(added, at, 3)));
    expect(all.flat().sort()).toEqual([...names(added)].sort());
    expect(all.filter((mine) => mine.includes("new-group"))).toHaveLength(1);
  });

  it("balances the measured times to within the one group that cannot be split", () => {
    const loads = [1, 2, 3].map((at) => load(shardOf(GROUPS, at, 3)));
    const heaviest = Math.max(...GROUPS.map(weight));
    // The GitHub group is one stateful flow, so the longest shard is that
    // group and the rest is no worse than the others' share.
    expect(Math.max(...loads)).toBeLessThanOrEqual(
      Math.max(heaviest, load(GROUPS) / 3) + Math.min(...GROUPS.map(weight)),
    );
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(
      heaviest,
    );
  });

  it("refuses a shard that does not exist", () => {
    expect(() => shardOf(GROUPS, 0, 3)).toThrow();
    expect(() => shardOf(GROUPS, 4, 3)).toThrow();
    expect(() => shardOf(GROUPS, 1, 0)).toThrow();
    expect(() => shardOf(GROUPS, 1.5, 3)).toThrow();
  });

  it("reads 2/3 and nothing looser", () => {
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    for (const text of ["", "0/3", "4/3", "2", "2/", "a/b", "1/3 ", "-1/3"]) {
      expect(() => parseShard(text), text).toThrow();
    }
  });
});

describe("the list of groups and the proof that runs it", () => {
  const main = readFileSync(join(proof, "main.ts"), "utf8");

  it("has every group once, with a runner in main.ts", () => {
    expect(new Set(names(GROUPS)).size).toBe(GROUPS.length);
    for (const name of names(GROUPS)) {
      const key = /^[a-z]+$/.test(name) ? name : `"${name}"`;
      expect(main, name).toContain(`  ${key}: (c) =>`);
    }
  });

  it("calls every prove function of the proof, so none is left out of every shard", () => {
    const proves = readdirSync(proof)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [
          ...readFileSync(join(proof, file), "utf8").matchAll(
            /^export (?:async )?function (prove\w+)\(/gm,
          ),
        ].map((match) => match[1] ?? ""),
      );
    expect(proves.length).toBeGreaterThan(0);
    for (const name of proves) {
      expect(main.split(`${name}(`).length - 1, name).toBe(1);
    }
    expect(proves).toHaveLength(GROUPS.length);
  });

  it("states the setup's statements", () => {
    expect(setupStatements).toBe(3);
    expect(main.match(/await check\(/g)).toHaveLength(setupStatements);
  });
});

describe("the proof as one shard runs it", () => {
  const main = join(root, "scripts", "dist", "proof", "main.js");
  // No PATH: the boot cannot start git or pnpm, which is a server that fails
  // to start.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [main, ...args], {
      env: { PATH: "" },
      encoding: "utf8",
      timeout: 25_000,
    });

  it("fails the shard when its server does not start", () => {
    const result = run("--shard", "1/3");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).not.toContain("ok   all");
  });

  it("fails for a shard that does not exist, without starting a server", () => {
    for (const shard of ["4/3", "0/3", "x"]) {
      const result = run("--shard", shard);
      expect(result.status, shard).toBe(1);
      expect(result.stdout, shard).toContain("FAIL the proof");
    }
  });
});
