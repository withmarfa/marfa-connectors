import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector } from "@withmarfa/connector";
import { start } from "../../../kit/src/main.js";
import {
  Harness,
  linkedType,
  testFields,
  testType,
} from "../../../kit/test/harness.js";
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

const types = [testType.id];
const source = "test";

function connector(scopes: string[], reads?: () => void) {
  return defineConnector({
    name: "test",
    source,
    types: [{ type: testType, fields: testFields }],
    env: googleEnv,
    async run(context) {
      const google = connectGoogle(
        context,
        { source, scopes, types },
        { endpoints: stub.endpoints },
      );
      await google.ready();
      reads?.();
    },
    setup: (context) => signIn(context, scopes, { endpoints: stub.endpoints }),
  });
}

/** A two-way connector that writes one row for the account, then fails
 *  where asked, and sends each row made in Marfa to Google. */
function writer(fails = false) {
  return defineConnector({
    name: "test",
    source,
    types: [{ type: linkedType, fields: testFields }],
    env: googleEnv,
    async run(context) {
      const google = connectGoogle(
        context,
        { source, scopes: [A], types },
        { endpoints: stub.endpoints },
      );
      const { account } = await google.ready();
      await context.upsert(testType.id, [
        {
          source_id: `${account}:event-1`,
          properties: { title: "Event", vendor_id: `${account}:event-1` },
        },
      ]);
      if (fails) throw new Error("Google stopped answering halfway");
    },
    async onChange(change, context) {
      const google = connectGoogle(
        context,
        { source, scopes: [A], types },
        { endpoints: stub.endpoints },
      );
      await google.json(`${stub.url}/calendars/primary/events`, {
        method: "POST",
        body: JSON.stringify({ summary: change.item.properties["title"] }),
      });
      await context.setLink(change.item, `made-${change.item.id}`);
      return undefined;
    },
  });
}

const other = "sub-2222222222";

function signedIn(token = freshToken()) {
  return harness.runtime(["--once"], {
    ...clientEnv,
    GOOGLE_REFRESH_TOKEN: token,
  });
}

const posts = (): number =>
  stub.api.filter((call) => call.method === "POST").length;

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
    expect(said).toContain("paste the address it ends on");
    expect(said).toContain(
      `from a browser on another machine, open ${consent.toString()} there`,
    );
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

  it("keeps the account before writing a row, so a run that fails after writing still holds it against another account", async () => {
    expect(await start(writer(true), signedIn())).toBe(1);
    expect(harness.server.row(`${stub.sub}:event-1`)).toBeDefined();
    expect(harness.kept()["state"]).toEqual({ google_account: stub.sub });

    stub.sub = other;
    expect(await start(writer(), signedIn())).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(Object.keys(harness.problems())).toContain("google:account");
    expect(
      harness.server.rows.filter((row) =>
        row.source_id?.startsWith(`${other}:`),
      ),
    ).toEqual([]);
    expect(harness.kept()["state"]).toEqual({
      google_account: "sub-1111111111",
    });
  });

  it("refuses another account after the connector's state was cleared, by the rows it holds", async () => {
    expect(await start(writer(), signedIn())).toBe(0);
    const cleared = (): void => {
      harness.server.states.delete(harness.server.keySource);
      harness.server.agreements.clear();
      harness.server.problems.delete(harness.server.keySource);
    };
    cleared();
    stub.sub = other;
    expect(await start(writer(), signedIn())).toBe(1);
    expect(Object.keys(harness.problems())).toContain("google:account");
    expect(
      harness.server.rows.filter((row) =>
        row.source_id?.startsWith(`${other}:`),
      ),
    ).toEqual([]);

    // The witness: the account the rows came from is kept again.
    cleared();
    stub.sub = "sub-1111111111";
    expect(await start(writer(), signedIn())).toBe(0);
    expect(harness.kept()["state"]).toEqual({
      google_account: "sub-1111111111",
    });
  });

  it("keeps the account on the first run beside another source's linked row whose source_id has a colon, and still refuses its own rows of another account", async () => {
    harness.server.insert(
      "ios:ABC-123",
      { title: "From the phone", vendor_id: "ABC-123" },
      testType.id,
      "person",
    );
    expect(await start(writer(), signedIn())).toBe(0);
    expect(Object.keys(harness.problems())).not.toContain("google:account");
    expect(harness.kept()["state"]).toEqual({ google_account: stub.sub });

    // The witness: a row of the connector's own source for another account
    // is refused once the kept account is cleared.
    harness.server.states.delete(harness.server.keySource);
    harness.server.agreements.clear();
    harness.server.problems.delete(harness.server.keySource);
    harness.server.insert(
      `${other}:event-9`,
      { title: "Another account's", vendor_id: `${other}:event-9` },
      testType.id,
    );
    expect(await start(writer(), signedIn())).toBe(1);
    expect(Object.keys(harness.problems())).toContain("google:account");
    expect(harness.kept()["state"]).toEqual({});
  });

  it("sends nothing from the watch phase once the account changed, and raises the account condition", async () => {
    expect(await start(writer(), signedIn())).toBe(0);
    harness.server.insert(undefined, { title: "Mine" }, testType.id, "person");
    stub.sub = other;
    expect(await start(writer(), signedIn())).toBe(1);
    expect(posts()).toBe(0);
    expect(Object.keys(harness.problems())).toContain("google:account");

    // The witness: the account the rows came from sends the queued create.
    stub.sub = "sub-1111111111";
    expect(await start(writer(), signedIn())).toBe(0);
    expect(posts()).toBe(1);
  });
});
