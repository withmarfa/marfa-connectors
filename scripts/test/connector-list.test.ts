import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { connectorList, listFile, render } from "../connector-list.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

const places: string[] = [];
afterEach(async () => {
  for (const place of places.splice(0)) {
    await rm(place, { recursive: true, force: true });
  }
});

/** A repository holding only the built definitions given, by folder name. */
async function repository(
  definitions: Record<string, string>,
): Promise<string> {
  const place = await mkdtemp(join(tmpdir(), "connector-list-"));
  places.push(place);
  for (const [folder, body] of Object.entries(definitions)) {
    const dist = join(place, "connectors", folder, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "definition.js"), body);
  }
  await mkdir(join(place, "connectors"), { recursive: true });
  return place;
}

function definition(name: string, extra = ""): string {
  return `export function connector() {
    return { name: "${name}", source: "${name}", types: [{ type: { id: "${name}.item" } }, { type: { id: "${name}.note" } }], ${extra} };
  }`;
}

describe("the generated list of connectors", () => {
  it("has one entry for each folder of connectors/, and none for any other", async () => {
    const folders = (
      await readdir(join(root, "connectors"), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => `connectors/${entry.name}`)
      .sort();
    expect(folders.length).toBeGreaterThan(0);
    const list = await connectorList(root);
    expect(list.connectors.map((one) => one.directory)).toEqual(folders);
  });

  it("is the committed file, so a definition changed without regenerating it fails here", async () => {
    expect(await readFile(join(root, listFile), "utf8")).toBe(
      await render(root),
    );
  });

  it("gains an entry when a connector folder is added and loses it when removed, with no other edit", async () => {
    const place = await repository({
      alpha: definition("alpha"),
      beta: definition("beta"),
    });
    expect(
      (await connectorList(place)).connectors.map((one) => one.name),
    ).toEqual(["alpha", "beta"]);

    const dist = join(place, "connectors", "gamma", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "definition.js"), definition("gamma"));
    expect(
      (await connectorList(place)).connectors.map((one) => one.name),
    ).toEqual(["alpha", "beta", "gamma"]);

    await rm(join(place, "connectors", "alpha"), { recursive: true });
    expect(
      (await connectorList(place)).connectors.map((one) => one.name),
    ).toEqual(["beta", "gamma"]);
  });

  it("reads each field from the definition and leaves out what it does not set", async () => {
    const place = await repository({
      full: definition(
        "full",
        `description: "A full one.", sourceName: "Full", sourceMark: "lucide:box"`,
      ),
      bare: definition("bare"),
    });
    const [bare, full] = (await connectorList(place)).connectors;
    expect(full).toEqual({
      directory: "connectors/full",
      name: "full",
      description: "A full one.",
      source: "full",
      sourceName: "Full",
      sourceMark: "lucide:box",
      types: ["full.item", "full.note"],
      carriesBack: false,
      carriesBackCanBeTurnedOff: false,
      carriedTypes: [],
    });
    expect(bare).not.toHaveProperty("description");
    expect(bare).not.toHaveProperty("sourceName");
    expect(bare).not.toHaveProperty("sourceMark");
  });

  it("says a connector carries back only where it has onChange, with every type when it names none", async () => {
    const place = await repository({
      none: definition("none", `carries: () => ["none.item"]`),
      all: definition("all", `onChange: async () => undefined`),
      some: definition(
        "some",
        `onChange: async () => undefined, carries: () => ["some.note", "other.type"]`,
      ),
      empty: definition(
        "empty",
        `onChange: async () => undefined, carries: () => []`,
      ),
    });
    const byName = Object.fromEntries(
      (await connectorList(place)).connectors.map((one) => [one.name, one]),
    );
    expect(byName["none"]).toMatchObject({
      carriesBack: false,
      carriedTypes: [],
    });
    expect(byName["all"]).toMatchObject({
      carriesBack: true,
      carriedTypes: ["all.item", "all.note"],
    });
    expect(byName["some"]).toMatchObject({
      carriesBack: true,
      carriedTypes: ["some.note"],
    });
    expect(byName["empty"]).toMatchObject({
      carriesBack: false,
      carriedTypes: [],
    });
  });

  it("asks carries about the default settings: optional ones unset, required ones given a placeholder", async () => {
    const place = await repository({
      settings: definition(
        "settings",
        `env: { TOKEN: "secret", MODE: "optional", ACCOUNT: "required", KEY: "optional-secret" },
         onChange: async () => undefined,
         carries: (env) =>
           env.TOKEN !== undefined && env.ACCOUNT !== undefined && env.MODE === undefined && env.KEY === undefined
             ? ["settings.item"]
             : []`,
      ),
    });
    expect((await connectorList(place)).connectors[0]).toMatchObject({
      carriesBack: true,
      carriedTypes: ["settings.item"],
    });
  });

  it("refuses a folder with no built definition, naming it", async () => {
    const place = await repository({ alpha: definition("alpha") });
    await mkdir(join(place, "connectors", "unbuilt"), { recursive: true });
    await expect(connectorList(place)).rejects.toThrow(/connectors\/unbuilt/);
  });

  it("refuses a definition that does not export connector as a function", async () => {
    const place = await repository({ odd: "export const connector = 1;" });
    await expect(connectorList(place)).rejects.toThrow(
      /connectors\/odd\/src\/definition\.ts must export a function/,
    );
  });

  it("is the same file whatever settings the caller's environment holds", async () => {
    // The generator is run as CI runs it, in a process of its own, with a
    // setting that adds a type, one that removes fields and a token set.
    const done = await run(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "scripts/connector-list.ts"),
        "--check",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          RSS_PICTURES: "save",
          GITHUB_PERSONAL_TOKEN: "token",
          GITHUB_STARS: "false",
          GITHUB_READ_ONLY: "true",
          TODOIST_READ_ONLY: "true",
          READWISE_READER_INBOUND_ONLY: "true",
        },
      },
    ).catch((error: unknown) => {
      throw new Error("the generator refused the list", { cause: error });
    });
    expect(done.stderr).not.toMatch(/out of date/);
  });

  it("builds a definition from no settings, so what a setting adds is named only through settingsAddingTypes", async () => {
    const place = await repository({
      plain: `export function connector(settings) {
        return {
          name: "plain", source: "plain",
          types: [
            { type: { id: "plain.entry" } },
            ...(settings.PICTURES === "save" ? [{ type: { id: "plain.picture" } }] : []),
          ],
        };
      }`,
      adding: `export const settingsAddingTypes = { PICTURES: ["off", "save", "save-more"] };
        export function connector(settings) {
          return {
            name: "adding", source: "adding",
            types: [
              { type: { id: "adding.entry" } },
              ...(settings.PICTURES === "save" ? [{ type: { id: "adding.picture" } }] : []),
              ...(settings.PICTURES === "save-more" ? [{ type: { id: "adding.picture" } }, { type: { id: "adding.extra" } }] : []),
            ],
          };
        }`,
    });
    const byName = Object.fromEntries(
      (await connectorList(place)).connectors.map((one) => [one.name, one]),
    );
    expect(byName["plain"]?.types).toEqual(["plain.entry"]);
    expect(byName["adding"]?.types).toEqual([
      "adding.entry",
      "adding.picture",
      "adding.extra",
    ]);
  });

  it("refuses settingsAddingTypes that is not each setting with its values", async () => {
    const place = await repository({
      odd: `export const settingsAddingTypes = { PICTURES: "save" };
        ${definition("odd")}`,
    });
    await expect(connectorList(place)).rejects.toThrow(
      /connectors\/odd\/src\/definition\.ts must export `settingsAddingTypes`/,
    );
  });

  it("names every type the real RSS connector can write, and the real ones whose carrying back a setting turns off", async () => {
    const list = await connectorList(root);
    const byName = Object.fromEntries(
      list.connectors.map((one) => [one.name, one]),
    );
    expect(byName["rss"]?.types).toEqual(["rss.entry", "rss.picture"]);
    expect(
      list.connectors
        .filter((one) => one.carriesBackCanBeTurnedOff)
        .map((one) => one.name),
    ).toEqual(["github", "readwise-reader", "todoist"]);
    for (const one of list.connectors) {
      expect(one.carriesBackCanBeTurnedOff && !one.carriesBack).toBe(false);
    }
  });

  it("says a setting turns carrying back off only where one setting set to true leaves no type carried", async () => {
    const place = await repository({
      off: definition(
        "off",
        `env: { TOKEN: "secret", READ_ONLY: "optional", NAMED: "optional-secret" },
         onChange: async () => undefined,
         carries: (env) => (env.READ_ONLY === "true" ? [] : ["off.item"])`,
      ),
      some: definition(
        "some",
        `env: { KINDS: "optional" },
         onChange: async () => undefined,
         carries: (env) => (env.KINDS === "true" ? ["some.item"] : ["some.item", "some.note"])`,
      ),
      always: definition("always", `onChange: async () => undefined`),
      refuses: definition(
        "refuses",
        `env: { LIMIT: "optional" },
         onChange: async () => undefined,
         carries: (env) => {
           if (env.LIMIT !== undefined) throw new Error("LIMIT is a number");
           return ["refuses.item"];
         }`,
      ),
    });
    const byName = Object.fromEntries(
      (await connectorList(place)).connectors.map((one) => [one.name, one]),
    );
    expect(byName["off"]).toMatchObject({
      carriesBack: true,
      carriesBackCanBeTurnedOff: true,
    });
    expect(byName["some"]).toMatchObject({
      carriesBack: true,
      carriesBackCanBeTurnedOff: false,
    });
    expect(byName["always"]).toMatchObject({
      carriesBack: true,
      carriesBackCanBeTurnedOff: false,
    });
    expect(byName["refuses"]).toMatchObject({
      carriesBack: true,
      carriesBackCanBeTurnedOff: false,
    });
  });
});
