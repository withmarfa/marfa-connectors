import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ScriptedServer } from "../../kit/test/scripted-server.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

/**
 * A repository laid out as this one is, holding only the base config, the
 * kit and the installed packages, linked in, and a copy of the template at
 * `connectors/copied/`, as its README says to make one. The copy is built
 * on its own, against the kit's built declarations.
 */
async function copiedConnector(place: string): Promise<string> {
  await copyFile(
    join(root, "tsconfig.base.json"),
    join(place, "tsconfig.base.json"),
  );
  await symlink(join(root, "kit"), join(place, "kit"));
  await symlink(join(root, "node_modules"), join(place, "node_modules"));
  const copied = join(place, "connectors", "copied");
  await cp(join(root, "template", "connector"), copied, {
    recursive: true,
    filter: (source) => !/[/\\](dist|node_modules)$/.test(source),
  });
  await mkdir(join(copied, "node_modules", "@withmarfa"), { recursive: true });
  await symlink(
    join(root, "kit"),
    join(copied, "node_modules", "@withmarfa", "connector"),
  );
  await run(join(root, "node_modules", ".bin", "tsc"), [
    "-p",
    join(copied, "tsconfig.json"),
  ]);
  return copied;
}

it("builds and runs once copied to a connector's place", async () => {
  const place = await mkdtemp(join(tmpdir(), "template-copy-"));
  const marfa = await new ScriptedServer("example", {
    types: ["example.item"],
  }).start();
  const vendor = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        account: "acct",
        items: [{ id: "1", title: "One", created: "2026-09-01T10:00:00Z" }],
      }),
    );
  });
  await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
  try {
    const copied = await copiedConnector(place);
    await run("node", [join(copied, "dist", "main.js"), "--once"], {
      env: {
        PATH: process.env["PATH"],
        MARFA_URL: marfa.url,
        MARFA_KEY: marfa.key,
        EXAMPLE_URL: `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`,
        EXAMPLE_TOKEN: "example-vendor-token",
      },
    });
    expect(marfa.types.has("example.item")).toBe(true);
    expect(marfa.rows.map((row) => [row.source_id, row.properties])).toEqual([
      ["acct:1", { example_id: "1", title: "One" }],
    ]);
  } finally {
    vendor.closeAllConnections();
    await new Promise((done) => vendor.close(done));
    await marfa.stop();
    await rm(place, { recursive: true, force: true });
  }
}, 60_000);
