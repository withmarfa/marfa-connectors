import { isDeepStrictEqual } from "node:util";
import type { ConnectionDefinition, TypeDefinition } from "./define.js";
import type { EdgeType } from "./marfa.js";

const shape = [
  "type",
  "items_type",
  "format",
  "enum_values",
  "searchable",
  "max_length",
  "max_items",
] as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function names(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").sort()
    : [];
}

function requiredSet(type: Record<string, unknown>): string[] {
  const fields = record(type["fields"]);
  const flagged = Object.entries(fields)
    .filter(([, field]) => record(field)["required"] === true)
    .map(([name]) => name);
  return [...new Set([...names(type["required"]), ...flagged])].sort();
}

function show(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

export interface TypeDifferences {
  /** Optional fields the connector declares and the server lacks, the one
   *  difference a connector puts right itself: a type gaining a field
   *  leaves the rows it holds as they are. */
  readonly missing: readonly string[];
  /** Of `label`, `description` and `display_hints`, and of each table's and
   *  column's `label` and `description`, those the connector carries and the
   *  type holds differently itself, not by inheritance. A connector puts these
   *  right itself: they change no stored item. */
  readonly presentation: readonly string[];
  /** Tables the connector declares that the server lacks, or lacks an
   *  optional column of or the `order` of, the other difference a connector
   *  puts right itself: each is named by its table, and no stored row is
   *  changed by adding it. */
  readonly tables: readonly string[];
  /** Every other difference, which only an operator may put right. */
  readonly other: readonly string[];
}

const columnShape = [
  "type",
  "enum_values",
  "format",
  "max_length",
  "minimum",
  "maximum",
  "type_constraints",
  "adds_up",
] as const;

/** What a table the connector declares needs of the server's: the tables and
 *  optional columns it lacks, the labels and descriptions the type itself
 *  holds differently, and what differs beyond that. The server's own tables
 *  and columns that the connector does not declare are no difference. */
function tableDifferences(
  carried: Record<string, unknown>,
  served: Record<string, unknown>,
  declared: Record<string, unknown>,
): { missing: string[]; presentation: string[]; other: string[] } {
  const missing: string[] = [];
  const presentation: string[] = [];
  const other: string[] = [];
  const mine = record(carried["tables"]);
  const theirs = record(served["tables"]);
  const own = record(declared["tables"]);
  const shown = (
    wanted: Record<string, unknown>,
    holds: Record<string, unknown>,
    where: string,
  ): void => {
    for (const attribute of ["label", "description"] as const) {
      if (
        wanted[attribute] !== undefined &&
        !isDeepStrictEqual(wanted[attribute], holds[attribute])
      )
        presentation.push(`${where} ${attribute}`);
    }
  };
  for (const name of Object.keys(mine).sort()) {
    if (!Object.hasOwn(theirs, name)) {
      missing.push(name);
      continue;
    }
    const here = record(mine[name]);
    const there = record(theirs[name]);
    const columns = record(here["columns"]);
    const held = record(there["columns"]);
    const mineOwn = record(own[name]);
    shown(here, mineOwn, `table ${name}`);
    let lacks = false;
    for (const column of Object.keys(columns).sort()) {
      const wanted = record(columns[column]);
      if (!Object.hasOwn(held, column)) {
        if (wanted["required"] === true)
          other.push(
            `table "${name}" column "${column}" is required here and missing on the server`,
          );
        else lacks = true;
        continue;
      }
      const have = record(held[column]);
      shown(
        wanted,
        record(record(mineOwn["columns"])[column]),
        `table ${name} column ${column}`,
      );
      for (const attribute of columnShape) {
        if (
          JSON.stringify(wanted[attribute]) !== JSON.stringify(have[attribute])
        )
          other.push(
            `table "${name}" column "${column}" has ${attribute} ${show(wanted[attribute])} here and ${show(have[attribute])} on the server`,
          );
      }
      for (const attribute of ["required", "searchable"] as const) {
        if ((wanted[attribute] ?? false) !== (have[attribute] ?? false))
          other.push(
            `table "${name}" column "${column}" has ${attribute} ${show(wanted[attribute] ?? false)} here and ${show(have[attribute] ?? false)} on the server`,
          );
      }
    }
    const order = here["order"];
    if (order !== undefined && order !== there["order"]) {
      if (there["order"] === undefined) lacks = true;
      else
        other.push(
          `table "${name}" has order ${show(order)} here and ${show(there["order"])} on the server`,
        );
    }
    if (lacks) missing.push(name);
  }
  return { missing, presentation, other };
}

/** Fields the server holds and the connector does not declare are no
 *  difference, unless the server requires them: another version of the
 *  connector, or an operator, added them, and they are kept. */
export function typeDifferences(
  carried: TypeDefinition,
  served: Record<string, unknown>,
  declared: Record<string, unknown> = served,
): TypeDifferences {
  const missing: string[] = [];
  const other: string[] = [];
  const mine = record(carried.fields);
  const theirs = record(served["fields"]);
  const required = requiredSet(carried);

  for (const name of Object.keys(mine)
    .filter((n) => !Object.hasOwn(theirs, n))
    .sort()) {
    if (required.includes(name)) {
      other.push(`field "${name}" is required here and missing on the server`);
    } else missing.push(name);
  }
  for (const name of Object.keys(mine)
    .filter((n) => Object.hasOwn(theirs, n))
    .sort()) {
    const here = record(mine[name]);
    const there = record(theirs[name]);
    for (const attribute of shape) {
      const a = here[attribute];
      const b = there[attribute];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        other.push(
          `field "${name}" has ${attribute} ${show(a)} here and ${show(b)} on the server`,
        );
      }
    }
  }

  for (const name of Object.keys(mine)
    .filter((n) => Object.hasOwn(theirs, n))
    .sort()) {
    const here = record(mine[name]);
    if (here["type"] !== "status") continue;
    // The server answers every word the chain gives, the type's own last, so
    // each word this type declares has to be among them, in its group: one
    // missing is added, and one in another group is for an operator.
    const there = Array.isArray(record(theirs[name])["status_values"])
      ? (record(theirs[name])["status_values"] as unknown[]).map(record)
      : [];
    for (const word of Array.isArray(here["status_values"])
      ? (here["status_values"] as unknown[]).map(record)
      : []) {
      const held = there.find((one) => one["value"] === word["value"]);
      if (held === undefined) {
        // Words are added the way a field is: a status field gaining a word
        // leaves the rows it holds as they are.
        if (!missing.includes(name)) missing.push(name);
      } else if (held["group"] !== word["group"]) {
        other.push(
          `field "${name}" has the status word ${show(word["value"])} in group ${show(word["group"])} here and ${show(held["group"])} on the server`,
        );
      }
    }
  }

  const requiredDeclared = requiredSet(declared);
  const requiredThere = requiredSet(served).filter(
    (n) => Object.hasOwn(mine, n) || requiredDeclared.includes(n),
  );
  for (const name of required.filter(
    (n) => Object.hasOwn(theirs, n) && !requiredThere.includes(n),
  )) {
    other.push(`field "${name}" is required here and not on the server`);
  }
  for (const name of requiredThere.filter((n) => !required.includes(n))) {
    other.push(`field "${name}" is required on the server and not here`);
  }

  if (carried.parent !== served["parent"]) {
    other.push(
      `parent is ${show(carried.parent)} here and ${show(served["parent"])} on the server`,
    );
  }
  const linkThere = served["link_field"] ?? undefined;
  if (carried.link_field !== linkThere) {
    other.push(
      `link_field is ${show(carried.link_field)} here and ${show(linkThere)} on the server`,
    );
  }
  const typePresentation = (["label", "description", "display_hints"] as const)
    .filter(
      (name) =>
        carried[name] !== undefined &&
        !isDeepStrictEqual(carried[name], declared[name]),
    )
    .map(String);
  const tables = tableDifferences(carried, served, declared);
  other.push(...tables.other);
  return {
    missing,
    presentation: [...typePresentation, ...tables.presentation],
    tables: tables.missing,
    other,
  };
}

