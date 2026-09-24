import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The checkout scripts/monorepo.sh made, at the pinned commit. */
export const monorepo = resolve(import.meta.dirname, "../../../vendor/marfa");

export interface Server {
  url: string;
  /** The working key the boot script mints, which holds every permission. */
  key: string;
  commit: string;
  stop(): Promise<void>;
}

/** Reads the `export NAME='value'` lines the boot script prints. */
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

/**
 * Boots the monorepo server on SQLite with its own boot script. The stop
 * function is armed before the boot starts, because a boot that fails
 * partway has already started a process only the env file names.
 */
export async function bootServer(): Promise<Server> {
  const commit = (
    await run("git", ["-C", monorepo, "rev-parse", "HEAD"])
  ).stdout.trim();
  await run("pnpm", ["--filter", "@withmarfa/server...", "build"], {
    cwd: monorepo,
    maxBuffer: 64 * 1024 * 1024,
  });

  const dir = await mkdtemp(join(tmpdir(), "marfa-connectors-proof-"));
  const envFile = join(dir, "server.env");
  const env = {
    ...process.env,
    MARFA_SERVER_REPO: monorepo,
    MARFA_SERVER_ENV: envFile,
  };
  const stop = async (): Promise<void> => {
    try {
      await run(
        "bash",
        [join(monorepo, "core/scripts/server-down.sh"), envFile],
        { env },
      );
    } catch (error) {
      console.error(`server-down: ${String(error)}`);
    }
    await rm(dir, { recursive: true, force: true });
  };

  try {
    await run("bash", [join(monorepo, "core/scripts/server-up.sh")], {
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const vars = parseEnv(await readFile(envFile, "utf8"));
    const url = vars.get("MARFA_TEST_URL");
    const key = vars.get("MARFA_TEST_KEY");
    if (url === undefined || key === undefined || key === "") {
      throw new Error("the boot script wrote no server URL or key");
    }
    return { url, key, commit, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
