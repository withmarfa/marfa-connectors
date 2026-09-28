import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createClient } from "@withmarfa/client";
import type {
  ConnectionDefinition,
  Connector,
  EnvDeclaration,
  EnvValues,
  TypeDefinition,
} from "./define.js";
import {
  checkDefinition,
  ConfigurationError,
  readEnvironment,
  type Environment,
} from "./environment.js";
import { cap, Logger } from "./log.js";
import { Marfa, Refusal, type Key } from "./marfa.js";
import { Hold } from "./hold.js";
import {
  describe,
  runOnce,
  specsOf,
  waitingInMarfa,
  type RunResult,
  type RunSetup,
  type Trigger,
} from "./run.js";
import { nodeRuntime, type Runtime } from "./runtime.js";
import { setUp } from "./setup.js";
import {
  backoff,
  describeDuration,
  readSchedule,
  type Schedule,
} from "./schedule.js";
import { edgeTypeDifferences, typeDifferences } from "./type-check.js";

const heartbeatMs = 60_000;

/** How long a heartbeat may take before it counts as failed. */
const beatTimeoutMs = 15_000;

/**
 * Worth another attempt: the server was unreachable, overloaded, failing or
 * too slow; any TypeError besides `fetch failed` is a bug no retry mends.
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
 * The wait before another start attempt: a minute or the interval, whichever
 * is shorter, doubled each attempt, so a long interval doesn't delay the first run.
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
 * What the key holds beyond read/write on the connector's own types,
 * connections and their registration: nothing, for a key minted per the README.
 */
function keyWiderThanTypes(
  key: Key,
  types: ReadonlySet<string>,
  connections: ReadonlySet<string>,
): string[] {
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
  held(
    "metadata",
    key.metadata_permissions,
    (name) =>
      name === "types" || (name === "edge_types" && connections.size > 0),
  );
  held("edge", key.edge_permissions, (name) => connections.has(name));
  held("extension", key.extension_permissions, () => false);
  held("profile", key.profile_permissions, () => false);
  // An exemption from the instance's own rules is never a connector's.
  for (const lever of Object.keys(key.enforcement_override ?? {})) {
    wider.push(`an enforcement override of ${lever}`);
  }
  return wider;
}

/** The connector's types and connections the key may not write, each named. */
function keyNarrowerThanTypes(
  key: Key,
  types: ReadonlySet<string>,
  connections: ReadonlySet<string>,
): string[] {
  return [
    ...[...types]
      .filter((name) => key.type_permissions[name] !== "write")
      .map((name) => `type ${name}`),
    ...[...connections]
      .filter((name) => key.edge_permissions?.[name] !== "write")
      .map((name) => `edge ${name}`),
  ];
}

/**
 * Shipped connection types a connector may write between its own rows,
 * narrowed itself and never registered, e.g. a file attaching to its item.
 */
const shippedConnections = new Set(["attached-to"]);

