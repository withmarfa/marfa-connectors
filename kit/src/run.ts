import {
  carried,
  changedInMarfa,
  noteWaiting,
  sideOf,
  type AgreedState,
  type Agreement,
} from "./agreement.js";
import type {
  Change,
  ChangeKind,
  Connector,
  Entry,
  EnvDeclaration,
  EnvValues,
  Item,
  Log,
  RunContext,
  State,
  WatchContext,
} from "./define.js";
import type { Environment } from "./environment.js";
import { collect, type Collected } from "./inbound.js";
import { cap, reportCap, type Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { Rows, stateKey, Stopped, type Counts, type Kind } from "./rows.js";
import type { Clock } from "./runtime.js";
import { Store } from "./store.js";
import { Watch, type LogRead, type Seen } from "./watch.js";

export interface RunSetup<E extends EnvDeclaration> {
  connector: Connector<E>;
  environment: Environment;
  marfa: Marfa;
  connectorId: string;
  /** This process, as the instance tells it from another under the same key. */
  process: string;
  logger: Logger;
  clock: Clock;
  signal: AbortSignal;
}

/**
 * Why a run starts: its schedule, which reads the vendor whole, or a
 * delivery waiting, which reads what the deliveries named, or the whole
 * vendor where one asked for everything. A two-way connector reads the
 * vendor whole either way.
 */
export type Trigger = "schedule" | "deliveries";

export interface RunResult {
  /** No error ended the run, whatever writes it held. */
  readonly succeeded: boolean;
  /**
   * Every delivery the run took is marked and none was left unfetched or
   * unverified, so none waits on its account.
   */
  readonly settled: boolean;
}

/** A row the vendor has not been told about. */
const createKey = "@create";

/** How many deliveries one request marks. */
const marksPerRequest = 200;

/** An error's message, with the cause beneath it where there is one. */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as NodeJS.ErrnoException).code;
  return `${error.message} (${code ?? cause.message})`;
}

/**
 * The counts as a run's summary opens: the two-way ones for a two-way
 * connector, and the deliveries for one that reads them.
 */
