import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");

function tree(): { path: string; text: string }[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((path) => path !== "")
    .flatMap((path) => {
      const full = resolve(root, path);
      let link: boolean;
      try {
        link = lstatSync(full).isSymbolicLink();
      } catch {
        return [];
      }
      return [
        { path, text: link ? readlinkSync(full) : readFileSync(full, "utf8") },
      ];
    });
}

function declaresVersion(manifest: string): boolean {
  return Object.hasOwn(JSON.parse(manifest) as object, "version");
}

function versionFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    /^version(\.txt)?$/.test(name) || /^package\.(ya?ml|json5)$/.test(name)
  );
}

const machineDetails = [
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"'`]+/,
  /\/var\/folders\/[^\s"'`]+/,
  /\b[a-z0-9-]+\.local\b/i,
  /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i,
];
const address = /\b[a-z0-9][\w.+-]*@([\w-]+\.)+[a-z]{2,}/gi;

/**
 * A home directory, a per-user temporary path, a machine's mDNS or tailnet
 * name, or a mail address outside the reserved example domains. The
 * forge's SSH user is nobody's address.
 */
function personalDetail(text: string): string | undefined {
  for (const pattern of machineDetails) {
    const found = pattern.exec(text);
    if (found !== null) return found[0];
  }
  for (const match of text.matchAll(address)) {
    const found = match[0];
    if (found === "git@github.com") continue;
    if (!/@(?:[\w-]+\.)*example\.(?:com|org|net)$/i.test(found)) {
      return found;
    }
  }
  return undefined;
}

function buildOutput(path: string): boolean {
  return path.split("/").includes("dist") || path.endsWith(".tsbuildinfo");
}

/** Files that bind a checkout to one person's secrets workspace. */
function secretsBinding(path: string): boolean {
  return basename(path) === ".infisical.json";
}

function trackedPaths(): string[] {
  return execFileSync("git", ["ls-files", "--cached"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path !== "");
}

/** `uses:` references that name a tag or branch where a commit belongs. */
function unpinnedActions(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].flatMap(
    ([, reference = "", rest = ""]) =>
      /@[0-9a-f]{40}$/.test(reference) && /^\s+#\s*v\S+/.test(rest)
        ? []
        : [reference],
  );
}

/** Base images named by a Dockerfile's `FROM` lines without a digest. */
function unpinnedImages(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].flatMap(
    ([, image = ""]) => (/@sha256:[0-9a-f]{64}$/.test(image) ? [] : [image]),
  );
}

/** Where `vitest.config.ts` looks for tests: under a `test/` directory. */
function strayTest(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)test\//.test(path)
  );
}

function offHosted(workflow: string): string[] {
  const document = parse(workflow) as {
    jobs?: Record<string, Record<string, unknown>>;
  };
  return Object.entries(document.jobs ?? {}).flatMap(([name, job]) => {
    if ("uses" in job) return [`${name}: uses ${String(job["uses"])}`];
    const runsOn = job["runs-on"];
    return runsOn === "ubuntu-latest"
      ? []
      : [`${name}: ${JSON.stringify(runsOn)}`];
  });
}

// Assembled, so this file does not hold the details it looks for.
const someHome = ["", "Users", "someone"].join("/");
const someTemp = ["", "var", "folders", "xy", "T"].join("/");
const someHost = ["laptop", "local"].join(".");
const someTailnetHost = ["laptop", "tail1234", "ts", "net"].join(".");
const someAddress = ["someone", "mail.test.org"].join("@");

