import { createClient } from "@withmarfa/client";
import type { Connector, EnvDeclaration } from "./define.js";
import {
  checkDefinition,
  ConfigurationError,
  readEnvironment,
} from "./environment.js";
import { cap, Logger } from "./log.js";
import { Marfa, Refusal } from "./marfa.js";
import { describe, runOnce, type RunSetup } from "./run.js";
import { nodeRuntime, type Runtime } from "./runtime.js";
import {
  backoff,
  describeDuration,
  readSchedule,
  type Schedule,
} from "./schedule.js";
import { StateFile } from "./state.js";
import { typeDifferences } from "./type-check.js";

const heartbeatMs = 60_000;

/** Worth another attempt: the server was unreachable, overloaded or failing. */
function transient(error: unknown): boolean {
  if (error instanceof Refusal) {
    return (
      error.status !== undefined &&
      (error.status >= 500 || error.status === 429)
    );
  }
  return error instanceof TypeError;
}

async function registerAndCheck<E extends EnvDeclaration>(
  connector: Connector<E>,
  marfa: Marfa,
): Promise<{ id: string; problem: string | undefined }> {
  const id = await marfa.register(connector.name, connector.description);
  const served = await marfa.type(connector.type.id);
  if (served === undefined) {
    try {
      await marfa.registerType(connector.type);
    } catch (error) {
      if (transient(error)) throw error;
      return {
        id,
        problem: `the type ${connector.type.id} could not be registered: ${describe(error)}`,
      };
    }
    return { id, problem: undefined };
  }
  const differences = typeDifferences(connector.type, served);
  if (differences.length === 0) return { id, problem: undefined };
  return {
    id,
    problem: `the type ${connector.type.id} on the server differs from the one this connector carries, and is not rewritten: ${differences.join("; ")}`,
  };
}

/** Runs the connector as the arguments say, and answers the exit code. */
export async function start<E extends EnvDeclaration>(
  connector: Connector<E>,
  runtime: Runtime,
): Promise<number> {
  const { clock } = runtime;
  let schedule: Schedule;
  let environment;
  try {
    checkDefinition(connector);
    schedule = readSchedule(runtime.argv);
    environment = readEnvironment(connector, runtime.env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    new Logger((line) => {
      runtime.write(line);
    }, clock).error(error.message);
    return 2;
  }
  const logger = new Logger(
    (line) => {
      runtime.write(line);
    },
    clock,
    environment.secrets,
  );

  const stop = new AbortController();
  const stopped = (): boolean => stop.signal.aborted;
  runtime.onStop(() => {
    logger.info("asked to stop");
    stop.abort();
  });
  const marfa = new Marfa(
    createClient({ baseUrl: environment.url, credential: environment.key }),
  );
  const intervalMs = schedule.mode === "every" ? schedule.intervalMs : 0;

  let started: { id: string; problem: string | undefined } | undefined;
  for (let failures = 1; started === undefined; failures += 1) {
    try {
      started = await registerAndCheck(connector, marfa);
    } catch (error) {
      if (schedule.mode === "once" || !transient(error)) {
        logger.error(`could not start: ${describe(error)}`);
        return 1;
      }
      const wait = backoff(intervalMs, failures);
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

  const beating = new AbortController();
  const beat = AbortSignal.any([beating.signal, stop.signal]);
  const heartbeat = (async () => {
    let failing = false;
    while (!beat.aborted) {
      try {
        await marfa.heartbeat(connectorId);
        if (failing) logger.info("the heartbeat is answered again");
        failing = false;
      } catch (error) {
        if (!failing) logger.warn(`the heartbeat failed: ${describe(error)}`);
        failing = true;
      }
      await clock.sleep(heartbeatMs, beat);
    }
  })();

  const setup: RunSetup<E> = {
    connector,
    environment,
    marfa,
    connectorId,
    stateFile: new StateFile(environment.stateDir, connector.name, logger),
    logger,
    clock,
    signal: stop.signal,
  };
  let code = 0;
  try {
    if (schedule.mode === "once") {
      const succeeded = await runOnce(setup);
      code = succeeded || stopped() ? 0 : 1;
    } else {
      let failures = 0;
      while (!stopped()) {
        failures = (await runOnce(setup)) ? 0 : failures + 1;
        if (stopped()) break;
        const wait = backoff(schedule.intervalMs, failures);
        if (failures > 0)
          logger.info(`the next run is in ${describeDuration(wait)}`);
        await clock.sleep(wait, stop.signal);
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
