import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineConnector,
  type LocalCallback,
  type SetupContext,
} from "../src/define.js";
import { start } from "../src/main.js";
import type { Runtime } from "../src/runtime.js";
import { Harness, testFields, testType } from "./harness.js";

let harness: Harness;
let dir: string;
beforeEach(async () => {
  harness = await Harness.create();
  dir = await mkdtemp(join(tmpdir(), "kit-paste-"));
});
afterEach(async () => {
  await harness.close();
  await rm(dir, { recursive: true, force: true });
});

const made = "pem_private_key_made_by_the_vendor";
const env = { TEST_APP_KEY: "secret" } as const;

interface Held {
  opened?: LocalCallback;
  query?: URLSearchParams;
}

function connector(
  held: Held,
  after?: (context: SetupContext<typeof env>, local: LocalCallback) => void,
) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [{ type: testType, fields: testFields }],
    env,
    async run() {
      // Nothing to read in these tests.
    },
    async setup(context) {
      held.opened = await context.listen("<form></form>");
      held.query = await held.opened.redirected;
      after?.(context, held.opened);
      return { TEST_APP_KEY: made };
    },
  });
}

function withInput(input: PassThrough | undefined, file: string): Runtime {
  return { ...harness.runtime(["--setup", file]), stdin: input };
}

function opened(held: Held): LocalCallback {
  if (held.opened === undefined) throw new Error("setup never opened a listen");
  return held.opened;
}

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Where the browser on another machine ended: the same path and query, a
 *  host and port of its own. */
function elsewhere(local: LocalCallback, query: string): string {
  const path = new URL(local.callback).pathname;
  return `http://127.0.0.1:41999${path}?${query}`;
}

const warnings = (): string[] =>
  harness.lines.filter((line) => line.includes(" warn "));

describe("a redirect that arrives by paste", () => {
  it("resolves from the address pasted into the terminal, whatever host and port the other browser showed", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    const local = opened(held);
    input.write(`${elsewhere(local, "code=abc&state=xyz")}\n`);
    expect(await exit).toBe(0);
    expect(held.query?.get("code")).toBe("abc");
    expect(held.query?.get("state")).toBe("xyz");
    expect(warnings()).toEqual([]);
  });

  it("says, beside the address to open, that a browser on another machine pastes the address it ended on", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    const lines = harness.lines.join("\n");
    expect(lines).toContain(`open ${held.opened?.url ?? ""} in a browser`);
    expect(lines).toMatch(
      /from a browser on another machine, paste the address it ended on/,
    );
    input.write(`${elsewhere(opened(held), "code=abc")}\n`);
    expect(await exit).toBe(0);
  });

  it("warns once for a wrong path, a garbage line and an address with another base, and goes on waiting", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    const local = opened(held);
    const path = new URL(local.callback).pathname;
    input.write(`http://127.0.0.1:41999${path}/other?code=leaked1\n`);
    await until(() => warnings().length === 1);
    input.write("this is not an address, code=leaked2\n");
    await until(() => warnings().length === 2);
    input.write(
      "http://127.0.0.1:41999/00000000-0000-4000-8000-000000000000/callback?code=leaked3\n",
    );
    await until(() => warnings().length === 3);
    input.write("\n");
    input.write("javascript:alert(1)\n");
    await until(() => warnings().length === 4);
    expect(held.query).toBeUndefined();
    input.write(`${elsewhere(local, "code=right")}\n`);
    expect(await exit).toBe(0);
    expect(held.query?.get("code")).toBe("right");
    expect(warnings()).toHaveLength(4);
    const lines = harness.lines.join("\n");
    expect(lines).toContain("is not the address the browser ended on");
    for (const leaked of ["leaked1", "leaked2", "leaked3"])
      expect(lines).not.toContain(leaked);
  });

  it("goes on waiting for the browser on this machine where standard input is closed", async () => {
    const input = new PassThrough();
    input.end();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await fetch(`${held.opened?.callback ?? ""}?code=abc`)).status,
    ).toBe(200);
    expect(await exit).toBe(0);
    expect(held.query?.get("code")).toBe("abc");
  });

  it("goes on waiting where standard input fails", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    input.destroy(new Error("the terminal went away"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetch(`${held.opened?.callback ?? ""}?code=abc`);
    expect(await exit).toBe(0);
  });

  it("needs no standard input at all", async () => {
    const held: Held = {};
    const exit = start(
      connector(held),
      withInput(undefined, join(dir, "a.json")),
    );
    await until(() => held.opened !== undefined);
    await fetch(`${held.opened?.callback ?? ""}?code=abc`);
    expect(await exit).toBe(0);
    expect(harness.lines.join("\n")).not.toContain("paste the address");
  });

  it("stops reading when asked to stop while it waits", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    expect(input.listenerCount("data") + input.listenerCount("readable")).toBe(
      1,
    );
    harness.stop();
    expect(await exit).toBe(1);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    input.write(`${elsewhere(opened(held), "code=late")}\n`);
    expect(held.query).toBeUndefined();
  });

  it("stops reading once setup ends, so standard input does not hold the process", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(connector(held), withInput(input, join(dir, "a.json")));
    await until(() => held.opened !== undefined);
    await fetch(`${held.opened?.callback ?? ""}?code=abc`);
    expect(await exit).toBe(0);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("takes the first of the browser and a paste, and ignores the second", async () => {
    const browserFirst = new PassThrough();
    const one: Held = {};
    const exitOne = start(
      connector(one),
      withInput(browserFirst, join(dir, "one.json")),
    );
    await until(() => one.opened !== undefined);
    const first = opened(one);
    expect((await fetch(`${first.callback}?code=browser`)).status).toBe(200);
    browserFirst.write(`${elsewhere(first, "code=paste")}\n`);
    expect(await exitOne).toBe(0);
    expect(one.query?.get("code")).toBe("browser");

    const pasteFirst = new PassThrough();
    const two: Held = {};
    const exitTwo = start(
      connector(two),
      withInput(pasteFirst, join(dir, "two.json")),
    );
    await until(() => two.opened !== undefined);
    const second = opened(two);
    pasteFirst.write(`${elsewhere(second, "code=paste")}\n`);
    expect(await exitTwo).toBe(0);
    const late = await fetch(`${second.callback}?code=browser`).catch(
      () => undefined,
    );
    expect(late?.status ?? 404).toBe(404);
    expect(two.query?.get("code")).toBe("paste");
  });

  it("gives the address to open itself where there is no browser to send on", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(
      connector(held, (_context, local) => {
        local.onward("https://vendor.example/apps/install");
      }),
      withInput(input, join(dir, "a.json")),
    );
    await until(() => held.opened !== undefined);
    input.write(`${elsewhere(opened(held), "code=abc")}\n`);
    expect(await exit).toBe(0);
    expect(harness.lines.join("\n")).toContain(
      "open https://vendor.example/apps/install in a browser to go on",
    );
  });

  it("still refuses to send on before anything arrived, or to somewhere not on the web", async () => {
    const input = new PassThrough();
    const held: Held = {};
    const exit = start(
      connector(held, (_context, local) => {
        local.onward("javascript:alert(1)");
      }),
      withInput(input, join(dir, "a.json")),
    );
    await until(() => held.opened !== undefined);
    input.write(`${elsewhere(opened(held), "code=abc")}\n`);
    expect(await exit).toBe(1);
    expect(harness.lines.join("\n")).toContain(
      "onward sends the browser only to a web address",
    );
  });
});
