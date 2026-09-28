import type { Agreement } from "./agreement.js";
import type {
  Connected,
  ConnectionDefinition,
  Item,
  Target,
} from "./define.js";
import { Refusal, type Edge, type Marfa } from "./marfa.js";
import { Stopped, type Hooks, type Rows, type Spec } from "./rows.js";
import type { Store } from "./store.js";

/** Marfa's connections of a row changed since the vendor last had them. */
export const connectionsKey = "@connections";

/** The vendor named a target Marfa holds no row for yet. */
export const connectKey = "@connect";

/** A target as the agreement keeps one the vendor named and Marfa lacks. */
function keyOf(target: Target): string {
  return `${target.type} ${target.id}`;
}

function targetOf(key: string): Target {
  const at = key.indexOf(" ");
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

/** A connection type's changes in Marfa, and the agreement once they are carried. */
export interface Carried {
  readonly connections: Record<string, Connected>;
  readonly agreed: Record<string, string[]>;
  /** A target the vendor has not been told about kept a change back. */
  readonly deferred: boolean;
}

/**
 * The connections from the connector's rows: what the vendor names is
 * written once the vendor's rows are, a target not yet in Marfa is retried
 * each run, and what changed in Marfa is carried back, or put back where the
 * row's kind is read only. Each side is compared with what was agreed, by
 * target id, so the kit's own writes are never a change.
 */
export class Connections {
  constructor(
    private readonly marfa: Marfa,
    private readonly kinds: ReadonlyMap<string, ConnectionDefinition>,
    private readonly lanes: ReadonlyMap<string, { spec: Spec; rows: Rows }>,
    private readonly store: Store,
    private readonly hooks: Hooks,
    private readonly signal: AbortSignal,
  ) {}

  /** The connection types a row of the type is the source of. */
  typesFrom(type: string): string[] {
    return [...this.kinds.values()]
      .filter((kind) => kind.source_type_constraints?.includes(type) === true)
      .map((kind) => kind.id);
  }

  /** Each row with its outbound edges of the connector's connection types. */
  async edgesOf(
    ids: readonly string[],
  ): Promise<Map<string, { item: Item; edges: Edge[] }>> {
    const [type] = this.lanes.keys();
    if (ids.length === 0 || type === undefined) return new Map();
    return this.marfa.edgesFrom(type, ids, new Set(this.kinds.keys()));
  }

  /**
   * Writes the connections the vendor named for each row, and the targets
   * earlier runs could not find, removals first so a type that allows one
   * target is re-pointed.
   */
  async connect(
    named: ReadonlyMap<string, Readonly<Record<string, readonly Target[]>>>,
    retry: readonly string[],
  ): Promise<void> {
    const ids = [...new Set([...named.keys(), ...retry])].filter(
      (id) => this.rowOf(id)?.item.state !== "trashed",
    );
    const edges = await this.edgesOf(ids);
    for (const id of ids) {
      const found = this.rowOf(id);
      const agreement = this.store.get(id);
      if (found === undefined || agreement === undefined) continue;
      const said = named.get(id) ?? {};
      const types = new Set([
        ...Object.keys(said),
        ...Object.keys(agreement.pending ?? {}),
      ]);
      let next = agreement;
      for (const type of types) {
        next = await this.connectType(
          found,
          next,
          type,
          said[type],
          edges.get(id)?.edges ?? [],
        );
      }
      this.store.set(id, next);
    }
  }

  private async connectType(
    found: { item: Item; spec: Spec },
    agreement: Agreement,
    type: string,
    said: readonly Target[] | undefined,
    edges: readonly Edge[],
  ): Promise<Agreement> {
    const { item, spec } = found;
    const kind = this.kinds.get(type);
    const agreed = new Set(agreement.connections?.[type] ?? []);
    const waiting = agreement.pending?.[type] ?? [];
    const outside = (said ?? []).filter(
      (target) => kind?.target_type_constraints?.includes(target.type) !== true,
    );
    if (kind === undefined || outside.length > 0) {
      this.hooks.condition(
        `connection-refused:${item.id}:${type}`,
        `the vendor names ${type} connections from ${item.id} that the connector does not declare for their ends, so they are not written`,
      );
      return agreement;
    }
    const resolved = await this.resolve(
      said ?? waiting.map((key) => targetOf(key)),
    );
    const wanted = new Set(
      said === undefined
        ? [...agreed, ...[...resolved.values()].map((row) => row.id)]
        : [...resolved.values()].map((row) => row.id),
    );
    const unresolved = (said ?? waiting.map((key) => targetOf(key)))
      .map((target) => keyOf(target))
      .filter((key) => !resolved.has(key));
    const current = new Map(
      edges
        .filter((edge) => edge.edge_type === type)
        .map((edge) => [edge.target_id, edge.id]),
    );
    const add = [...wanted].filter(
      (target) => !current.has(target) && (!spec.twoWay || !agreed.has(target)),
    );
    const remove = [...current].filter(
      ([target]) => !wanted.has(target) && (!spec.twoWay || agreed.has(target)),
    );
    if (
      !spec.twoWay &&
      [...current.keys()].some(
        (target) => !agreed.has(target) && !wanted.has(target),
      )
    ) {
      this.putBackCondition(item.id, type);
    }
    const kept = new Set(wanted);
    for (const [target, edge] of remove) {
      if (!(await this.disconnect(edge, item))) kept.add(target);
    }
    for (const target of await this.link(item, type, add)) kept.delete(target);
    return this.agreeOn(agreement, type, kept, unresolved);
  }

  /**
   * A read-only row's connections a person changed in Marfa, put back to
   * what the vendor last said.
   */
  async putBack(item: Item, agreement: Agreement, edges: readonly Edge[]) {
    let next = agreement;
    for (const type of this.typesFrom(item.type)) {
      const agreed = new Set(agreement.connections?.[type] ?? []);
      const current = new Map(
        edges
          .filter((edge) => edge.edge_type === type)
          .map((edge) => [edge.target_id, edge.id]),
      );
      const add = [...agreed].filter((target) => !current.has(target));
      const remove = [...current].filter(([target]) => !agreed.has(target));
      if (add.length === 0 && remove.length === 0) continue;
      const kept = new Set(agreed);
      for (const [target, edge] of remove) {
        if (!(await this.disconnect(edge, item))) kept.add(target);
      }
      const gone = await this.present(add);
      for (const target of await this.link(
        item,
        type,
        add.filter((target) => !gone.has(target)),
      )) {
        kept.delete(target);
      }
      for (const target of gone) kept.delete(target);
      this.putBackCondition(item.id, type);
      next = this.agreeOn(next, type, kept, next.pending?.[type] ?? []);
    }
    return next;
  }

  /**
   * What changed in Marfa against what was agreed, by connection type, as
   * the rows at the other end: a target purged since is dropped, and one
   * the vendor has not been told about waits.
   */
  async changes(
    item: Item,
    agreement: Agreement,
    edges: readonly Edge[],
  ): Promise<Carried> {
    const connections: Record<string, Connected> = {};
    const agreed: Record<string, string[]> = { ...agreement.connections };
    let deferred = false;
    for (const type of this.typesFrom(item.type)) {
      const was = new Set(agreement.connections?.[type] ?? []);
      const now = new Set(
        edges
          .filter((edge) => edge.edge_type === type)
          .map((edge) => edge.target_id),
      );
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
      // Removed: carried, or gone with a target purged or never told.
      for (const target of removed) {
        if (rows.get(target) === undefined || told(target) !== undefined) {
          next.delete(target);
        }
      }
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
        if (row !== undefined) found.set(keyOf(target), row);
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

  private async present(ids: readonly string[]): Promise<Set<string>> {
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

  private async disconnect(edge: string, item: Item): Promise<boolean> {
    if (this.signal.aborted) throw new Stopped();
    try {
      await this.marfa.disconnect(edge);
      return true;
    } catch (error) {
      if (!(error instanceof Refusal) || error.status === undefined) {
        throw error;
      }
      if (error.status >= 500 || error.status === 401) throw error;
      this.hooks.refused(
        item.source_id ?? item.id,
        `${error.code}, ${error.detail}`,
      );
      return false;
    }
  }

  /** Writes the edges, and answers the targets the server refused. */
  private async link(
    item: Item,
    type: string,
    targets: readonly string[],
  ): Promise<string[]> {
    if (targets.length === 0) return [];
    if (this.signal.aborted) throw new Stopped();
    const results = await this.marfa.connect(
      targets.map((target) => ({
        source_id: item.id,
        target_id: target,
        edge_type: type,
      })),
    );
    const refused: string[] = [];
    for (const result of results) {
      if (result.outcome !== "errored") continue;
      const target = targets[result.index];
      if (target === undefined) continue;
      refused.push(target);
      this.hooks.refused(
        item.source_id ?? item.id,
        `${type} to ${target}: ${result.error?.code ?? "unknown"}, ${result.error?.message ?? ""}`,
      );
    }
    return refused;
  }
}
