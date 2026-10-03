/** Compare deployed SDK identity and bytes with the frozen registry install. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ClientIdentity {
  version: string;
  contract: number;
  runtime: string;
  types: string;
}

interface ClientPackage {
  version: string;
  exports: { ".": { import: string; types: string } };
}

export async function clientIdentity(
  directory: string,
): Promise<ClientIdentity> {
  const pkg = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  ) as ClientPackage;
  const entry = pkg.exports["."];
  const runtime = join(directory, entry.import);
  const { CONTRACT_VERSION } = (await import(pathToFileURL(runtime).href)) as {
    CONTRACT_VERSION: number;
  };
  const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    version: pkg.version,
    contract: CONTRACT_VERSION,
    runtime: hash(runtime),
    types: hash(join(directory, entry.types)),
  };
}

export function sameClient(a: ClientIdentity, b: ClientIdentity): boolean {
  return (
    a.version === b.version &&
    a.contract === b.contract &&
    a.runtime === b.runtime &&
    a.types === b.types
  );
}

export function exactDependency(specifier: string, version: string): void {
  if (specifier !== version) {
    throw new Error(`Client dependency ${specifier} does not pin ${version}`);
  }
}

// pnpm deploy puts the kit's own client dependency beside the deployed kit.
const inImage = `
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = join(realpathSync("node_modules/@withmarfa/connector"), "..", "client");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const entry = pkg.exports["."];
const runtime = join(dir, entry.import);
const { CONTRACT_VERSION } = await import(pathToFileURL(runtime).href);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
console.log(JSON.stringify({ version: pkg.version, contract: CONTRACT_VERSION,
  runtime: hash(runtime), types: hash(join(dir, entry.types)) }));
`;

async function main(images: string[]): Promise<void> {
  if (images.length === 0) throw new Error("Name at least one image");
  const root = resolve(import.meta.dirname, "..");
  const installed = dirname(
    dirname(
      realpathSync(fileURLToPath(import.meta.resolve("@withmarfa/client"))),
    ),
  );
  const expected = await clientIdentity(installed);
  for (const consumer of ["kit", "scripts"]) {
    const pkg = JSON.parse(
      readFileSync(join(root, consumer, "package.json"), "utf8"),
    ) as { dependencies: { "@withmarfa/client": string } };
    exactDependency(pkg.dependencies["@withmarfa/client"], expected.version);
  }
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
    ) as ClientIdentity;
    const same = sameClient(held, expected);
    console.log(
      `${same ? "ok  " : "FAIL"} ${image}: ${JSON.stringify(held)}` +
        (same ? "" : `; expected ${JSON.stringify(expected)}`),
    );
    if (!same) process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}
