import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector } from "@withmarfa/connector";
import { start } from "../../../kit/src/main.js";
import { Harness, testFields, testType } from "../../../kit/test/harness.js";
import { connectGoogle, googleEnv, signIn } from "../src/index.js";
import { clientEnv, freshToken, GoogleStub } from "./stub.js";

const A = "https://www.googleapis.com/auth/a";
const B = "https://www.googleapis.com/auth/b";
const issued = "1//the-refresh-token-google-issued-in-setup";
const code = "4/0AVeryLongAuthorizationCodeFromGoogle";

let harness: Harness;
let stub: GoogleStub;
let dir: string;
beforeEach(async () => {
  harness = await Harness.create();
  stub = await new GoogleStub().start();
  dir = await mkdtemp(join(tmpdir(), "google-kit-"));
});
afterEach(async () => {
  await harness.close();
  await stub.stop();
  await rm(dir, { recursive: true, force: true });
});

function connector(scopes: string[], reads?: () => void) {
  return defineConnector({
    name: "test",
    source: "test",
    types: [{ type: testType, fields: testFields }],
    env: googleEnv,
    async run(context) {
      const google = connectGoogle(context, scopes, {
        endpoints: stub.endpoints,
      });
      await google.ready();
      reads?.();
    },
    setup: (context) => signIn(context, scopes, { endpoints: stub.endpoints }),
  });
}

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Everything the run said and reported, where a secret must not be. */
function reported(): string {
  return [
    ...harness.lines,
    ...Object.values(harness.problems()),
    ...harness.server.runs.flatMap((run) => [
      run.error ?? "",
      run.summary ?? "",
    ]),
  ].join("\n");
}

describe("through the kit", () => {
  it("signs in through a redirect pasted from a browser on another machine, and writes only the refresh token to a file only its owner reads", async () => {
    stub.onToken = () =>
      stub.granted({ refresh_token: issued, scope: `openid ${A}` });
    const stdin = new PassThrough();
    const file = join(dir, "google.json");
    const done = start(connector([A]), {
      ...harness.runtime(["--setup", file], clientEnv),
      stdin,
    });
    await until(() => harness.lines.some((line) => line.includes("/auth?")));
    const lines = harness.lines.join("\n");
    const consent = new URL(/(http\S+\/auth\?\S+)/.exec(lines)?.[1] ?? "");
    const opened = /open (http:\/\/127\.0\.0\.1:\d+\/[\w-]+) in a browser/.exec(
      lines,
    )?.[1];
    expect(opened).toBeDefined();
    const path = new URL(`${opened ?? ""}/callback`).pathname;
    stdin.write(
      `http://127.0.0.1:41999${path}?state=${consent.searchParams.get("state") ?? ""}&code=${code}&scope=openid\n`,
    );
    expect(await done).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      GOOGLE_REFRESH_TOKEN: issued,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const said = reported();
    for (const value of [clientEnv.GOOGLE_CLIENT_SECRET, issued, code]) {
      expect(said).not.toContain(value);
    }
    expect(said).toContain("paste the address it ended on");
  });

  it("fails the run with one condition to reconnect where Google ends the grant, and leaks nothing", async () => {
    const token = freshToken();
    stub.onToken = () => ({
      status: 400,
      json: {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
    });
    let read = false;
    const exit = await start(
      connector([A], () => {
        read = true;
      }),
      harness.runtime(["--once"], {
        ...clientEnv,
        GOOGLE_REFRESH_TOKEN: token,
      }),
    );
    expect(exit).not.toBe(0);
    expect(read).toBe(false);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(Object.keys(harness.problems())).toEqual(["google:reconnect"]);
    const said = reported();
    for (const value of [clientEnv.GOOGLE_CLIENT_SECRET, token]) {
      expect(said).not.toContain(value);
    }
    // The witness: the kit does keep what a run raises where it reports.
    expect(said).toContain("--setup <file>");
  });

  it("runs, and raises a condition naming a scope the person left unticked", async () => {
    stub.scope = `openid ${A}`;
    const token = freshToken();
    let read = false;
    const exit = await start(
      connector([A, B], () => {
        read = true;
      }),
      harness.runtime(["--once"], {
        ...clientEnv,
        GOOGLE_REFRESH_TOKEN: token,
      }),
    );
    expect(exit).toBe(0);
    expect(read).toBe(true);
    expect(Object.keys(harness.problems())).toEqual([`google:scope:${B}`]);
    expect(harness.problems()[`google:scope:${B}`]).toContain("--setup <file>");
    const said = reported();
    expect(said).not.toContain(token);
    expect(said).not.toContain("ya29.");
  });
});
