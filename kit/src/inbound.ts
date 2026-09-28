import type {
  Delivery,
  EnvDeclaration,
  EnvValues,
  Hint,
  Inbound,
} from "./define.js";
import type { InboundDeliveryRow, Marfa } from "./marfa.js";
import { Stopped } from "./rows.js";
import type { Clock } from "./runtime.js";

/**
 * The most deliveries one run takes; what waits past them goes to the next
 * run, or under `--every`, starts one as soon as the next look finds it waiting.
 */
export const deliveriesPerRun = 500;

/** How long one delivery's `verify` may run before the delivery is left waiting. */
export const verifyLimitMs = 10_000;

export interface Collected {
  /** Verified, and not a repeat of one handled: marked processed once the run succeeds. */
  readonly fresh: readonly string[];
  /** What the fresh deliveries named, by type, or `undefined` where one asked for everything. */
  readonly hints: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  readonly rejected: number;
  readonly duplicate: number;
  /** Verified deliveries whose hints could not be read, so everything is read for them. */
  readonly unreadable: number;
  /** Deliveries whose body could not be fetched, left waiting for a later run. */
  readonly unfetched: number;
  /** Deliveries whose `verify` ran past its limit, left waiting for a later run. */
  readonly unverified: number;
}

/**
 * The delivery's `verify`, bounded: `late` once it runs past the limit, so
 * a check that hangs holds neither the run nor the deliveries behind it.
 */
async function bounded<E extends EnvDeclaration>(
  inbound: Inbound<E>,
  delivery: Delivery,
  env: EnvValues<E>,
  signal: AbortSignal,
  clock: Clock,
): Promise<boolean | "late"> {
  const late = new AbortController();
  const done = new AbortController();
  const verifying = Promise.resolve().then(() =>
    inbound.verify(delivery, env, AbortSignal.any([signal, late.signal])),
  );
  // Settled after the race is lost, so it must not surface as unhandled.
  verifying.catch(() => undefined);
  const deadline = clock
    .sleep(verifyLimitMs, AbortSignal.any([signal, done.signal]))
    .then(() => "late" as const);
  try {
    const outcome = await Promise.race([verifying, deadline]);
    if (outcome === "late") late.abort();
    return outcome;
  } finally {
    done.abort();
  }
}

function delivery(row: InboundDeliveryRow, body: Uint8Array): Delivery {
  const headers = row.headers.flatMap(([name, value]) =>
    name === undefined || value === undefined ? [] : [[name, value] as const],
  );
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    receivedAt: row.received_at,
    headers,
    header: (name) => {
      const wanted = name.toLowerCase();
      return headers.find(
        ([candidate]) => candidate.toLowerCase() === wanted,
      )?.[1];
    },
    query: row.query,
    body,
  };
}

/**
 * Takes what waits at the connector's endpoints and sorts it; a delivery
 * that can't be fetched, verified in time, or read for hints never blocks the rest.
 */
export async function collect<E extends EnvDeclaration>(
  marfa: Marfa,
  connectorId: string,
  inbound: Inbound<E>,
  env: EnvValues<E>,
  signal: AbortSignal,
  clock: Clock,
): Promise<Collected> {
  const rows = await marfa.pendingDeliveries(
    connectorId,
    deliveriesPerRun,
    signal,
  );
  const fresh: string[] = [];
  const rejected: string[] = [];
  const duplicate: string[] = [];
  const verified = new Set<string>();
  const hints = new Map<string, Set<string>>();
  let everything = false;
  let unreadable = 0;
  let unfetched = 0;
  let unverified = 0;
  // Read through a call, since the signal can abort while a fetch waits.
  const stopped = (): boolean => signal.aborted;
  for (const row of rows) {
    if (stopped()) throw new Stopped();
    let body: Uint8Array;
    try {
      body = await marfa.deliveryBody(connectorId, row.id, signal);
    } catch (error) {
      if (stopped()) throw error;
      unfetched += 1;
      continue;
    }
    const arrived = delivery(row, body);
    let genuine: boolean | "late";
    try {
      genuine = await bounded(inbound, arrived, env, signal, clock);
    } catch {
      // Not logged: a verify error can quote the delivery body.
      genuine = false;
    }
    if (stopped()) throw new Stopped();
    if (genuine === "late") {
      unverified += 1;
      continue;
    }
    if (!genuine) {
      rejected.push(row.id);
      continue;
    }
    verified.add(row.id);
    const original = row.duplicate_of;
    // Only an already-landed original counts, so a forged delivery sent
    // first can't hide behind a later, genuine one.
    if (
      original !== null &&
      (original.outcome === "processed" || verified.has(original.id))
    ) {
      duplicate.push(row.id);
      continue;
    }
    fresh.push(row.id);
    let named: readonly Hint[] | "everything";
    try {
      named = inbound.hints(arrived);
    } catch {
      unreadable += 1;
      named = "everything";
    }
    if (named === "everything") everything = true;
    else {
      for (const { type, id } of named) {
        const ids = hints.get(type) ?? new Set<string>();
        ids.add(id);
        hints.set(type, ids);
      }
    }
  }
  await marfa.handled(connectorId, rejected, "rejected");
  await marfa.handled(connectorId, duplicate, "duplicate");
  return {
    fresh,
    hints: everything ? undefined : hints,
    rejected: rejected.length,
    duplicate: duplicate.length,
    unreadable,
    unfetched,
    unverified,
  };
}
