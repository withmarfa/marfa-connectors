import { randomUUID } from "node:crypto";
import { createClient } from "@withmarfa/client";
import type {
  Connector,
  EnvDeclaration,
  EnvValues,
  TypeDefinition,
} from "./define.js";
import {
  checkDefinition,
  ConfigurationError,
  readEnvironment,
} from "./environment.js";
import { cap, Logger } from "./log.js";
import { Marfa, Refusal, type Key } from "./marfa.js";
import { describe, runOnce, type RunSetup } from "./run.js";
import { nodeRuntime, type Runtime } from "./runtime.js";
import {
  backoff,
  describeDuration,
  readSchedule,
  type Schedule,
} from "./schedule.js";
import { typeDifferences } from "./type-check.js";

const heartbeatMs = 60_000;

/**
 * Worth another attempt: the server was unreachable, overloaded, failing or
 * too slow. `fetch failed` is the network's own refusal; any other
 * TypeError is a request the kit built wrong, which no retry mends.
 */
function transient(error: unknown): boolean {
  if (error instanceof Refusal) {
    return (
      error.status !== undefined &&
      (error.status >= 500 || error.status === 429)
    );
  }
  return (
    (error instanceof TypeError && error.message === "fetch failed") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

/** A fetch that gives up on a request the server has not answered in `ms`. */
function timedFetch(ms: number): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    // Handed to fetch as its own option: built into a copy of the request,
    // the timer's signal is collected before it fires.
    return fetch(request, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(ms)]),
    });
  };
}

/**
 * The wait before another attempt at a start that could not reach the
 * server: a minute or the interval, whichever is shorter, doubled on each
 * attempt, so a long interval does not delay the first run by as much.
 */
function startBackoff(intervalMs: number, attempts: number): number {
  return Math.min(intervalMs, 60_000) * Math.min(2 ** (attempts - 1), 8);
}

async function checkType(
  type: TypeDefinition,
  marfa: Marfa,
  served: Record<string, unknown>,
): Promise<string | undefined> {
  const parent = type.parent;
  const inherited =
    parent === undefined
      ? []
      : Object.keys((await marfa.type(parent))?.["fields"] ?? {});
  const differences = typeDifferences(type, served, inherited);
  if (differences.length === 0) return undefined;
  return `the type ${type.id} on the server differs from the one this connector carries, and is not rewritten: ${differences.join("; ")}`;
}

/**
 * What the key holds beyond read and write on the connector's own types and
 * their registration, each named: nothing, for a key minted as the
 * template's README says.
 */
function keyWiderThanTypes(key: Key, types: ReadonlySet<string>): string[] {
  const wider: string[] = [];
  if (key.is_operator) wider.push("it is the operator key");
  for (const permission of key.permissions ?? []) wider.push(permission);
  const held = (
    family: string,
    map: Record<string, string> | undefined,
    allowed: (name: string) => boolean,
  ): void => {
    for (const [name, level] of Object.entries(map ?? {})) {
      if (level === "none" || allowed(name)) continue;
      wider.push(`${family} ${name}=${level}`);
    }
  };
  held("type", key.type_permissions, (name) => types.has(name));
  held("metadata", key.metadata_permissions, (name) => name === "types");
  held("edge", key.edge_permissions, () => false);
  held("extension", key.extension_permissions, () => false);
  held("profile", key.profile_permissions, () => false);
  return wider;
}

/** Registers a type the server lacks, or checks the one it holds. */
async function ensureType(
  type: TypeDefinition,
  marfa: Marfa,
): Promise<string | undefined> {
  const served = await marfa.type(type.id);
  if (served !== undefined) return checkType(type, marfa, served);
  try {
    await marfa.registerType(type);
    return undefined;
  } catch (error) {
    if (transient(error)) throw error;
    // Another process holding the key registered it first, which is as good
    // as registering it, if it is the same type.
    if (error instanceof Refusal && error.status === 409) {
      const now = await marfa.type(type.id);
      if (now !== undefined) return checkType(type, marfa, now);
    }
    return `the type ${type.id} could not be registered: ${describe(error)}`;
  }
}

async function registerAndCheck<E extends EnvDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
): Promise<{ id: string; source: string; problem: string | undefined }> {
  const { id, source } = await marfa.register(
    connector.name,
    connector.description,
  );
  const key = await marfa.currentKey();
  if (key === undefined) {
    return {
      id,
      source,
      problem:
        "the server has no door for a key to read itself (GET /keys/current), so the key cannot be checked; the server is older than this kit",
    };
  }
  const types = connector.types.map((kind) => kind.type.id);
  const wider = keyWiderThanTypes(key, new Set(types));
  if (wider.length > 0) {
    return {
      id,
      source,
      problem: `the key ${key.id} holds more than read and write on ${types.join(", ")}, and is refused: ${wider.join(", ")}. Revoke it and mint another as the template's README says.`,
    };
  }
  for (const kind of connector.types) {
    const problem = await ensureType(kind.type, marfa);
    if (problem !== undefined) return { id, source, problem };
  }
  return { id, source, problem: undefined };
}

/**
 * Until the next scheduled run, looks for a waiting delivery every
 * `everyMs` and runs for it at once. A run for deliveries that fails, or
 * leaves what it took unmarked, leaves them waiting for the scheduled run
 * rather than being tried again at every look.
 */
