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
import {
  causeOf,
  hostNotFound,
  Marfa,
  marfaFetch,
  Refusal,
  retryAfterOf,
  type Cause,
  type Key,
} from "./marfa.js";
import { Hold, type Ended } from "./hold.js";
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
import { setUp, workingTreeOf } from "./setup.js";
import {
  backoff,
  describeDuration,
  readSchedule,
  usage,
  type Schedule,
} from "./schedule.js";
import { edgeTypeDifferences, typeDifferences } from "./type-check.js";

const heartbeatMs = 60_000;

const beatTimeoutMs = 15_000;

/** A round of heartbeat and renewal never starts closer to the last than
 *  this, however long that one ran. */
const minimumBeatGapMs = 1000;

/** A registration lost again within this long of being made again is not
 *  made a third time. */
const reregisterAfterMs = 300_000;

/** The longest a `Retry-After` holds the start back. */
const longestRetryAfterMs = 300_000;

/** How far an ask of Marfa after an outage is spread, as a share of its
 *  wait, and how long the first run after an answer is spread over. */
const probeJitter = 0.2;
const afterAnswerMs = 5000;

/** How often a connector asks whether Marfa answers again after a run it
 *  could not finish for want of an answer. */
const probeMs = 15_000;

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

/** Shipped connection types a connector may write between its own rows,
 *  narrowed itself and never registered: a file attaching to its item, a
 *  message in its thread. */
const shippedConnections = new Set(["attached-to", "in-thread"]);

/** The connector's rows carry its source, so a key writes under it as its
 *  own or as a claim, a second account's key the latter; any other claim
 *  reaches rows that are not the connector's, and an app's key is the
 *  app's. */
function keySourceProblem(key: Key, source: string): string | undefined {
  if (key.oauth_client_id !== undefined) {
    return `the key ${key.id} is refused: an app made it, and it stays that app's. Mint the connector a key of its own as the template's README says.`;
  }
  const own = key.source === source;
  const others = key.sources.filter((claim) => claim !== source);
  if (!own && !key.sources.includes(source)) {
    return `the key ${key.id} writes under its own source ${key.source} and does not claim the connector's, ${source}, so every row it wrote would be refused: claim it with \`marfa keys update ${key.id} --claim ${source}\` from the operator key, or mint a key as the template's README says.`;
  }
  if (others.length > 0) {
    return `the key ${key.id} claims sources besides the connector's, ${source}, and is refused: ${others.join(", ")}. Narrow it with \`marfa keys update ${key.id} ${own ? "--no-claims" : `--claim ${source}`}\`.`;
  }
  return undefined;
}