function tally(
  counts: Counts,
  outbound: { pushed: number; own: number } | undefined,
  deliveries:
    { processed: number; rejected: number; duplicate: number } | undefined,
): string {
  let summary = `created ${String(counts.created)}, updated ${String(counts.updated)}, archived ${String(counts.archived)}, unchanged ${String(counts.unchanged)}, skipped ${String(counts.skipped)}`;
  if (outbound !== undefined) {
    summary += `, pushed ${String(outbound.pushed)}, own ${String(outbound.own)}, conflicts ${String(counts.conflicts)}`;
  }
  if (deliveries !== undefined) {
    summary += `; deliveries processed ${String(deliveries.processed)}, rejected ${String(deliveries.rejected)}, duplicate ${String(deliveries.duplicate)}`;
  }
  return summary;
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

/** The kind of type the connector writes, as the rows and the agreements read it. */
export function kindOf<E extends EnvDeclaration>(
  connector: Connector<E>,
): Kind {
  const twoWay = connector.onChange !== undefined;
  const readOnly = new Set(
    twoWay ? (connector.readOnly ?? []) : connector.fields,
  );
  if (connector.link !== undefined) readOnly.add(connector.link);
  return {
    type: connector.type.id,
    source: connector.source,
    link: connector.link,
    fields: connector.fields,
    readOnly,
  };
}

/**
 * The agreement with what the log shows of the row since: each field that
 * differs from what the kit last wrote or carried waits, from when it was
 * first seen, and so does a state the two sides did not agree on. `own`
 * counts the frames showing the row as the kit last left it: its own writes.
 */
function observe(
  kind: Kind,
  twoWay: boolean,
  seen: Seen,
  agreement: Agreement,
): { next: Agreement; own: number } {
  let waiting: Record<string, string> = { ...agreement.waiting };
  Reflect.deleteProperty(waiting, stateKey);
  let stateSince = agreement.waiting?.[stateKey];
  let own = 0;
  for (const { item } of seen.frames) {
    if (
      item.state === agreement.state &&
      changedInMarfa(agreement, kind.fields, item.properties).length === 0
    ) {
      own += 1;
    }
    const fields =
      noteWaiting(
        { ...agreement, waiting },
        kind.fields,
        item.properties,
        item.updated_at,
      ) ?? {};
    for (const key of Object.keys(waiting)) {
      if (!key.startsWith("@")) Reflect.deleteProperty(waiting, key);
    }
    waiting = { ...waiting, ...fields };
    stateSince =
      twoWay && item.state !== agreement.state
        ? (stateSince ?? item.updated_at)
        : undefined;
  }
  if (stateSince !== undefined) waiting[stateKey] = stateSince;
  const next: Agreement = { ...agreement };
  Reflect.deleteProperty(next, "waiting");
  if (Object.keys(waiting).length > 0) next.waiting = waiting;
  return { next, own };
}

/** A row's state as the two sides agree on it; a revoked row counts as trashed. */
function agreedState(state: string): AgreedState {
  return state === "active" || state === "archived" ? state : "trashed";
}

/**
 * One run, start to report: the waiting deliveries collected and sorted;
 * the log read, and each row it names compared with what the two sides
 * last agreed on, recording what waits to be carried; the creates carried
 * and the restored rows made again at the vendor; the connector's own pull
 * written in, field by field against the agreements; the rest of what
 * waits carried back; the agreements written, and only then the cursor
 * moved past the log that named them; the fresh deliveries marked; the run
 * reported. The connector's own state is kept only when every write
 * landed; what waits is kept either way, so a failed run loses nothing.
 */
export async function runOnce<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  trigger: Trigger,
): Promise<RunResult> {
  const { connector, logger, clock } = setup;
  const store = new Store(setup.marfa, setup.connectorId, setup.process);
  const kind = kindOf(connector);
  const twoWay = connector.onChange !== undefined;
  const raised = new Map<string, string>();
  const startedAt = clock.now();
  let failure: unknown;
  let loaded;
  try {
    loaded = await store.load();
  } catch (error) {
    failure = error;
    loaded = undefined;
  }
  const stored = loaded ?? { state: {}, conditions: {} };
  const draft = structuredClone(stored.state);
  const rows = new Rows(setup.marfa, kind, store, setup.signal, {
    refused: (sourceId, reason) =>
      raised.set(
        `refused:${sourceId}`,
        `the server refused ${sourceId}: ${reason}`,
      ),
    condition: (key, message) => raised.set(key, message),
  });
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
  let hints: ReadonlySet<string> | undefined;
  const context: RunContext<E> = {
    env,
    signal: setup.signal,
    state,
    log,
    get hints() {
      return hints;
    },
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

  let read: LogRead | undefined;
  let pushed = 0;
  let own = 0;
  let collected: Collected | undefined;
  const whole = trigger === "schedule" || twoWay;
  // On a whole run the deliveries are extra: a failure reading them is a
  // condition, and the vendor is still read whole.
  const bookkeeping = async <T>(
    key: string,
    message: string,
    step: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (!whole) return step();
    try {
      return await step();
    } catch (error) {
      if (setup.signal.aborted) throw error;
      raised.set(key, `${message}: ${describe(error)}`);
      return undefined;
    }
  };
  /** Rows purged since the last run, with the row as the log last showed it. */
  const purged = new Map<string, Item>();
  /** Rows the log showed that nothing was agreed for, not carried. */
  let unagreed = 0;

  const carry = async (item: Item, agreement: Agreement): Promise<void> => {
    if (setup.signal.aborted) throw new Stopped();
    if (connector.onChange === undefined) return;
    let current = item;
    // The link is the connector's: a row whose link a person changed is
    // linked back before anything is carried by it.
    if (
      agreement.link !== undefined &&
      rows.linkOf(current.properties) !== agreement.link
    ) {
      await rows.setLink(current, agreement.link);
      current = (await rows.row(current.id)) ?? current;
      raised.set(
        `link-put-back:${current.id}`,
        `the ${kind.link ?? "link"} of ${current.id} was changed in Marfa and put back, since it names the vendor's own item`,
      );
    }
    const base = store.get(current.id) ?? agreement;
    const unlinked =
      kind.link !== undefined && rows.linkOf(current.properties) === undefined;
    const changeKind: ChangeKind = unlinked
      ? "created"
      : current.state !== base.state
        ? current.state === "trashed"
          ? "trashed"
          : current.state === "archived"
            ? "archived"
            : "restored"
        : "updated";
    const trashed = changeKind === "trashed";
    const changed = trashed
      ? []
      : changedInMarfa(
          base,
          kind.fields.filter((field) => !kind.readOnly.has(field)),
          current.properties,
        );
    if (changeKind === "updated" && changed.length === 0) {
      store.set(current.id, { ...base, ...withoutWaiting(base) });
      return;
    }
    if (changeKind === "created") {
      // Kept before the vendor is asked, so a run that dies between its
      // answer and the link says so to the next.
      const attempted = base.attempted;
      store.set(current.id, { ...base, attempted: clock.now().toISOString() });
      await store.flush([current.id]);
      const change: Change = {
        kind: changeKind,
        item: current,
        changed: new Set(changed),
        ...(attempted !== undefined && { attempted }),
      };
      settle(current, changed, await connector.onChange(change, watchContext));
      return;
    }
    const answered = await connector.onChange(
      { kind: changeKind, item: current, changed: new Set(changed) },
      watchContext,
    );
    settle(current, changed, answered);
  };
  const withoutWaiting = (agreement: Agreement): Agreement => {
    const next = { ...agreement };
    Reflect.deleteProperty(next, "waiting");
    return next;
  };
  const settle = (
    item: Item,
    changed: readonly string[],
    answered: Entry | undefined,
  ): void => {
    pushed += 1;
    const base = store.get(item.id);
    const next = carried({
      fields: kind.fields,
      agreement: base,
      properties: item.properties,
      state: agreedState(item.state),
      changed,
      answered,
    });
    const linked = store.get(item.id)?.link;
    // Carried as the row stood; any field still differing waits on.
    const left = base === undefined ? {} : (base.waiting ?? {});
    const waiting: Record<string, string> = {};
    for (const [key, since] of Object.entries(left)) {
      if (key.startsWith("@") || changed.includes(key)) continue;
      waiting[key] = since;
    }
    Reflect.deleteProperty(next, "waiting");
    store.set(item.id, {
      ...next,
      ...(linked !== undefined && { link: linked }),
      ...(Object.keys(waiting).length > 0 &&
        item.state !== "trashed" && {
          waiting,
        }),
    });
  };

  try {
    if (loaded === undefined) throw failure;
    const inbound = connector.inbound;
    if (inbound !== undefined) {
      collected = await bookkeeping(
        "deliveries-unread",
        "the waiting deliveries could not be read, so this run read the vendor whole without them",
        () =>
          collect(
            setup.marfa,
            setup.connectorId,
            inbound,
            env,
            setup.signal,
            clock,
          ),
      );
      if (!whole) hints = collected?.hints;
      const rejected = collected?.rejected ?? 0;
      if (rejected > 0) {
        raised.set(
          "rejected",
          `${String(rejected)} ${rejected === 1 ? "delivery" : "deliveries"} failed the signature check and ${rejected === 1 ? "was" : "were"} marked rejected; the secret the sender signs with may not be the one this connector holds`,
        );
      }
      const unreadable = collected?.unreadable ?? 0;
      if (unreadable > 0) {
        raised.set(
          "unreadable",
          `${String(unreadable)} verified ${unreadable === 1 ? "delivery" : "deliveries"} could not be read for what changed, so the vendor was read whole for ${unreadable === 1 ? "it" : "them"}`,
        );
      }
      const unfetched = collected?.unfetched ?? 0;
      if (unfetched > 0) {
        raised.set(
          "unfetched",
          `${String(unfetched)} ${unfetched === 1 ? "delivery's body" : "deliveries' bodies"} could not be fetched, so ${unfetched === 1 ? "it waits" : "they wait"} for a later run`,
        );
      }
      const unverified = collected?.unverified ?? 0;
      if (unverified > 0) {
        raised.set(
          "unverified",
          `${String(unverified)} ${unverified === 1 ? "delivery's signature check" : "deliveries' signature checks"} ran past ten seconds, so ${unverified === 1 ? "it waits" : "they wait"} for a later run`,
        );
      }
      const endpoints = whole
        ? await bookkeeping(
            "endpoints-unread",
            "the webhook endpoints could not be read, so whether one is live is not known",
            () => setup.marfa.endpoints(setup.connectorId),
          )
        : undefined;
      if (
        endpoints !== undefined &&
        !endpoints.some((endpoint) => endpoint.retired_at === null)
      ) {
        raised.set(
          "no-endpoint",
          `no webhook endpoint is live, so nothing reaches this connector but its schedule; make one with \`marfa connectors endpoints create ${setup.connectorId}\``,
        );
      }
    }
    read = await new Watch(
      setup.marfa,
      connector.type.id,
      stored.cursor,
      setup.signal,
    ).read();
    if (read.resync) {
      raised.set(
        "resync",
        "the log no longer holds the cursor, so every row of the type was compared with what was last agreed",
      );
    }
    if (read.incomplete !== undefined) {
      logger.warn(`${read.incomplete}; the rest of the log is read next run`);
    }
    const waitingIds = await store.waiting(setup.signal);
    await store.fetch([...read.rows.keys(), ...waitingIds]);
    const order: string[] = [];
    for (const [id, seen] of read.rows) {
      const last = seen.frames.at(-1)?.item;
      if (last === undefined) continue;
      const agreement = store.get(id);
      if (seen.purged) {
        const link = agreement?.link ?? rows.linkOf(last.properties);
        if (agreement === undefined && link === undefined) continue;
        store.clear(id);
        rows.purged.add(link ?? last.source_id ?? id);
        if (twoWay) purged.set(id, last);
        continue;
      }
      if (agreement === undefined) {
        const unlinked =
          kind.link !== undefined && rows.linkOf(last.properties) === undefined;
        if (twoWay && unlinked && last.state === "active") {
          store.set(id, {
            vendor: {},
            marfa: {},
            state: "active",
            waiting: {
              [createKey]: seen.frames[0]?.item.updated_at ?? last.updated_at,
            },
          });
          order.push(id);
        } else if (twoWay && !unlinked) {
          unagreed += 1;
        }
        continue;
      }
      const observed = observe(kind, twoWay, seen, agreement);
      own += observed.own;
      const next = observed.next;
      store.set(id, next);
      if (next.waiting !== undefined) order.push(id);
    }
    for (const id of waitingIds) {
      if (!order.includes(id) && store.get(id)?.waiting !== undefined) {
        order.push(id);
      }
    }
    if (unagreed > 0) {
      raised.set(
        "unagreed",
        `${String(unagreed)} ${unagreed === 1 ? "row" : "rows"} the log named ${unagreed === 1 ? "has" : "have"} nothing agreed with the vendor yet, so nothing is carried for ${unagreed === 1 ? "it" : "them"} until the vendor next sends ${unagreed === 1 ? "it" : "them"}, whose values ${unagreed === 1 ? "it takes" : "they take"} where they differ`,
      );
    }
    // Everything the log named is recorded, so the cursor may move past it
    // however the rest of the run goes.
    await store.flush();

    const done = new Set<string>();
    if (twoWay) {
      // A row the vendor has not been told about, and a restored row the
      // vendor no longer has, are made there before the vendor is read. A
      // run that failed between the vendor's answer and the link would
      // otherwise read the vendor's copy first and create the row's twin.
      for (const id of order) {
        const agreement = store.get(id);
        const item = await rows.row(id);
        if (agreement === undefined || item === undefined) continue;
        if (agreement.waiting?.[createKey] !== undefined) {
          await carry(item, agreement);
          done.add(id);
          continue;
        }
        const restored =
          item.state === "active" && agreement.state !== "active";
        if (connector.remake !== undefined && restored) {
          if (setup.signal.aborted) throw new Stopped();
          const change: Change = {
            kind: "restored",
            item,
            changed: new Set(
              changedInMarfa(
                agreement,
                kind.fields.filter((field) => !kind.readOnly.has(field)),
                item.properties,
              ),
            ),
          };
          if (await connector.remake(change, watchContext)) {
            pushed += 1;
            const current = (await rows.row(id)) ?? item;
            const side = sideOf(kind.fields, current.properties);
            const linked = store.get(id)?.link;
            store.set(id, {
              vendor: side,
              marfa: side,
              state: "active",
              ...(linked !== undefined && { link: linked }),
            });
            done.add(id);
          }
        }
      }
    }
    await connector.run(context);
    if (twoWay) {
      for (const id of rows.marked) if (!order.includes(id)) order.push(id);
      for (const id of order) {
        if (done.has(id)) continue;
        const agreement = store.get(id);
        const item = await rows.row(id);
        if (agreement?.waiting === undefined || item === undefined) continue;
        await carry(item, agreement);
      }
      for (const item of purged.values()) {
        if (setup.signal.aborted) throw new Stopped();
        await connector.onChange?.(
          { kind: "purged", item, changed: new Set() },
          watchContext,
        );
        pushed += 1;
      }
    }
  } catch (error) {
    failure = error;
  }
  let flushed = true;
  try {
    await store.flush();
  } catch (error) {
    flushed = false;
    failure ??= error;
    logger.warn(
      `what the two sides agreed on could not be kept: ${describe(error)}`,
    );
  }
  const finishedAt = clock.now();

  if (rows.seeded > 0) {
    raised.set(
      "seeded",
      `${String(rows.seeded)} ${rows.seeded === 1 ? "row" : "rows"} with nothing agreed took the vendor's values where they differed, and nothing was carried back for ${rows.seeded === 1 ? "it" : "them"}`,
    );
  }
  if (failure === undefined && rows.held > 0) {
    raised.set(
      "held",
      "the state is held, so the next run reads the vendor again: a write did not land",
    );
  }
  // Kept redacted, key and message, since the conditions are kept on the
  // instance as they stand.
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

  const landed = failure === undefined && rows.held === 0;
  // A delivery is processed once the run that took it ends without error.
  // A write it held is read again by the next scheduled run, which reads
  // the vendor whole, so the delivery need not wait for it.
  const taken = collected?.fresh ?? [];
  let processed = 0;
  if (failure === undefined && !setup.signal.aborted) {
    try {
      for (let at = 0; at < taken.length; at += marksPerRequest) {
        const marking = taken.slice(at, at + marksPerRequest);
        await setup.marfa.handled(setup.connectorId, marking, "processed");
        processed += marking.length;
      }
    } catch (error) {
      logger.warn(
        `the deliveries could not be marked processed, and are taken again by a later run: ${describe(error)}`,
      );
    }
  }
  const settled =
    processed === taken.length &&
    (collected?.unfetched ?? 0) === 0 &&
    (collected?.unverified ?? 0) === 0;
  const counts = tally(
    rows.counts,
    twoWay ? { pushed, own } : undefined,
    connector.inbound === undefined
      ? undefined
      : {
          processed,
          rejected: collected?.rejected ?? 0,
          duplicate: collected?.duplicate ?? 0,
        },
  );
  const { summary, carried: sent } = summarize(counts, fresh);
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
  // A run that failed, or read only what deliveries named, may not have
  // reached what raises one, so nothing it did not raise is taken to have
  // cleared.
  const known = [...raised].filter(
    ([key]) => key in stored.conditions || sent.has(key),
  );
  let conditions = stored.conditions;
  if (reported && failure === undefined && whole) {
    for (const [key, message] of Object.entries(stored.conditions)) {
      if (!raised.has(key)) logger.info(`cleared: ${message}`);
    }
    conditions = Object.fromEntries(known);
  } else if (reported) {
    conditions = { ...stored.conditions, ...Object.fromEntries(known) };
  }
  try {
    await store.save({
      state: landed ? draft : stored.state,
      conditions,
      // Past the log only once what it named is kept on the instance.
      ...(flushed && read?.cursor !== undefined
        ? { cursor: read.cursor }
        : stored.cursor !== undefined && { cursor: stored.cursor }),
    });
  } catch (error) {
    logger.warn(`the connector's state could not be kept: ${describe(error)}`);
  }
  return { succeeded: failure === undefined, settled };
}