async function awaitDeliveries<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  everyMs: number,
  next: number,
): Promise<void> {
  const { clock, signal, marfa, connectorId, logger } = setup;
  // Read through a call, since the signal can abort while a sleep waits.
  const stopped = (): boolean => signal.aborted;
  let unreachable = false;
  while (!stopped()) {
    const left = next - clock.now().getTime();
    if (left <= 0) return;
    await clock.sleep(Math.min(left, everyMs), signal);
    if (stopped() || clock.now().getTime() >= next) return;
    let waiting: boolean;
    try {
      waiting =
        (await marfa.pendingDeliveries(connectorId, 1, signal)).length > 0;
      if (unreachable) logger.info("waiting deliveries can be read again");
      unreachable = false;
    } catch (error) {
      if (stopped()) return;
      if (!unreachable) {
        logger.warn(`waiting deliveries could not be read: ${describe(error)}`);
      }
      unreachable = true;
      continue;
    }
    if (!waiting || stopped()) continue;
    const run = await runOnce(setup, "deliveries");
    if (!run.succeeded || !run.settled) {
      await clock.sleep(Math.max(0, next - clock.now().getTime()), signal);
      return;
    }
  }
}

/** Runs the connector as the arguments say, and answers the exit code. */
export async function start<E extends EnvDeclaration>(
  connector: Connector<E>,
  runtime: Runtime,
): Promise<number> {
  const { clock } = runtime;
  const write = (line: string): void => {
    runtime.write(line);
  };
  let schedule: Schedule;
  let environment;
  try {
    checkDefinition(connector);
    schedule = readSchedule(runtime.argv);
    environment = readEnvironment(connector, runtime.env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    new Logger(write, clock).error(error.message);
    return 2;
  }
  const logger = new Logger(write, clock, environment.secrets);
  try {
    await connector.checkEnv?.(environment.values as EnvValues<E>);
  } catch (error) {
    logger.error(`cannot start: ${describe(error)}`);
    return 2;
  }

  const stop = new AbortController();
  const stopped = (): boolean => stop.signal.aborted;
  runtime.onStop(() => {
    logger.info("asked to stop");
    stop.abort();
  });
  const marfa = new Marfa(
    createClient({
      baseUrl: environment.url,
      credential: environment.key,
      fetch: timedFetch(runtime.requestTimeoutMs),
    }),
  );
  const intervalMs = schedule.mode === "every" ? schedule.intervalMs : 0;

  let started:
    { id: string; source: string; problem: string | undefined } | undefined;
  for (let failures = 1; started === undefined; failures += 1) {
    try {
      started = await registerAndCheck(connector, marfa);
    } catch (error) {
      if (schedule.mode === "once" || !transient(error)) {
        logger.error(`could not start: ${describe(error)}`);
        return 1;
      }
      const wait = startBackoff(intervalMs, failures);
      logger.warn(
        `could not reach the server, trying again in ${describeDuration(wait)}: ${describe(error)}`,
      );
      await clock.sleep(wait, stop.signal);
      if (stopped()) return 0;
    }
  }
  const connectorId = started.id;
  logger.info(`registered as ${connectorId}`);

  if (started.problem !== undefined) {
    const at = clock.now().toISOString();
    logger.error(started.problem);
    try {
      await marfa.report(connectorId, {
        outcome: "failed",
        started_at: at,
        finished_at: at,
        error: cap(logger.redact(started.problem)),
      });
    } catch (error) {
      logger.warn(`the failure could not be reported: ${describe(error)}`);
    }
    return 1;
  }
  if (stopped()) return 0;

  const beating = new AbortController();
  const beat = AbortSignal.any([beating.signal, stop.signal]);
  const beatingEnded = (): boolean => beat.aborted;
  const heartbeat = (async () => {
    let failing = false;
    while (!beatingEnded()) {
      try {
        await marfa.heartbeat(connectorId, beat);
        if (failing) logger.info("the heartbeat is answered again");
        failing = false;
      } catch (error) {
        // A heartbeat cut short because beating ended is not a failure.
        if (!beatingEnded() && !failing) {
          logger.warn(`the heartbeat failed: ${describe(error)}`);
          failing = true;
        }
      }
      await clock.sleep(heartbeatMs, beat);
    }
  })();

  const setup: RunSetup<E> = {
    connector,
    environment,
    marfa,
    connectorId,
    process: randomUUID(),
    logger,
    clock,
    signal: stop.signal,
  };
  let code = 0;
  try {
    if (schedule.mode === "once") {
      const { succeeded } = await runOnce(setup, "schedule");
      code = succeeded || stopped() ? 0 : 1;
    } else {
      let failures = 0;
      while (!stopped()) {
        const run = await runOnce(setup, "schedule");
        failures = run.succeeded ? 0 : failures + 1;
        if (stopped()) break;
        const wait = backoff(schedule.intervalMs, failures);
        if (failures > 0) {
          logger.info(`the next run is in ${describeDuration(wait)}`);
        }
        const next = clock.now().getTime() + wait;
        if (connector.inbound === undefined || !run.settled) {
          await clock.sleep(wait, stop.signal);
          continue;
        }
        await awaitDeliveries(setup, schedule.deliveriesMs, next);
      }
    }
  } finally {
    beating.abort();
    await heartbeat;
  }
  return code;
}

export async function main<E extends EnvDeclaration>(
  connector: Connector<E>,
): Promise<void> {
  process.exitCode = await start(connector, nodeRuntime());
}