describe("the tree", () => {
  it("carries no version in any manifest, and no file that holds one", () => {
    expect(declaresVersion('{ "name": "x", "version": "0.0.1" }')).toBe(true);
    expect(
      ["VERSION", "kit/version.txt", "kit/package.yaml"].filter(versionFile),
    ).toHaveLength(3);
    const files = tree();
    const manifests = files.filter(
      (file) => basename(file.path) === "package.json",
    );
    expect(manifests.length).toBeGreaterThan(0);
    expect(
      manifests
        .filter((file) => declaresVersion(file.text))
        .map((file) => file.path),
    ).toEqual([]);
    expect(files.map((file) => file.path).filter(versionFile)).toEqual([]);
  });

  it("carries no home directory, machine name or personal address", () => {
    expect(personalDetail(`cd ${someHome}/code`)).toBe(someHome);
    expect(personalDetail(`TMPDIR=${someTemp}/`)).toBe(`${someTemp}/`);
    expect(personalDetail(`ssh ${someHost}`)).toBe(someHost);
    expect(personalDetail(`https://${someTailnetHost}/`)).toBe(someTailnetHost);
    expect(personalDetail(`mail ${someAddress}`)).toBe(someAddress);
    expect(
      personalDetail(
        "me@example.com, git@github.com, localhost and /usr/local/bin",
      ),
    ).toBeUndefined();
    const files = tree();
    expect(files.length).toBeGreaterThan(0);
    const found = files
      .map((file) => ({ path: file.path, detail: personalDetail(file.text) }))
      .filter((entry) => entry.detail !== undefined);
    expect(found).toEqual([]);
  });

  it("tracks no build output", () => {
    expect(
      ["kit/dist/index.js", "kit/tsconfig.tsbuildinfo", "kit/src/a.ts"].filter(
        buildOutput,
      ),
    ).toEqual(["kit/dist/index.js", "kit/tsconfig.tsbuildinfo"]);
    expect(
      tree()
        .map((file) => file.path)
        .filter(buildOutput),
    ).toEqual([]);
  });

  it("builds every package, a new connector included", () => {
    const unbuilt = (packages: string[], tsconfig: string): string[] => {
      const references = (
        JSON.parse(tsconfig) as { references: { path: string }[] }
      ).references.map((reference) => reference.path);
      return packages.filter((dir) => !references.includes(dir));
    };
    expect(
      unbuilt(
        ["kit", "connectors/new"],
        JSON.stringify({ references: [{ path: "kit" }] }),
      ),
    ).toEqual(["connectors/new"]);
    const packages = tree()
      .map((file) => file.path)
      .filter((path) => /^.+\/package\.json$/.test(path))
      .map((path) => path.slice(0, -"/package.json".length));
    expect(packages).toContain("template/connector");
    expect(
      unbuilt(packages, readFileSync(resolve(root, "tsconfig.json"), "utf8")),
    ).toEqual([]);
  });

  it("runs every workflow job on standard hosted Linux", () => {
    expect(
      offHosted(
        [
          "jobs:",
          "  a: { runs-on: ubuntu-latest }",
          '  b: { "runs-on": macos-latest }',
          "  c:",
          "    uses: someone/else/.github/workflows/ci.yml@main",
          "  d:",
          "    runs-on: [self-hosted, linux]",
          "  e:",
          "    runs-on: self-hosted",
        ].join("\n"),
      ),
    ).toEqual([
      'b: "macos-latest"',
      "c: uses someone/else/.github/workflows/ci.yml@main",
      'd: ["self-hosted","linux"]',
      'e: "self-hosted"',
    ]);
    const workflows = tree().filter((file) =>
      /^\.github\/workflows\/.+\.ya?ml$/.test(file.path),
    );
    expect(workflows.length).toBeGreaterThan(0);
    expect(
      workflows.flatMap((file) =>
        offHosted(file.text).map((job) => `${file.path} ${job}`),
      ),
    ).toEqual([]);
  });

  it("tracks no secrets workspace binding", () => {
    expect(
      [".infisical.json", "connectors/x/.infisical.json", "README.md"].filter(
        secretsBinding,
      ),
    ).toEqual([".infisical.json", "connectors/x/.infisical.json"]);
    expect(trackedPaths().filter(secretsBinding)).toEqual([]);
  });

  it("pins every action by commit, with its tag beside it, and every base image by digest", () => {
    const sha = "a".repeat(40);
    expect(
      unpinnedActions(
        [
          `      - uses: someone/tag@v4`,
          `      - uses: someone/bare@${sha}`,
          `      - uses: someone/ok@${sha} # v4.1.0`,
        ].join("\n"),
      ),
    ).toEqual(["someone/tag@v4", `someone/bare@${sha}`]);
    expect(
      unpinnedImages(
        `FROM node:22-slim AS build\nFROM node:22-slim@sha256:${"b".repeat(64)}\n`,
      ),
    ).toEqual(["node:22-slim"]);
    const workflows = tree().filter((file) =>
      /^\.github\/workflows\/.+\.ya?ml$/.test(file.path),
    );
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.flatMap((file) => unpinnedActions(file.text))).toEqual([]);
    const dockerfiles = tree().filter(
      (file) => basename(file.path) === "Dockerfile",
    );
    expect(dockerfiles.length).toBeGreaterThan(0);
    expect(dockerfiles.flatMap((file) => unpinnedImages(file.text))).toEqual(
      [],
    );
  });

  it("keeps every test file where the test runner looks", () => {
    expect(
      ["kit/src/a.test.ts", "kit/test/a.test.ts", "b.spec.mjs"].filter(
        strayTest,
      ),
    ).toEqual(["kit/src/a.test.ts", "b.spec.mjs"]);
    expect(
      trackedPaths().filter((path) => path.endsWith(".ts")).length,
    ).toBeGreaterThan(0);
    expect(trackedPaths().filter(strayTest)).toEqual([]);
  });
});
