import { execFile } from "node:child_process";
import { createClient } from "@withmarfa/client";
import { request } from "node:http";
import type { Minted } from "./connector.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const monorepo = resolve(import.meta.dirname, "../../../vendor/marfa");

// Choices the boot script reads on purpose; one inherited from the shell
// would make two proofs share a port or an instance. MARFA_AUTH_SECRET and
// API_KEY_SALT are listed so a boot never takes a secret nobody chose for it.
const bootChoices = [
  "PORT",
  "MARFA_SERVER_KEEP",
  "MARFA_AUTH_SECRET",
  "API_KEY_SALT",
  "MARFA_CONNECTOR_HOLD_MS",
];

export interface Booted {
  url: string;
  key: string;
  managementKey: string;
  commit: string;
}

function parseEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^export ([A-Z_]+)='(.*)'$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      vars.set(match[1], match[2]);
    }
  }
  return vars;
}

export class ProofServer {
  constructor(private readonly connectorHoldMs?: number) {}
  private dir: string | undefined;
  private socketPath: string | undefined;
  private stopped: Promise<void> | undefined;

  async boot(): Promise<Booted> {
    const commit = (
      await run("git", ["-C", monorepo, "rev-parse", "HEAD"])
    ).stdout.trim();
    await run("pnpm", ["--filter", "@withmarfa/server...", "build"], {
      cwd: monorepo,
      maxBuffer: 64 * 1024 * 1024,
    });
    this.dir = await mkdtemp(join(tmpdir(), "marfa-connectors-proof-"));
    await run("bash", [join(monorepo, "core/scripts/server-up.sh")], {
      env: this.env(),
      maxBuffer: 64 * 1024 * 1024,
    });
    const vars = parseEnv(await readFile(this.envFile(), "utf8"));
    const url = vars.get("MARFA_TEST_URL");
    const key = vars.get("MARFA_TEST_KEY");
    this.socketPath = vars.get("MARFA_TEST_SOCKET");
    if (
      url === undefined ||
      key === undefined ||
      key === "" ||
      this.socketPath === undefined ||
      this.socketPath === ""
    ) {
      throw new Error(
        "the boot script wrote no server URL, working key or private socket",
      );
    }
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
    const client = createClient({ baseUrl: url, credential: key });
    const current = await client.GET("/keys/current");
    if (current.data === undefined)
      throw new Error("the working key was refused");
    const narrowed = await client.PATCH("/keys/{id}", {
      params: { path: { id: current.data.id } },
      body: {
        permissions: [
          "keys.mint",
          "items.purge",
          "webhooks.manage",
          "grants.manage",
          "audit.read",
          "config.manage",
          "schema.write",
        ],
      },
    });
    if (!narrowed.response.ok)
      throw new Error("the working key could not shed management permissions");
    return { url, key, managementKey: management.key, commit };
  }

  // Fixture provisioning uses the server's private machine-authority transport.
  // All connector and public proof requests still use the published SDK.
  async mintKey(body: Record<string, unknown>): Promise<Minted> {
    const minted = (await this.localKeyRequest(
      "POST",
      "/keys",
      body,
    )) as Minted;
    if (typeof minted.id !== "string" || typeof minted.key !== "string")
      throw new Error("local key provisioning returned no key");
    return minted;
  }

  async updateKey(id: string, body: Record<string, unknown>): Promise<void> {
    await this.localKeyRequest(
      "PATCH",
      `/keys/${encodeURIComponent(id)}`,
      body,
    );
  }

  private async localKeyRequest(
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
              if (res.statusCode !== (method === "POST" ? 201 : 200))
                throw new Error(
                  `local key provisioning returned ${String(res.statusCode)}`,
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
        req.destroy(new Error("local key provisioning timed out")),
      );
      req.end(JSON.stringify(body));
    });
  }

  /** Safe to call more than once, and after a boot that failed. */
  stop(): Promise<void> {
    this.stopped ??= this.down();
    return this.stopped;
  }

  private envFile(): string {
    if (this.dir === undefined) throw new Error("the server was never booted");
    return join(this.dir, "server.env");
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MARFA_SERVER_REPO: monorepo,
      MARFA_SERVER_ENV: this.envFile(),
      // The tracker waits on the enrichment sweep, every 30 s by default.
      MARFA_ENRICHMENT_INTERVAL_MS: "1000",
    };
    for (const name of bootChoices) Reflect.deleteProperty(env, name);
    if (this.connectorHoldMs !== undefined)
      env["MARFA_CONNECTOR_HOLD_MS"] = String(this.connectorHoldMs);
    return env;
  }

  private async down(): Promise<void> {
    if (this.dir === undefined) return;
    // The file names the server's process from the moment the boot starts
    // it, and server-down refuses a file that is not there, which is the
    // case when the boot never got that far or cleaned up after itself.
    if (existsSync(this.envFile())) {
      try {
        await run(
          "bash",
          [join(monorepo, "core/scripts/server-down.sh"), this.envFile()],
          { env: this.env() },
        );
      } catch (error) {
        console.error(`server-down: ${String(error)}`);
      }
    }
    await rm(this.dir, { recursive: true, force: true });
  }
}
