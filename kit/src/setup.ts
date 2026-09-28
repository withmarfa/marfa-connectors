import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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

/**
 * Runs the connector's setup once and writes the secrets it answers to a
 * new file its owner alone may read, made before setup runs, since a
 * vendor may hand a secret over only once. Answers the exit code.
 */
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
  // The start refuses --setup for a connector without one.
  if (setup === undefined) throw new Error("the connector has no setup");
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    logger.error(`${file} could not be made: ${describe(error)}`);
    return 1;
  }
  const servers: Server[] = [];
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
  let answered: Readonly<Record<string, string>>;
  try {
    answered = await setup(context);
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    logger.error(`setup failed, and ${file} was removed: ${describe(error)}`);
    return 1;
  } finally {
    for (const server of servers) server.close();
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
}

/** Serves the page on a local address until the vendor's redirect arrives there. */
function serve(
  page: string | undefined,
  servers: Server[],
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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const callback = url.pathname === `${base}/callback`;
    const html = callback ? done : url.pathname === base ? page : undefined;
    if (html === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(html);
    if (callback) arrived(url.searchParams);
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The address the server bound, never `localhost`, which a browser may
    // reach over IPv6 instead.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${String(port)}${base}`;
      logger.info(`open ${url} in a browser`);
      resolve({ url, callback: `${url}/callback`, redirected });
    });
  });
}
