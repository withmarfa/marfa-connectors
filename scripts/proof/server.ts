import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The checkout scripts/monorepo.sh made, at the pinned commit. */
export const monorepo = resolve(import.meta.dirname, "../../../vendor/marfa");

/**
 * Read by the boot script as choices a caller makes on purpose: a port, an
 * instance to reuse, the auth secret and the key salt. One inherited from
 * the shell would have two proofs on one machine share a port or an
 * instance, or boot this one with a secret nobody chose for it.
 */
const bootChoices = [
  "PORT",
  "MARFA_SERVER_KEEP",
  "MARFA_AUTH_SECRET",
  "API_KEY_SALT",
];

export interface Booted {
  url: string;
  /** The working key the boot script mints, which holds every permission. */
  key: string;
  commit: string;
}

/** Reads the `export NAME='value'` lines the boot script writes. */
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

/** The monorepo server on SQLite, booted and stopped by its own scripts. */
export class ProofServer {
  private dir: string | undefined;
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
    if (url === undefined || key === undefined || key === "") {
      throw new Error("the boot script wrote no server URL or key");
    }
    return { url, key, commit };
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
    };
    for (const name of bootChoices) Reflect.deleteProperty(env, name);
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
