import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

/** Every file git would commit: tracked, plus untracked and not ignored. */
function treeFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((path) => path !== "");
}

function declaresVersion(manifest: string): boolean {
  return Object.hasOwn(JSON.parse(manifest) as object, "version");
}

const homePath = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"'`]+/;
const address = /\b[a-z0-9][\w.+-]*@([\w-]+\.)+[a-z]{2,}/gi;

/**
 * A home directory, or a mail address outside the reserved example domains.
 * The forge's SSH user is nobody's address.
 */
function personalDetail(text: string): string | undefined {
  const path = homePath.exec(text);
  if (path !== null) return path[0];
  for (const match of text.matchAll(address)) {
    const found = match[0];
    if (found === "git@github.com") continue;
    if (!/@(?:[\w-]+\.)*example\.(?:com|org|net)$/i.test(found)) {
      return found;
    }
  }
  return undefined;
}

// Assembled, so this file does not hold the details it looks for.
const someHome = ["", "Users", "someone"].join("/");
const someAddress = ["someone", "mail.test.org"].join("@");

describe("the tree", () => {
  it("carries no version in any manifest", () => {
    expect(declaresVersion('{ "name": "x", "version": "0.0.1" }')).toBe(true);
    const manifests = treeFiles().filter((path) =>
      path.endsWith("package.json"),
    );
    expect(manifests.length).toBeGreaterThan(0);
    const versioned = manifests.filter((path) =>
      declaresVersion(readFileSync(resolve(root, path), "utf8")),
    );
    expect(versioned).toEqual([]);
  });

  it("carries no home directory or personal address", () => {
    expect(personalDetail(`cd ${someHome}/code`)).toBe(someHome);
    expect(personalDetail(`mail ${someAddress}`)).toBe(someAddress);
    expect(personalDetail("me@example.com and /usr/local/bin")).toBeUndefined();
    const found = treeFiles()
      .filter((path) => !path.endsWith(".tgz"))
      .map((path) => ({
        path,
        detail: personalDetail(readFileSync(resolve(root, path), "utf8")),
      }))
      .filter((entry) => entry.detail !== undefined);
    expect(found).toEqual([]);
  });
});
