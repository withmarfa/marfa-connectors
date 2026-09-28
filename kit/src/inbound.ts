import type { Delivery, EnvDeclaration, EnvValues, Inbound } from "./define.js";
import type { InboundDeliveryRow, Marfa } from "./marfa.js";
import { Stopped } from "./rows.js";

/**
 * The most deliveries one run takes. What waits past them is taken by the
 * next run; under `--every`, the kit's next look for waiting deliveries
 * starts one.
 */
export const deliveriesPerRun = 500;

export interface Collected {
  /** Verified, and not a repeat of one handled: marked processed once the run succeeds. */
  readonly fresh: readonly string[];
  /** What the fresh deliveries named, or `undefined` where one asked for everything. */
  readonly hints: ReadonlySet<string> | undefined;
  readonly rejected: number;
  readonly duplicate: number;
  /** Verified deliveries whose hints could not be read, so everything is read for them. */
  readonly unreadable: number;
  /** Deliveries whose body could not be fetched, left waiting for a later run. */
  readonly unfetched: number;
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
 * Takes what waits at the connector's endpoints and sorts it. A delivery
 * that fails its signature is marked rejected, and one that repeats a
 * verified delivery is marked a duplicate, both at once, since nothing the
 * run does changes them. A repeat counts only where its original was
 * processed or verified earlier in the same collection, so a forged
 * delivery sent first cannot hide the real one. The rest are the run's to
 * process. A `verify` that throws rejects its delivery and a `hints` that
 * throws reads everything for it, and a body that cannot be fetched leaves
 * its delivery waiting, so one delivery the connector cannot read never
 * holds up the rest; neither error's text is kept, since it can quote the
 * body.
 */
export async function collect<E extends EnvDeclaration>(
  marfa: Marfa,
  connectorId: string,
  inbound: Inbound<E>,
  env: EnvValues<E>,
  signal: AbortSignal,
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
  const hints = new Set<string>();
  let everything = false;
  let unreadable = 0;
  let unfetched = 0;
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
    let genuine: boolean;
    try {
      genuine = await inbound.verify(arrived, env);
    } catch {
      genuine = false;
    }
    if (!genuine) {
      rejected.push(row.id);
      continue;
    }
    verified.add(row.id);
    const original = row.duplicate_of;
    if (
      original !== null &&
      (original.outcome === "processed" || verified.has(original.id))
    ) {
      duplicate.push(row.id);
      continue;
    }
    fresh.push(row.id);
    let named: readonly string[] | "everything";
    try {
      named = inbound.hints(arrived);
    } catch {
      unreadable += 1;
      named = "everything";
    }
    if (named === "everything") everything = true;
    else for (const hint of named) hints.add(hint);
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
  };
}
