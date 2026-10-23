import type { ConnectionDefinition } from "./define.js";

/**
 * A connection type the instance ships and a connector declares without
 * registering it. `inbound` marks a declared id that is the shipped type's
 * reverse name: the connector's row is then the edge's target, and the
 * declaration reads from that row's side, as every declaration does, so its
 * ends are swapped and its cardinality turned about.
 */
export interface Shipped {
  /** The instance's edge type that the connection writes. */
  readonly edge: string;
  readonly inbound: boolean;
  /** A trash of the edge's source takes its targets into the bin. */
  readonly cascades: boolean;
}

const shipped: ReadonlyMap<string, Shipped> = new Map([
  ["attached-to", { edge: "attached-to", inbound: false, cascades: false }],
  ["in-thread", { edge: "in-thread", inbound: false, cascades: false }],
  ["references", { edge: "references", inbound: false, cascades: false }],
  ["parent-of", { edge: "parent-of", inbound: false, cascades: true }],
  ["child-of", { edge: "parent-of", inbound: true, cascades: true }],
]);

export function shippedConnection(id: string): Shipped | undefined {
  return shipped.get(id);
}

/** How a declared connection reaches the instance's edges. */
export function wireOf(id: string): Shipped {
  return shipped.get(id) ?? { edge: id, inbound: false, cascades: false };
}

/** The instance's edge types the connections write, which a key's edge
 *  permissions name. */
export function edgeTypesOf(
  connections: readonly Pick<ConnectionDefinition, "id">[],
): Set<string> {
  return new Set(connections.map((kind) => wireOf(kind.id).edge));
}

/** For each edge type the connections write, the end of its edges that is
 *  the connector's row: the source, or for an inbound connection the target. */
export function endsOf(
  connections: readonly Pick<ConnectionDefinition, "id">[],
): Map<string, "source" | "target"> {
  return new Map(
    connections.map((kind) => {
      const wire = wireOf(kind.id);
      return [wire.edge, wire.inbound ? "target" : "source"];
    }),
  );
}

/** A cardinality as the other end of the edge reads it. */
export function turned(
  cardinality: ConnectionDefinition["cardinality"],
): ConnectionDefinition["cardinality"] {
  if (cardinality === "one-to-many") return "many-to-one";
  if (cardinality === "many-to-one") return "one-to-many";
  return cardinality;
}
