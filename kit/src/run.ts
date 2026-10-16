import {
  agreedState,
  carried,
  changedInMarfa,
  laterThan,
  mark,
  noteWaiting,
  sideOf,
  type Agreement,
} from "./agreement.js";
import type {
  PendingInbound,
  InboundRetryCapability,
  CheckpointResult,
  ScopedRunContext,
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
  Target,
  WatchContext,
} from "./define.js";
import { Connections, connectionsKey, type Carried } from "./connections.js";
import type { Environment } from "./environment.js";
import { collect, type Collected } from "./inbound.js";
import { cap, keepSecret, reportCap, type Logger } from "./log.js";
import {
  Refusal,
  causeOf,
  retryAfterOf,
  type Cause,
  type Edge,
  type Marfa,
} from "./marfa.js";
import {
  carriable,
  forRow,
  watchedFields,
  cascaded,
  connectKey,
  Declined,
  LinkTaken,
  Refused,
  Rows,
  stateKey,
  Stopped,
  Unreachable,
  type Counts,
  type Spec,
} from "./rows.js";
import { instant } from "./values.js";
import type { Narrowed } from "./own-types.js";
import type { Clock } from "./runtime.js";
import {
  AgreementBlocked,
  type Kept,
  capBytes,
  reasonBytes,
  Store,
  withRefusal,
  purgeBytes,
  purgeOf,
  purgeRefusalLimit,
  type Purge,
} from "./store.js";
import {
  digest,
  identityKey,
  intentOf,
  fitsJournal,
  type UpsertAttempt,
} from "./inbound-retry.js";
import { Watch, type LogRead, type Seen } from "./watch.js";
import { checkedJson, intentOf as checkedEntry } from "./inbound-retry.js";
import {
  captureChange,
  restoreChange,
  publicIntent,
  outboundToken,
  type OutboundRecord,
} from "./outbound.js";

export interface RunSetup<E extends EnvDeclaration> {
  connector: Connector<E>;
  environment: Environment;
  marfa: Marfa;
  connectorId: string;
  process: string;
  logger: Logger;
  clock: Clock;
  signal: AbortSignal;
  fenced?: () => boolean;
  /** Whether the process was told to stop, which leaves a run unreported. */
  stopping?: () => boolean;
  /** The fields the server's types lack and the key may not add, which
   *  every run writes without. */
  narrowed?: Narrowed | undefined;
}

export type Trigger = "schedule" | "look";

export interface RunResult {
  readonly succeeded: boolean;
  /** Whose failure ended a run that did not succeed. */
  readonly cause: Cause | undefined;
  /** What a refusal that failed the run asked to wait, where it did. */
  readonly retryAfterMs: number | undefined;
  readonly cursor: string | undefined;
  readonly settled: boolean;
  /** What failed a run reported as failed: absent for one that succeeded,
   *  was stopped or never started. */
  readonly failure?: unknown;
}

const createKey = "@create";

const wholeAbove = 200;

const marksPerRequest = 200;

/** At about a hundred bytes each, a small part of the state's cap. */
const relinkedCap = 1000;

/** Events that move a row between states and change none of its fields. */
const quiet = new Set([
  "item.deleted",
  "item.restored",
  "item.state_changed",
  "item.purged",
]);

export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as NodeJS.ErrnoException).code;
  return `${error.message} (${code ?? cause.message})`;
}

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

const moreNote = 80;

/** The longest a single condition may be, so one never crowds out the rest. */
const conditionCap = 500;

/** The most conditions kept in the source's explicit problem snapshot. */
const keptConditions = 200;

/** The conditions that fit in a report beside counts of this length. */
function fitting(
  counts: string,
  standing: ReadonlyMap<string, string>,
): Set<string> {
  let length = counts.length;
  const shown = new Set<string>();
  for (const [key, message] of standing) {
    length += 2 + message.length;
    if (length > reportCap - moreNote) break;
    shown.add(key);
  }
  return shown;
}

function summarize(
  counts: string,
  standing: ReadonlyMap<string, string>,
  shown: ReadonlySet<string>,
): string {
  let summary = counts;
  for (const [key, message] of standing) {
    if (shown.has(key)) summary += `. ${message}`;
  }
  const more = standing.size - shown.size;
  if (more > 0) {
    summary += `. ${String(more)} more ${more === 1 ? "condition is" : "conditions are"} in the connector's log`;
  }
  return summary;
}

/** What a change sends, so the one a vendor refused is not sent again. */
function sending(change: Change): string {
  const ids = (items: readonly Item[]): string[] =>
    items.map((item) => item.id).sort();
  return mark({
    kind: change.kind,
    state: change.item.state,
    was: change.was,
    // A field the row does not hold is named alone, apart from any value.
    values: [...change.changed].sort().map((field) => {
      const value = change.item.properties[field];
      return value === undefined || value === null ? [field] : [field, value];
    }),
    connections: Object.fromEntries(
      Object.entries(change.connections ?? {}).map(([type, connected]) => [
        type,
        { added: ids(connected.added), removed: ids(connected.removed) },
      ]),
    ),
  });
}

/** How long a refused purge waits before it is asked again. */
const purgeAgainMs = 24 * 3_600_000;

export function specsOf<E extends EnvDeclaration>(
  connector: Connector<E>,
  env: EnvValues<E>,
  narrowed: Narrowed | undefined,
): Map<string, Spec> {
  const carried = new Set(
    connector.onChange === undefined
      ? []
      : (connector.carries?.(env) ??
          connector.types.map((kind) => kind.type.id)),
  );
  return new Map(
    connector.types.map((kind) => {
      const twoWay = carried.has(kind.type.id);
      const omitted = new Set(narrowed?.fields.get(kind.type.id) ?? []);
      const kept = (names: readonly string[]): string[] =>
        names.filter((name) => !omitted.has(name));
      const fields = kept(kind.fields);
      const readOnly = new Set(twoWay ? kept(kind.readOnly ?? []) : fields);
      const link = kind.type.link_field;
      if (link !== undefined) readOnly.add(link);
      return [
        kind.type.id,
        {
          policy: kind.policy,
          type: kind.type.id,
          source: connector.source,
          link,
          fields,
          omitted,
          readOnly,
          derived: new Set(kept(kind.derived ?? [])),
          twoWay,
          revive: kind.revive === true,
          connections: new Set(
            (connector.connections ?? [])
              .filter((connection) =>
                connection.source_type_constraints?.includes(kind.type.id),
              )
              .map((connection) => connection.id),
          ),
        },
      ];
    }),
  );
}

export function observe(
  kind: Spec,
  seen: Seen,
  agreement: Agreement,
): { next: Agreement; own: number } {
  let waiting: Record<string, string> = { ...agreement.waiting };
  Reflect.deleteProperty(waiting, stateKey);
  let stateSince = agreement.waiting?.[stateKey];
  let state = agreement.state;
  let stateBy = agreement.stateBy;
  let stateAt = agreement.stateAt;
  let own = 0;
  for (const { item } of seen.frames) {
    const policy = forRow(kind, item);
    if (policy.owned === false) continue;
    const fieldsToWatch = watchedFields(policy);
    if (
      item.state === state &&
      changedInMarfa(agreement, fieldsToWatch, item.properties).length === 0
    ) {
      own += 1;
    }
    const fields =
      noteWaiting(
        { ...agreement, waiting },
        fieldsToWatch,
        item.properties,
        item.updated_at,
      ) ?? {};
    for (const key of Object.keys(waiting)) {
      if (!key.startsWith("@")) Reflect.deleteProperty(waiting, key);
    }
    waiting = { ...waiting, ...fields };
    if (item.state === "trashed" && cascaded(item) && state !== "trashed") {
      state = "trashed";
      stateBy = "cascade";
      stateAt = item.updated_at;
      stateSince = undefined;
      continue;
    }
    const after = laterThan(item.updated_at, stateAt);
    if (stateBy === "cascade" && item.state !== "trashed" && after) {
      state = agreedState(item.state);
      stateBy = undefined;
    }
    // A person moved it: whatever state follows is theirs.
    if (stateBy === "vendor" && item.state !== state && after) {
      stateBy = undefined;
    }
    stateSince =
      policy.twoWay && item.state !== state
        ? (stateSince ?? item.updated_at)
        : undefined;
  }
  if (stateSince !== undefined) waiting[stateKey] = stateSince;
  const next: Agreement = { ...agreement, state };
  Reflect.deleteProperty(next, "waiting");
  Reflect.deleteProperty(next, "stateBy");
  Reflect.deleteProperty(next, "stateAt");
  if (stateBy !== undefined) next.stateBy = stateBy;
  if (stateBy !== undefined && stateAt !== undefined) next.stateAt = stateAt;
  if (Object.keys(waiting).length > 0) next.waiting = waiting;
  if (!carriable(next.waiting)) {
    Reflect.deleteProperty(next, "refused");
    Reflect.deleteProperty(next, "made");
  }
  return { next, own };
}

function connectionTypes<E extends EnvDeclaration>(
  connector: Connector<E>,
): Set<string> {
  return new Set((connector.connections ?? []).map((kind) => kind.id));
}

function sumOf(counts: readonly Counts[]): Counts {
  const total: Counts = {
    created: 0,
    updated: 0,
    archived: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
  };
  for (const each of counts) {
    for (const key of Object.keys(total) as (keyof Counts)[]) {
      total[key] += each[key];
    }
  }
  return total;
}

/** JSON is the durable contract: reject values JSON.stringify would silently lose. */
function jsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value))
    throw new Error("checkpoint state must be JSON-compatible");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("checkpoint state must be JSON-compatible");
  }
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error("checkpoint state must be JSON-compatible");
  seen.add(value);
  try {
    return Array.isArray(value)
      ? Array.from(value, (entry) => jsonValue(entry, seen))
      : Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            jsonValue(entry, seen),
          ]),
        );
  } finally {
    seen.delete(value);
  }
}