export function edgeTypeDifferences(
  carried: ConnectionDefinition,
  served: EdgeType,
): string[] {
  const sorted = (values: readonly string[] | undefined) =>
    [...(values ?? [])].sort();
  const pairs: [string, unknown, unknown][] = [
    ["cardinality", carried.cardinality, served.cardinality],
    [
      "cascade_on_delete",
      carried.cascade_on_delete ?? "orphan",
      served.cascade_on_delete,
    ],
    [
      "from_type_constraints",
      sorted(carried.from_type_constraints),
      sorted(served.from_type_constraints),
    ],
    [
      "to_type_constraints",
      sorted(carried.to_type_constraints),
      sorted(served.to_type_constraints),
    ],
    ["reverse_name", carried.reverse_name, served.reverse_name],
    ["written_from", carried.written_from ?? "from", served.written_from],
  ];
  return pairs
    .filter(([, here, there]) => JSON.stringify(here) !== JSON.stringify(there))
    .map(
      ([name, here, there]) =>
        `${name} is ${show(here)} here and ${show(there)} on the server`,
    );
}

export function constraintWidening(
  carried: ConnectionDefinition,
  served: EdgeType,
): boolean {
  if (
    edgeTypeDifferences(
      {
        ...carried,
        from_type_constraints: served.from_type_constraints,
        to_type_constraints: served.to_type_constraints,
      },
      served,
    ).length > 0 ||
    !isDeepStrictEqual(carried.property_schema ?? {}, served.property_schema)
  )
    return false;
  const widens = (before: readonly string[], after: readonly string[]) => {
    const all = (values: readonly string[]) =>
      values.length === 0 || values.includes("*");
    if (all(after)) return true;
    if (all(before)) return false;
    return before.every((value) => after.includes(value));
  };
  return (
    widens(served.from_type_constraints, carried.from_type_constraints ?? []) &&
    widens(served.to_type_constraints, carried.to_type_constraints ?? [])
  );
}
