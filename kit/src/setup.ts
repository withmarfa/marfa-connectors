import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import type {
  Connector,
  EnvDeclaration,
  LocalCallback,
  SetupContext,
} from "./define.js";
import type { Environment } from "./environment.js";
import { keepSecret, type Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { describe } from "./run.js";

const done =
  "<!doctype html><title>Done</title><p>Done: go back to the terminal.</p>";
const failed =
  "<!doctype html><title>Failed</title><p>Setup failed: the terminal says why.</p>";

interface Served {
  readonly server: Server;
  release(succeeded: boolean): void;
}

const notTheAddress =
  "what was pasted is not the address the browser ended on after the vendor sent it back: paste the whole address from the browser's address bar, or finish in a browser on this machine";

const ignore = (): void => undefined;

/**
 * Reads the lines a person pastes into the terminal while setup waits for a
 * redirect, and hands each address to whoever waits for one like it. It
 * reads nothing until something waits, and nothing once nothing does, so
 * standard input never holds the process after setup ends.
 */
class Pasted {
  private readonly waiting = new Set<(address: URL) => boolean>();
  private lines: Interface | undefined;

  constructor(
    private readonly input: () => Readable | undefined,
    private readonly logger: Logger,
  ) {}

  /** Whether a person could paste at all: a closed input cannot. */
  get possible(): boolean {
    return this.input()?.readable === true;
  }

  /** Offers each pasted address to `accept`, which answers whether it took
   *  it. The answer stops the waiting. */
  wait(accept: (address: URL) => boolean): () => void {
    this.waiting.add(accept);
    this.read();
    return () => {
      this.waiting.delete(accept);
      if (this.waiting.size === 0) this.close();
    };
  }

  close(): void {
    this.waiting.clear();
    const lines = this.lines;
    this.lines = undefined;
    lines?.close();
  }

  private read(): void {
    const input = this.input();
    if (this.lines !== undefined || input?.readable !== true) return;
    const lines = createInterface({
      input,
      terminal: false,
      crlfDelay: Infinity,
    });
    // A terminal that goes away is no reason to stop waiting for the browser;
    // the interface passes on its input's error.
    lines.on("error", ignore);
    lines.on("line", (line) => {
      this.take(line);
    });
    lines.on("close", () => {
      if (this.lines === lines) this.lines = undefined;
    });
    this.lines = lines;
  }

  private take(line: string): void {
    const text = line.trim();
    if (text === "") return;
    const address = URL.parse(text);
    if (
      (address?.protocol === "http:" || address?.protocol === "https:") &&
      [...this.waiting].some((accept) => accept(address))
    ) {
      return;
    }
    this.logger.warn(notTheAddress);
  }
}

/** The root of the git working tree holding `file`, a checkout's `.git`
 *  being a directory and a worktree's a file. */
export function workingTreeOf(file: string): string | undefined {
  let dir = resolve(dirname(file));
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = realpathSync(dir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The file is new and owner-only, made first since a vendor may hand a
 *  secret once. */
export async function setUp<E extends EnvDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
  connectorId: string,
  environment: Environment,
  logger: Logger,
  signal: AbortSignal,
  file: string,
  at: string,
  stdin: () => Readable | undefined,
): Promise<number> {
  const setup = connector.setup;
  if (setup === undefined) throw new Error("the connector has no setup");
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    logger.error(`${file} could not be made: ${describe(error)}`);
    return 1;
  }
  const servers: Served[] = [];
  const pasted = new Pasted(stdin, logger);
  const made: { id: string; label: string }[] = [];
  const context: SetupContext<E> = {
    env: environment.values,
    signal,
    log: {
      info: (message) => {
        logger.info(message);
      },
      warn: (message) => {
        logger.warn(message);
      },
    },
    secret: (value) => {
      keepSecret(logger, value);
    },
    listen: (page) => serve(page, servers, logger, signal, pasted),
    endpoint: async (options = {}) => {
      // The listing shows an address by its last four characters, so the
      // label is what tells this setup's endpoint from an earlier one's.
      const suffix = `, set up ${at}`;
      const label = `${(options.label ?? connector.name).slice(0, 200 - suffix.length)}${suffix}`;
      const endpoint = await marfa.createEndpoint(connectorId, {
        ...options,
        label,
      });
      made.push({ id: endpoint.id, label });
      // Anyone holding the address can post to it.
      logger.keep([endpoint.path]);
      return {
        path: endpoint.path,
        url: `${environment.url.replace(/\/+$/, "")}${endpoint.path}`,
      };
    },
  };
  const written = async (): Promise<number> => {
    let answered: Readonly<Record<string, string>>;
    try {
      answered = await setup(context);
      await handle.writeFile(`${JSON.stringify(answered, null, 2)}\n`);
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      logger.error(`setup failed, and ${file} was removed: ${describe(error)}`);
      // An address handed to a vendor whose secrets are gone only takes
      // deliveries no one can verify, and holds one of the ten places.
      await retire(marfa, connectorId, made, logger);
      return 1;
    }
    await handle.close();
    const names = Object.keys(answered);
    logger.info(
      `setup wrote ${names.join(", ")} to ${file}, which its owner alone may read: move them into the secret store, then delete the file`,
    );
    for (const endpoint of made) {
      logger.info(
        `setup made the inbound endpoint ${endpoint.id} (${endpoint.label}); once the vendor posts to it, retire any endpoint it replaces with \`marfa connectors endpoints retire ${connectorId} <endpoint-id>\``,
      );
    }
    const declared = Object.keys(connector.env ?? {});
    const unknown = names.filter((name) => !declared.includes(name));
    if (unknown.length > 0) {
      logger.error(
        `setup answered ${unknown.join(", ")}, which the connector does not declare`,
      );
      return 1;
    }
    return 0;
  };
  let succeeded = false;
  try {
    const code = await written();
    succeeded = code === 0;
    return code;
  } finally {
    pasted.close();
    for (const served of servers) {
      served.release(succeeded);
      served.server.close();
    }
  }
}

async function retire(
  marfa: Marfa,
  connectorId: string,
  made: readonly { id: string }[],
  logger: Logger,
): Promise<void> {
  for (const { id } of made) {
    try {
      await marfa.retireEndpoint(connectorId, id);
      logger.info(`the inbound endpoint ${id} it made was retired`);
    } catch (error) {
      logger.error(
        `the inbound endpoint ${id} it made could not be retired, and still takes deliveries: retire it with \`marfa connectors endpoints retire ${connectorId} ${id}\`: ${describe(error)}`,
      );
    }
  }
}

function serve(
  page: string | ((callback: string) => string) | undefined,
  servers: Served[],
  logger: Logger,
  signal: AbortSignal,
  pasted: Pasted,
): Promise<LocalCallback> {
  let arrived!: (query: URLSearchParams) => void;
  let stopped!: (reason: Error) => void;
  const redirected = new Promise<URLSearchParams>((resolve, reject) => {
    arrived = resolve;
    stopped = reject;
  });
  // The first of the browser and a pasted address wins; the other is ignored.
  let came: "browser" | "paste" | undefined;
  let stopWaiting: (() => void) | undefined;
  signal.addEventListener("abort", () => {
    stopWaiting?.();
    stopped(new Error("stopped before the vendor redirected back"));
  });
  // A setup that never waits for the redirect leaves nothing unhandled.
  redirected.catch(() => undefined);
  // Unguessable, so no other local process or page can answer for the vendor.
  const base = `/${randomUUID()}`;
  let shown: string | undefined;
  let held: ServerResponse | undefined;
  const answer = (response: ServerResponse, html: string): void => {
    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(html);
  };
  const arrive = (by: "browser" | "paste", query: URLSearchParams): boolean => {
    if (came !== undefined) return false;
    came = by;
    stopWaiting?.();
    arrived(query);
    return true;
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === `${base}/callback` && came === undefined) {
      held = response;
      arrive("browser", url.searchParams);
      return;
    }
    if (url.pathname !== base || shown === undefined) {
      response.writeHead(404).end();
      return;
    }
    answer(response, shown);
  });
  const release = (html: string): void => {
    if (held !== undefined && !held.writableEnded) answer(held, html);
  };
  servers.push({
    server,
    release: (succeeded) => {
      release(succeeded ? done : failed);
    },
  });
  const onward = (address: string): void => {
    const target = URL.parse(address);
    if (target?.protocol !== "https:" && target?.protocol !== "http:") {
      throw new Error("onward sends the browser only to a web address");
    }
    if (came === "paste") {
      logger.info(`open ${target.toString()} in a browser to go on`);
      return;
    }
    if (held === undefined) {
      throw new Error(
        "onward sends on the browser the vendor sent back, which has not arrived",
      );
    }
    if (held.writableEnded) return;
    held.writeHead(303, { Location: target.toString() }).end();
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The address the server bound, never `localhost`, which a browser may
    // reach over IPv6 instead.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${String(port)}${base}`;
      try {
        shown = typeof page === "function" ? page(`${url}/callback`) : page;
      } catch (error) {
        server.close();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      logger.info(`open ${url} in a browser`);
      if (pasted.possible) {
        logger.info(
          "from a browser on another machine, paste the address it ended on into this terminal and press Enter",
        );
        stopWaiting = pasted.wait(
          (address) =>
            address.pathname === `${base}/callback` &&
            arrive("paste", address.searchParams),
        );
      }
      resolve({ url, callback: `${url}/callback`, redirected, onward });
    });
  });
}
