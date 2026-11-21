import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createClient } from "@withmarfa/client";
import { request } from "node:http";
import type { Minted } from "./connector.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const root = resolve(import.meta.dirname, "../../..");

/** Where `scripts/monorepo.sh` leaves the pinned release's `marfa-server`. */
const release = join(root, "vendor/marfa-server");
/** Where `scripts/monorepo.sh hooks` leaves a `marfa-server` built from the
 *  pinned commit with test hooks, which a release is built without. */
const hooked = join(root, "vendor/marfa-server-hooks");

/** The throwaway owner of every proof instance, which is gone with it. */
const owner = {
  username: "proof-owner",
  password: "throwaway-proof-owner-password",
};

/** How often the proof looks at what enrichment writes while it waits for it
 *  to settle. */
export const enrichmentPollMs = 1000;

export interface Booted {
  url: string;
  key: string;
  managementKey: string;
  /** What the server program says it is, and whether it is the pinned one. */
  server: string;
}

/** A name is the proof's to choose, never the shell's: the server warns of a
 *  `MARFA_` name it does not know, and an inherited telemetry setting would
 *  make a throwaway instance report. */
function inherited(name: string): boolean {
  return (
    name.startsWith("MARFA_") ||
    name.startsWith("OTEL_") ||
    name === "API_KEY_SALT"
  );
}

