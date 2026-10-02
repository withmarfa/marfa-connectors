import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { appKey, GitHubStub } from "../../../scripts/proof/github-stub.js";
import { apiVersion } from "../src/github.js";
import { hookUrl } from "../src/setup.js";

const built = resolve(import.meta.dirname, "../dist/main.js");

let marfa: ScriptedServer;
let github: GitHubStub;
let dir: string;

beforeEach(async () => {
  marfa = await new ScriptedServer("github", {
    types: ["github.repository", "github.issue", "github.comment"],
    edges: [
      "github.in-repository",
      "github.sub-issue-of",
      "github.blocked-by",
      "in-thread",
    ],
  }).start();
  marfa.grants = {
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  github = await new GitHubStub().start();
  github.appPem = appKey();
  dir = await mkdtemp(join(tmpdir(), "github-setup-"));
});

afterEach(async () => {
  await marfa.stop();
  await github.stop();
  await rm(dir, { recursive: true, force: true });
});

function setup(
  file: string,
  env: Record<string, string>,
  seen: (line: string) => void,
): Promise<{ code: number | null; output: string }> {
  const child = spawn("node", [built, "--setup", file], {
    env: {
      PATH: process.env["PATH"],
      MARFA_URL: marfa.url,
      MARFA_KEY: marfa.key,
      GITHUB_API_URL: github.url,
      ...env,
    },
  });
  let output = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
    for (const line of chunk.split("\n")) if (line !== "") seen(line);
  });
  return new Promise((done) => {
    child.on("close", (code) => {
      done({ code, output });
    });
  });
}

function decoded(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("the webhook's address", () => {
  it("keeps the public address's own path before the endpoint's", () => {
    expect(hookUrl("https://marfa.example", "/inbound/in_1")).toBe(
      "https://marfa.example/inbound/in_1",
    );
    expect(hookUrl("https://marfa.example/a/b/", "/inbound/in_1")).toBe(
      "https://marfa.example/a/b/inbound/in_1",
    );
  });
});

describe("setup", () => {
  it("registers the App from a manifest, with its webhook at the instance's public address, and writes its secrets", async () => {
    const file = join(dir, "secrets.json");
    let visited: Promise<void> | undefined;
    const seenPage: {
      action?: string;
      manifest?: Record<string, unknown>;
      onward?: string | undefined;
    } = {};
    const finished = await setup(
      file,
      { GITHUB_PUBLIC_URL: "https://marfa.example/behind/a/prefix/" },
      (line) => {
        const opened = / open (\S+) in a browser/.exec(line)?.[1];
        if (opened === undefined) return;
        visited = (async () => {
          const html = await (await fetch(opened)).text();
          seenPage.action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
          seenPage.manifest = JSON.parse(
            decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
          ) as Record<string, unknown>;
          const state = new URL(seenPage.action).searchParams.get("state");
          const back = await fetch(
            `${String(seenPage.manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
            { redirect: "manual" },
          );
          seenPage.onward = back.headers.get("location") ?? undefined;
        })();
      },
    );
    await visited;
    expect(finished.code).toBe(0);
    expect(seenPage.action).toMatch(
      new RegExp(`^${github.url}/settings/apps/new\\?state=[0-9a-f-]{36}$`),
    );
    expect(seenPage.manifest).toMatchObject({
      name: "Marfa Connectors",
      url: "https://github.com/withmarfa/marfa-connectors",
      hook_attributes: { active: true },
      public: false,
      default_permissions: { issues: "write", metadata: "read" },
      default_events: [
        "issues",
        "issue_comment",
        "sub_issues",
        "issue_dependencies",
        "repository",
      ],
    });
    const hook = (seenPage.manifest?.["hook_attributes"] as { url: string })
      .url;
    expect(hook).toMatch(
      /^https:\/\/marfa\.example\/behind\/a\/prefix\/inbound\/in_/,
    );
    const written = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      string
    >;
    expect(written).toEqual({
      GITHUB_APP_ID: "424242",
      GITHUB_PRIVATE_KEY: github.appPem,
      GITHUB_WEBHOOK_SECRET: "stub-webhook-secret-from-github",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(finished.output).toContain(
      "install it on the repositories to sync at https://github.com/apps/marfa-sync-test/installations/new",
    );
    expect(seenPage.onward).toBe(
      "https://github.com/apps/marfa-sync-test/installations/new",
    );
    expect(finished.output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(finished.output).not.toContain("stub-webhook-secret-from-github");
    expect(
      github.asked
        .filter((one) => one.path.startsWith("/app-manifests/"))
        .map((one) => one.version),
    ).toEqual([apiVersion]);
  });

  it("asks only to read where the connector runs read only, and leaves the webhook off without a public address", async () => {
    const file = join(dir, "secrets.json");
    let manifest: Record<string, unknown> | undefined;
    let visited: Promise<void> | undefined;
    const finished = await setup(file, { GITHUB_READ_ONLY: "true" }, (line) => {
      const opened = / open (\S+) in a browser/.exec(line)?.[1];
      if (opened === undefined) return;
      visited = (async () => {
        const html = await (await fetch(opened)).text();
        manifest = JSON.parse(
          decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
        ) as Record<string, unknown>;
        const action = decoded(/action="([^"]+)"/.exec(html)?.[1] ?? "");
        const state = new URL(action).searchParams.get("state");
        await fetch(
          `${String(manifest["redirect_url"])}?code=manifest-code&state=${String(state)}`,
        );
      })();
    });
    await visited;
    expect(finished.code).toBe(0);
    expect(manifest).toMatchObject({
      hook_attributes: { active: false },
      default_permissions: { issues: "read", metadata: "read" },
    });
    expect(finished.output).toContain("its webhook is off");
  });

  it("uses no code GitHub sent back with another state, and keeps no file", async () => {
    const file = join(dir, "secrets.json");
    let visited: Promise<void> | undefined;
    const finished = await setup(file, {}, (line) => {
      const opened = / open (\S+) in a browser/.exec(line)?.[1];
      if (opened === undefined) return;
      visited = (async () => {
        const html = await (await fetch(opened)).text();
        const manifest = JSON.parse(
          decoded(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? ""),
        ) as Record<string, unknown>;
        await fetch(
          `${String(manifest["redirect_url"])}?code=manifest-code&state=forged`,
        );
      })();
    });
    await visited;
    expect(finished.code).toBe(1);
    expect(finished.output).toContain("carried another state");
    await expect(stat(file)).rejects.toThrow();
    expect(github.manifestCode).toBe("manifest-code");
  });

  it("points an App already in the environment at this instance, with a new secret", async () => {
    const file = join(dir, "secrets.json");
    const finished = await setup(
      file,
      {
        GITHUB_APP_ID: "424242",
        GITHUB_PRIVATE_KEY: github.appPem,
        GITHUB_PUBLIC_URL: "https://marfa.example",
      },
      () => undefined,
    );
    expect(finished.code).toBe(0);
    const written = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      string
    >;
    expect(Object.keys(written)).toEqual(["GITHUB_WEBHOOK_SECRET"]);
    expect(String(github.hook?.["url"])).toMatch(
      /^https:\/\/marfa\.example\/inbound\/in_/,
    );
    expect(github.hook?.["content_type"]).toBe("json");
    expect(github.hook?.["secret"]).toBe(written["GITHUB_WEBHOOK_SECRET"]);
    expect(finished.output).not.toContain(written["GITHUB_WEBHOOK_SECRET"]);
  });
});
