import type { Agreement } from "./agreement.js";
import type {
  Connected,
  ConnectionDefinition,
  Item,
  Target,
} from "./define.js";
import { Refusal, type Edge, type Marfa } from "./marfa.js";
import {
  connectKey,
  Stopped,
  type Hooks,
  type Rows,
  type Spec,
} from "./rows.js";
import type { Store } from "./store.js";

/** Marfa's connections of a row changed since the vendor last had them. */
export const connectionsKey = "@connections";

/** A target as the agreement keeps one the vendor named and Marfa lacks. */
function keyOf(target: Target): string {
  return `${target.type} ${target.id}`;
}

function targetOf(key: string): Target {
  const at = key.indexOf(" ");
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

/** A connection type's changes in Marfa, and agreement once carried. */
export interface Carried {
  readonly connections: Record<string, Connected>;
  readonly agreed: Record<string, string[]>;
  /** A target the vendor has not been told about kept a change back. */
  readonly deferred: boolean;
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
    return this.marfa.edgesFrom(type, ids, new Set(this.kinds.keys()));
  }

  /** Writes the connections named, plus targets earlier runs missed.
   *  Removals go first, so a target with one source moves, not refused. */
  async connect(
    named: ReadonlyMap<string, Readonly<Record<string, readonly Target[]>>>,
    retry: readonly string[],
  ): Promise<void> {
    const ids = [...new Set([...named.keys(), ...retry])].filter(
      (id) => this.rowOf(id)?.item.state !== "trashed",
    );
    const edges = await this.edgesOf(ids);
    const plans: Plan[] = [];
    for (const id of ids) {
      const found = this.rowOf(id);
      const agreement = this.store.get(id);
      if (found === undefined || agreement === undefined) continue;
      const said = named.get(id) ?? {};
      for (const type of new Set([
        ...Object.keys(said),
        ...Object.keys(agreement.pending ?? {}),
      ])) {
        const plan = await this.plan(
          found,
          agreement,
          type,
          said[type],
          edges.get(id)?.edges ?? [],
        );
        if (plan !== undefined) plans.push(plan);
      }
    }
    for (const plan of plans) {
      for (const [target, edge] of plan.remove) {
        if (!(await this.disconnect(edge, plan.item, plan.type, target))) {
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
      })),
    )) {
      plans
        .find(
          (plan) => plan.item.id === refused.id && plan.type === refused.type,
        )
        ?.kept.delete(refused.target);
    }
    for (const plan of plans) {
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

  /** What one row's connections of one type need, against what was agreed:
   *  nothing agreed or read-only takes the vendor's; two-way keeps Marfa's. */
  private async plan(
    found: { item: Item; spec: Spec },
    agreement: Agreement,
    type: string,
    said: readonly Target[] | undefined,
    edges: readonly Edge[],
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
    const mirror = !spec.twoWay || seeding;
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
      type,
      add,
      remove,
      kept: new Set(wanted),
      unresolved,
      putBack: !spec.twoWay && !seeding && diverged,
      // A new row has nothing agreed either; only what Marfa held differs.
      seeded: seeding && remove.length > 0,
    };
  }

  /** The row's edges of the type to the connector's own rows of the target
   *  types: another's, e.g. a note's attached file, isn't the connector's. */
  private async own(
    edges: readonly Edge[],
    kind: ConnectionDefinition,
    known: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    const ofType = edges.filter((edge) => edge.edge_type === kind.id);
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

  /** A read-only row's connections a person changed in Marfa, put back to
   *  what the vendor last said. */
  async putBack(item: Item, agreement: Agreement, edges: readonly Edge[]) {
    let next = agreement;
    for (const type of this.typesFrom(item.type)) {
      const kind = this.kinds.get(type);
      if (kind === undefined) continue;
      const agreed = new Set(agreement.connections?.[type] ?? []);
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
      this.putBackCondition(item.id, type);
      next = this.agreeOn(next, type, kept, next.pending?.[type] ?? []);
    }
    return next;
  }

  /** What changed in Marfa against what was agreed: nothing agreed carries
   *  nothing unless created; a purged target drops, an untold one waits. */
  async changes(
    item: Item,
    agreement: Agreement,
    edges: readonly Edge[],
    created: boolean,
  ): Promise<Carried> {
    const connections: Record<string, Connected> = {};
    const agreed: Record<string, string[]> = { ...agreement.connections };
    let deferred = false;
    for (const type of this.typesFrom(item.type)) {
      const kind = this.kinds.get(type);
      const agreedList = agreement.connections?.[type];
      if (kind === undefined || (agreedList === undefined && !created)) {
        continue;
      }
      const was = new Set(agreedList ?? []);
      const now = new Set((await this.own(edges, kind, was)).keys());
      const added = [...now].filter((target) => !was.has(target));
      const removed = [...was].filter((target) => !now.has(target));
      if (added.length === 0 && removed.length === 0) continue;
      const rows = await this.rows([...added, ...removed]);
      const told = (target: string): Item | undefined => {
        const row = rows.get(target);
        return row !== undefined && this.linked(row) ? row : undefined;
      };
      const carried: Connected = {
        added: added.flatMap((target) => told(target) ?? []),
        removed: removed.flatMap((target) => told(target) ?? []),
      };
      // Added to a target not yet at the vendor: carried once it is.
      deferred ||= added.some((target) => told(target) === undefined);
      const next = new Set(was);
      for (const row of carried.added) next.add(row.id);
      // Removed and carried, or gone, or never at the vendor: agreed no more.
      for (const target of removed) next.delete(target);
      agreed[type] = [...next].sort();
      if (carried.added.length > 0 || carried.removed.length > 0) {
        connections[type] = carried;
      }
    }
    return { connections, agreed, deferred };
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

  /** The rows the targets name, by `<type> <id>`, where Marfa holds them. */
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

  /** The rows by id, in any state, that still exist. */
  private async rows(ids: readonly string[]): Promise<Map<string, Item>> {
    const [type] = this.lanes.keys();
    if (ids.length === 0 || type === undefined) return new Map();
    const found = await this.marfa.lookup(type, { ids });
    for (const item of found.data) this.lanes.get(item.type)?.rows.adopt(item);
    return new Map(found.data.map((item) => [item.id, item]));
  }

  /** The ids no row answers for any more. */
  private async absent(ids: readonly string[]): Promise<Set<string>> {
    const rows = await this.rows(ids);
    return new Set(ids.filter((id) => !rows.has(id)));
  }

  /** Whether the vendor knows the row: a kind with a link holds one on it. */
  private linked(row: Item): boolean {
    const lane = this.lanes.get(row.type);
    if (lane === undefined) return false;
    return (
      lane.spec.link === undefined ||
      lane.rows.linkOf(row.properties) !== undefined
    );
  }

  private rowOf(id: string): { item: Item; spec: Spec } | undefined {
    for (const { spec, rows } of this.lanes.values()) {
      const item = rows.known(id);
      if (item !== undefined) return { item, spec };
    }
    return undefined;
  }

  private async disconnect(
    edge: string,
    item: Item,
    type: string,
    target: string,
  ): Promise<boolean> {
    if (this.hooks.fenced() || this.signal.aborted) throw new Stopped();
    try {
      await this.marfa.disconnect(edge);
      return true;
    } catch (error) {
      if (!(error instanceof Refusal) || error.status === undefined) {
        throw error;
      }
      if (error.status >= 500 || error.status === 401) throw error;
      this.refused(item, type, target, `${error.code}, ${error.detail}`);
      return false;
    }
  }

  private async link(
    adds: readonly { item: Item; type: string; target: string }[],
  ): Promise<{ id: string; type: string; target: string }[]> {
    if (adds.length === 0) return [];
    if (this.hooks.fenced() || this.signal.aborted) throw new Stopped();
    const results = await this.marfa.connect(
      adds.map(({ item, type, target }) => ({
        source_id: item.id,
        target_id: target,
        edge_type: type,
      })),
    );
    const refused: { id: string; type: string; target: string }[] = [];
    for (const result of results) {
      const add = adds[result.index];
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

/** One row's connections of one type, as the run will change them. */
interface Plan {
  readonly item: Item;
  readonly type: string;
  readonly add: readonly string[];
  readonly remove: readonly [string, string][];
  /** The targets agreed once the writes land. */
  readonly kept: Set<string>;
  readonly unresolved: readonly string[];
  readonly putBack: boolean;
  readonly seeded: boolean;
}