async function descendants(pid: number): Promise<number[]> {
  let found: number[] = [];
  try {
    const { stdout } = await run("pgrep", ["-P", String(pid)]);
    for (const child of stdout.split("\n").filter((line) => line !== "")) {
      found = [...found, ...(await descendants(Number(child))), Number(child)];
    }
  } catch {
    // pgrep answers 1 when the process has no children.
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ProofServer {
  /** `connectorHoldMs` shortens the window a connector's hold lasts, which only
   *  a server built with test hooks allows; the released one refuses to start
   *  asked for it. */
  constructor(private readonly connectorHoldMs?: number) {}
  private dir: string | undefined;
  private controlDir: string | undefined;
  private socketPath: string | undefined;
  private child: ChildProcess | undefined;
  private output = "";
  private stopped: Promise<void> | undefined;

  async boot(): Promise<Booted> {
    const program = await this.program();
    const version = (await run(program, ["--version"])).stdout.trim();
    this.dir = await mkdtemp(join(tmpdir(), "plugins-proof-"));
    // A socket path has a short limit, and a temporary folder here can pass it.
    this.controlDir = await mkdtemp(
      join(await realpath("/tmp"), "marfa-proof-control-"),
    );
    this.socketPath = join(this.controlDir, "marfa.sock");
    const url = await this.start(program);
    await this.claim();
    const key = await this.mintKey({
      label: "connector proof",
      source: "core-proof",
      permissions: [
        "keys.mint",
        "items.purge",
        "webhooks.manage",
        "grants.manage",
        "audit.read",
        "config.manage",
        "schema.write",
      ],
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      profile_permissions: { "*": "read" },
    });
    const management = await this.mintKey({
      label: "connector proof reports",
      source: "proof-reports",
      permissions: ["connectors.manage", "keys.manage"],
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
    });
    const client = createClient({ baseUrl: url, credential: key.key });
    const current = await client.GET("/keys/current");
    if (current.data === undefined)
      throw new Error("the working key was refused");
    return {
      url,
      key: key.key,
      managementKey: management.key,
      server: version,
    };
  }

  /** The `marfa-server` to boot: the one `MARFA_SERVER_BIN` names, or the
   *  pinned release's, which `scripts/monorepo.sh` fetched. A server that
   *  shortens the connector hold needs test hooks, so it is the one
   *  `MARFA_HOOKS_SERVER_BIN` names, or the build `scripts/monorepo.sh hooks`
   *  made. */
  private async program(): Promise<string> {
    const hooks = this.connectorHoldMs !== undefined;
    const named =
      process.env[hooks ? "MARFA_HOOKS_SERVER_BIN" : "MARFA_SERVER_BIN"];
    const fetched = hooks ? hooked : release;
    if (named !== undefined && named !== "") return resolve(named);
    const pin = (
      await readFile(resolve(root, "scripts/monorepo.commit"), "utf8")
    ).trim();
    const held = await readFile(join(fetched, "commit"), "utf8").catch(
      () => undefined,
    );
    if (held?.trim() !== pin) {
      throw new Error(
        `${relative(root, fetched)} holds ${held?.trim() ?? "no server"}, the pin is ${pin}; run scripts/monorepo.sh${hooks ? " hooks" : ""}`,
      );
    }
    return join(fetched, "marfa-server");
  }

  private async start(program: string): Promise<string> {
    if (this.dir === undefined || this.socketPath === undefined)
      throw new Error("the server has no folder");
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!inherited(name)) env[name] = value;
    }
    env["OTEL_SDK_DISABLED"] = "true";
    env["MARFA_DATABASE_PATH"] = join(this.dir, "marfa.db");
    env["MARFA_BLOB_PATH"] = join(this.dir, "blobs");
    env["MARFA_PORT"] = "0";
    env["MARFA_LISTEN_HOST"] = "127.0.0.1";
    env["MARFA_CONTROL_SOCKET"] = this.socketPath;
    if (this.connectorHoldMs !== undefined) {
      env["MARFA_TEST_HOOKS"] = "true";
      env["MARFA_TEST_TUNING"] =
        `connector_hold_ms=${String(this.connectorHoldMs)}`;
    }
    const child = spawn(program, [], {
      cwd: this.dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const exited = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `the server exited (${String(code ?? signal)}) before answering /health:\n${this.log()}`,
          ),
        );
      });
    });
    exited.catch(() => undefined);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        this.output += chunk;
      });
    }
    const listening = (async (): Promise<string> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && child.exitCode === null) {
        const port = /Marfa server listening on port (\d+)/.exec(
          this.output,
        )?.[1];
        if (port !== undefined) return `http://127.0.0.1:${port}`;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error(`the server never said it was listening:\n${this.log()}`);
    })();
    const url = await Promise.race([listening, exited]);
    const health = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok)
      throw new Error(`/health answered ${String(health.status)}`);
    return url;
  }

  /** The server's own words, with any setup proof left out. */
  private log(): string {
    return this.output.replace(
      /(setup|recovery) code: [A-Z2-7-]+/g,
      "$1 code: [redacted]",
    );
  }

  private async claim(): Promise<void> {
    const claimed = await this.overSocket(
      "POST",
      "/_control/setup/claim",
      owner,
    );
    if (typeof (claimed as { username?: unknown }).username !== "string")
      throw new Error("the owner claim returned no owner");
  }

  // Fixture provisioning uses the server's private control socket. All
  // connector and public proof requests still use the published SDK.
  async mintKey(body: Record<string, unknown>): Promise<Minted> {
    const minted = (await this.overSocket("POST", "/keys", body)) as Minted;
    if (typeof minted.id !== "string" || typeof minted.key !== "string")
      throw new Error("local key provisioning returned no key");
    return minted;
  }

  async updateKey(id: string, body: Record<string, unknown>): Promise<void> {
    await this.overSocket("PATCH", `/keys/${encodeURIComponent(id)}`, body);
  }

  private async overSocket(
    method: "POST" | "PATCH",
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.socketPath === undefined)
      throw new Error("the server was never booted");
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (
                res.statusCode === undefined ||
                res.statusCode < 200 ||
                res.statusCode >= 300
              )
                throw new Error(
                  `${method} ${path} on the private socket returned ${String(res.statusCode)}`,
                );
              resolve(JSON.parse(text) as unknown);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(15_000, () =>
        req.destroy(new Error("the private socket timed out")),
      );
      req.end(JSON.stringify(body));
    });
  }

  /** Safe to call more than once, and after a boot that failed. */
  stop(): Promise<void> {
    this.stopped ??= this.down();
    return this.stopped;
  }

  /** Ends the server this proof started, by its process ID and its children's,
   *  and removes its folders. */
  private async down(): Promise<void> {
    const pid = this.child?.pid;
    if (pid !== undefined && alive(pid)) {
      // The children are found first, since an orphan can no longer be.
      const family = [...(await descendants(pid)), pid];
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const one of family) {
          try {
            process.kill(one, signal);
          } catch {
            // Already gone.
          }
        }
        const deadline = Date.now() + 10_000;
        while (alive(pid) && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 100));
        if (!alive(pid)) break;
      }
    }
    for (const dir of [this.dir, this.controlDir]) {
      if (dir !== undefined && existsSync(dir))
        await rm(dir, { recursive: true, force: true });
    }
  }
}