function keyWiderThanTypes(
  key: Key,
  types: ReadonlySet<string>,
  connections: ReadonlySet<string>,
): string[] {
  const wider: string[] = [];
  if (key.is_operator) wider.push("it is the operator key");
  for (const permission of key.permissions) wider.push(permission);
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
      name === "types" ||
      (name === "edge_types" &&
        [...connections].some((id) => !shippedConnections.has(id))),
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
      .filter((name) => key.edge_permissions[name] !== "write")
      .map((name) => `edge ${name}`),
  ];
}

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
        if (causeOf(error) === "marfa") throw error;
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
    if (causeOf(error) === "marfa") throw error;
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
): Promise<Started> {
  const id = await marfa.register(connector.name, connector.description);
  const key = await marfa.currentKey();
  if (key === undefined) {
    return {
      id,
      spare: undefined,
      problem:
        "the server has no door for a key to read itself (GET /keys/current), so the key cannot be checked; the server is older than this kit",
    };
  }
  const types = connector.types.map((kind) => kind.type.id);
  const connections = (connector.connections ?? []).map((kind) => kind.id);
  const named = [...types, ...connections].join(", ");
  const wider = keyWiderThanTypes(key, new Set(types), new Set(connections));
  const narrower = keyNarrowerThanTypes(
    key,
    new Set(types),
    new Set(connections),
  );
  // Every way the key is wrong at once, so one new key mends them all.
  const problems = [
    keySourceProblem(key, connector.source),
    wider.length === 0
      ? undefined
      : `the key ${key.id} holds more than read and write on ${named}, and is refused: ${wider.join(", ")}. Revoke it and mint another as the template's README says.`,
    narrower.length === 0
      ? undefined
      : `the key ${key.id} may not write ${narrower.join(", ")}, which the connector writes, and is refused. Revoke it and mint another as the template's README says.`,
  ].filter((problem) => problem !== undefined);
  if (problems.length > 0) {
    return { id, spare: undefined, problem: problems.join(" ") };
  }
  for (const kind of connector.types) {
    const problem = await ensureType(kind.type, marfa);
    if (problem !== undefined) return { id, spare: undefined, problem };
  }
  const problem = await ensureConnections(connector.connections ?? [], marfa);
  if (problem !== undefined) return { id, spare: undefined, problem };
  // Everything is registered as declared now, and registering is all write
  // on the two is for. Read on them gates nothing, and is the narrowing the
  // binary can name, since it cannot name one map empty.
  const spare = ["types", "edge_types"].filter(
    (name) => key.metadata_permissions[name] === "write",
  );
  return {
    id,
    spare:
      spare.length === 0
        ? undefined
        : `every type and connection it declares is registered, so the key no longer needs metadata ${spare.map((name) => `${name}=write`).join(" or ")}: narrow it with \`marfa keys update ${key.id} ${spare.map((name) => `--metadata-permission ${name}=read`).join(" ")}\``,
    problem: undefined,
  };
}

interface Started {
  readonly id: string;
  /** Says the key holds a registering lever it no longer uses. */
  readonly spare: string | undefined;
  readonly problem: string | undefined;
}

function carriesBack<E extends EnvDeclaration>(
  connector: Connector<E>,
  environment: Environment,
): boolean {
  return [
    ...specsOf(connector, environment.values as EnvValues<E>).values(),
  ].some((spec) => spec.twoWay);
}

function looks<E extends EnvDeclaration>(
  connector: Connector<E>,
  environment: Environment,
): boolean {
  return connector.inbound !== undefined || carriesBack(connector, environment);
}

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
      if (!waiting) {
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

function helpOf<E extends EnvDeclaration>(connector: Connector<E>): string[] {
  const named = Object.entries(connector.env ?? {}).map(
    ([name, kind]) => `  ${name} (${kind})`,
  );
  return [
    `${connector.name}: ${usage}`,
    "It reads its settings from the environment:",
    "  MARFA_URL (the address of the Marfa server)",
    "  MARFA_KEY (a key minted for this connector, as the template's README says)",
    ...named,
  ];
}

function addressProblem(error: unknown): string {
  return hostNotFound(error)
    ? `could not start: the host in MARFA_URL was not found (${describe(error)}). Check the address in MARFA_URL.`
    : `could not start: MARFA_URL cannot be used (${describe(error)}). It must name the Marfa server itself, with no redirect in front of it and a certificate this machine trusts.`;
}

function startProblem(error: unknown): string {
  const cause = causeOf(error);
  if (cause === "key") {
    return `could not start: the server refused MARFA_KEY (${describe(error)}): the key is wrong or revoked. Set MARFA_KEY to a key minted for this connector, as the template's README says.`;
  }
  if (cause === "marfa") {
    return `could not start: the server at MARFA_URL did not answer (${describe(error)}). Check MARFA_URL and that the server is up, then start the connector again.`;
  }
  if (error instanceof Refusal && error.status === 403) {
    return `could not start: the server will not register this connector (${describe(error)}). MARFA_KEY must be a key minted for the connector itself, not an app's or a session's.`;
  }
  return `could not start: ${describe(error)}`;
}

interface Shared<E extends EnvDeclaration> {
  readonly connector: Connector<E>;
  readonly environment: Environment;
  readonly schedule: Exclude<Schedule, { mode: "help" }>;
  readonly marfa: Marfa;
  readonly logger: Logger;
  readonly clock: Runtime["clock"];
  readonly random: () => number;
  readonly stop: AbortController;
}

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
    if (schedule.mode === "help") {
      for (const line of helpOf(connector)) write(line);
      return 0;
    }
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
      const tree = workingTreeOf(schedule.file);
      if (tree !== undefined) {
        throw new ConfigurationError(
          `${schedule.file} is inside the git working tree at ${tree}, where a file of secrets can be committed or copied into an image: name a file outside every repository`,
        );
      }
    }
    environment = readEnvironment(
      connector,
      runtime.env,
      schedule.mode === "setup",
    );
    // Without a link, a row made in Marfa cannot be told to the vendor,
    // nor a purge found there.
    const unlinked = [
      ...specsOf(connector, environment.values as EnvValues<E>).values(),
    ].filter((spec) => spec.twoWay && spec.link === undefined);
    if (unlinked.length > 0) {
      throw new ConfigurationError(
        `${unlinked.map((spec) => spec.type).join(", ")} ${unlinked.length === 1 ? "is" : "are"} carried back, so ${unlinked.length === 1 ? "its type needs" : "their types need"} a link_field`,
      );
    }
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
  runtime.onStop(() => {
    logger.info("asked to stop");
    stop.abort();
  });
  const marfa = new Marfa(
    createClient({
      baseUrl: environment.url,
      credential: environment.key,
      fetch: marfaFetch(runtime.requestTimeoutMs),
    }),
  );
  const shared: Shared<E> = {
    connector,
    environment,
    schedule,
    marfa,
    logger,
    clock,
    random: runtime.random,
    stop,
  };
  let lostAt: number | undefined;
  for (;;) {
    const ended = await serve(shared);
    if (ended !== "registration") return ended;
    // A server that loses the registration as fast as it is made would
    // have this loop register it for good.
    const now = clock.now().getTime();
    if (lostAt !== undefined && now - lostAt < reregisterAfterMs) {
      logger.error(
        "the server keeps losing this connector's registration, so the connector stops; check what removes it, then start it again",
      );
      return 1;
    }
    lostAt = now;
    logger.warn(
      "the server no longer holds this connector's registration, so it is registered again",
    );
  }
}

