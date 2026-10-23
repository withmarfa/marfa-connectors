import type { Agreement } from "./agreement.js";
import type {
  Connected,
  ConnectionDefinition,
  Entry,
  Item,
  Target,
} from "./define.js";
import { causeOf, Refusal, type Edge, type Marfa } from "./marfa.js";
import {
  connectKey,
  forRow,
  suspended,
  Stopped,
  type Hooks,
  type Rows,
  type Spec,
} from "./rows.js";
import { wireOf } from "./shipped.js";
import type { Store } from "./store.js";

export const connectionsKey = "@connections";

function keyOf(target: Target): string {
  return `${target.type} ${target.id}`;
}

function targetOf(key: string): Target {
  const at = key.indexOf(" ");
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

/** Rows read at once for their inbound edges. */
const inboundReads = 8;

/**
 * The edges of the declared connections at each row, every one read from the
 * row's side as the declaration is: an edge the row is the target of, for a
 * connection that is the reverse name of a shipped type, comes back turned
 * about, naming the other row as its target, with the edge's own id.
 */
export async function readEdges(
  marfa: Marfa,
  type: string,
  ids: readonly string[],
  kinds: Iterable<ConnectionDefinition>,
): Promise<Map<string, { item: Item; edges: Edge[] }>> {
  const declared = [...kinds];
  const found = await marfa.edgesFrom(
    type,
    ids,
    new Set(
      declared
        .filter((kind) => !wireOf(kind.id).inbound)
        .map((kind) => kind.id),
    ),
  );
  // A lookup carries only the edges that start at a row.
  const reads = declared
    .filter((kind) => wireOf(kind.id).inbound)
    .flatMap((kind) =>
      [...found.values()]
        .filter(
          ({ item }) =>
            kind.source_type_constraints?.includes(item.type) === true,
        )
        .map(({ item, edges }) => ({ kind, item, edges })),
    );
  for (let at = 0; at < reads.length; at += inboundReads) {
    await Promise.all(
      reads.slice(at, at + inboundReads).map(async ({ kind, item, edges }) => {
        for (const edge of await marfa.edgesInto(
          item.id,
          wireOf(kind.id).edge,
        )) {
          edges.push({
            ...edge,
            edge_type: kind.id,
            source_id: edge.target_id,
            target_id: edge.source_id,
          });
        }
      }),
    );
  }
  return found;
}

export interface Carried {
  readonly connections: Record<string, Connected>;
  readonly agreed: Record<string, string[]>;
  readonly deferred: boolean;
  readonly unplaced: boolean;
}

/** The connections from the connector's rows, against what was agreed by
 *  target id, so the kit's own writes are never mistaken for a change. */
export class Connections {
  constructor(
    private readonly marfa: Marfa,
    private readonly kinds: ReadonlyMap<string, ConnectionDefinition>,
    private readonly lanes: ReadonlyMap<string, { spec: Spec; rows: Rows }>,
    private readonly store: Store,
    private readonly hooks: Hooks,
    private readonly signal: AbortSignal,
  ) {}

  mirrored(spec: Spec, type: string): boolean {
    return !spec.twoWay || spec.readOnly.has(type);
  }

  typesFrom(type: string): string[] {
    return [...this.kinds.values()]
      .filter((kind) => kind.source_type_constraints?.includes(type) === true)
      .map((kind) => kind.id);
  }

  async edgesOf(
    ids: readonly string[],
  ): Promise<Map<string, { item: Item; edges: Edge[] }>> {
    const [type] = this.lanes.keys();
    if (ids.length === 0 || type === undefined) return new Map();
    return readEdges(this.marfa, type, ids, this.kinds.values());
  }

  /** Removals go first, so a target with one source moves, not refused. */
  async connect(
    named: ReadonlyMap<string, Readonly<Record<string, readonly Target[]>>>,
    retry: readonly string[],
    incoming: ReadonlyMap<string, Entry> = new Map(),
  ): Promise<void> {
    const ids = [...new Set([...named.keys(), ...retry])].filter(
      (id) =>
        this.rowOf(id)?.item.state !== "trashed" &&
        (Object.keys(named.get(id) ?? {}).length > 0 ||
          Object.keys(this.store.get(id)?.pending ?? {}).length > 0),
    );
    const edges = await this.edgesOf(ids);
    const plans: Plan[] = [];
    for (const id of ids) {
      const agreement = this.store.get(id);
      if (agreement === undefined) continue;
      const said = named.get(id) ?? {};
      for (const type of new Set([
        ...Object.keys(said),
        ...Object.keys(agreement.pending ?? {}),
      ])) {
        const candidate = incoming.get(id);
        const entry =
          said[type] !== undefined &&
          candidate?.connections?.[type] !== undefined
            ? candidate
            : undefined;
        const found = await this.freshOwned(id, entry);
        if (found === undefined) continue;
        const plan = await this.plan(
          found,
          agreement,
          type,
          said[type],
          edges.get(id)?.edges ?? [],
          entry,
        );
        if (plan !== undefined) plans.push(plan);
      }
    }
    for (const plan of plans) {
      for (const [target, edge] of plan.remove) {
        if (
          !(await this.disconnect(
            edge,
            plan.item,
            plan.type,
            target,
            plan.entry,
          ))
        ) {
          plan.kept.add(target);
        }
      }
    }
    const adds = plans.flatMap((plan) =>
      plan.add.map((target) => ({ plan, target })),
    );
    for (const refused of await this.link(
      adds.map(({ plan, target }) => ({
        item: plan.item,
        type: plan.type,
        target,
        ...(plan.entry !== undefined && { entry: plan.entry }),
      })),
    )) {
      plans
        .find(
          (plan) => plan.item.id === refused.id && plan.type === refused.type,
        )
        ?.kept.delete(refused.target);
    }
    for (const plan of plans) {
      if ((await this.freshOwned(plan.item.id, plan.entry)) === undefined)
        continue;
      const agreement = this.store.get(plan.item.id);
      if (agreement === undefined) continue;
      const next = this.agreeOn(
        agreement,
        plan.type,
        plan.kept,
        plan.unresolved,
      );
      if (JSON.stringify(next) !== JSON.stringify(agreement)) {
        this.store.set(plan.item.id, next);
      }
      if (plan.putBack) this.putBackCondition(plan.item.id, plan.type);
      if (plan.seeded) {
        this.hooks.condition(
          `connections-seeded:${plan.item.id}:${plan.type}`,
          `the ${plan.type} connections of ${plan.item.id} had nothing agreed, so they took the vendor's and nothing was carried back`,
        );
      }
    }
  }

  private async plan(
    found: { item: Item; spec: Spec },
    agreement: Agreement,
    type: string,
    said: readonly Target[] | undefined,
    edges: readonly Edge[],
    entry?: Entry,
  ): Promise<Plan | undefined> {
    const { item, spec } = found;
    const kind = this.kinds.get(type);
    const outside = (said ?? []).filter(
      (target) => kind?.target_type_constraints?.includes(target.type) !== true,
    );
    if (kind === undefined || outside.length > 0) {
      this.hooks.condition(
        `connection-refused:${item.id}:${type}`,
        `the vendor names ${type} connections from ${item.id} that the connector does not declare for their ends, so they are not written`,
      );
      return undefined;
    }
    const agreedList = agreement.connections?.[type];
    const agreed = new Set(agreedList ?? []);
    const seeding = said !== undefined && agreedList === undefined;
    const named = said ?? (agreement.pending?.[type] ?? []).map(targetOf);
    const resolved = await this.resolve(named);
    const wanted = new Set([
      ...(said === undefined ? agreed : []),
      ...[...resolved.values()].map((row) => row.id),
    ]);
    const unresolved = named
      .map((target) => keyOf(target))
      .filter((key) => !resolved.has(key));
    const current = await this.own(
      edges,
      kind,
      new Set([...agreed, ...wanted]),
    );
    const mirror = this.mirrored(spec, type) || seeding;
    const add = [...wanted].filter(
      (target) => !current.has(target) && (mirror || !agreed.has(target)),
    );
    const remove = [...current].filter(
      ([target]) => !wanted.has(target) && (mirror || agreed.has(target)),
    );
    const diverged =
      [...current.keys()].some(
        (target) => !agreed.has(target) && !wanted.has(target),
      ) ||
      [...agreed].some((target) => wanted.has(target) && !current.has(target));
    return {
      item,
      ...(entry !== undefined && { entry }),
      type,
      add,
      remove,
      kept: new Set(wanted),
      unresolved,
      putBack: this.mirrored(spec, type) && !seeding && diverged,
      seeded: seeding && remove.length > 0,
    };
  }

  /** Another's, e.g. a note's attached file, isn't the connector's. */
  private async own(
    edges: readonly Edge[],
    kind: ConnectionDefinition,
    known: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    // References are shared with links people make themselves, even between
    // the connector's own types. Only its agreed or requested targets belong
    // to this connector's reconciliation.
    const ofType = edges.filter(
      (edge) =>
        edge.edge_type === kind.id &&
        (kind.id !== "references" || known.has(edge.target_id)),
    );
    const unknown = ofType
      .map((edge) => edge.target_id)
      .filter((target) => !known.has(target));
    const rows = await this.rows(unknown);
    return new Map(
      ofType
        .filter((edge) => {
          if (known.has(edge.target_id)) return true;
          const row = rows.get(edge.target_id);
          return (
            row !== undefined &&
            kind.target_type_constraints?.includes(row.type) === true
          );
        })
        .map((edge) => [edge.target_id, edge.id]),
    );
  }

  async differ(
    item: Item,
    agreement: Agreement,
    edges: readonly Edge[],
  ): Promise<boolean> {
    for (const type of this.typesFrom(item.type)) {
      const kind = this.kinds.get(type);
      if (kind === undefined) continue;
      const agreed = new Set(agreement.connections?.[type] ?? []);
      const current = await this.own(edges, kind, agreed);
      if (
        current.size !== agreed.size ||
        [...agreed].some((target) => !current.has(target))
      ) {
        return true;
      }
    }
    return false;
  }

  async putBack(
    item: Item,
    spec: Spec,
    agreement: Agreement,
    edges: readonly Edge[],
  ) {
    let next = agreement;
    for (const type of this.typesFrom(item.type)) {
      const agreedList = agreement.connections?.[type];
      if (!this.mirrored(spec, type)) continue;
      // Nothing agreed on a two-way kind: the vendor's set is taken when it
      // next names one.
      if (spec.twoWay && agreedList === undefined) continue;
      const kind = this.kinds.get(type);
      if (kind === undefined) continue;
      const agreed = new Set(agreedList ?? []);
      const current = await this.own(edges, kind, agreed);
      const add = [...agreed].filter((target) => !current.has(target));
      const remove = [...current].filter(([target]) => !agreed.has(target));
      if (add.length === 0 && remove.length === 0) continue;
      const kept = new Set(agreed);
      for (const [target, edge] of remove) {
        if (!(await this.disconnect(edge, item, type, target)))
          kept.add(target);
      }
      const gone = await this.absent(add);
      for (const { target } of await this.link(
        add
          .filter((target) => !gone.has(target))
          .map((target) => ({ item, type, target })),
      )) {
        kept.delete(target);
      }
      for (const target of gone) kept.delete(target);
      if (
        spec.policy !== undefined &&
        (await this.freshOwned(item.id)) === undefined
      )
        return agreement;
      // A target purged meanwhile is let go, which no person changed.
      if (remove.length > 0 || add.length > gone.size) {
        this.putBackCondition(item.id, type);
      }
      next = this.agreeOn(next, type, kept, next.pending?.[type] ?? []);
    }
    return next;
  }

  async changes(
    item: Item,
    spec: Spec,
    agreement: Agreement,
    edges: readonly Edge[],
    created: boolean,
  ): Promise<Carried> {
    const connections: Record<string, Connected> = {};
    const agreed: Record<string, string[]> = { ...agreement.connections };
    let deferred = false;
    let unplaced = false;
    for (const type of this.typesFrom(item.type)) {
      const kind = this.kinds.get(type);
      const agreedList = agreement.connections?.[type];
      if (
        kind === undefined ||
        (agreedList === undefined && !created) ||
        (this.mirrored(spec, type) && !created)
      ) {
        continue;
      }
      // The vendor holds none of a create's, whatever an earlier try agreed.
      const was = new Set(created ? [] : (agreedList ?? []));
      const now = new Set(
        (await this.own(edges, kind, new Set(agreedList ?? []))).keys(),
      );
      const added = [...now].filter((target) => !was.has(target));
      const removed = [...was].filter((target) => !now.has(target));
      if (added.length === 0 && removed.length === 0) continue;
      const rows = await this.rows([...added, ...removed]);
      const atVendor = await this.told([...rows.values()]);
      const told = (target: string): Item | undefined => {
        const row = rows.get(target);
        return row !== undefined && atVendor.has(target) ? row : undefined;
      };
      const carried: Connected = {
        added: added.flatMap((target) => told(target) ?? []),
        removed: removed.flatMap((target) => told(target) ?? []),
      };
      // Added to a target not yet at the vendor: carried once it is, and
      // a create a mirrored one places waits for it.
      const untold = added.some((target) => told(target) === undefined);
      deferred ||= untold;
      unplaced ||= untold && this.mirrored(spec, type);
      const next = new Set(was);
      for (const row of carried.added) next.add(row.id);
      for (const target of removed) next.delete(target);
      agreed[type] = [...next].sort();
      if (carried.added.length > 0 || carried.removed.length > 0) {
        connections[type] = carried;
      }
    }
    return { connections, agreed, deferred, unplaced };
  }

  private putBackCondition(id: string, type: string): void {
    this.hooks.condition(
      `connections-put-back:${id}:${type}`,
      `the ${type} connections of ${id} were changed in Marfa and put back from the vendor, which Marfa mirrors`,
    );
  }

  private agreeOn(
    agreement: Agreement,
    type: string,
    targets: ReadonlySet<string>,
    unresolved: readonly string[],
  ): Agreement {
    const connections = {
      ...agreement.connections,
      [type]: [...targets].sort(),
    };
    const pending = { ...agreement.pending };
    if (unresolved.length > 0) pending[type] = [...unresolved].sort();
    else Reflect.deleteProperty(pending, type);
    const waiting = { ...agreement.waiting };
    if (Object.keys(pending).length > 0) {
      waiting[connectKey] ??= new Date().toISOString();
    } else Reflect.deleteProperty(waiting, connectKey);
    const next: Agreement = { ...agreement, connections };
    Reflect.deleteProperty(next, "pending");
    Reflect.deleteProperty(next, "waiting");
    if (Object.keys(pending).length > 0) next.pending = pending;
    if (Object.keys(waiting).length > 0) next.waiting = waiting;
    return next;
  }

  private async resolve(
    targets: readonly Target[],
  ): Promise<Map<string, Item>> {
    const found = new Map<string, Item>();
    const byType = new Map<string, Target[]>();
    for (const target of targets) {
      byType.set(target.type, [...(byType.get(target.type) ?? []), target]);
    }
    for (const [type, named] of byType) {
      const rows = this.lanes.get(type)?.rows;
      if (rows === undefined) continue;
      const held = await rows.named(named.map((target) => target.id));
      for (const target of named) {
        const row = held.get(target.id);
        // The server refuses an edge to a row in the bin: it waits instead.
        if (row !== undefined && row.state !== "trashed") {
          found.set(keyOf(target), row);
        }
      }
    }
    return found;
  }

  private async rows(ids: readonly string[]): Promise<Map<string, Item>> {
    const [type] = this.lanes.keys();
    if (ids.length === 0 || type === undefined) return new Map();
    const found = await this.marfa.lookup(type, { ids });
    for (const item of found.data) this.lanes.get(item.type)?.rows.adopt(item);
    return new Map(found.data.map((item) => [item.id, item]));
  }

  private async absent(ids: readonly string[]): Promise<Set<string>> {
    const rows = await this.rows(ids);
    return new Set(ids.filter((id) => !rows.has(id)));
  }

  /** The rows the agreed connections of each type the vendor holds read
   *  only name, as told: where the row sits at the vendor. */
  async placementOf(
    item: Item,
    spec: Spec,
    agreement: Agreement,
  ): Promise<Record<string, Item[]> | undefined> {
    const types = this.typesFrom(item.type).filter(
      (type) => spec.twoWay && spec.readOnly.has(type),
    );
    const ids = types.flatMap((type) => agreement.connections?.[type] ?? []);
    if (ids.length === 0) return undefined;
    const rows = await this.rows(ids);
    const told = await this.told([...rows.values()]);
    const placement = Object.fromEntries(
      types
        .map((type): [string, Item[]] => [
          type,
          (agreement.connections?.[type] ?? []).flatMap((id) => {
            const row = rows.get(id);
            return row !== undefined && told.has(id) ? [row] : [];
          }),
        ])
        .filter(([, rows]) => rows.length > 0),
    );
    return Object.keys(placement).length === 0 ? undefined : placement;
  }

  private async told(rows: readonly Item[]): Promise<Set<string>> {
    const told = new Set<string>();
    for (const { rows: lane } of this.lanes.values()) {
      for (const id of await lane.told(rows)) told.add(id);
    }
    return told;
  }

  private rowOf(id: string): { item: Item; spec: Spec } | undefined {
    for (const { spec, rows } of this.lanes.values()) {
      const item = rows.known(id);
      if (item !== undefined) return { item, spec };
    }
    return undefined;
  }

  private async freshOwned(
    id: string,
    entry?: Entry,
  ): Promise<{ item: Item; spec: Spec } | undefined> {
    const found = this.rowOf(id);
    if (found !== undefined && suspended(found.spec, found.item, entry)) {
      this.hooks.omitted?.();
      return undefined;
    }
    if (found?.spec.policy === undefined) return found;
    const item = await this.marfa.item(id);
    if (
      item?.type !== found.spec.type ||
      forRow(found.spec, item, entry).owned === false
    ) {
      this.hooks.omitted?.();
      return undefined;
    }
    this.lanes.get(item.type)?.rows.adopt(item);
    return { item, spec: found.spec };
  }

  private async guarded(
    item: Item,
    write: (fresh: Item) => Promise<void>,
    entry?: Entry,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      const found = await this.freshOwned(item.id, entry);
      if (found === undefined) return false;
      try {
        await write(found.item);
        return true;
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof Refusal) ||
          error.code !== "version_conflict"
        )
          throw error;
      }
    }
  }

  private async disconnect(
    edge: string,
    item: Item,
    type: string,
    target: string,
    entry?: Entry,
  ): Promise<boolean> {
    if (this.hooks.fenced() || this.signal.aborted) throw new Stopped();
    const found = this.rowOf(item.id);
    if (found !== undefined && suspended(found.spec, found.item, entry)) {
      this.hooks.omitted?.();
      return false;
    }
    try {
      if (this.rowOf(item.id)?.spec.policy !== undefined) {
        return await this.guarded(
          item,
          (fresh) => this.marfa.disconnect(edge, fresh.version),
          entry,
        );
      }
      await this.marfa.disconnect(edge);
      return true;
    } catch (error) {
      if (!(error instanceof Refusal) || error.status === undefined) {
        throw error;
      }
      if (causeOf(error) !== "refused") throw error;
      this.refused(item, type, target, `${error.code}, ${error.detail}`);
      return false;
    }
  }

  private async link(
    adds: readonly {
      item: Item;
      type: string;
      target: string;
      entry?: Entry;
    }[],
  ): Promise<{ id: string; type: string; target: string }[]> {
    if (adds.length === 0) return [];
    if (this.hooks.fenced() || this.signal.aborted) throw new Stopped();
    const refused: { id: string; type: string; target: string }[] = [];
    const plain = [];
    for (const add of adds) {
      const found = this.rowOf(add.item.id);
      if (found !== undefined && suspended(found.spec, found.item, add.entry)) {
        this.hooks.omitted?.();
        refused.push({ id: add.item.id, type: add.type, target: add.target });
        continue;
      }
      if (this.rowOf(add.item.id)?.spec.policy === undefined) {
        plain.push(add);
        continue;
      }
      try {
        if (
          await this.guarded(
            add.item,
            (fresh) => this.marfa.connectExact(fresh, add.type, add.target),
            add.entry,
          )
        )
          continue;
      } catch (error) {
        if (!(error instanceof Refusal) || causeOf(error) !== "refused")
          throw error;
        this.refused(
          add.item,
          add.type,
          add.target,
          `${error.code}, ${error.detail}`,
        );
      }
      refused.push({ id: add.item.id, type: add.type, target: add.target });
    }
    const results = await this.marfa.connect(
      plain.map(({ item, type, target }) => {
        const wire = wireOf(type);
        return wire.inbound
          ? { source_id: target, target_id: item.id, edge_type: wire.edge }
          : { source_id: item.id, target_id: target, edge_type: wire.edge };
      }),
    );
    for (const result of results) {
      const add = plain[result.index];
      if (result.outcome !== "errored" || add === undefined) continue;
      refused.push({ id: add.item.id, type: add.type, target: add.target });
      this.refused(
        add.item,
        add.type,
        add.target,
        `${result.error?.code ?? "unknown"}, ${result.error?.message ?? ""}`,
      );
    }
    return refused;
  }

  private refused(item: Item, type: string, target: string, why: string) {
    this.hooks.condition(
      `connection-refused:${item.id}:${type}:${target}`,
      `the server refused the ${type} connection from ${item.id} to ${target}: ${why}`,
    );
  }
}

interface Plan {
  readonly item: Item;
  readonly entry?: Entry;
  readonly type: string;
  readonly add: readonly string[];
  readonly remove: readonly [string, string][];
  readonly kept: Set<string>;
  readonly unresolved: readonly string[];
  readonly putBack: boolean;
  readonly seeded: boolean;
}