/** Registers each connection the server lacks, or checks the one it holds. */
async function ensureConnections(
  connections: readonly ConnectionDefinition[],
  marfa: Marfa,
): Promise<string | undefined> {
  if (connections.length === 0) return undefined;
  let served = await marfa.edgeTypes();
  for (const connection of connections) {
    let held = served.find((type) => type.id === connection.id);
    if (shippedConnections.has(connection.id)) {
      const differences =
        held === undefined
          ? ["the instance does not hold it"]
          : edgeTypeDifferences(
              {
                ...connection,
                source_type_constraints: held.source_type_constraints,
                target_type_constraints: held.target_type_constraints,
                ...(held.reverse_name !== undefined && {
                  reverse_name: held.reverse_name,
                }),
                written_at: held.written_at,
              },
              held,
            );
      if (differences.length > 0) {
        return `the connection type ${connection.id} differs from the instance's own: ${differences.join("; ")}`;
      }
      continue;
    }
    if (held === undefined) {
      try {
        await marfa.registerEdgeType(connection);
        continue;
      } catch (error) {
        if (transient(error)) throw error;
        // Another process under the key registered it first.
        if (!(error instanceof Refusal) || error.status !== 409) {
          return `the connection type ${connection.id} could not be registered: ${describe(error)}`;
        }
        served = await marfa.edgeTypes();
        held = served.find((type) => type.id === connection.id);
        if (held === undefined) {
          return `the connection type ${connection.id} could not be registered: ${describe(error)}`;
        }
      }
    }
    const differences = edgeTypeDifferences(connection, held);
    if (differences.length > 0) {
      return `the connection type ${connection.id} on the server differs from the one this connector carries, and is not rewritten: ${differences.join("; ")}`;
    }
  }
  return undefined;
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
  const connections = (connector.connections ?? []).map((kind) => kind.id);
  const named = [...types, ...connections].join(", ");
  const wider = keyWiderThanTypes(key, new Set(types), new Set(connections));
  if (wider.length > 0) {
    return {
      id,
      source,
      problem: `the key ${key.id} holds more than read and write on ${named}, and is refused: ${wider.join(", ")}. Revoke it and mint another as the template's README says.`,
    };
  }
  const narrower = keyNarrowerThanTypes(
    key,
    new Set(types),
    new Set(connections),
  );
  if (narrower.length > 0) {
    return {
      id,
      source,
      problem: `the key ${key.id} may not write ${narrower.join(", ")}, which the connector writes, and is refused. Revoke it and mint another as the template's README says.`,
    };
  }
  for (const kind of connector.types) {
    const problem = await ensureType(kind.type, marfa);
    if (problem !== undefined) return { id, source, problem };
  }
  const problem = await ensureConnections(connector.connections ?? [], marfa);
  return { id, source, problem };
}

/** Whether the connector carries any of its types back. */
function carriesBack<E extends EnvDeclaration>(
  connector: Connector<E>,
  environment: Environment,
): boolean {
  return [
    ...specsOf(connector, environment.values as EnvValues<E>).values(),
  ].some((spec) => spec.twoWay);
}

/** Whether the connector looks between runs: for deliveries, or for changes to carry back. */
function looks<E extends EnvDeclaration>(
  connector: Connector<E>,
  environment: Environment,
): boolean {
  return connector.inbound !== undefined || carriesBack(connector, environment);
}

/**
 * Until the next scheduled run, looks every `everyMs` for a waiting delivery
 * or Marfa change to carry; on failure it waits for that run rather than retrying every look.
 */
