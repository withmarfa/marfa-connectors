import type {
  Connector,
  EnvDeclaration,
  EnvValues,
  RunContext,
} from "./define.js";
import type { Environment } from "./environment.js";
import { cap, reportCap, type Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { Rows, type Counts } from "./rows.js";
import type { Clock } from "./runtime.js";
import type { StateFile } from "./state.js";

export interface RunSetup<E extends EnvDeclaration> {
  connector: Connector<E>;
  environment: Environment;
  marfa: Marfa;
  connectorId: string;
  stateFile: StateFile;
  logger: Logger;
  clock: Clock;
  signal: AbortSignal;
}

/** An error's message, with the cause beneath it where there is one. */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as NodeJS.ErrnoException).code;
  return `${error.message} (${code ?? cause.message})`;
}

function tally(counts: Counts): string {
  return `created ${String(counts.created)}, updated ${String(counts.updated)}, archived ${String(counts.archived)}, unchanged ${String(counts.unchanged)}, skipped ${String(counts.skipped)}`;
}

/** Room left in a summary for saying that more conditions wait. */
const moreNote = 80;

/** The longest a single condition may be, so one never crowds out the rest. */
const conditionCap = 500;

/**
 * The counts, then as many of the new conditions as the server's cap on a
 * summary takes, in the order they were raised. The rest wait for a later
 * run's report.
 */
function summarize(
  counts: string,
  fresh: [string, string][],
): {
  summary: string;
  carried: Set<string>;
} {
  let summary = counts;
  const carried = new Set<string>();
  for (const [key, message] of fresh) {
    const longer = `${summary}. ${message}`;
    if (longer.length > reportCap - moreNote) break;
    summary = longer;
    carried.add(key);
  }
  const waiting = fresh.length - carried.size;
  if (waiting > 0) {
    summary += `. ${String(waiting)} more ${waiting === 1 ? "condition waits" : "conditions wait"} for a later report`;
  }
  return { summary, carried };
}

/**
 * One run, start to report. The run's state is kept only when every write
 * landed; its conditions are kept either way, so a condition is reported on
 * the run it first appears and not on the ones after.
 */
export async function runOnce<E extends EnvDeclaration>(
  setup: RunSetup<E>,
): Promise<boolean> {
  const { connector, logger, clock } = setup;
  const stored = await setup.stateFile.load();
  const draft = structuredClone(stored.state);
  const raised = new Map<string, string>();
  const rows = new Rows(
    setup.marfa,
    connector.type.id,
    connector.source,
    setup.signal,
    (sourceId, reason) =>
      raised.set(
        `refused:${sourceId}`,
        `the server refused ${sourceId}: ${reason}`,
      ),
  );
  const context: RunContext<E> = {
    env: setup.environment.values as EnvValues<E>,
    signal: setup.signal,
    state: {
      get: (key) => draft[key],
      set: (key, value) => {
        draft[key] = value;
      },
    },
    log: {
      info: (message) => {
        logger.info(message);
      },
      warn: (message) => {
        logger.warn(message);
      },
      condition: (key, message) => raised.set(key, message),
    },
    upsert: (entries) => rows.upsert(entries),
    archive: (sourceIds) => rows.archive(sourceIds),
  };

  const startedAt = clock.now();
  let failure: unknown;
  try {
    await connector.run(context);
  } catch (error) {
    failure = error;
  }
  const finishedAt = clock.now();

  if (failure === undefined && rows.held > 0) {
    raised.set(
      "held",
      "the state is held, so the next run reads the vendor again: a write did not land",
    );
  }
  // Kept redacted, since the state file is written to disk as it stands.
  for (const [key, message] of raised) {
    raised.set(key, cap(logger.redact(message), conditionCap));
  }
  const fresh = [...raised].filter(([key]) => !(key in stored.conditions));
  for (const [, message] of fresh) logger.warn(message);

  const counts = tally(rows.counts);
  const { summary, carried } = summarize(counts, fresh);
  const outcome = failure === undefined ? "succeeded" : "failed";
  if (failure === undefined) {
    logger.info(`run succeeded: ${counts}`);
  } else {
    logger.error(`run failed: ${describe(failure)}; ${counts}`);
  }
  let reported = false;
  try {
    await setup.marfa.report(setup.connectorId, {
      outcome,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      summary: cap(logger.redact(summary)),
      ...(failure !== undefined && {
        error: cap(logger.redact(describe(failure))),
      }),
    });
    reported = true;
  } catch (error) {
    logger.warn(`the run could not be reported: ${describe(error)}`);
  }

  // A condition counts as reported only once a report carrying it landed.
  // A run that failed may not have reached what raises one, so nothing it
  // did not raise is taken to have cleared.
  const known = [...raised].filter(
    ([key]) => key in stored.conditions || carried.has(key),
  );
  let conditions = stored.conditions;
  if (reported && failure === undefined) {
    for (const [key, message] of Object.entries(stored.conditions)) {
      if (!raised.has(key)) logger.info(`cleared: ${message}`);
    }
    conditions = Object.fromEntries(known);
  } else if (reported) {
    conditions = { ...stored.conditions, ...Object.fromEntries(known) };
  }
  const landed = failure === undefined && rows.held === 0;
  try {
    await setup.stateFile.save({
      state: landed ? draft : stored.state,
      conditions,
    });
  } catch (error) {
    logger.warn(`the state file could not be written: ${describe(error)}`);
  }
  return failure === undefined;
}
