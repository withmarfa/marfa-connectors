import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Runs the connector's setup once and writes what it answers to a
 *  new, owner-only file, made first since a vendor may hand a secret once. */
export async function setUp<E extends EnvDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
  connectorId: string,
  environment: Environment,
  logger: Logger,
  signal: AbortSignal,
  file: string,
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
    listen: (page) => serve(page, servers, logger, signal),
    endpoint: async (options = {}) => {
      const made = await marfa.createEndpoint(connectorId, options);
      // Anyone holding the address can post to it.
      logger.keep([made.path]);
      return {
        path: made.path,
        url: `${environment.url.replace(/\/+$/, "")}${made.path}`,
      };
    },
  };
  const written = async (): Promise<number> => {
    let answered: Readonly<Record<string, string>>;
    try {
      answered = await setup(context);
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      logger.error(`setup failed, and ${file} was removed: ${describe(error)}`);
      return 1;
    }
    try {
      await handle.writeFile(`${JSON.stringify(answered, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    const names = Object.keys(answered);
    logger.info(
      `setup wrote ${names.join(", ")} to ${file}, which its owner alone may read: move them into the secret store, then delete the file`,
    );
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
    for (const served of servers) {
      served.release(succeeded);
      served.server.close();
    }
  }
}

function serve(
  page: string | ((callback: string) => string) | undefined,
  servers: Served[],
  logger: Logger,
  signal: AbortSignal,
): Promise<LocalCallback> {
  let arrived!: (query: URLSearchParams) => void;
  let stopped!: (reason: Error) => void;
  const redirected = new Promise<URLSearchParams>((resolve, reject) => {
    arrived = resolve;
    stopped = reject;
  });
  signal.addEventListener("abort", () => {
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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === `${base}/callback` && held === undefined) {
      held = response;
      arrived(url.searchParams);
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
      resolve({ url, callback: `${url}/callback`, redirected, onward });
    });
  });
}