async function awaitChanges<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  held: (trigger: Trigger) => Promise<RunResult | undefined>,
  everyMs: number,
  next: number,
  cursor: string | undefined,
): Promise<void> {
  const { clock, signal, marfa, connectorId, logger, connector } = setup;
  // Read through a call, since the signal can abort while a sleep waits.
  const stopped = (): boolean => signal.aborted;
  let unreachable = false;
  let peeked = cursor;
  while (!stopped()) {
    const left = next - clock.now().getTime();
    if (left <= 0) return;
    await clock.sleep(Math.min(left, everyMs), signal);
    if (stopped() || clock.now().getTime() >= next) return;
    let waiting = false;
    try {
      if (connector.inbound !== undefined) {
        waiting =
          (await marfa.pendingDeliveries(connectorId, 1, signal)).length > 0;
      }
      if (!waiting && carriesBack(connector, setup.environment)) {
        const log = await waitingInMarfa(setup, peeked);
        waiting = log.waiting;
        if (!waiting) peeked = log.cursor;
      }
      if (unreachable) logger.info("the look between runs is answered again");
      unreachable = false;
    } catch (error) {
      if (stopped()) return;
      if (!unreachable) {
        logger.warn(`the look between runs failed: ${describe(error)}`);
      }
      unreachable = true;
      continue;
    }
    if (!waiting || stopped()) continue;
    const run = await held("look");
    if (run === undefined || !run.succeeded || !run.settled) {
      await clock.sleep(Math.max(0, next - clock.now().getTime()), signal);
      return;
    }
    peeked = run.cursor;
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
    if (schedule.mode === "setup") {
      if (connector.setup === undefined) {
        throw new ConfigurationError(
          "--setup is for a connector with a setup, which this one has not",
        );
      }
      if (existsSync(schedule.file)) {
        throw new ConfigurationError(
          `${schedule.file} exists already, and setup writes its secrets only to a new file`,
        );
      }
    }
    environment = readEnvironment(
      connector,
      runtime.env,
      schedule.mode === "setup",
    );
    if (
      schedule.mode === "every" &&
      schedule.lookGiven &&
      !looks(connector, environment)
    ) {
      throw new ConfigurationError(
        "--look-every is for a connector that receives webhooks or carries changes back, which this one does not",
      );
    }
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    new Logger(write, clock).error(error.message);
    return 2;
  }
  const logger = new Logger(write, clock, environment.secrets);
  try {
    if (schedule.mode !== "setup") {
      await connector.checkEnv?.(environment.values as EnvValues<E>);
    }
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
  if (schedule.mode === "setup") {
    return setUp(
      connector,
      marfa,
      connectorId,
      environment,
      logger,
      stop.signal,
      schedule.file,
    );
  }

  const hold = new Hold(marfa, connectorId, randomUUID(), logger, clock);
  const beating = new AbortController();
  const beat = AbortSignal.any([beating.signal, stop.signal]);
  const beatingEnded = (): boolean => beat.aborted;
  const heartbeat = (async () => {
    let failing = false;
    while (!beatingEnded()) {
      // Side by side, and neither waiting long, so a slow heartbeat never
      // leaves the hold unrenewed.
      const beating = async (): Promise<void> => {
        try {
          await marfa.heartbeat(
            connectorId,
            AbortSignal.any([beat, AbortSignal.timeout(beatTimeoutMs)]),
          );
          if (failing) logger.info("the heartbeat is answered again");
          failing = false;
        } catch (error) {
          // A heartbeat cut short because beating ended is not a failure.
          if (!beatingEnded() && !failing) {
            logger.warn(`the heartbeat failed: ${describe(error)}`);
            failing = true;
          }
        }
      };
      await Promise.all([beating(), hold.renew()]);
      await clock.sleep(heartbeatMs, beat);
    }
  })();

  const setup: RunSetup<E> = {
    connector,
    environment,
    marfa,
    connectorId,
    process: hold.process,
    logger,
    clock,
    signal: stop.signal,
  };
  /** A run under the hold; none where another process holds the connector. */
  const held = async (trigger: Trigger): Promise<RunResult | undefined> => {
    let taken;
    try {
      taken = await hold.take();
    } catch (error) {
      if (stopped()) return undefined;
      logger.error(`the hold could not be taken: ${describe(error)}`);
      return { succeeded: false, settled: false, cursor: undefined };
    }
    if (!taken.held) {
      logger.warn(
        `another process holds this connector until ${taken.until}, so this one does not run`,
      );
      return undefined;
    }
    return runOnce(
      {
        ...setup,
        signal: AbortSignal.any([stop.signal, hold.signal]),
        fenced: () => hold.check(),
      },
      trigger,
    );
  };
  let code = 0;
  try {
    if (schedule.mode === "once") {
      const run = await held("schedule");
      code = run === undefined || run.succeeded || stopped() ? 0 : 1;
    } else {
      let failures = 0;
      while (!stopped()) {
        const run = await held("schedule");
        if (run === undefined) {
          await clock.sleep(schedule.intervalMs, stop.signal);
          continue;
        }
        failures = run.succeeded ? 0 : failures + 1;
        if (stopped()) break;
        const wait = backoff(schedule.intervalMs, failures);
        if (failures > 0) {
          logger.info(`the next run is in ${describeDuration(wait)}`);
        }
        const next = clock.now().getTime() + wait;
        if (!looks(connector, environment) || !run.settled) {
          await clock.sleep(wait, stop.signal);
          continue;
        }
        await awaitChanges(setup, held, schedule.lookMs, next, run.cursor);
      }
    }
  } finally {
    beating.abort();
    await heartbeat;
    await hold.release();
  }
  return code;
}

export async function main<E extends EnvDeclaration>(
  connector: Connector<E>,
): Promise<void> {
  process.exitCode = await start(connector, nodeRuntime());
}
