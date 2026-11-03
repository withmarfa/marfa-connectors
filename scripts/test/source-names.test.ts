import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

async function declaration(dir: string): Promise<string> {
  const files = await readdir(join(root, dir, "src"), { recursive: true });
  const texts = await Promise.all(
    files
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFile(join(root, dir, "src", file), "utf8")),
  );
  return texts.join("\n");
}

it("has every connector and the template declare the name of its source, and any mark as an icon ID", async () => {
  const connectors = (await readdir(join(root, "connectors"))).map(
    (name) => `connectors/${name}`,
  );
  expect(connectors).toContain("connectors/github");
  for (const dir of [...connectors, "template/connector"]) {
    const text = await declaration(dir);
    expect(text, dir).toMatch(/\bsourceName: "[^"]+",/);
    for (const [, mark] of text.matchAll(/\bsourceMark: "([^"]*)"/g)) {
      expect(mark, dir).toMatch(
        /^(simple-icons|lucide):[a-z0-9]+(-[a-z0-9]+)*$/,
      );
    }
  }
});
