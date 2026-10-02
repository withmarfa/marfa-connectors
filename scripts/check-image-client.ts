/**
 * Fails when a connector image holds a `@withmarfa/client` other than the
 * pinned one, which `pnpm deploy` could otherwise replace with the registry's
 * release. Takes image names; run it after `scripts/monorepo.sh`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const client = resolve(import.meta.dirname, "../vendor/marfa/packages/client");

// Beside the kit in pnpm's store, where the kit's own dependency lives.
const inImage = `
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = join(realpathSync("node_modules/@withmarfa/connector"), "..", "client");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const { CONTRACT_VERSION } = await import(pathToFileURL(join(dir, pkg.exports["."].import)).href);
console.log(JSON.stringify({ version: pkg.version, contract: CONTRACT_VERSION }));
`;

interface Held {
  version: string;
  contract: number;
}

const pinnedPackage = JSON.parse(
  readFileSync(resolve(client, "package.json"), "utf8"),
) as { version: string };
const pinnedContract = /CONTRACT_VERSION = (\d+)/.exec(
  readFileSync(resolve(client, "src/generated/contract.ts"), "utf8"),
)?.[1];
if (pinnedContract === undefined) {
  throw new Error("The pinned client names no contract version");
}
const pinned: Held = {
  version: pinnedPackage.version,
  contract: Number(pinnedContract),
};

const images = process.argv.slice(2);
if (images.length === 0) throw new Error("Name at least one image");

let failed = false;
for (const image of images) {
  const held = JSON.parse(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        inImage,
      ],
      { encoding: "utf8" },
    ),
  ) as Held;
  const same =
    held.version === pinned.version && held.contract === pinned.contract;
  console.log(
    `${same ? "ok  " : "FAIL"} ${image}: @withmarfa/client ${held.version}, contract ${String(held.contract)}` +
      (same
        ? ""
        : `; the pin is ${pinned.version}, contract ${String(pinned.contract)}`),
  );
  if (!same) failed = true;
}
if (failed) process.exitCode = 1;
