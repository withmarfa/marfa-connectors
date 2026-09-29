import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineConnector,
  type LocalCallback,
  type SetupContext,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, testFields, testType } from "./harness.js";

let harness: Harness;
let dir: string;
beforeEach(async () => {
  harness = await Harness.create();
  dir = await mkdtemp(join(tmpdir(), "kit-setup-"));
});
afterEach(async () => {
  await harness.close();
  await rm(dir, { recursive: true, force: true });
});

const made = "pem_private_key_made_by_the_vendor";
const env = { TEST_APP_KEY: "secret", TEST_REGION: "optional" } as const;

interface Held {
  opened?: LocalCallback;
  endpoint?: { path: string; url: string };
  answer?: Record<string, string>;
}

function withSetup(
  held: Held,
  setup?: (
    context: SetupContext<typeof env>,
  ) => Promise<Record<string, string>>,
) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [{ type: testType, fields: testFields }],
    env,
    async run() {
      // Nothing to read in these tests.
    },
    setup:
      setup ??
      (async (context) => {
        held.opened = await context.listen("<form>the manifest</form>");
        const query = await held.opened.redirected;
        held.endpoint = await context.endpoint({
          duplicateHeader: "X-GitHub-Delivery",
        });
        context.log.info(`the vendor posts to ${held.endpoint.url}`);
        context.secret(made);
        context.log.info(`code ${query.get("code") ?? ""} became ${made}`);
        return held.answer ?? { TEST_APP_KEY: made };
      }),
  });
}

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("--setup", () => {
  it("sets the connector up through a local redirect and its own endpoint, and writes the secrets to a new file its owner alone may read", async () => {
    const held: Held = {};
    const file = join(dir, "secrets.json");
    const exit = start(withSetup(held), harness.runtime(["--setup", file]));
    await until(() => held.opened !== undefined);
    const local = held.opened;
    if (local === undefined) throw new Error("setup listened nowhere");
    expect(await (await fetch(local.url)).text()).toBe(
      "<form>the manifest</form>",
    );
    expect(local.callback).toBe(`${local.url}/callback`);
    // Only the unguessable path answers.
    const root = new URL("/", local.url).toString();
    expect((await fetch(root)).status).toBe(404);
    expect((await fetch(`${root}callback?code=forged`)).status).toBe(404);
    expect((await fetch(`${local.callback}?code=abc`)).status).toBe(200);
    expect(await exit).toBe(0);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      TEST_APP_KEY: made,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(held.endpoint?.path).toMatch(/^\/inbound\/in_/);
    expect(held.endpoint?.url).toBe(
      new URL(held.endpoint?.path ?? "", harness.server.url).toString(),
    );
    expect(
      harness.server.requestsTo("POST", "/connectors/connector-1/endpoints")[0]
        ?.body,
    ).toEqual({ duplicate_header: "X-GitHub-Delivery" });
    const lines = harness.lines.join("\n");
    expect(lines).toContain(`open ${local.url} in a browser`);
    expect(lines).toContain("code abc became [redacted]");
    expect(lines).toContain(`setup wrote TEST_APP_KEY to ${file}`);
    expect(lines).not.toContain(made);
    expect(lines).not.toContain(held.endpoint?.path ?? "");
    // No run, no hold.
    expect(harness.server.runs).toEqual([]);
    expect(harness.server.holds).toEqual([]);
  });

  it("writes over no file, and is refused for a connector without a setup", async () => {
    const file = join(dir, "secrets.json");
    await writeFile(file, "kept");
    expect(await start(withSetup({}), harness.runtime(["--setup", file]))).toBe(
      2,
    );
    expect(await readFile(file, "utf8")).toBe("kept");
    const without = { ...withSetup({}) };
    Reflect.deleteProperty(without, "setup");
    expect(
      await start(without, harness.runtime(["--setup", join(dir, "new")])),
    ).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      "--setup is for a connector with a setup",
    );
    expect(harness.server.requests).toEqual([]);
  });

  it("makes the file before setup runs, and removes it where setup fails", async () => {
    const file = join(dir, "secrets.json");
    let during: number | undefined;
    const failing = withSetup({}, async () => {
      during = (await stat(file)).mode & 0o777;
      throw new Error("the vendor refused the manifest");
    });
    expect(await start(failing, harness.runtime(["--setup", file]))).toBe(1);
    expect(during).toBe(0o600);
    await expect(stat(file)).rejects.toThrow();
    expect(harness.lines.join("\n")).toContain(
      `setup failed, and ${file} was removed: the vendor refused the manifest`,
    );
  });

  it("keeps a name the connector does not declare in the file, and says so", async () => {
    const file = join(dir, "secrets.json");
    const exit = start(
      withSetup({}, () => Promise.resolve({ OTHER_KEY: made })),
      harness.runtime(["--setup", file]),
    );
    expect(await exit).toBe(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      OTHER_KEY: made,
    });
    expect(harness.lines.join("\n")).toContain(
      "setup answered OTHER_KEY, which the connector does not declare",
    );
  });
});

describe("a secret made at run time", () => {
  it("never reaches a log line, a condition or the report", async () => {
    const token = "installation_token_value_1234";
    const connector = defineConnector({
      name: "test",
      source: "test",
      types: [{ type: testType, fields: testFields }],
      env: {},
      run(context) {
        context.secret(token);
        context.log.warn(`holding ${token}`);
        context.log.condition(`token:${token}`, `made ${token}`);
        return Promise.reject(new Error(`the vendor refused ${token}`));
      },
    });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(1);
    const run = harness.lastRun();
    expect(`${run.summary ?? ""} ${run.error ?? ""}`).not.toContain(token);
    expect(run.error).toContain("the vendor refused [redacted]");
    expect(harness.lines.join("\n")).not.toContain(token);
    expect(JSON.stringify(harness.kept())).not.toContain(token);
  });
});
