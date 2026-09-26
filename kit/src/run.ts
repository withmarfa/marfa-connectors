import type {
  Change,
  Connector,
  EnvDeclaration,
  EnvValues,
  Log,
  RunContext,
  State,
  WatchContext,
} from "./define.js";
import type { Environment } from "./environment.js";
import { cap, reportCap, type Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { Rows, Stopped, type Counts } from "./rows.js";
import type { Clock } from "./runtime.js";
import type { StateFile } from "./state.js";
import { cleaned, fingerprint } from "./values.js";
import { Memory, Watch, type WatchRead } from "./watch.js";

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

/** The counts as a run's summary opens, the two-way ones for a two-way connector. */
function tally(
  counts: Counts,
  outbound: { pushed: number; own: number } | undefined,
): string {
  const inbound = `created ${String(counts.created)}, updated ${String(counts.updated)}, archived ${String(counts.archived)}, unchanged ${String(counts.unchanged)}, skipped ${String(counts.skipped)}`;
  if (outbound === undefined) return inbound;
  return `${inbound}, pushed ${String(outbound.pushed)}, own ${String(outbound.own)}, conflicts ${String(counts.conflicts)}`;
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
 * One run, start to report: the log read for what changed in Marfa, the
 * creates among those carried to the vendor, the connector's own pull
 * from its vendor written in, the rest of the changes carried back, the
 * run reported. The run's state and the read's cursor are kept only when
 * every write and every push landed; the memory of where the two sides
 * agreed keeps what did land either way, and the conditions are kept
 * either way, so a condition is reported on the run it first appears and
 * not on the ones after.
 */
export async function runOnce<E extends EnvDeclaration>(
  setup: RunSetup<E>,
): Promise<boolean> {
  const { connector, logger, clock } = setup;
  const stored = await setup.stateFile.load();
  const draft = structuredClone(stored.state);
  const raised = new Map<string, string>();
  const twoWay = connector.onChange !== undefined;
  const memory = new Memory(structuredClone(stored.watch.written));
  const pending = twoWay ? new Map<string, Change>() : undefined;
  const rows = new Rows(
    setup.marfa,
    connector.type.id,
    connector.source,
    setup.signal,
    {
      link: connector.link,
      memory,
      pending,
      refused: (sourceId, reason) =>
        raised.set(
          `refused:${sourceId}`,
          `the server refused ${sourceId}: ${reason}`,
        ),
      conflict: (id, message) => raised.set(`conflict:${id}`, message),
    },
  );
  const state: State = {
    get: (key) => draft[key],
    set: (key, value) => {
      draft[key] = value;
    },
  };
  const log: Log = {
    info: (message) => {
      logger.info(message);
    },
    warn: (message) => {
      logger.warn(message);
    },
    condition: (key, message) => raised.set(key, message),
  };
  const env = setup.environment.values as EnvValues<E>;
  const context: RunContext<E> = {
    env,
    signal: setup.signal,
    state,
    log,
    upsert: (entries) => rows.upsert(entries),
    archive: (keys) => rows.archive(keys),
  };
  const watchContext: WatchContext<E> = {
    env,
    signal: setup.signal,
    state,
    log,
    setLink: (item, value) => rows.setLink(item, value),
  };

  const startedAt = clock.now();
  let failure: unknown;
  let read: WatchRead | undefined;
  let pushed = 0;
  try {
    if (pending !== undefined) {
      const watch = new Watch(
        setup.marfa,
        connector.type.id,
        stored.watch,
        memory,
        setup.signal,
        connector.link,
        connector.source,
      );
      read = await watch.read();
      for (const change of read.changes) pending.set(change.item.id, change);
      if (read.unlinked > 0) {
        raised.set(
          "unlinked",
          `${String(read.unlinked)} ${read.unlinked === 1 ? "row" : "rows"} the connector wrote before its link existed ${read.unlinked === 1 ? "is" : "are"} not carried to the vendor; the vendor's entries link them as they come`,
        );
      }
      if (read.resync) {
        raised.set(
          "resync",
          "the log no longer holds the cursor, so every row of the type is carried to the vendor once",
        );
      }
      if (read.incomplete !== undefined) {
        logger.warn(`${read.incomplete}; the rest of the log is read next run`);
      }
    }
    const carry = async (change: Change): Promise<void> => {
      // A stop here fails the run, as one inside a write does: the
      // cursor then holds, and the changes not yet carried are offered
      // again.
      if (setup.signal.aborted) throw new Stopped();
      await connector.onChange?.(change, watchContext);
      pushed += 1;
      // The vendor now has the row as this change showed it, so the two
      // sides agree at this version and state; a purged row has none.
      // A write the push made itself, the link, is a later agreement
      // and stands.
      const record = memory.written[change.item.id];
      // A purged row's record went with the purge's frame.
      if (change.kind === "purged") return;
      if (record === undefined || record.version <= change.item.version) {
        memory.remember(change.item.id, change.item.version, change.item.state);
      }
      // What was carried is what the two sides now agree on, so the
      // vendor's copy of it, when it comes back under a new time, is the
      // agreement and not a change.
      memory.agree(
        change.item.id,
        fingerprint(cleaned(change.item.properties)),
      );
    };
    if (pending !== undefined && connector.onChange !== undefined) {
      // A row the vendor has not been told about is carried before the
      // vendor is read. Nothing the vendor sends can concern it, and a
      // run that failed between the vendor's answer and the link would
      // otherwise read the vendor's copy first and create the row's twin,
      // leaving the link nowhere to go.
      for (const change of pending.values()) {
        if (change.kind !== "created") continue;
        await carry(change);
        pending.delete(change.item.id);
      }
    }
    await connector.run(context);
    if (pending !== undefined && connector.onChange !== undefined) {
      for (const change of pending.values()) await carry(change);
    }
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
  // Kept redacted, key and message, since the state file is written to disk
  // as it stands.
  const redacted = new Map(
    [...raised].map(([key, message]) => [
      logger.redact(key),
      cap(logger.redact(message), conditionCap),
    ]),
  );
  raised.clear();
  for (const [key, message] of redacted) raised.set(key, message);
  const fresh = [...raised].filter(([key]) => !(key in stored.conditions));
  for (const [, message] of fresh) logger.warn(message);

  const counts = tally(
    rows.counts,
    twoWay ? { pushed, own: read?.own ?? 0 } : undefined,
  );
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
      // The cursor moves only when every write and push landed. The memory
      // records what did land, whatever else happened, so a held run does
      // not carry its own writes back next run as somebody else's.
      watch: !twoWay
        ? stored.watch
        : {
            ...(landed && read?.cursor !== undefined
              ? { cursor: read.cursor }
              : stored.watch.cursor !== undefined && {
                  cursor: stored.watch.cursor,
                }),
            written: memory.written,
          },
    });
  } catch (error) {
    logger.warn(`the state file could not be written: ${describe(error)}`);
  }
  return failure === undefined;
}
