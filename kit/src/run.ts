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
import type { Edge, Marfa } from "./marfa.js";
import {
  carriable,
  cascaded,
  connectKey,
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
import type { Clock } from "./runtime.js";
import { recordBytes, Store, type Purge } from "./store.js";
import { Watch, type LogRead, type Seen } from "./watch.js";

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
}

export type Trigger = "schedule" | "look";

export interface RunResult {
  readonly succeeded: boolean;
  readonly cursor: string | undefined;
  readonly settled: boolean;
}

const createKey = "@create";

const wholeAbove = 200;

const marksPerRequest = 200;

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

/** How much of a refusal's reason is kept with the row. */
const reasonBytes = 200;

/** How long a refused purge waits before it is asked again. */
const purgeAgainMs = 24 * 3_600_000;

function capBytes(text: string, bytes: number): string {
  let kept = "";
  for (const char of text) {
    if (Buffer.byteLength(kept + char) > bytes) break;
    kept += char;
  }
  return kept;
}

function fits(agreement: Agreement): boolean {
  return Buffer.byteLength(JSON.stringify(agreement)) <= recordBytes;
}

export function specsOf<E extends EnvDeclaration>(
  connector: Connector<E>,
  env: EnvValues<E>,
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
      const readOnly = new Set(twoWay ? (kind.readOnly ?? []) : kind.fields);
      const link = kind.type.link_field;
      if (link !== undefined) readOnly.add(link);
      return [
        kind.type.id,
        {
          type: kind.type.id,
          source: connector.source,
          link,
          fields: kind.fields,
          readOnly,
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
    if (
      item.state === state &&
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
      kind.twoWay && item.state !== state
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
  if (!carriable(next.waiting)) Reflect.deleteProperty(next, "refused");
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

export async function runOnce<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  trigger: Trigger,
): Promise<RunResult> {
  const { connector, logger, clock } = setup;
  const env = setup.environment.values as EnvValues<E>;
  const store = new Store(setup.marfa, setup.connectorId, setup.process);
  const specs = specsOf(connector, env);
  const twoWay = [...specs.values()].some((spec) => spec.twoWay);
  const raised = new Map<string, string>();
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
  ): void => {
    const what =
      kind === "trashed"
        ? `the trash of ${id} was refused, so it waits until the row is restored in Marfa`
        : `the change to ${id} was refused, so it waits until the row changes in Marfa`;
    raised.set(
      `change-refused:${id}`,
      `${what}: ${reason ?? "its reason was too long to keep"}`,
    );
  };
  // What a refusal names is kept with the row, so it stands until settled,
  // but never at the cost of the row's agreement.
  const refuse = (id: string, change: Change, error: Refused): void => {
    const said = logger.redact(error.message);
    refusedOf(id, change.kind, said);
    const agreement = store.get(id);
    if (agreement === undefined) return;
    const marked = sending(change);
    const full: Agreement = {
      ...agreement,
      refused: { change: marked, reason: capBytes(said, reasonBytes) },
    };
    const bare: Agreement = { ...agreement, refused: { change: marked } };
    store.set(id, fits(full) ? full : fits(bare) ? bare : agreement);
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
  const draft = structuredClone(stored.state);
  const hooks = {
    refused: (sourceId: string, reason: string) =>
      raised.set(
        `refused:${sourceId}`,
        `the server refused ${sourceId}: ${reason}`,
      ),
    condition: (key: string, message: string) => raised.set(key, message),
    fenced: () => setup.fenced?.() === true,
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
      if (item !== undefined) return { item, spec, rows };
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
    return inLane(id);
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
  };
  let hints: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  const secret = (value: string): void => {
    keepSecret(logger, value);
  };
  const context: RunContext<E> = {
    env,
    signal: setup.signal,
    state,
    log,
    secret,
    get hints() {
      return hints;
    },
    upsert: (type, entries) => lane(type).rows.upsert(entries),
    archive: (type, keys) => lane(type).rows.archive(keys),
    linked: async (type, connection, target) => {
      const { rows } = lane(type);
      if (!specs.get(type)?.connections.has(connection)) {
        throw new Error(`${type} declares no connection ${connection}`);
      }
      const held = (await lane(target.type).rows.named([target.id])).get(
        target.id,
      );
      if (held === undefined) return [];
      const spec = lane(type).spec;
      const found = await setup.marfa.connectedTo(type, connection, held.id);
      return found
        .filter((row) => {
          if (row.type !== type) return false;
          if (
            spec.link !== undefined &&
            rows.linkOf(row.properties) === undefined
          )
            return false;
          if (spec.link === undefined && row.source !== spec.source)
            return false;
          const named =
            rows.connecting.get(row.id)?.[connection] ??
            answeredConnections.get(row.id)?.[connection];
          return (
            named === undefined ||
            named.some(
              (one) => one.type === target.type && one.id === target.id,
            )
          );
        })
        .map((row) => {
          rows.adopt(row);
          return structuredClone(row);
        });
    },
  };
  const watchContext: WatchContext<E> = {
    env,
    signal: setup.signal,
    state,
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
    if (
      agreement?.waiting === undefined ||
      found === undefined ||
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
        return;
      }
      current = rows.known(id) ?? current;
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
    const back = stale.length === 0 ? [] : await rows.putBack(id, stale);
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
    if (!carriable(waiting)) Reflect.deleteProperty(now, "refused");
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
  const carry = async (
    item: Item,
    agreement: Agreement,
  ): Promise<"unplaced" | undefined> => {
    if (setup.fenced?.() === true || setup.signal.aborted) throw new Stopped();
    const { spec: kind, rows } = lane(item.type);
    if (connector.onChange === undefined || !kind.twoWay) return;
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
    const carriable = kind.fields.filter((field) => !kind.readOnly.has(field));
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
    // A row a person relinked that could not be put back, being in the
    // bin, is carried by the link the two sides agreed.
    const current =
      kind.link !== undefined &&
      agreement.link !== undefined &&
      rows.linkOf(item.properties) !== agreement.link
        ? {
            ...item,
            properties: { ...item.properties, [kind.link]: agreement.link },
          }
        : item;
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
    const change: Change = {
      kind: changeKind,
      item: current,
      changed: new Set(changed),
      ...(attempted !== undefined && { attempted }),
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
      answered = await connector.onChange(change, watchContext);
    } catch (error) {
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
    settle(kind, current, changeKind, changed, answered, moved);
    // A carried field keeps its value over the answer's.
    if (answered !== undefined && current.state !== "trashed") {
      await rows.adoptAnswer(current.id, answered, new Set(changed));
    }
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
    const base = store.get(item.id);
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
    if (base?.attempted !== undefined && next.link === undefined) {
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
    const waitingIds = await store.waiting(setup.signal);
    await store.fetch([
      ...read.rows.keys(),
      ...read.connected.keys(),
      ...waitingIds,
    ]);
    await fetchRows([
      ...read.connected.keys(),
      ...[...read.rows].filter(([, seen]) => !seen.purged).map(([id]) => id),
      ...waitingIds,
    ]);
    const order = new Set<string>();
    for (const [id, seen] of read.rows) {
      const last = seen.frames.at(-1)?.item;
      if (last === undefined) continue;
      const { spec: kind, rows } = lane(last.type);
      const agreement = store.get(id);
      if (seen.purged) {
        // The instance drops a purged row's agreement and keeps its
        // keys as tombstones, named as the log last showed the row.
        store.clear(id);
        if (
          kind.twoWay &&
          rows.linkOf(last.properties) !== undefined &&
          !cascaded(last)
        ) {
          purged.set(id, last);
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
      const observed = observe(kind, seen, agreement);
      own += observed.own;
      const next = observed.next;
      // A remake's first try holds only while its restore does.
      if (next.link !== undefined && last.state !== "active") {
        Reflect.deleteProperty(next, "attempted");
      }
      store.set(id, next);
      if (carriable(next.waiting)) order.add(id);
    }
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
        `${String(unagreed)} ${unagreed === 1 ? "row" : "rows"} the log named ${unagreed === 1 ? "has" : "have"} nothing agreed with the vendor yet, so nothing is carried for ${unagreed === 1 ? "it" : "them"} until the vendor next sends ${unagreed === 1 ? "it" : "them"}, whose values ${unagreed === 1 ? "it takes" : "they take"} where they differ`,
      );
    }
    // Everything the log named is noted; the cursor passes it once the final
    // flush keeps that on the instance.
    recorded = true;
    for (const id of order) await putBack(id);
    if (hints !== undefined) hints = await withWaiting(hints, order);

    const done = new Set<string>();
    if (twoWay) {
      // An untold or restored-but-vendor-lost row is made there before
      // the vendor is read, so failing before it links makes no twin.
      const unplaced: string[] = [];
      for (const id of order) {
        const agreement = store.get(id);
        const found = await find(id);
        if (agreement === undefined || found === undefined) continue;
        const { item, spec: kind } = found;
        if (!kind.twoWay) continue;
        if (agreement.waiting?.[createKey] !== undefined) {
          if ((await carry(item, agreement)) === "unplaced") unplaced.push(id);
          done.add(id);
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
                kind.fields.filter((field) => !kind.readOnly.has(field)),
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
          if (placed?.unplaced === true) {
            heldBack(id);
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
            remade = await connector.remake(change, watchContext);
          } catch (error) {
            if (error instanceof Unreachable) unreached(id, error);
            else if (error instanceof Refused) refuse(id, change, error);
            else throw error;
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
    await connector.run(context);
    // Once the vendor's rows are written, so a target made this run is found.
    // An answer from before the run gives way, type by type, to the
    // vendor's entry since.
    const named = new Map(answeredConnections);
    for (const { rows } of lanes.values()) {
      for (const [id, said] of rows.connecting) {
        named.set(id, { ...named.get(id), ...said });
      }
    }
    answeredConnections.clear();
    await connections.connect(
      named,
      waitingIds.filter(
        (id) => store.get(id)?.waiting?.[connectKey] !== undefined,
      ),
    );
    if (twoWay) {
      for (const { rows } of lanes.values()) {
        for (const id of rows.marked) order.add(id);
      }
      for (const id of order) {
        if (done.has(id)) continue;
        const agreement = store.get(id);
        const found = await find(id);
        if (agreement?.waiting === undefined || found === undefined) continue;
        if ((await carry(found.item, agreement)) === "unplaced") heldBack(id);
      }
      await answeredBack();
      for (const { refused, ...item } of purged.values()) {
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
          purged.delete(item.id);
          continue;
        }
        let answered: Entry | undefined;
        try {
          answered = await connector.onChange?.(
            { kind: "purged", item, changed: new Set() },
            watchContext,
          );
        } catch (error) {
          if (error instanceof Unreachable) {
            unreached(item.id, error);
            purged.set(item.id, item);
          } else if (error instanceof Refused) {
            const said = logger.redact(error.message);
            purgeRefusedOf(item.id, said);
            purged.set(item.id, {
              ...item,
              refused: {
                at: clock.now().toISOString(),
                reason: capBytes(said, reasonBytes),
              },
            });
          } else throw error;
          continue;
        }
        pushed += 1;
        await settlePurge(lane(item.type).spec, item, answered);
        purged.delete(item.id);
      }
    }
  } catch (error) {
    failure = error;
    if (!(error instanceof Stopped) && setup.fenced?.() !== true) {
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
    if (fenced) throw new Error("the hold was lost, so nothing more is kept");
    await store.flush();
  } catch (error) {
    flushed = false;
    failure ??= error;
    logger.warn(
      `what the two sides agreed on could not be kept: ${describe(error)}`,
    );
  }
  const finishedAt = clock.now();
  const pastLog = recorded && flushed && read?.cursor !== undefined;

  const all = [...lanes.values()].map(({ rows }) => rows);
  const seeded = all.reduce((sum, rows) => sum + rows.seeded, 0);
  const held = all.reduce((sum, rows) => sum + rows.held, 0);
  for (const id of store.oversized) {
    raised.set(
      `oversized:${id}`,
      `what was agreed for ${id} outgrew the instance's cap and was dropped, so the row takes the vendor's values when next sent`,
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

  const landed = failure === undefined && held === 0;
  // A delivery is processed once its run ends without error; a write it
  // held is re-read by the next scheduled run's full read, so it need not wait.
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
  // A run that didn't reach what raises one can't be taken to have cleared it.
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
  // A state that could not be read is not written over with nothing.
  if (loaded !== undefined && !fenced) {
    try {
      await store.save({
        state: landed ? draft : stored.state,
        conditions,
        ...(pastLog && read?.cursor !== undefined
          ? { cursor: read.cursor }
          : stored.cursor !== undefined && { cursor: stored.cursor }),
        ...(purged.size > 0 && { purges: [...purged.values()] }),
      });
    } catch (error) {
      logger.warn(
        `the connector's state could not be kept: ${describe(error)}`,
      );
    }
  }
  return {
    succeeded: failure === undefined,
    settled,
    cursor: pastLog ? read?.cursor : stored.cursor,
  };
}

export async function waitingInMarfa<E extends EnvDeclaration>(
  setup: RunSetup<E>,
  cursor: string | undefined,
): Promise<{ waiting: boolean; cursor: string | undefined }> {
  const specs = specsOf(
    setup.connector,
    setup.environment.values as EnvValues<E>,
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
    const spec = last === undefined ? undefined : specs.get(last.type);
    if (last === undefined || spec === undefined) return false;
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
    const spec = specs.get(item.type);
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