/** Registers, then runs, until the process is told to stop or its key or
 *  registration is lost. Answers `registration` where registering again
 *  would mend it. */
async function serve<E extends EnvDeclaration>(
  shared: Shared<E>,
): Promise<number | "registration"> {
  const {
    connector,
    environment,
    schedule,
    marfa,
    logger,
    clock,
    random,
    stop,
  } = shared;
  const stopped = (): boolean => stop.signal.aborted;
  const intervalMs = schedule.mode === "every" ? schedule.intervalMs : 0;

  let started: Started | undefined;
  for (let failures = 1; started === undefined; failures += 1) {
    try {
      started = await registerAndCheck(connector, marfa);
    } catch (error) {
      if (causeOf(error) === "address" || hostNotFound(error)) {
        logger.error(addressProblem(error));
        return 2;
      }
      if (schedule.mode !== "every" || causeOf(error) !== "marfa") {
        logger.error(startProblem(error));
        return 1;
      }
      const wait = Math.max(
        startBackoff(intervalMs, failures),
        Math.min(retryAfterOf(error) ?? 0, longestRetryAfterMs),
      );
      logger.warn(
        `could not reach the server at MARFA_URL, trying again in ${describeDuration(wait)}: ${describe(error)}`,
      );
      await clock.sleep(wait, stop.signal);
      if (stopped()) return 0;
    }
  }
  const connectorId = started.id;
  logger.info(`registered as ${connectorId}`);
  if (started.spare !== undefined) logger.warn(started.spare);

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
      clock.now().toISOString(),
    );
  }

  // The key refused, the registration gone or an address that cannot be
  // used ends the session, whatever it was doing: no run mends any.
  const halt = new AbortController();
  let halted: Ended | undefined;
  let haltedBy: unknown;
  const end = (why: Ended, error?: unknown): void => {
    if (halted !== undefined) return;
    halted = why;
    haltedBy = error;
    halt.abort();
  };
  const ends = (cause: Cause): cause is Ended =>
    cause === "key" || cause === "registration" || cause === "address";
  const lasting = AbortSignal.any([stop.signal, halt.signal]);
  const over = (): boolean => lasting.aborted;

  const hold = new Hold(marfa, connectorId, randomUUID(), logger, clock);
  const beating = new AbortController();
  const beat = AbortSignal.any([beating.signal, lasting]);
  const beatingEnded = (): boolean => beat.aborted;
  const heartbeat = (async () => {
    let failing = false;
    let beatBegan = Number.NEGATIVE_INFINITY;
    let beatInFlight: Promise<void> | undefined;
    const beating = async (): Promise<void> => {
      try {
        await marfa.heartbeat(
          connectorId,
          AbortSignal.any([beat, AbortSignal.timeout(beatTimeoutMs)]),
        );
        if (failing) logger.info("the heartbeat is answered again");
        failing = false;
      } catch (error) {
        const cause = causeOf(error);
        if (ends(cause)) {
          end(cause, error);
          return;
        }
        // A heartbeat cut short because beating ended is not a failure.
        if (!beatingEnded() && !failing) {
          logger.warn(
            `the heartbeat failed, and is tried again with the next beat: ${describe(error)}`,
          );
          failing = true;
        }
      }
    };
    while (!beatingEnded()) {
      const began = clock.now().getTime();
      // Not waited for, so a heartbeat that has not answered never holds up
      // a renewal, which has its own timer and its own timeout.
      if (beatInFlight === undefined && began - beatBegan >= heartbeatMs) {
        beatBegan = began;
        beatInFlight = beating().finally(() => {
          beatInFlight = undefined;
        });
      }
      const lost = await hold.renew();
      if (lost !== undefined) end(lost);
      if (beatingEnded()) break;
      // From the start of one round to the start of the next, so a round
      // that ran long does not push the renewal past what the hold allows,
      // and never closer than half a renewal, whatever the window.
      const left =
        Math.min(heartbeatMs, hold.renewEvery) -
        (clock.now().getTime() - began);
      await clock.sleep(
        Math.max(Math.min(minimumBeatGapMs, hold.renewEvery / 2), left),
        AbortSignal.any([beat, hold.rearmed]),
      );
    }
    await beatInFlight;
  })();

  const setup: RunSetup<E> = {
    connector,
    environment,
    marfa,
    connectorId,
    process: hold.process,
    logger,
    clock,
    signal: lasting,
  };
  let heldUntil: string | undefined;
  const held = async (trigger: Trigger): Promise<RunResult | undefined> => {
    heldUntil = undefined;
    let taken;
    try {
      taken = await hold.take();
    } catch (error) {
      if (over()) return undefined;
      const cause = causeOf(error);
      if (ends(cause)) {
        end(cause, error);
        return undefined;
      }
      logger.error(
        `the hold could not be taken, so this run does not start: ${describe(error)}`,
      );
      return {
        succeeded: false,
        cause,
        retryAfterMs: retryAfterOf(error),
        settled: false,
        cursor: undefined,
      };
    }
    if (!taken.held) {
      logger.warn(
        `another process holds this connector until ${taken.until}, so this one does not run`,
      );
      heldUntil = taken.until;
      return undefined;
    }
    const ran = await runOnce(
      {
        ...setup,
        signal: AbortSignal.any([lasting, hold.signal]),
        fenced: () => hold.check(),
      },
      trigger,
    );
    // A run fenced for want of an answer to its renewals failed on Marfa.
    const run =
      !ran.succeeded && ran.cause === "run" && hold.fencedBy !== undefined
        ? { ...ran, cause: hold.fencedBy }
        : ran;
    if (run.cause !== undefined && ends(run.cause)) end(run.cause);
    return run;
  };
  // Asks Marfa, the cheapest way it can be asked, until it answers: not
  // sooner than a refusal's `Retry-After`, nor in step with other
  // connectors, and the run that follows is spread the same way.
  const untilMarfaAnswers = async (
    named: number | undefined,
  ): Promise<void> => {
    const every = Math.min(intervalMs, probeMs);
    const spread = (ms: number): number => ms * (1 + probeJitter * random());
    const asked = (ms: number | undefined): number =>
      Math.min(ms ?? 0, longestRetryAfterMs);
    let wait = spread(Math.max(every, asked(named)));
    logger.info(
      `Marfa did not answer, so the connector asks every ${describeDuration(every)} and runs again once it does`,
    );
    while (!over()) {
      await clock.sleep(wait, lasting);
      if (over()) return;
      try {
        await marfa.heartbeat(
          connectorId,
          AbortSignal.any([lasting, AbortSignal.timeout(beatTimeoutMs)]),
        );
        break;
      } catch (error) {
        if (over()) return;
        const cause = causeOf(error);
        if (ends(cause)) {
          end(cause, error);
          return;
        }
        // Marfa answered, though it refused: the run can find out why.
        if (cause !== "marfa") break;
        wait = spread(Math.max(every, asked(retryAfterOf(error))));
      }
    }
    logger.info("Marfa answers again, so the connector runs now");
    const after = Math.round(random() * Math.min(afterAnswerMs, intervalMs));
    if (after > 0) await clock.sleep(after, lasting);
  };
  let code = 0;
  let succeeded = false;
  try {
    if (schedule.mode === "once") {
      const run = await held("schedule");
      succeeded = run?.succeeded === true;
      code = run === undefined || run.succeeded || stopped() ? 0 : 1;
    } else {
      let failures = 0;
      // Asked for once until a run succeeds or fails for another cause, so a
      // Marfa that answers but keeps failing runs is given no more load than
      // the backoff gives.
      let hurried = false;
      while (!over()) {
        const run = await held("schedule");
        if (over()) break;
        if (run === undefined) {
          await clock.sleep(
            untilLapsed(heldUntil, clock.now().getTime(), schedule.intervalMs),
            lasting,
          );
          continue;
        }
        failures = run.succeeded ? 0 : failures + 1;
        if (run.cause !== "marfa") hurried = false;
        if (run.cause === "marfa" && !hurried) {
          hurried = true;
          await untilMarfaAnswers(run.retryAfterMs);
          continue;
        }
        const wait = Math.max(
          backoff(schedule.intervalMs, failures),
          Math.min(run.retryAfterMs ?? 0, longestRetryAfterMs),
        );
        if (failures > 0) {
          logger.info(`the next run is in ${describeDuration(wait)}`);
        }
        const next = clock.now().getTime() + wait;
        if (!looks(connector, environment) || !run.settled) {
          await clock.sleep(wait, lasting);
          continue;
        }
        await awaitChanges(setup, held, schedule.lookMs, next, run.cursor);
      }
    }
  } finally {
    beating.abort();
    await heartbeat;
    if (halted === undefined) await hold.release();
    else hold.abandon();
  }
  if (halted === undefined || (succeeded && code === 0)) return code;
  if (halted === "key") {
    logger.error(
      "the server refused MARFA_KEY, so the connector stops: the key is wrong or revoked. Mint another as the template's README says, set MARFA_KEY, and start the connector again.",
    );
    return 1;
  }
  if (halted === "address") {
    logger.error(
      `the server's address stopped working (${describe(haltedBy)}), so the connector stops: MARFA_URL must name the Marfa server itself, with no redirect in front of it and a certificate this machine trusts.`,
    );
    return 2;
  }
  if (schedule.mode === "once") {
    logger.error(
      "the server no longer holds this connector's registration, so this run stops; start it again to register it anew",
    );
    return 1;
  }
  return "registration";
}

/**
 * How long a process refused the hold waits: until a second after the
 * hold would lapse, since one a stopped process left lapses well within an
 * interval; at least half a minute, so a clock ahead of the instance's does
 * not ask every second; at most the interval.
 */
export function untilLapsed(
  until: string | undefined,
  now: number,
  intervalMs: number,
): number {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at)) return intervalMs;
  return Math.min(intervalMs, Math.max(30_000, at - now + 1000));
}

export async function main<E extends EnvDeclaration>(
  connector: Connector<E>,
): Promise<void> {
  process.exitCode = await start(connector, nodeRuntime());
}