export async function runOnce<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  trigger: Trigger,
): Promise<RunResult> {
  const { connector, logger, clock } = setup;
  const env = setup.environment.values as EnvValues<E>;
  interface Scope {
    name: string;
    retry?: InboundRetryCapability;
    journal: Map<string, PendingInbound | null>;
    ids: Set<string>;
    blocked?: "row-refused" | "connection-unresolved";
  }
  const scopes = new Map<string, Scope>();
  const owners = new Map<string, Set<Scope | undefined>>();
  let activeScope: Scope | undefined;
  const phase = {
    mutating: false,
    reading: false,
    uncertainState: false,
    failedPrerequisite: false,
    unfinishedOperations: false,
    rootInFlight: 0,
  };
  const checkDurability = (): void => {
    if (phase.failedPrerequisite)
      throw new Error(
        "watch agreement prerequisite was not acknowledged; restart before writing again",
      );
    if (phase.unfinishedOperations)
      throw new Error(
        "scope operations were not awaited before the read ended",
      );
    if (phase.uncertainState)
      throw new Error(
        "state acknowledgment was lost; restart before writing again",
      );
    if (setup.fenced?.() === true) throw new Stopped();
  };
  const check = (): void => {
    checkDurability();
    if (setup.signal.aborted) throw new Stopped();
  };
  const store = new Store(setup.marfa, setup.connectorId, setup.process, {
    changed: (id) => {
      const ownership = owners.get(id) ?? new Set<Scope | undefined>();
      ownership.add(activeScope);
      owners.set(id, ownership);
      activeScope?.ids.add(id);
    },
    acknowledged: (id) => {
      const ownership = owners.get(id);
      ownership?.delete(undefined);
      if (ownership?.size === 0) owners.delete(id);
    },
    check: checkDurability,
  });
  const serial = async <T>(
    scope: Scope | undefined,
    work: () => Promise<T>,
  ): Promise<T> => {
    check();
    if (phase.mutating) {
      if (scope !== undefined) scope.blocked = "row-refused";
      throw new Error("scope operations must be awaited serially");
    }
    phase.mutating = true;
    activeScope = scope;
    try {
      return await work();
    } catch (error) {
      if (scope !== undefined) scope.blocked ??= "row-refused";
      throw error;
    } finally {
      activeScope = undefined;
      phase.mutating = false;
    }
  };
  // Existing unscoped callers may read several feeds concurrently. Queue
  // their shared row operations; scoped callers must await attribution.
  let rootTail: Promise<unknown> = Promise.resolve();
  const unscoped = <T>(work: () => Promise<T>): Promise<T> => {
    phase.rootInFlight += 1;
    const next = rootTail
      .then(() => serial(undefined, work))
      .finally(() => {
        phase.rootInFlight -= 1;
      });
    rootTail = next.catch(() => undefined);
    return next;
  };
  const specs = specsOf(connector, env, setup.narrowed);
  // The retry guard below must not add ownership lookups for trashed rows.
  const policyKinds = new Set(
    [...specs.values()]
      .filter((kind) => kind.policy !== undefined)
      .map((kind) => kind.type),
  );
  const twoWay = [...specs.values()].some((spec) => spec.twoWay);
  const raised = new Map<string, string>();
  for (const [type, condition] of setup.narrowed?.conditions ?? []) {
    raised.set(`type-fields:${type}`, condition);
  }
  const unreachedKeys = new Set<string>();
  const unreachedBatches: { prefixes: string[]; exceptKeys: string[] }[] = [];
  const waiting = new Map<string, { message: string; ids: Set<string> }>();
  const unreached = (id: string, error: Unreachable): void => {
    if (error.scope === undefined) {
      raised.set(`unreachable:${id}`, error.message);
      return;
    }
    const scope = waiting.get(error.scope);
    if (scope === undefined) {
      waiting.set(error.scope, { message: error.message, ids: new Set([id]) });
    } else {
      scope.ids.add(id);
    }
  };
  const refusedOf = (
    id: string,
    kind: ChangeKind,
    reason: string | undefined,
    remembered = true,
  ): void => {
    const change =
      kind === "trashed" ? `the trash of ${id}` : `the change to ${id}`;
    const what = !remembered
      ? `${change} was refused, and the row's agreement has no room to remember the refusal, so it is sent again next run`
      : kind === "trashed"
        ? `${change} was refused, so it waits until the row is restored in Marfa`
        : `${change} was refused, so it waits until the row changes in Marfa`;
    raised.set(
      `change-refused:${id}`,
      `${what}: ${reason ?? "its reason was too long to keep"}`,
    );
  };
  // What a refusal names is kept with the row, so it stands until settled,
  // but never at the cost of the row's agreement.
  const refuse = (id: string, change: Change, error: Refused): void => {
    const said = logger.redact(error.message);
    const agreement = store.get(id);
    const marked =
      agreement === undefined
        ? undefined
        : withRefusal(agreement, sending(change), said);
    refusedOf(id, change.kind, said, marked !== undefined);
    if (marked !== undefined) store.set(id, marked);
  };
  const refusedBefore = (
    id: string,
    agreement: Agreement,
    change: Change,
  ): boolean => {
    const refused = agreement.refused;
    if (refused?.change !== sending(change)) return false;
    refusedOf(id, change.kind, refused.reason);
    return true;
  };
  const purgeRefusedOf = (id: string, reason: string | undefined): void => {
    raised.set(
      `change-refused:${id}`,
      `the purge of ${id} was refused, so it is asked again a day after: ${reason ?? "its reason was too long to keep"}`,
    );
  };
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
  let acknowledged: Kept = structuredClone(stored);
  const draft = structuredClone(stored.state);
  const outbound = new Map(
    (stored.outbound ?? []).map((record) => [record.change.item.id, record]),
  );
  let activeOutbound:
    | { change: Change; operation: "change" | "remake"; moved?: Carried }
    | undefined;
  let outboundBusy = false;
  let outboundRetryAt = stored.outboundRetryAt;
  const checkVendorRetry = (): void => {
    if (outboundRetryAt === undefined) return;
    if (Date.parse(outboundRetryAt) > clock.now().getTime())
      throw new Unreachable(`vendor requests wait until ${outboundRetryAt}`, {
        retryAt: outboundRetryAt,
      });
    outboundRetryAt = undefined;
  };
  const recovered = new Set<string>();
  const suspendedOutbound = new Set<string>();
  // An uncertain write must keep its local row until it can be recovered.
  // Reuse ownership admission so mirrors, inbound writes and connections
  // cannot replace it while another kind continues to sync.
  for (const type of new Set(
    [...outbound.values()].map((one) => one.change.item.type),
  )) {
    const original = specs.get(type);
    if (original === undefined) continue;
    specs.set(type, {
      ...original,
      policy(item, entry) {
        const policy = original.policy?.(item, entry);
        const held = [...outbound.values()].some((one) => {
          const captured = one.change.item;
          if (captured.type !== type || !suspendedOutbound.has(captured.id))
            return false;
          if (item?.id === captured.id) return true;
          if (entry === undefined) return false;
          const link =
            original.link === undefined
              ? undefined
              : (one.agreement?.link ?? captured.properties[original.link]);
          return (
            entry.source_id === captured.source_id ||
            (original.link !== undefined &&
              typeof link === "string" &&
              entry.properties[original.link] === link) ||
            (one.change.kind === "created" && link === undefined)
          );
        });
        return held ? { ...policy, owned: false } : (policy ?? {});
      },
    });
  }
  const refusedOutbound = new Map<
    string,
    { change: Change; reason?: string }
  >();
  let narrowed: Promise<string[]> | undefined;
  const retryOwners = new Map<string, Scope>();
  const retryContext = (scope: Scope): string =>
    digest({
      caller: scope.retry?.context,
      declarations: JSON.parse(
        JSON.stringify(
          connector.types.map((kind) => ({
            type: kind.type,
            fields: kind.fields,
            readOnly: kind.readOnly,
            derived: kind.derived,
          })),
        ),
      ) as unknown,
      connections: JSON.parse(
        JSON.stringify(connector.connections ?? []),
      ) as unknown,
      // A write the narrowing changed is a different write.
      ...(setup.narrowed !== undefined && {
        narrowed: Object.fromEntries(setup.narrowed.fields),
      }),
    });
  const journalFor = (scope?: Scope): PendingInbound[] => {
    const entries = new Map(
      (acknowledged.inbound ?? []).map((record) => [
        identityKey(record.identity.type, record.identity.sourceId),
        record,
      ]),
    );
    for (const [key, record] of scope?.journal ?? []) {
      if (record === null) entries.delete(key);
      else entries.set(key, record);
    }
    return [...entries.values()];
  };
  const due = (scope: Scope, record: PendingInbound): boolean =>
    scope.retry !== undefined &&
    (record.context !== retryContext(scope) ||
      clock.now().getTime() >= Date.parse(record.dueAt));
  const ownRetry = (scope: Scope, key: string): boolean => {
    const owner = retryOwners.get(key);
    const saved = (acknowledged.inbound ?? []).find(
      (record) =>
        identityKey(record.identity.type, record.identity.sourceId) === key,
    );
    if (
      (owner !== undefined && owner !== scope) ||
      (saved !== undefined && saved.scope !== scope.name)
    ) {
      scope.blocked = "row-refused";
      return false;
    }
    retryOwners.set(key, scope);
    return true;
  };
  const archiveRetries = (type: string, key: string): PendingInbound[] => {
    const scope = activeScope;
    if (scope?.retry === undefined) return [];
    return journalFor(scope).filter(
      (record) =>
        record.identity.type === type &&
        (specs.get(type)?.link !== undefined
          ? record.identity.link
          : record.identity.sourceId) === key &&
        record.scope === scope.name &&
        record.mode === scope.retry?.mode,
    );
  };
  const hooks = {
    narrowed: () =>
      (narrowed ??= setup.marfa.narrower(
        new Set(connector.types.map((kind) => kind.type.id)),
        new Set((connector.connections ?? []).map((kind) => kind.id)),
      )),
    refused: (sourceId: string, reason: string) =>
      raised.set(
        `refused:${sourceId}`,
        `the server refused ${sourceId}: ${reason}`,
      ),
    omitted: () => {
      if (activeScope !== undefined) activeScope.blocked = "row-refused";
    },
    suppressed: (type: string, entry: Entry): boolean => {
      const scope = activeScope;
      if (scope?.retry === undefined) return false;
      const key = identityKey(type, entry.source_id);
      const saved = journalFor(scope).find(
        (record) =>
          identityKey(record.identity.type, record.identity.sourceId) === key,
      );
      if (saved === undefined) return false;
      if (!ownRetry(scope, key)) return false;
      if (saved.mode !== scope.retry.mode) {
        scope.blocked = "row-refused";
        return false;
      }
      try {
        return (
          saved.fingerprint === digest(intentOf(type, entry)) &&
          !due(scope, saved)
        );
      } catch {
        scope.blocked = "row-refused";
        return false;
      }
    },
    captureUpsert: (type: string, entry: Entry): UpsertAttempt | undefined => {
      const scope = activeScope;
      if (scope?.retry === undefined) return undefined;
      try {
        const intent = intentOf(type, entry);
        const link = lanes.get(type)?.rows.linkOf(intent.entry.properties);
        return {
          intent,
          fingerprint: digest(intent),
          context: retryContext(scope),
          identity: {
            type,
            sourceId: intent.entry.source_id,
            ...(link !== undefined && { link }),
          },
        };
      } catch {
        return undefined;
      }
    },
    upsertRefused: (
      captured: UpsertAttempt,
      error: Refusal,
      singleton: boolean,
      refusedInsert: boolean,
    ): false | "new" | "retained" => {
      const scope = activeScope;
      if (
        scope?.retry === undefined ||
        (error.code !== "invalid_properties" &&
          !(singleton && error.code === "request_too_large"))
      )
        return false;
      try {
        const { intent, identity, fingerprint, context } = captured;
        const key = identityKey(identity.type, identity.sourceId);
        if (!ownRetry(scope, key)) return false;
        const reason = logger.redact(error.detail);
        const boundedReason = capBytes(reason, reasonBytes);
        const record: PendingInbound = {
          identity,
          scope: scope.name,
          operation: "upsert",
          ...(refusedInsert && { refusedInsert: true }),
          fingerprint,
          context,
          code: error.code,
          reason:
            boundedReason === reason
              ? reason
              : `${capBytes(reason, reasonBytes - 14)} [abbreviated]`,
          attemptedAt: clock.now().toISOString(),
          dueAt: new Date(
            clock.now().getTime() + 24 * 60 * 60 * 1000,
          ).toISOString(),
          ...(scope.retry.mode === "replay"
            ? { mode: "replay" as const, intent }
            : { mode: "refetch" as const }),
        };
        scope.journal.set(key, record);
        if (!fitsJournal(journalFor(scope))) {
          scope.blocked = "row-refused";
          return false;
        }
        const retained = (acknowledged.inbound ?? []).some(
          (saved) =>
            identityKey(saved.identity.type, saved.identity.sourceId) === key &&
            saved.identity.link === identity.link &&
            saved.scope === scope.name &&
            saved.mode === scope.retry?.mode &&
            saved.fingerprint === fingerprint &&
            saved.context === context &&
            saved.code === error.code,
        );
        return retained ? "retained" : "new";
      } catch {
        return false;
      }
    },
    upserted: (type: string, entry: Entry): void => {
      const scope = activeScope;
      const key = identityKey(type, entry.source_id);
      const saved = journalFor(scope).find(
        (record) =>
          identityKey(record.identity.type, record.identity.sourceId) === key,
      );
      if (saved === undefined) return;
      if (scope?.retry === undefined) {
        if (scope !== undefined) scope.blocked = "row-refused";
        return;
      }
      if (ownRetry(scope, key)) scope.journal.set(key, null);
    },
    archivePending: (type: string, key: string): boolean =>
      archiveRetries(type, key).length > 0,
    archived: (type: string, key: string, absent = false): void => {
      const scope = activeScope;
      if (scope === undefined) return;
      for (const record of archiveRetries(type, key)) {
        if (absent && record.refusedInsert !== true) continue;
        const identity = identityKey(type, record.identity.sourceId);
        if (ownRetry(scope, identity)) scope.journal.set(identity, null);
      }
    },
    inboundRefused: () => {
      if (activeScope !== undefined) activeScope.blocked = "row-refused";
    },
    condition: (key: string, message: string) => {
      raised.set(key, message);
      if (activeScope !== undefined && key.startsWith("connection-refused:")) {
        activeScope.blocked = "connection-unresolved";
      }
    },
    fenced: () =>
      phase.uncertainState ||
      phase.failedPrerequisite ||
      phase.unfinishedOperations ||
      setup.fenced?.() === true,
  };
  const lanes = new Map(
    [...specs.values()].map((spec) => [
      spec.type,
      {
        spec,
        rows: new Rows(setup.marfa, spec, store, setup.signal, hooks),
      },
    ]),
  );
  const connections = new Connections(
    setup.marfa,
    new Map((connector.connections ?? []).map((kind) => [kind.id, kind])),
    lanes,
    store,
    hooks,
    setup.signal,
  );
  const lane = (type: string): { spec: Spec; rows: Rows } => {
    const found = lanes.get(type);
    if (found === undefined) {
      throw new Error(`the connector declares no type ${type}`);
    }
    return found;
  };
  const inLane = (
    id: string,
  ): { item: Item; spec: Spec; rows: Rows } | undefined => {
    for (const { spec, rows } of lanes.values()) {
      const item = rows.known(id);
      if (item !== undefined) return { item, spec: forRow(spec, item), rows };
    }
    return undefined;
  };
  const asked = new Set<string>();
  const fetchRows = async (ids: Iterable<string>): Promise<void> => {
    const fresh = [...new Set(ids)].filter(
      (id) => !asked.has(id) && inLane(id) === undefined,
    );
    if (fresh.length === 0) return;
    const [first] = specs.keys();
    if (first === undefined) return;
    const found = await setup.marfa.lookup(first, { ids: fresh });
    for (const id of fresh) asked.add(id);
    for (const item of found.data) lanes.get(item.type)?.rows.adopt(item);
  };
  const find = async (
    id: string,
  ): Promise<{ item: Item; spec: Spec; rows: Rows } | undefined> => {
    await fetchRows([id]);
    const found = inLane(id);
    if (found?.spec.policy !== undefined) {
      const fresh = await setup.marfa.item(id);
      if (fresh?.type !== found.spec.type) return undefined;
      found.rows.adopt(fresh);
      return inLane(id);
    }
    return found;
  };
  const settlePurge = async (
    kind: Spec,
    item: Item,
    answered: Entry | undefined,
  ): Promise<void> => {
    const until = instant(answered?.changed_at);
    if (until === undefined) return;
    const link = lane(kind.type).rows.linkOf(item.properties);
    if (link !== undefined) {
      await setup.marfa.settleTombstones(kind.type, { links: [link] }, until);
    }
    if (item.source === kind.source && item.source_id !== undefined) {
      await setup.marfa.settleTombstones(
        kind.type,
        { source: kind.source, source_ids: [item.source_id] },
        until,
      );
    }
  };
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
    unreached: ({ keys = [], prefixes = [], exceptKeys = [] }) => {
      for (const key of keys) unreachedKeys.add(key);
      unreachedBatches.push({
        prefixes: [...prefixes],
        exceptKeys: [...exceptKeys],
      });
    },
  };
  let hints: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  const secret = (value: string): void => {
    keepSecret(logger, value);
  };
  const written: RunContext<E>["written"] = (type) => [
    ...lane(type).spec.fields,
  ];
  const pendingOutbound: RunContext<E>["pendingOutbound"] = () =>
    [...outbound.values()]
      .filter((record) => record.rejected === undefined)
      .map(publicIntent);
  const waitUntil: RunContext<E>["waitUntil"] = async (retryAt) => {
    check();
    const delay = new Unreachable("vendor rate limit", { retryAt });
    rememberVendorRetry(delay);
    phase.rootInFlight += 1;
    try {
      await unscoped(saveOutbound);
      for (;;) {
        check();
        if (acknowledged.outboundRetryAt !== outboundRetryAt) {
          await unscoped(saveOutbound);
          continue;
        }
        const left =
          outboundRetryAt === undefined
            ? 0
            : Date.parse(outboundRetryAt) - clock.now().getTime();
        if (left > 0) {
          await clock.sleep(left, setup.signal);
          continue;
        }
        const cleared = await unscoped(async () => {
          if (
            outboundRetryAt !== undefined &&
            Date.parse(outboundRetryAt) > clock.now().getTime()
          )
            return false;
          outboundRetryAt = undefined;
          await saveOutbound();
          return true;
        });
        if (cleared && outboundRetryAt === undefined) return;
      }
    } finally {
      phase.rootInFlight -= 1;
    }
  };
  const context: RunContext<E> = {
    waitUntil,
    pendingOutbound,
    env,
    signal: setup.signal,
    state,
    log,
    secret,
    get hints() {
      return hints;
    },
    forScope: (name, options) => {
      if (name.length === 0) throw new Error("a scope needs a name");
      if (
        options !== undefined &&
        (!/^[a-f0-9]{64}$/.test(options.retry.context) ||
          !["refetch", "replay"].includes(options.retry.mode))
      )
        throw new Error(
          "retry capability needs a mode and full nonsecret SHA-256 context",
        );
      const existing = scopes.get(name);
      if (
        existing !== undefined &&
        JSON.stringify(existing.retry) !== JSON.stringify(options?.retry)
      )
        throw new Error(
          "scope retry capability must stay consistent within a run",
        );
      const scope: Scope = existing ?? {
        name,
        ...(options !== undefined && { retry: { ...options.retry } }),
        journal: new Map(),
        ids: new Set<string>(),
      };
      scopes.set(name, scope);
      const scoped: ScopedRunContext<E> = {
        waitUntil,
        pendingOutbound,
        refusals: {
          pending: () =>
            (acknowledged.inbound ?? [])
              .filter((record) => record.scope === name)
              .map((record) => ({
                record: structuredClone(record),
                due: due(scope, record),
              })),
        },
        env,
        signal: setup.signal,
        log,
        secret,
        get hints() {
          return hints;
        },
        state: {
          get: (key) =>
            Object.hasOwn(acknowledged.state, key)
              ? structuredClone(acknowledged.state[key])
              : undefined,
          checkpoint: (key, value) =>
            serial(scope, () => checkpoint(scope, key, value)),
        },
        upsert: (type, entries) =>
          serial(scope, () => lane(type).rows.upsert(entries)),
        archive: (type, keys) =>
          serial(scope, () => lane(type).rows.archive(keys)),
        derive: (type, keys, values) =>
          serial(scope, () => lane(type).rows.derive(keys, values)),
        linked: (...args) => serial(scope, () => linked(...args)),
        known: (type, keys) => serial(scope, () => known(type, keys)),
        held: (type, options) => serial(scope, () => heldRows(type, options)),
        inspect: (type, by) => serial(scope, () => inspect(type, by)),
        written,
      };
      return scoped;
    },
    upsert: (type, entries) => unscoped(() => lane(type).rows.upsert(entries)),
    archive: (type, keys) => unscoped(() => lane(type).rows.archive(keys)),
    derive: (type, keys, values) =>
      unscoped(() => lane(type).rows.derive(keys, values)),
    linked: (...args) => unscoped(() => linked(...args)),
    known: (type, keys) => unscoped(() => known(type, keys)),
    held: (type, options) => unscoped(() => heldRows(type, options)),
    inspect: (type, by) => unscoped(() => inspect(type, by)),
    written,
  };
  const inspect: RunContext<E>["inspect"] = async (type, by) => {
    const { spec } = lane(type);
    const found = await setup.marfa.lookup(
      type,
      "links" in by ? by : { source: spec.source, source_ids: by.source_ids },
    );
    return structuredClone({ items: found.data, tombstones: found.tombstones });
  };
  const known: RunContext<E>["known"] = async (type, keys) => {
    const { rows } = lane(type);
    const found = await rows.named(keys);
    const told = await rows.told([...found.values()]);
    return new Set(
      [...found].filter(([, row]) => told.has(row.id)).map(([key]) => key),
    );
  };
  const linked: RunContext<E>["linked"] = async (type, connection, target) => {
    const { rows } = lane(type);
    if (!specs.get(type)?.connections.has(connection)) {
      throw new Error(`${type} declares no connection ${connection}`);
    }
    const held = (await lane(target.type).rows.named([target.id])).get(
      target.id,
    );
    if (held === undefined) return [];
    const found = await setup.marfa.connectedTo(type, connection, held.id);
    const told = await rows.told(found);
    return found
      .filter((row) => {
        if (!told.has(row.id)) return false;
        const named =
          rows.connecting.get(row.id)?.connections[connection] ??
          answeredConnections.get(row.id)?.[connection];
        return (
          named === undefined ||
          named.some((one) => one.type === target.type && one.id === target.id)
        );
      })
      .map((row) => {
        rows.adopt(row);
        return structuredClone(row);
      });
  };
  const heldRows: RunContext<E>["held"] = async (type, options) => {
    const { rows, spec } = lane(type);
    const state = options?.state ?? "active";
    const found = await setup.marfa.ownRows(type, state);
    return found
      .filter(
        (row) =>
          row.type === type &&
          (state === "any" || row.state === "active") &&
          (options?.includeUnlinked === true ||
            (spec.link === undefined ||
            (state === "any" && row.source === spec.source)
              ? row.source === spec.source
              : rows.linkOf(row.properties) !== undefined)),
      )
      .map((row) => {
        rows.adopt(row);
        return structuredClone(row);
      });
  };
  const callChange = (change: Change) => {
    if (connector.onChange === undefined)
      throw new Error("no outbound handler");
    return connector.onChange(change, watchContext);
  };
  const callRemake = (change: Change) => {
    if (connector.remake === undefined) throw new Error("no remake handler");
    return connector.remake(change, watchContext);
  };
  const watchContext: WatchContext<E> = {
    env,
    signal: setup.signal,
    state,
    waitUntil,
    outbound: {
      get: (id) => {
        const record = outbound.get(id);
        return record === undefined ? undefined : publicIntent(record);
      },
      save: async (change, intent) => {
        check();
        if (
          activeOutbound === undefined ||
          digest(captureChange(change)) !==
            digest(captureChange(activeOutbound.change))
        )
          throw new Error("outbound intent must capture the active change");
        if (outboundBusy)
          throw new Error("outbound journal operations must be awaited");
        const agreement = store.get(change.item.id);
        const content = checkedJson({
          change: captureChange(activeOutbound.change),
          request: intent.request,
          baseline: intent.baseline,
          operation: activeOutbound.operation,
          ...(agreement !== undefined && { agreement }),
          ...(activeOutbound.moved !== undefined && {
            moved: activeOutbound.moved,
          }),
        }) as Omit<
          OutboundRecord,
          | "token"
          | "acknowledged"
          | "answer"
          | "confirmationAgreement"
          | "rejected"
        >;
        const token = outboundToken(content);
        const held = outbound.get(change.item.id);
        if (held !== undefined) {
          if (held.token !== token)
            throw new Error("a pending outbound intent cannot be replaced");
          return publicIntent(held);
        }
        const record: OutboundRecord = {
          ...content,
          token,
          acknowledged: false,
        };
        outbound.set(change.item.id, record);
        await saveOutbound();
        return publicIntent(record);
      },
      advance: async (id, token, intent) => {
        check();
        const held = outbound.get(id);
        if (
          activeOutbound?.change.item.id !== id ||
          outboundBusy ||
          held?.token !== token ||
          held.acknowledged
        )
          throw new Error("advance requires the active unacknowledged intent");
        const content = checkedJson({
          change: held.change,
          operation: held.operation,
          ...(held.agreement !== undefined && { agreement: held.agreement }),
          ...(held.moved !== undefined && { moved: held.moved }),
          request: intent.request,
          baseline: intent.baseline,
        }) as Omit<
          OutboundRecord,
          | "token"
          | "acknowledged"
          | "answer"
          | "confirmationAgreement"
          | "rejected"
          | "requestNotApplied"
        >;
        const record: OutboundRecord = {
          ...content,
          token: outboundToken(content),
          acknowledged: false,
        };
        outbound.set(id, record);
        await saveOutbound();
        return publicIntent(record);
      },
      prepareRetry: async (id, token) => {
        check();
        const held = outbound.get(id);
        if (
          activeOutbound?.change.item.id !== id ||
          outboundBusy ||
          held?.token !== token ||
          held.acknowledged ||
          held.requestNotApplied !== true
        )
          throw new Error(
            "retry requires the active intent and known-no-apply evidence",
          );
        const next = { ...held };
        Reflect.deleteProperty(next, "requestNotApplied");
        outbound.set(id, next);
        await saveOutbound();
      },
      acknowledge: async (id, token, answer) => {
        check();
        if (activeOutbound?.change.item.id !== id || outboundBusy)
          throw new Error(
            "outbound acknowledgment must belong to the active change and be awaited",
          );
        const held = outbound.get(id);
        if (held?.token !== token)
          throw new Error("outbound intent token does not match");
        const entry =
          answer === undefined
            ? undefined
            : checkedEntry(held.change.item.type, answer).entry;
        if (held.acknowledged) {
          if (digest(held.answer ?? null) !== digest(entry ?? null))
            throw new Error("outbound acknowledgment cannot be replaced");
          return;
        }
        const confirmationAgreement = store.get(id);
        outbound.set(id, {
          ...held,
          acknowledged: true,
          ...(entry !== undefined && { answer: entry }),
          ...(confirmationAgreement !== undefined && {
            confirmationAgreement: structuredClone(confirmationAgreement),
          }),
        });
        await saveOutbound();
      },
    },
    log,
    secret,
    setLink: (item, value) => lane(item.type).rows.setLink(item, value),
  };

  let read: LogRead | undefined;
  let pushed = 0;
  let own = 0;
  let collected: Collected | undefined;
  const whole = trigger === "schedule";
  // A failure reading deliveries is a condition, and the vendor is still read
  // whole.
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
  const purged = new Map<string, Purge>(
    (stored.purges ?? []).map((purge) => [purge.id, purge]),
  );
  const refusals = (purge: Purge): number =>
    purge.refused === undefined ? 0 : (purge.refused.count ?? 1);
  // Past what the state may hold, the ones the vendor has refused most go
  // first, so they leave room for the rest of the state. Only the last save
  // gives them up, once the run has asked the vendor for every one; a save
  // before that keeps the same list and leaves them to be carried.
  const keepPurges = (final = false): Purge[] => {
    if (connector.preflight !== undefined) return [...purged.values()];
    const ranked = [...purged.values()].sort(
      (a, b) => refusals(a) - refusals(b),
    );
    let bytes = 0;
    const kept: Purge[] = [];
    const dropped: Purge[] = [];
    for (const purge of ranked) {
      bytes += Buffer.byteLength(JSON.stringify(purge)) + 1;
      (bytes > purgeBytes ? dropped : kept).push(purge);
    }
    if (final && dropped.length > 0) {
      for (const purge of dropped) purged.delete(purge.id);
      raised.set(
        "purges-given-up",
        `${String(dropped.length)} ${dropped.length === 1 ? "purge was" : "purges were"} given up, since the state keeps at most ${String(purgeBytes / 1024)} KiB of them and more waited: the vendor may still hold ${dropped.length === 1 ? "that row" : "those rows"}`,
      );
    }
    return kept;
  };
  const relinked = new Map(
    Object.entries(stored.relinked?.rows ?? {}).filter(
      ([, row]) => specs.get(row.type)?.twoWay === true,
    ),
  );
  let overflowed = stored.relinked?.overflowed === true;
  let overflowing = false;
  const envelope = (
    vendorState: Record<string, unknown>,
    inbound = acknowledged.inbound ?? [],
  ): Kept => ({
    ...(outboundRetryAt !== undefined && { outboundRetryAt }),
    ...(outbound.size > 0 && { outbound: [...outbound.values()] }),
    ...(purged.size > 0 && { purges: keepPurges() }),
    ...(inbound.length > 0 && { inbound }),
    state: vendorState,
    conditions: Object.fromEntries(
      [
        ...[
          ...Object.entries(acknowledged.conditions),
          ...[...raised].map(
            ([key, message]) =>
              [
                logger.redact(key),
                cap(logger.redact(message), conditionCap),
              ] as const,
          ),
        ]
          .reduce(
            (map, [key, message]) => map.set(key, message),
            new Map<string, string>(),
          )
          .entries(),
      ].slice(0, keptConditions),
    ),
    ...(acknowledged.cursor !== undefined && { cursor: acknowledged.cursor }),
    ...((relinked.size > 0 || overflowed) && {
      relinked: {
        rows: Object.fromEntries(relinked),
        ...(overflowed && { overflowed: true as const }),
      },
    }),
  });
  const saveOutbound = async (): Promise<void> => {
    check();
    if (outboundBusy)
      throw new Error("outbound journal operations must be awaited");
    outboundBusy = true;
    try {
      const snapshot = envelope(acknowledged.state);
      await store.save(snapshot);
      check();
      acknowledged = structuredClone(snapshot);
    } catch (error) {
      phase.uncertainState = true;
      throw error;
    } finally {
      outboundBusy = false;
    }
  };
  const rememberVendorRetry = (error: Unreachable, itemId?: string): void => {
    if (error.retryAt === undefined) return;
    if (
      outboundRetryAt === undefined ||
      Date.parse(error.retryAt) > Date.parse(outboundRetryAt)
    )
      outboundRetryAt = error.retryAt;
    if (error.requestNotApplied === true && itemId !== undefined) {
      const held = outbound.get(itemId);
      if (held !== undefined && !held.acknowledged)
        outbound.set(itemId, { ...held, requestNotApplied: true });
    }
  };
  const keepVendorRetry = async (
    error: unknown,
    itemId?: string,
  ): Promise<void> => {
    if (!(error instanceof Unreachable) || error.retryAt === undefined) return;
    rememberVendorRetry(error, itemId);
    await saveOutbound();
  };
  const invoke = async <T>(
    change: Change,
    operation: "change" | "remake",
    callback: () => Promise<T>,
    moved?: Carried,
  ): Promise<T> => {
    check();
    checkVendorRetry();
    activeOutbound = {
      change: structuredClone(change),
      operation,
      ...(moved !== undefined && { moved }),
    };
    try {
      const result = await callback();
      checkDurability();
      if (outboundBusy || phase.rootInFlight > 0) {
        phase.unfinishedOperations = true;
        throw new Error("outbound journal operations were not awaited");
      }
      const pending = outbound.get(change.item.id);
      if (pending !== undefined && !pending.acknowledged)
        throw new Error("outbound success requires a durable acknowledgment");
      return result;
    } catch (error) {
      if (error instanceof Refused && change.kind !== "purged") {
        const held = outbound.get(change.item.id);
        if (held !== undefined && !held.acknowledged) {
          outbound.set(change.item.id, {
            ...held,
            rejected: capBytes(logger.redact(error.message), reasonBytes),
          });
          await saveOutbound();
        }
      }
      await keepVendorRetry(error, change.item.id);
      throw error;
    } finally {
      activeOutbound = undefined;
    }
  };
  const finishOutbound = async (id: string): Promise<void> => {
    if (!outbound.has(id)) return;
    check();
    try {
      await store.flush([id], check);
    } catch (error) {
      phase.failedPrerequisite = true;
      throw error;
    }
    outbound.delete(id);
    await saveOutbound();
  };
  const releaseRefused = async (change: Change): Promise<boolean> => {
    const held = refusedOutbound.get(change.item.id);
    if (held === undefined) return true;
    const refused = held.change;
    const changed = new Set([...refused.changed, ...change.changed]);
    const current = { ...change, kind: refused.kind, changed };
    Reflect.deleteProperty(current, "was");
    if (refused.was !== undefined) Object.assign(current, { was: refused.was });
    // A confirmed create may now be an update; its link alone is no new edit.
    if (sending(current) === sending({ ...refused, changed })) {
      refusedOf(change.item.id, refused.kind, held.reason);
      return false;
    }
    await finishOutbound(change.item.id);
    refusedOutbound.delete(change.item.id);
    return true;
  };
  const overlaps = (scope: Scope): boolean =>
    [...scope.ids].some((id) => {
      const ownership = owners.get(id);
      return (
        ownership !== undefined &&
        (ownership.size !== 1 || !ownership.has(scope))
      );
    });
  const blocked = (scope: Scope): CheckpointResult | undefined =>
    scope.blocked === undefined
      ? undefined
      : { committed: false, reason: scope.blocked };
  const checkpoint = async (
    scope: Scope,
    key: string,
    value: unknown,
  ): Promise<CheckpointResult> => {
    if (!phase.reading || hints !== undefined)
      throw new Error("checkpoint requires an active full vendor read");
    if (loaded === undefined)
      throw new Error("checkpoint requires acknowledged loaded state");
    const pending = (acknowledged.inbound ?? []).filter(
      (record) => record.scope === scope.name,
    );
    if (
      pending.length > 0 &&
      (scope.retry === undefined ||
        pending.some((record) => record.mode !== scope.retry?.mode))
    )
      return { committed: false, reason: "row-refused" };
    const candidate = jsonValue(value);
    const vendorState = { ...acknowledged.state, [key]: candidate };
    const inbound = journalFor(scope);
    if (!fitsJournal(inbound))
      return { committed: false, reason: "state-oversized" };
    const fitsState = (): boolean =>
      Buffer.byteLength(
        JSON.stringify({
          ...envelope(vendorState, inbound),
          conditions: undefined,
        }),
      ) <=
      512 * 1024;
    if (!fitsState()) return { committed: false, reason: "state-oversized" };
    const refusal = blocked(scope);
    if (refusal !== undefined) return refusal;
    if (overlaps(scope)) return { committed: false, reason: "scope-overlap" };
    check();
    const named = new Map<string, Record<string, readonly Target[]>>();
    const incoming = new Map<string, Entry>();
    const captured: {
      rows: Rows;
      id: string;
      entry: Entry;
    }[] = [];
    for (const { rows } of lanes.values()) {
      for (const [id, entry] of rows.connecting) {
        if (!scope.ids.has(id)) continue;
        named.set(id, entry.connections);
        incoming.set(id, entry);
        captured.push({ rows, id, entry });
      }
    }
    await connections.connect(named, [], incoming);
    const connectionRefusal = blocked(scope);
    if (connectionRefusal !== undefined) return connectionRefusal;
    if (overlaps(scope)) return { committed: false, reason: "scope-overlap" };
    if (!fitsState()) return { committed: false, reason: "state-oversized" };
    try {
      await store.flush([...scope.ids], check);
    } catch (error) {
      if (error instanceof AgreementBlocked)
        return { committed: false, reason: error.reason };
      throw error;
    }
    for (const { rows, id, entry } of captured) {
      if (rows.connecting.get(id) === entry) rows.connecting.delete(id);
    }
    check();
    if (!fitsState()) return { committed: false, reason: "state-oversized" };
    const kept = jsonValue(envelope(vendorState, inbound)) as Kept;
    try {
      await store.save(kept);
    } catch (error) {
      // A definite 4xx refusal applied no state. Every other failure may have
      // committed it, so no old envelope may be sent after an uncertain answer.
      if (!(
        error instanceof Refusal &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500
      )) {
        phase.uncertainState = true;
      }
      throw error;
    }
    acknowledged = structuredClone(kept);
    Object.defineProperty(draft, key, {
      value: structuredClone(candidate),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    for (const id of scope.ids) {
      const ownership = owners.get(id);
      ownership?.delete(scope);
      if (ownership?.size === 0) owners.delete(id);
    }
    scope.ids.clear();
    scope.journal.clear();
    for (const [identity, owner] of retryOwners)
      if (owner === scope) retryOwners.delete(identity);
    return { committed: true };
  };

  /** A link a person changed and the row purged before a run saw it would
   *  steer the purge. The window's first frame vouches for the link it
   *  shows where it changed no field, or is the connector's own create; any
   *  later frame showing another link, or a first one that may have set it,
   *  leaves nothing vouched for. Outside the window, a link that differed
   *  from the agreed one was kept. */
  const vouched = (kind: Spec, seen: Seen): string | undefined => {
    const [first, ...rest] = seen.frames;
    if (first === undefined) return undefined;
    const { rows } = lane(kind.type);
    const own =
      first.event === "item.created" && first.item.source === kind.source;
    if (!own && (first.event === undefined || !quiet.has(first.event))) {
      return undefined;
    }
    const link = rows.linkOf(first.item.properties);
    return rest.every((frame) => rows.linkOf(frame.item.properties) === link)
      ? link
      : undefined;
  };
  /** A row holding a link other than the agreed one, as the run records
   *  it and until its put-back writes the agreed one back, keeps the agreed
   *  one here, which its purge, dropping the agreement, would otherwise
   *  lose. A row in the bin cannot have it put back, so keeps it there. */
  const keepAgreedLink = (kind: Spec, item: Item, agreement: Agreement) => {
    const own = lane(kind.type).rows.linkOf(item.properties);
    if (
      kind.link === undefined ||
      agreement.link === undefined ||
      own === agreement.link
    ) {
      relinked.delete(item.id);
      return;
    }
    if (!relinked.has(item.id) && relinked.size >= relinkedCap) {
      overflowed = true;
      overflowing = true;
      raised.set(
        "relinked-full",
        `more than ${String(relinkedCap)} rows carry a link other than the one agreed, so the agreed link of ${item.id} is not kept, and a purge the kit cannot vouch for is not carried until a resync of the log finds them again`,
      );
      return;
    }
    relinked.set(item.id, { link: agreement.link, type: kind.type });
  };
  const unagreedOf = (
    kind: Spec,
    item: Item,
    agreement: Agreement,
  ): ReadonlySet<string> | undefined => {
    const off = changedInMarfa(
      agreement,
      kind.fields.filter(
        (field) => kind.readOnly.has(field) && field !== kind.link,
      ),
      item.properties,
    );
    return off.length === 0 ? undefined : new Set(off);
  };
  let recorded = false;
  let unagreed = 0;

  const withoutWaiting = (agreement: Agreement): Agreement => {
    const next = { ...agreement };
    Reflect.deleteProperty(next, "waiting");
    return next;
  };
  const putBack = async (id: string): Promise<void> => {
    const agreement = store.get(id);
    const found = await find(id);
    if (agreement !== undefined && found?.item.state === "trashed") {
      keepAgreedLink(found.spec, found.item, agreement);
    }
    if (
      agreement?.waiting === undefined ||
      found === undefined ||
      found.spec.owned === false ||
      found.item.state === "trashed"
    ) {
      return;
    }
    const { spec: kind, rows } = found;
    let current = found.item;
    if (
      agreement.link !== undefined &&
      rows.linkOf(current.properties) !== agreement.link
    ) {
      try {
        await rows.setLink(current, agreement.link);
      } catch (error) {
        if (!(error instanceof LinkTaken)) throw error;
        raised.set(
          `link-taken:${id}`,
          `the ${kind.link ?? "link"} of ${id} was changed in Marfa and cannot be put back: ${error.message}`,
        );
        keepAgreedLink(kind, current, agreement);
        return;
      }
      current = rows.known(id) ?? current;
      keepAgreedLink(kind, current, agreement);
      raised.set(
        `link-put-back:${id}`,
        `the ${kind.link ?? "link"} of ${id} was changed in Marfa and put back, since it names the vendor's own item`,
      );
    }
    const stale = changedInMarfa(
      agreement,
      kind.fields.filter(
        (field) => kind.readOnly.has(field) && field !== kind.link,
      ),
      current.properties,
    );
    const back = stale.length === 0 ? [] : await rows.putBack(id, stale, true);
    if (back.length > 0) {
      raised.set(
        `put-back:${id}`,
        `${back.join(", ")} on ${id} ${back.length === 1 ? "was" : "were"} changed in Marfa and put back from the vendor, which Marfa mirrors`,
      );
    }
    const types = connections.typesFrom(kind.type);
    const mirrored = types.filter((type) => connections.mirrored(kind, type));
    // A create's mirrored connections place it, so they are not put back.
    const told = !kind.twoWay || agreement.link !== undefined;
    if (
      mirrored.length > 0 &&
      told &&
      agreement.waiting[connectionsKey] !== undefined
    ) {
      const edges = (await connections.edgesOf([id])).get(id)?.edges ?? [];
      store.set(
        id,
        await connections.putBack(
          current,
          kind,
          store.get(id) ?? agreement,
          edges,
        ),
      );
    }
    const waiting = { ...store.get(id)?.waiting };
    for (const field of [
      ...back,
      ...(kind.link === undefined ? [] : [kind.link]),
      ...(told && mirrored.length === types.length ? [connectionsKey] : []),
    ]) {
      Reflect.deleteProperty(waiting, field);
    }
    const now = withoutWaiting(store.get(id) ?? agreement);
    if (!carriable(waiting)) {
      Reflect.deleteProperty(now, "refused");
      Reflect.deleteProperty(now, "made");
    }
    store.set(id, {
      ...now,
      ...(Object.keys(waiting).length > 0 && { waiting }),
    });
  };
  const withWaiting = async (
    named: ReadonlyMap<string, ReadonlySet<string>>,
    ids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined> => {
    if (ids.size > wholeAbove) return undefined;
    const merged = new Map(
      [...named].map(([type, values]) => [type, new Set(values)]),
    );
    for (const id of ids) {
      const link = store.get(id)?.link;
      const found = link === undefined ? undefined : await find(id);
      if (link === undefined || found === undefined) continue;
      const values = merged.get(found.spec.type) ?? new Set<string>();
      values.add(link);
      merged.set(found.spec.type, values);
    }
    for (const [type, values] of merged) {
      lane(type).rows.archivable = values;
    }
    for (const { spec, rows } of lanes.values()) {
      rows.archivable ??= merged.get(spec.type) ?? new Set();
    }
    return merged;
  };
  const heldBack = (id: string): void => {
    raised.set(
      `create-held:${id}`,
      `${id} is not sent to the vendor until the vendor has each row its read-only connections name`,
    );
  };
  // A row a person relinked that could not be put back, being in the bin or
  // its link taken, is carried by the link the two sides agreed.
  const byAgreedLink = (kind: Spec, item: Item, agreement: Agreement): Item =>
    kind.link !== undefined &&
    agreement.link !== undefined &&
    lane(kind.type).rows.linkOf(item.properties) !== agreement.link
      ? {
          ...item,
          properties: { ...item.properties, [kind.link]: agreement.link },
        }
      : item;
  const decline = async (
    kind: Spec,
    item: Item,
    changed: readonly string[],
    error: Declined,
  ): Promise<void> => {
    const rows = lane(kind.type).rows;
    const back =
      changed.length === 0 || item.state === "trashed"
        ? []
        : await rows.putBack(item.id, changed);
    raised.set(
      `declined:${item.id}`,
      back.length === 0
        ? error.message
        : `${error.message}; ${back.join(", ")} ${back.length === 1 ? "was" : "were"} put back`,
    );
    const agreement = store.get(item.id);
    if (agreement === undefined) return;
    const waiting = { ...agreement.waiting };
    for (const key of [...back, stateKey, createKey]) {
      Reflect.deleteProperty(waiting, key);
    }
    const next: Agreement = {
      ...withoutWaiting(agreement),
      state: agreedState(item.state),
    };
    Reflect.deleteProperty(next, "attempted");
    if (Object.keys(waiting).length > 0) next.waiting = waiting;
    store.set(item.id, next);
  };
  const carry = async (
    item: Item,
    agreement: Agreement,
  ): Promise<"unplaced" | undefined> => {
    if (recovered.has(item.id)) return;
    if (setup.fenced?.() === true || setup.signal.aborted) throw new Stopped();
    const { spec, rows } = lane(item.type);
    if (policyKinds.has(item.type) || refusedOutbound.has(item.id)) {
      const fresh = await setup.marfa.item(item.id);
      if (fresh?.type !== item.type) return;
      rows.adopt(fresh);
      item = fresh;
    }
    const kind = forRow(spec, item);
    if (kind.owned === false) return;
    if (connector.onChange === undefined || !kind.twoWay) return;
    keepAgreedLink(kind, item, agreement);
    // What changed before another row's trash took it waits for its restore.
    if (agreement.stateBy === "cascade") return;
    if (item.state === "trashed" && cascaded(item)) {
      // Taken after the log was read: the log's frame will say the same.
      store.set(item.id, {
        ...agreement,
        state: "trashed",
        stateBy: "cascade",
        stateAt: item.updated_at,
      });
      return;
    }
    const carriable = watchedFields(kind).filter(
      (field) => !kind.readOnly.has(field),
    );
    const unlinked =
      kind.link !== undefined &&
      agreement.link === undefined &&
      rows.linkOf(item.properties) === undefined;
    if (
      unlinked &&
      item.state === "trashed" &&
      agreement.attempted === undefined
    ) {
      store.clear(item.id);
      return;
    }
    const current = byAgreedLink(kind, item, agreement);
    // A trash of a row whose create got no link back may still find it made.
    const changeKind: ChangeKind = unlinked
      ? current.state === "trashed"
        ? "trashed"
        : "created"
      : current.state !== agreement.state
        ? current.state === "trashed"
          ? "trashed"
          : current.state === "archived"
            ? "archived"
            : "restored"
        : "updated";
    const changed =
      changeKind === "trashed"
        ? []
        : changedInMarfa(agreement, carriable, current.properties);
    const moved =
      changeKind !== "trashed" &&
      kind.connections.size > 0 &&
      (changeKind === "created" ||
        agreement.waiting?.[connectionsKey] !== undefined)
        ? await connections.changes(
            current,
            kind,
            agreement,
            (await connections.edgesOf([current.id])).get(current.id)?.edges ??
              [],
            changeKind === "created",
          )
        : undefined;
    if (changeKind === "created" && moved?.unplaced === true) {
      return "unplaced";
    }
    const connected = Object.keys(moved?.connections ?? {}).length > 0;
    if (changeKind === "updated" && changed.length === 0 && !connected) {
      if (
        !(await releaseRefused({
          kind: changeKind,
          item: current,
          changed: new Set(),
        }))
      )
        return;
      const binned =
        current.state === "trashed" &&
        connections
          .typesFrom(kind.type)
          .some((type) => connections.mirrored(kind, type));
      const left = Object.fromEntries(
        Object.entries(agreement.waiting ?? {}).filter(
          ([key]) =>
            key === connectKey ||
            kind.readOnly.has(key) ||
            (binned && key === connectionsKey),
        ),
      );
      const next = withoutWaiting(agreement);
      Reflect.deleteProperty(next, "refused");
      Reflect.deleteProperty(next, "made");
      if (Object.keys(left).length > 0) next.waiting = left;
      store.set(current.id, settledConnections(next, moved));
      return;
    }
    if (
      hints !== undefined &&
      changeKind !== "created" &&
      (changed.length > 0 || connected) &&
      !rows.reached.has(current.id)
    ) {
      return;
    }
    const attempted = unlinked ? agreement.attempted : undefined;
    // A run that died after the link landed on the row, before the agreement
    // kept it, left the first send's time as `attempted` alone.
    const made = unlinked
      ? undefined
      : (agreement.made ??
        (agreement.link === undefined ? agreement.attempted : undefined));
    const change: Change = {
      kind: changeKind,
      item: current,
      changed: new Set(changed),
      ...(attempted !== undefined && { attempted }),
      ...(made !== undefined && { made }),
      ...(changeKind === "restored" &&
        (agreement.state === "trashed" || agreement.state === "archived") && {
          was: agreement.state,
        }),
      ...(connected &&
        moved !== undefined && { connections: moved.connections }),
      ...(agreement.refused !== undefined && {
        refused: agreement.refused.change,
      }),
    };
    const unagreed = unagreedOf(kind, current, agreement);
    if (unagreed !== undefined) Object.assign(change, { unagreed });
    const placement = await connections.placementOf(current, kind, agreement);
    if (placement !== undefined) Object.assign(change, { placement });
    if (!(await releaseRefused(change))) return;
    if (refusedBefore(current.id, agreement, change)) return;
    if (changeKind === "created") {
      // Kept before the vendor is asked, so a run that dies between its
      // answer and the link says so to the next.
      // The first try's time: a later one's would miss what the first made.
      store.set(current.id, {
        ...agreement,
        attempted: agreement.attempted ?? clock.now().toISOString(),
      });
      await store.flush([current.id]);
    }
    let answered: Entry | undefined;
    try {
      answered = await invoke(
        change,
        "change",
        () => callChange(change),
        moved,
      );
    } catch (error) {
      if (error instanceof Declined) {
        await decline(kind, current, changed, error);
        return;
      }
      if (error instanceof Unreachable) {
        unreached(current.id, error);
        return;
      }
      if (error instanceof Refused) {
        refuse(current.id, change, error);
        return;
      }
      throw error;
    }
    const intent = outbound.get(current.id);
    if (intent !== undefined) {
      await completeIntent(intent);
      return;
    }
    settle(kind, current, changeKind, changed, answered, moved);
    // A carried field keeps its value over the answer's.
    if (answered !== undefined && current.state !== "trashed") {
      await rows.adoptAnswer(current.id, answered, new Set(changed));
    }
    await finishOutbound(current.id);
  };
  const settledConnections = (
    agreement: Agreement,
    moved: Carried | undefined,
  ): Agreement => {
    if (moved === undefined) return agreement;
    const next: Agreement = { ...agreement, connections: moved.agreed };
    if (moved.deferred) {
      next.waiting = {
        ...next.waiting,
        [connectionsKey]: clock.now().toISOString(),
      };
    }
    return next;
  };
  const answeredConnections = new Map<
    string,
    Readonly<Record<string, readonly Target[]>>
  >();
  const answeredBack = async (): Promise<void> => {
    if (answeredConnections.size === 0) return;
    const answers = new Map(answeredConnections);
    answeredConnections.clear();
    await connections.connect(answers, []);
  };
  const settle = (
    kind: Spec,
    item: Item,
    changeKind: ChangeKind,
    changed: readonly string[],
    answered: Entry | undefined,
    moved: Carried | undefined,
    capturedBase?: Agreement,
  ): void => {
    pushed += 1;
    if (answered?.connections !== undefined && item.state !== "trashed") {
      answeredConnections.set(
        item.id,
        Object.fromEntries(
          Object.entries(answered.connections).filter(([type]) =>
            kind.connections.has(type),
          ),
        ),
      );
    }
    const base = capturedBase ?? store.get(item.id);
    // A vendor makes a row live; a state beside the create is carried next.
    const later = changeKind === "created" && item.state !== "active";
    const next = carried({
      fields: kind.fields,
      agreement: base,
      properties: item.properties,
      state: later ? "active" : agreedState(item.state),
      changed,
      answered,
    });
    // Until the row is linked, the vendor may still hold what a create made.
    if (
      base?.attempted !== undefined &&
      next.link === undefined &&
      lane(kind.type).rows.linkOf(item.properties) === undefined
    ) {
      next.attempted = base.attempted;
    }
    if (base?.stateBy !== undefined && next.state === base.state) {
      next.stateBy = base.stateBy;
      if (base.stateAt !== undefined) next.stateAt = base.stateAt;
    }
    const waiting: Record<string, string> = {};
    if (later) waiting[stateKey] = item.updated_at;
    const pending = base?.waiting?.[connectKey];
    if (pending !== undefined) waiting[connectKey] = pending;
    const connecting = base?.waiting?.[connectionsKey];
    if (moved === undefined && connecting !== undefined) {
      waiting[connectionsKey] = connecting;
    }
    if (item.state !== "trashed") {
      for (const field of changedInMarfa(next, kind.fields, item.properties)) {
        const since = base?.waiting?.[field];
        if (kind.readOnly.has(field) && since !== undefined) {
          waiting[field] = since;
        }
      }
    }
    store.set(
      item.id,
      settledConnections(
        {
          ...next,
          ...(base?.connections !== undefined && {
            connections: base.connections,
          }),
          ...(base?.pending !== undefined && { pending: base.pending }),
          ...(base?.file !== undefined && { file: base.file }),
          ...(Object.keys(waiting).length > 0 && { waiting }),
        },
        moved,
      ),
    );
  };

  const completeIntent = async (record: OutboundRecord): Promise<void> => {
    const change = restoreChange(record.change);
    const id = change.item.id;
    const { spec, rows } = lane(change.item.type);
    const kind = forRow(spec, change.item);
    if (change.kind === "purged") {
      await settlePurge(kind, change.item, record.answer);
      purged.delete(id);
      pushed += 1;
    } else {
      let live = await setup.marfa.item(id);
      if (live !== undefined) {
        rows.adopt(live);
        // The create's link is confirmed separately from the captured values.
        const linked =
          record.confirmationAgreement?.link ?? store.get(id)?.link;
        const base: Agreement = {
          vendor: {},
          marfa: {},
          state: "active",
          ...record.agreement,
          ...(linked !== undefined && { link: linked }),
        };
        if (kind.link !== undefined && linked !== undefined) {
          base.vendor = { ...base.vendor, [kind.link]: mark(linked) };
          base.marfa = { ...base.marfa, [kind.link]: mark(linked) };
        }
        settle(
          kind,
          change.item,
          change.kind,
          record.operation === "remake"
            ? watchedFields(kind)
            : [...change.changed],
          record.answer,
          record.moved,
          base,
        );
        if (record.answer !== undefined && live.state !== "trashed") {
          await rows.adoptAnswer(
            id,
            record.answer,
            record.operation === "remake"
              ? new Set(watchedFields(kind))
              : change.changed,
            change.item,
          );
          live = rows.known(id) ?? live;
        }
        const agreed = store.get(id);
        if (agreed === undefined)
          throw new Error("outbound settlement has no agreement");
        const waiting =
          noteWaiting(
            agreed,
            watchedFields(kind),
            live.properties,
            live.updated_at,
          ) ?? {};
        if (live.state !== agreed.state) waiting[stateKey] = live.updated_at;
        store.set(id, {
          ...agreed,
          ...(Object.keys(waiting).length > 0 && { waiting }),
        });
      }
    }
    await finishOutbound(id);
  };

  try {
    if (loaded === undefined) throw failure;
    checkVendorRetry();
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
      if (!whole && collected?.hints !== undefined) {
        const named = [...collected.hints];
        for (const [type] of named.filter(([type]) => !specs.has(type))) {
          raised.set(
            `undeclared-hint:${type}`,
            `a delivery named ${type}, which the connector does not declare, so it was not fetched`,
          );
        }
        hints = new Map(named.filter(([type]) => specs.has(type)));
      }
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
    if (!whole && connector.inbound === undefined) hints = new Map();
    read = await new Watch(
      setup.marfa,
      [...specs.keys()],
      stored.cursor,
      setup.signal,
      connectionTypes(connector),
    ).read();
    if (read.resync && stored.cursor !== undefined) {
      raised.set(
        "resync",
        "the log no longer holds the cursor, so every row of the connector's types was compared with what was last agreed",
      );
    }
    if (read.incomplete !== undefined) {
      logger.warn(`${read.incomplete}; the rest of the log is read next run`);
    }
    if (
      twoWay &&
      (read.incomplete !== undefined ||
        (connector.preflight !== undefined &&
          read.resync &&
          stored.cursor !== undefined))
    )
      throw new Error(
        "outbound mutations are blocked because the complete watch inventory is unavailable",
      );
    if (read.resync && read.incomplete === undefined) {
      // Every row of the connector's types is in hand: one not among them
      // was purged unseen, and each still relinked is found again below.
      for (const id of relinked.keys()) {
        if (!read.rows.has(id)) relinked.delete(id);
      }
    }
    const waitingIds = await store.waiting(setup.signal);
    await store.fetch([
      ...read.rows.keys(),
      ...read.connected.keys(),
      ...waitingIds,
      ...outbound.keys(),
    ]);
    for (const record of outbound.values()) {
      const change = restoreChange(record.change);
      if (record.rejected !== undefined)
        refusedOutbound.set(change.item.id, {
          change,
          reason: record.rejected,
        });
    }
    await fetchRows([
      ...read.connected.keys(),
      ...[...read.rows].filter(([, seen]) => !seen.purged).map(([id]) => id),
      ...waitingIds,
    ]);
    const order = new Set<string>();
    for (const [id, seen] of read.rows) {
      const last = seen.frames.at(-1)?.item;
      if (last === undefined) continue;
      const { spec, rows } = lane(last.type);
      const kind = forRow(spec, last);
      if (kind.owned === false) continue;
      const agreement = store.get(id);
      if (seen.purged) {
        // The instance drops a purged row's agreement and keeps its
        // keys as tombstones, named as the log last showed the row.
        const agreed = relinked.get(id)?.link;
        relinked.delete(id);
        const own = rows.linkOf(last.properties);
        if (
          kind.twoWay &&
          kind.link !== undefined &&
          own !== undefined &&
          !cascaded(last)
        ) {
          const link = agreed ?? (overflowed ? undefined : vouched(kind, seen));
          if (link === undefined) {
            raised.set(
              `purge-unvouched:${id}`,
              `the purge of ${id} is not carried, since its link may have been changed in Marfa since the vendor last had it`,
            );
          } else {
            const refused = purged.get(id)?.refused;
            purged.set(id, {
              ...purgeOf(
                last,
                kind.link,
                link,
                kind.policy !== undefined || connector.preflight !== undefined,
              ),
              ...(refused !== undefined && { refused }),
            });
          }
        }
        continue;
      }
      if (agreement === undefined) {
        const unlinked =
          kind.link !== undefined && rows.linkOf(last.properties) === undefined;
        if (kind.twoWay && unlinked && last.state === "active") {
          store.set(id, {
            vendor: {},
            marfa: {},
            state: "active",
            waiting: {
              [createKey]: seen.frames[0]?.item.updated_at ?? last.updated_at,
            },
          });
          order.add(id);
        } else if (kind.twoWay && !unlinked) {
          unagreed += 1;
        }
        continue;
      }
      // Kept before the cursor passes the frames, so a put-back that fails
      // later in the run loses nothing a purge needs.
      if (kind.twoWay && rows.linkOf(last.properties) !== agreement.link) {
        keepAgreedLink(kind, last, agreement);
      }
      const observed = observe(spec, seen, agreement);
      own += observed.own;
      const next = observed.next;
      // A remake's first try holds only while its restore does.
      if (next.link !== undefined && last.state !== "active") {
        Reflect.deleteProperty(next, "attempted");
      }
      store.set(id, next);
      if (carriable(next.waiting)) order.add(id);
    }
    // Every row is in hand after a whole read of the log: past the cap only
    // where this one's rows overflowed it again.
    if (read.resync && read.incomplete === undefined) overflowed = overflowing;
    // Not the connector's to carry: a row nothing was agreed for, or one whose
    // connections are what was agreed, as the kit's own writes leave them.
    const edges = await connections.edgesOf(
      [...read.connected.keys()].filter((id) => store.get(id) !== undefined),
    );
    for (const [id, since] of read.connected) {
      const agreement = store.get(id);
      if (agreement === undefined) continue;
      const found = edges.get(id);
      if (
        found !== undefined &&
        forRow(lane(found.item.type).spec, found.item).owned === false
      )
        continue;
      if (
        found !== undefined &&
        !(await connections.differ(found.item, agreement, found.edges))
      ) {
        continue;
      }
      store.set(id, {
        ...agreement,
        waiting: {
          [connectionsKey]: since,
          ...agreement.waiting,
        },
      });
      order.add(id);
    }
    for (const id of waitingIds) {
      if (carriable(store.get(id)?.waiting)) order.add(id);
    }
    if (unagreed > 0) {
      raised.set(
        "unagreed",
        `${String(unagreed)} ${unagreed === 1 ? "row" : "rows"} the log named ${unagreed === 1 ? "has" : "have"} nothing agreed with the vendor yet, so nothing is carried for ${unagreed === 1 ? "it" : "them"} until the vendor next sends ${unagreed === 1 ? "it" : "them"}`,
      );
    }
    // Everything the log named is noted; the cursor passes it once the final
    // flush keeps that on the instance.
    if (connector.preflight !== undefined) {
      const inventory = new Map<string, Change>();
      for (const purge of purged.values()) {
        const item = { ...purge };
        Reflect.deleteProperty(item, "refused");
        inventory.set(item.id, { kind: "purged", item, changed: new Set() });
      }
      for (const seen of read.rows.values()) {
        const item = seen.frames.at(-1)?.item;
        if (seen.purged && item !== undefined)
          inventory.set(item.id, { kind: "purged", item, changed: new Set() });
      }
      for (const pending of outbound.values())
        if (pending.change.kind === "purged")
          inventory.set(pending.change.item.id, restoreChange(pending.change));
      check();
      try {
        await connector.preflight(
          { purges: structuredClone([...inventory.values()]) },
          watchContext,
        );
      } catch (error) {
        await keepVendorRetry(error);
        throw error;
      }
      check();
      await saveOutbound();
    }
    recorded = true;
    for (const record of [...outbound.values()]) {
      const change = restoreChange(record.change);
      const id = change.item.id;
      recovered.add(id);
      const declared = specs.get(change.item.type);
      const suspend = (reason: string): void => {
        suspendedOutbound.add(id);
        raised.set(
          `outbound-pending:${id}`,
          `the pending write for ${id} is retained without replay because ${reason}`,
        );
      };
      if (declared === undefined || connector.onChange === undefined) {
        suspend("its kind has no declared write handler");
        continue;
      }
      if (
        !record.acknowledged &&
        record.operation === "remake" &&
        connector.remake === undefined
      ) {
        suspend("its remake handler is no longer declared");
        continue;
      }
      const kind = forRow(declared, change.item);
      if (!kind.twoWay || kind.owned === false) {
        suspend("its kind no longer has write authority");
        continue;
      }
      if (refusedOutbound.has(id)) {
        const live = await setup.marfa.item(id);
        if (live?.type === change.item.type) {
          lane(live.type).rows.adopt(live);
          recovered.delete(id);
          order.add(id);
        }
        continue;
      }
      const refusal = purged.get(id)?.refused;
      if (
        !record.acknowledged &&
        change.kind === "purged" &&
        refusal !== undefined &&
        ((refusal.count ?? 0) >= purgeRefusalLimit ||
          clock.now().getTime() - Date.parse(refusal.at) < purgeAgainMs)
      ) {
        purgeRefusedOf(id, refusal.reason);
        continue;
      }
      try {
        if (!record.acknowledged) {
          const live = await setup.marfa.item(id);
          if (
            (live === undefined && change.kind !== "purged") ||
            (live !== undefined &&
              (live.type !== change.item.type ||
                !forRow(declared, live).twoWay))
          ) {
            suspend("the current row does not prove write authority");
            continue;
          }
          if (record.operation === "remake") {
            await invoke(change, "remake", () => callRemake(change));
          } else {
            await invoke(
              change,
              "change",
              () => callChange(change),
              record.moved,
            );
          }
        }
      } catch (error) {
        check();
        if (error instanceof Unreachable) {
          unreached(id, error);
          continue;
        }
        if (error instanceof Refused && change.kind !== "purged")
          refuse(id, change, error);
        if (error instanceof Refused && change.kind === "purged") {
          purged.set(id, {
            ...change.item,
            refused: {
              at: clock.now().toISOString(),
              reason: capBytes(logger.redact(error.message), reasonBytes),
              count: (refusal?.count ?? 0) + 1,
            },
          });
        }
        if (error instanceof Refused || error instanceof Declined) {
          raised.set(`outbound-pending:${id}`, error.message);
          continue;
        }
        throw error;
      }
      const confirmed = outbound.get(id);
      if (confirmed === undefined)
        throw new Error("pending outbound intent disappeared");
      await completeIntent(confirmed);
    }
    for (const id of order) await putBack(id);
    if (hints !== undefined) hints = await withWaiting(hints, order);

    const done = new Set<string>();
    if (twoWay) {
      // An untold or restored-but-vendor-lost row is made there before
      // the vendor is read, so failing before it links makes no twin.
      const unplaced: string[] = [];
      for (const id of order) {
        if (recovered.has(id)) continue;
        const agreement = store.get(id);
        const found = await find(id);
        if (agreement === undefined || found === undefined) continue;
        const { spec: kind } = found;
        if (!kind.twoWay) continue;
        const item = byAgreedLink(kind, found.item, agreement);
        if (
          agreement.waiting?.[createKey] !== undefined &&
          (!refusedOutbound.has(id) || agreement.link === undefined)
        ) {
          if ((await carry(item, agreement)) === "unplaced") unplaced.push(id);
          done.add(id);
          continue;
        }
        if (agreement.stateBy === "cascade" && item.state !== "trashed") {
          // Out of another row's trash, which never reached the vendor, so
          // there is nothing for it to remake.
          const returned: Agreement = {
            ...agreement,
            state: agreedState(item.state),
          };
          Reflect.deleteProperty(returned, "stateBy");
          Reflect.deleteProperty(returned, "stateAt");
          store.set(id, returned);
          continue;
        }
        const told = kind.link === undefined || agreement.link !== undefined;
        const restored =
          told && item.state === "active" && agreement.state !== "active";
        if (connector.remake !== undefined && restored) {
          if (setup.fenced?.() === true || setup.signal.aborted) {
            throw new Stopped();
          }
          const placing = new Set(
            connections
              .typesFrom(kind.type)
              .filter((type) => connections.mirrored(kind, type)),
          );
          const placed =
            placing.size === 0
              ? undefined
              : await connections.changes(
                  item,
                  kind,
                  agreement,
                  (await connections.edgesOf([id])).get(id)?.edges ?? [],
                  true,
                );
          const handed = Object.fromEntries(
            Object.entries(placed?.connections ?? {}).filter(([type]) =>
              placing.has(type),
            ),
          );
          const change: Change = {
            kind: "restored",
            item,
            changed: new Set(
              changedInMarfa(
                agreement,
                watchedFields(kind).filter(
                  (field) => !kind.readOnly.has(field),
                ),
                item.properties,
              ),
            ),
            ...(Object.keys(handed).length > 0 && { connections: handed }),
            ...(agreement.state !== "active" && { was: agreement.state }),
            ...(agreement.attempted !== undefined && {
              attempted: agreement.attempted,
            }),
            ...(agreement.refused !== undefined && {
              refused: agreement.refused.change,
            }),
          };
          const unagreed = unagreedOf(kind, item, agreement);
          if (unagreed !== undefined) Object.assign(change, { unagreed });
          const placement = await connections.placementOf(
            item,
            kind,
            agreement,
          );
          if (placement !== undefined) Object.assign(change, { placement });
          if (placed?.unplaced === true) {
            heldBack(id);
            done.add(id);
            continue;
          }
          if (!(await releaseRefused(change))) {
            done.add(id);
            continue;
          }
          if (refusedBefore(id, agreement, change)) {
            done.add(id);
            continue;
          }
          store.set(id, {
            ...agreement,
            attempted: agreement.attempted ?? clock.now().toISOString(),
          });
          await store.flush([id]);
          let remade: boolean;
          try {
            remade = await invoke(change, "remake", () => callRemake(change));
          } catch (error) {
            if (error instanceof Declined) {
              await decline(kind, item, [...change.changed], error);
            } else if (error instanceof Unreachable) unreached(id, error);
            else if (error instanceof Refused) refuse(id, change, error);
            else throw error;
            done.add(id);
            continue;
          }
          const pending = outbound.get(id);
          if (pending !== undefined) {
            await completeIntent(pending);
            done.add(id);
            continue;
          }
          if (!remade) {
            const kept = { ...(store.get(id) ?? agreement) };
            Reflect.deleteProperty(kept, "attempted");
            store.set(id, kept);
          }
          if (remade) {
            pushed += 1;
            // What was sent, never the server's answer, which can hold a
            // person's edit made meanwhile.
            const linked = store.get(id)?.link;
            const side = sideOf(kind.fields, {
              ...item.properties,
              ...(kind.link !== undefined &&
                linked !== undefined && { [kind.link]: linked }),
            });
            store.set(id, {
              vendor: side,
              marfa: side,
              state: "active",
              ...(linked !== undefined && { link: linked }),
              ...(agreement.file !== undefined && { file: agreement.file }),
              ...(kind.connections.size > 0 && {
                connections: Object.fromEntries(
                  [...kind.connections].map((type) => [
                    type,
                    placing.has(type) ? (placed?.agreed[type] ?? []) : [],
                  ]),
                ),
                waiting: { [connectionsKey]: clock.now().toISOString() },
              }),
            });
            done.add(id);
          }
          await finishOutbound(id);
        }
      }
      // Again while any lands, for a create naming a row made after it.
      let held = unplaced;
      for (let progress = true; progress && held.length > 0;) {
        const still: string[] = [];
        for (const id of held) {
          const agreement = store.get(id);
          const found = await find(id);
          if (agreement === undefined || found === undefined) continue;
          if ((await carry(found.item, agreement)) === "unplaced") {
            still.push(id);
          }
        }
        progress = still.length < held.length;
        held = still;
      }
      for (const id of held) heldBack(id);
    }
    // Watch observations and completed early carries must be durable before
    // a scoped reader can safely rescan their rows. Ownership leaves only on ACK.
    try {
      check();
      await store.flush(undefined, check);
      check();
    } catch (error) {
      phase.failedPrerequisite = true;
      throw error;
    }
    checkVendorRetry();
    phase.reading = true;
    try {
      await connector.run(context);
    } catch (error) {
      await keepVendorRetry(error);
      throw error;
    } finally {
      phase.reading = false;
      phase.unfinishedOperations = phase.mutating || phase.rootInFlight > 0;
    }
    check();
    // Once the vendor's rows are written, so a target made this run is found.
    // An answer from before the run gives way, type by type, to the
    // vendor's entry since.
    const named = new Map(answeredConnections);
    const incoming = new Map<string, Entry>();
    for (const { rows } of lanes.values()) {
      for (const [id, entry] of rows.connecting) {
        named.set(id, { ...named.get(id), ...entry.connections });
        incoming.set(id, entry);
      }
    }
    answeredConnections.clear();
    await connections.connect(
      named,
      waitingIds.filter(
        (id) => store.get(id)?.waiting?.[connectKey] !== undefined,
      ),
      incoming,
    );
    if (twoWay) {
      for (const { rows } of lanes.values()) {
        for (const id of rows.marked) order.add(id);
      }
      for (const id of order) {
        if (done.has(id)) continue;
        const agreement = store.get(id);
        const found = await find(id);
        if (
          agreement === undefined ||
          found === undefined ||
          (agreement.waiting === undefined && !refusedOutbound.has(id))
        )
          continue;
        if ((await carry(found.item, agreement)) === "unplaced") heldBack(id);
      }
      await answeredBack();
      for (const { refused, ...item } of purged.values()) {
        if (recovered.has(item.id)) continue;
        const spec = specs.get(item.type);
        if (spec !== undefined && !forRow(spec, item).twoWay) {
          raised.set(
            `purge-pending:${item.id}`,
            `the purge of ${item.id} is retained while its kind has no write authority`,
          );
          continue;
        }
        if (setup.fenced?.() === true || setup.signal.aborted) {
          throw new Stopped();
        }
        if (
          refused !== undefined &&
          clock.now().getTime() - Date.parse(refused.at) < purgeAgainMs
        ) {
          purgeRefusedOf(item.id, refused.reason);
          continue;
        }
        if (!specs.has(item.type)) {
          raised.set(
            `purge-undeclared:${item.id}`,
            `the purge of ${item.id} is not carried, since the connector no longer declares ${item.type}`,
          );
          continue;
        }
        let answered: Entry | undefined;
        try {
          const change: Change = { kind: "purged", item, changed: new Set() };
          answered = await invoke(change, "change", () => callChange(change));
        } catch (error) {
          if (error instanceof Declined) {
            raised.set(`declined:${item.id}`, error.message);
            purged.delete(item.id);
          } else if (error instanceof Unreachable) {
            unreached(item.id, error);
            purged.set(item.id, {
              ...item,
              ...(refused !== undefined && { refused }),
            });
          } else if (error instanceof Refused) {
            const said = logger.redact(error.message);
            const count =
              (refused === undefined ? 0 : (refused.count ?? 1)) + 1;
            if (count >= purgeRefusalLimit && !outbound.has(item.id)) {
              purged.delete(item.id);
              raised.set(
                `purge-given-up:${item.id}`,
                `the purge of ${item.id} was refused ${String(count)} times, so it is given up and the vendor may still hold the row: ${said}`,
              );
            } else {
              purgeRefusedOf(item.id, said);
              purged.set(item.id, {
                ...item,
                refused: {
                  at: clock.now().toISOString(),
                  reason: capBytes(said, reasonBytes),
                  count,
                },
              });
            }
          } else throw error;
          continue;
        }
        const intent = outbound.get(item.id);
        if (intent !== undefined) {
          await completeIntent(intent);
          continue;
        }
        pushed += 1;
        await settlePurge(lane(item.type).spec, item, answered);
        purged.delete(item.id);
        await finishOutbound(item.id);
      }
    }
  } catch (error) {
    failure = error;
    if (
      !phase.unfinishedOperations &&
      !phase.uncertainState &&
      !phase.failedPrerequisite &&
      !(error instanceof Stopped) &&
      setup.fenced?.() !== true
    ) {
      try {
        await answeredBack();
      } catch {
        // The run has failed already; the vendor's next entry settles it.
      }
    }
  }
  let flushed = true;
  const fenced = setup.fenced?.() === true;
  try {
    // Another process may hold what this run read; the next run reads it again.
    checkDurability();
    if (fenced) throw new Error("the hold was lost, so nothing more is kept");
    await store.flush();
  } catch (error) {
    flushed = false;
    failure ??= error;
    logger.warn(
      `what the two sides agreed on could not be kept: ${describe(error)}`,
    );
  }
  const pastLog = recorded && flushed && read?.cursor !== undefined;

  const all = [...lanes.values()].map(({ rows }) => rows);
  const seeded = all.reduce((sum, rows) => sum + rows.seeded, 0);
  const held = all.reduce((sum, rows) => sum + rows.held, 0);
  for (const id of store.oversized) {
    raised.set(
      `oversized:${id}`,
      `what was agreed for ${id} outgrew the instance's cap and remains pending, so vendor progress cannot advance`,
    );
  }
  for (const [scope, { message, ids }] of waiting) {
    raised.set(
      `unreachable-in:${scope}`,
      `${String(ids.size)} ${ids.size === 1 ? "change waits" : "changes wait"}: ${message}`,
    );
  }
  const remembered = all.reduce((sum, rows) => sum + rows.remembered, 0);
  if (remembered > 0) {
    raised.set(
      "remembered",
      `${String(remembered)} ${remembered === 1 ? "entry names a row" : "entries name rows"} purged in Marfa and unchanged at the vendor since, so ${remembered === 1 ? "it is" : "they are"} not written back`,
    );
  }
  if (seeded > 0) {
    raised.set(
      "seeded",
      `${String(seeded)} ${seeded === 1 ? "row" : "rows"} with nothing agreed took the vendor's values where they differed, and nothing was carried back for ${seeded === 1 ? "it" : "them"}`,
    );
  }
  if (failure === undefined && held > 0) {
    raised.set(
      "held",
      "the state is held, so the next run reads the vendor again: a write did not land",
    );
  }
  for (const record of acknowledged.inbound ?? []) {
    raised.set(
      `inbound:${identityKey(record.identity.type, record.identity.sourceId)}`,
      `the server refused ${record.identity.type} ${record.identity.sourceId}: ${record.code}, ${record.reason}; durable retry intent waits`,
    );
  }
  const keptPurges = keepPurges(true);
  // Kept redacted, key and message, since the conditions are kept on the
  // instance as they stand.
  const redacted = new Map(
    [...raised].map(([key, message]) => [
      logger.redact(key),
      cap(logger.redact(message), conditionCap),
    ]),
  );
  const skippedKeys = new Set(
    [...unreachedKeys].map((key) => logger.redact(key)),
  );
  const skippedBatches = unreachedBatches.map(({ prefixes, exceptKeys }) => ({
    prefixes: prefixes.map((prefix) => logger.redact(prefix)),
    exceptKeys: new Set(exceptKeys.map((key) => logger.redact(key))),
  }));
  // Only a finished scheduled run that reached its check can find one gone. The
  // newly raised go first, then the rest in the order kept, which puts those
  // the last report had no room for ahead of those it carried.
  const clears = failure === undefined && whole;
  const standing = new Map(
    [...redacted].filter(
      ([key]) => !Object.hasOwn(acknowledged.conditions, key),
    ),
  );
  const cleared: string[] = [];
  for (const [key, message] of Object.entries(acknowledged.conditions)) {
    const now = redacted.get(key);
    if (now !== undefined) standing.set(key, now);
    else if (
      clears &&
      !skippedKeys.has(key) &&
      !skippedBatches.some(
        ({ prefixes, exceptKeys }) =>
          !exceptKeys.has(key) &&
          prefixes.some((prefix) => key.startsWith(prefix)),
      )
    )
      cleared.push(message);
    else standing.set(key, message);
  }
  for (const message of standing.values()) logger.warn(message);

  const landed =
    failure === undefined &&
    held === 0 &&
    (acknowledged.inbound ?? []).length === 0;
  const marking = failure === undefined && !setup.signal.aborted;
  // A delivery is processed once its run ends without error; a write it
  // held is re-read by the next scheduled run's full read, so it need not wait.
  const taken = collected?.fresh ?? [];
  const tallied = (processed: number): string =>
    tally(
      sumOf(all.map((rows) => rows.counts)),
      twoWay ? { pushed, own } : undefined,
      connector.inbound === undefined
        ? undefined
        : {
            processed,
            rejected: collected?.rejected ?? 0,
            duplicate: collected?.duplicate ?? 0,
          },
    );
  // Fitted to the most the deliveries can count, so the report holds them
  // however many are marked.
  const shown = fitting(tallied(marking ? taken.length : 0), standing);
  let saved = false;
  // A state that could not be read is not written over with nothing.
  if (
    loaded !== undefined &&
    !fenced &&
    !phase.uncertainState &&
    !phase.failedPrerequisite &&
    !phase.unfinishedOperations
  ) {
    try {
      await store.save({
        ...(outboundRetryAt !== undefined && { outboundRetryAt }),
        ...(outbound.size > 0 && { outbound: [...outbound.values()] }),
        ...(acknowledged.inbound !== undefined && {
          inbound: acknowledged.inbound,
        }),
        state: landed ? draft : acknowledged.state,
        conditions: Object.fromEntries(
          [
            ...[...standing].filter(([key]) => !shown.has(key)),
            ...[...standing].filter(([key]) => shown.has(key)),
          ].slice(0, keptConditions),
        ),
        ...(pastLog && read?.cursor !== undefined
          ? { cursor: read.cursor }
          : acknowledged.cursor !== undefined && {
              cursor: acknowledged.cursor,
            }),
        ...(keptPurges.length > 0 && { purges: keptPurges }),
        ...((relinked.size > 0 || overflowed) && {
          relinked: {
            rows: Object.fromEntries(relinked),
            ...(overflowed && { overflowed: true as const }),
          },
        }),
      });
      saved = true;
    } catch (error) {
      failure ??= new Error(
        `the connector's state could not be kept, so the next run starts from the state last kept: ${describe(error)}`,
        { cause: error },
      );
    }
  }
  if (saved) {
    for (const message of cleared) {
      logger.info(
        `cleared: ${message} (this run reached its check and did not find it again)`,
      );
    }
  }

  let processed = 0;
  if (failure === undefined && marking) {
    try {
      for (let at = 0; at < taken.length; at += marksPerRequest) {
        const marks = taken.slice(at, at + marksPerRequest);
        await setup.marfa.handled(setup.connectorId, marks, "processed");
        processed += marks.length;
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
  const finishedAt = clock.now();
  const counts = tallied(processed);
  // The contract knows only succeeded and failed; a stop is neither.
  const stopped = failure !== undefined && setup.stopping?.() === true;
  if (stopped) {
    logger.info(
      `run stopped before it finished, so it is not reported: ${counts}`,
    );
  } else {
    if (failure === undefined) {
      logger.info(`run succeeded: ${counts}`);
    } else {
      logger.error(`run failed: ${describe(failure)}; ${counts}`);
    }
    try {
      await setup.marfa.report(setup.connectorId, {
        outcome: failure === undefined ? "succeeded" : "failed",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        summary: cap(logger.redact(summarize(counts, standing, shown))),
        ...(failure !== undefined && {
          error: cap(logger.redact(describe(failure))),
        }),
      });
    } catch (error) {
      logger.warn(`the run could not be reported: ${describe(error)}`);
    }
  }
  return {
    succeeded: failure === undefined,
    cause: failure === undefined ? undefined : causeOf(failure),
    retryAfterMs:
      outboundRetryAt !== undefined
        ? Math.max(0, Date.parse(outboundRetryAt) - clock.now().getTime())
        : failure === undefined
          ? undefined
          : retryAfterOf(failure),
    settled,
    cursor: pastLog && saved ? read?.cursor : acknowledged.cursor,
    ...(failure !== undefined && !stopped && { failure }),
  };
}

export async function waitingInMarfa<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  cursor: string | undefined,
): Promise<{ waiting: boolean; cursor: string | undefined }> {
  const specs = specsOf(
    setup.connector,
    setup.environment.values as EnvValues<E>,
    setup.narrowed,
  );
  const read = await new Watch(
    setup.marfa,
    [...specs.keys()],
    cursor,
    setup.signal,
    connectionTypes(setup.connector),
  ).read();
  if (read.resync) return { waiting: true, cursor };
  if (read.rows.size === 0 && read.connected.size === 0) {
    return { waiting: false, cursor: read.cursor };
  }
  const store = new Store(setup.marfa, setup.connectorId, setup.process);
  await store.fetch([...read.rows.keys(), ...read.connected.keys()]);
  const waiting = [...read.rows].some(([id, seen]) => {
    const last = seen.frames.at(-1)?.item;
    const declared = last === undefined ? undefined : specs.get(last.type);
    if (last === undefined || declared === undefined) return false;
    const spec = forRow(declared, last);
    if (spec.owned === false) return false;
    if (seen.purged) {
      if (!spec.twoWay) return false;
      const link =
        spec.link === undefined ? undefined : last.properties[spec.link];
      return !cascaded(last) && typeof link === "string" && link !== "";
    }
    const agreement = store.get(id);
    if (agreement === undefined) return spec.twoWay && last.state === "active";
    return carriable(observe(spec, seen, agreement).next.waiting);
  });
  if (waiting || read.connected.size === 0) {
    return { waiting, cursor: read.cursor };
  }
  const [first] = specs.keys();
  const connected =
    first === undefined
      ? new Map<string, { item: Item; edges: Edge[] }>()
      : await setup.marfa.edgesFrom(
          first,
          [...read.connected.keys()].filter(
            (id) => store.get(id) !== undefined,
          ),
          connectionTypes(setup.connector),
        );
  // A purge's never counts.
  const kinds = new Map(
    (setup.connector.connections ?? []).map((kind) => [kind.id, kind]),
  );
  const added: [string, string][] = [];
  const removed: string[] = [];
  for (const { item, edges } of connected.values()) {
    const declared = specs.get(item.type);
    const spec = declared === undefined ? undefined : forRow(declared, item);
    if (spec?.twoWay !== true) continue;
    const agreed = store.get(item.id)?.connections ?? {};
    for (const type of spec.connections) {
      const list = agreed[type];
      if (list === undefined) continue;
      const was = new Set(list);
      const now = new Set(
        edges
          .filter((edge) => edge.edge_type === type)
          .map((edge) => edge.target_id),
      );
      for (const target of now)
        if (!was.has(target)) added.push([type, target]);
      for (const target of was) if (!now.has(target)) removed.push(target);
    }
  }
  const named = [
    ...new Set([...added.map(([, target]) => target), ...removed]),
  ];
  const rows =
    first === undefined || named.length === 0
      ? new Map<string, Item>()
      : new Map(
          (await setup.marfa.lookup(first, { ids: named })).data.map((row) => [
            row.id,
            row,
          ]),
        );
  const changed =
    added.some(([type, target]) => {
      const row = rows.get(target);
      return (
        row !== undefined &&
        kinds.get(type)?.target_type_constraints?.includes(row.type) === true
      );
    }) || removed.some((target) => rows.has(target));
  return { waiting: changed, cursor: read.cursor };
}
