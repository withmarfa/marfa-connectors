/**
 * `scripts/follow-release.sh` decides when the connectors move to a marfa
 * release and writes the move. `.github/workflows/follow-releases.yml` calls it.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "follow-release.sh");

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

function sh(args: string[], cwd = ROOT): { status: number; output: string } {
  try {
    const output = execFileSync("bash", [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: output.trim() };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, output: failed.stdout + failed.stderr };
  }
}

/** A run that is behind a release and could move, changed by `over`. */
function decide(over: Record<string, string> = {}): {
  status: number;
  output: string;
} {
  const input: Record<string, string> = {
    pin: OLD,
    kit: "0.0.23",
    scripts: "0.0.23",
    tag: "v0.0.50",
    release: NEW,
    relation: "ahead",
    published: "yes",
    open: "0",
    ...over,
  };
  return sh([
    "decide",
    ...Object.entries(input).map(([key, value]) => `${key}=${value}`),
  ]);
}

describe("scripts/follow-release.sh decide", () => {
  it("bumps a pin behind the newest release", () => {
    expect(decide()).toEqual({ status: 0, output: "bump" });
  });

  it("bumps when the pin is on the release but a client is older", () => {
    const base = { pin: NEW, release: NEW, relation: "identical" };
    expect(decide({ ...base, kit: "0.0.50", scripts: "0.0.49" }).output).toBe(
      "bump",
    );
    expect(decide({ ...base, kit: "0.0.49", scripts: "0.0.50" }).output).toBe(
      "bump",
    );
  });

  it("bumps when the pin is behind and both clients are on the release", () => {
    expect(decide({ kit: "0.0.50", scripts: "0.0.50" }).output).toBe("bump");
  });

  it("leaves connectors that follow the release already, so a second run does nothing", () => {
    const followed = {
      pin: NEW,
      release: NEW,
      relation: "identical",
      kit: "0.0.50",
      scripts: "0.0.50",
    };
    expect(decide(followed).output).toBe(
      "skip: the connectors follow v0.0.50 already",
    );
    // The witness: the same inputs with one client older bump.
    expect(decide({ ...followed, kit: "0.0.49" }).output).toBe("bump");
  });

  it("leaves a pin that an open pull request already moves", () => {
    expect(decide({ open: "1" }).output).toBe(
      "skip: a pull request that moves the pin is open",
    );
    expect(decide({ open: "0" }).output).toBe("bump");
  });

  it("waits for a client that npm does not serve yet", () => {
    expect(decide({ published: "no" }).output).toBe(
      "skip: @withmarfa/client 0.0.50 is not published yet",
    );
  });

  it("never moves back to an older release", () => {
    expect(decide({ relation: "behind" }).output).toMatch(
      /^skip: the pin is not/,
    );
    expect(decide({ relation: "diverged" }).output).toMatch(
      /^skip: the pin is not/,
    );
    expect(decide({ kit: "0.0.51" }).output).toBe(
      "skip: a client is newer than v0.0.50",
    );
    expect(decide({ scripts: "0.0.100" }).output).toBe(
      "skip: a client is newer than v0.0.50",
    );
  });

  it("compares versions as numbers", () => {
    expect(
      decide({ tag: "v0.0.100", kit: "0.0.99", scripts: "0.0.99" }).output,
    ).toBe("bump");
  });

  it.each([
    ["a pin that is not a commit", { pin: "main" }],
    ["a release that is not a commit", { release: NEW.slice(0, 39) }],
    ["a tag that is not a release tag", { tag: "latest" }],
    ["a pre-release tag", { tag: "v0.0.50-rc.1" }],
    ["a client range", { kit: "^0.0.23" }],
    ["a relation that is not one", { relation: "unknown" }],
    ["a published answer that is not yes or no", { published: "maybe" }],
    ["a count that is not a number", { open: "many" }],
    ["an identical relation for two commits", { relation: "identical" }],
    ["two commits that are the same and not identical", { release: OLD }],
  ])("refuses %s", (_name, over) => {
    const result = decide(over);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/^follow-release\.sh: /);
  });

  it("refuses a missing argument and an unknown one", () => {
    expect(sh(["decide", `pin=${OLD}`]).status).toBe(1);
    expect(decide({ nonsense: "x" }).status).toBe(1);
    expect(sh([]).status).toBe(2);
  });
});

describe("scripts/follow-release.sh apply", () => {
  const scratch = mkdtempSync(join(tmpdir(), "follow-release-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const manifest = (version: string): string =>
    [
      "{",
      '  "name": "x",',
      '  "dependencies": {',
      `    "@withmarfa/client": "${version}",`,
      '    "@withmarfa/connector": "workspace:*"',
      "  }",
      "}",
      "",
    ].join("\n");

  /** A copy of the script with the three files it writes, in a folder of its own. */
  function checkout(name: string, kit = manifest("0.0.23")): string {
    const dir = join(scratch, name);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "kit"), { recursive: true });
    cpSync(SCRIPT, join(dir, "scripts", "follow-release.sh"));
    writeFileSync(join(dir, "scripts", "monorepo.commit"), `${OLD}\n`);
    writeFileSync(join(dir, "scripts", "package.json"), manifest("0.0.23"));
    writeFileSync(join(dir, "kit", "package.json"), kit);
    return dir;
  }
  /** Runs the copy in `dir`, which writes only inside it. */
  const apply = (dir: string, ...args: string[]): string =>
    execFileSync(
      "bash",
      [join(dir, "scripts", "follow-release.sh"), "apply", ...args],
      { encoding: "utf8", stdio: "pipe" },
    );
  const read = (dir: string, path: string): string =>
    readFileSync(join(dir, path), "utf8");

  it("writes the commit and the exact version and leaves every other byte alone", () => {
    const dir = checkout("writes");
    apply(dir, NEW, "0.0.50");
    expect(read(dir, "scripts/monorepo.commit")).toBe(`${NEW}\n`);
    expect(read(dir, "kit/package.json")).toBe(manifest("0.0.50"));
    expect(read(dir, "scripts/package.json")).toBe(manifest("0.0.50"));
  });

  it("is the same when run twice", () => {
    const dir = checkout("twice");
    apply(dir, NEW, "0.0.50");
    apply(dir, NEW, "0.0.50");
    expect(read(dir, "kit/package.json")).toBe(manifest("0.0.50"));
  });

  it("changes nothing when a manifest does not name the client exactly once", () => {
    const dir = checkout(
      "two-lines",
      manifest("0.0.23").replace(
        '    "@withmarfa/connector"',
        '    "@withmarfa/client": "0.0.23",\n    "@withmarfa/connector"',
      ),
    );
    expect(() => apply(dir, NEW, "0.0.50")).toThrow();
    expect(read(dir, "scripts/monorepo.commit")).toBe(`${OLD}\n`);
  });

  it("refuses a version that is not exact and a commit that is not one", () => {
    const dir = checkout("refused");
    expect(() => apply(dir, NEW, "^0.0.50")).toThrow();
    expect(() => apply(dir, "main", "0.0.50")).toThrow();
    expect(read(dir, "scripts/monorepo.commit")).toBe(`${OLD}\n`);
    expect(read(dir, "kit/package.json")).toBe(manifest("0.0.23"));
  });
});
