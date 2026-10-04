import type { ConnectionDefinition, TypeDefinition } from "./define.js";
import type { EdgeType } from "./marfa.js";

const shape = [
  "type",
  "items_type",
  "format",
  "enum_values",
  "searchable",
  "maxLength",
  "maxItems",
] as const;

const defaults: Partial<Record<(typeof shape)[number], unknown>> = {
  searchable: true,
};

const typeFormats = new Set(["url", "email", "datetime", "date", "thumbnail"]);

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

function normalized(field: unknown): Record<string, unknown> {
  const out = { ...record(field) };
  const format = out["format"];
  if (typeof format === "string" && typeFormats.has(format)) {
    // The server folds the format into the field's type, or into `items_type`
    // on an array of strings.
    out[out["type"] === "array" ? "items_type" : "type"] = format;
    delete out["format"];
  }
  return out;
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
  /** Every other difference, which only an operator may put right. */
  readonly other: readonly string[];
}

/** Fields the server holds and the connector does not declare are no
 *  difference, unless the server requires them: another version of the
 *  connector, or an operator, added them, and they are kept. */
export function typeDifferences(
  carried: TypeDefinition,
  served: Record<string, unknown>,
  inherited: readonly string[] = [],
): TypeDifferences {
  const missing: string[] = [];
  const other: string[] = [];
  const mine = record(carried.fields);
  const theirs = record(served["fields"]);
  const required = requiredSet(carried);

  for (const name of Object.keys(mine)
    .filter((n) => !(n in theirs))
    .sort()) {
    if (required.includes(name)) {
      other.push(`field "${name}" is required here and missing on the server`);
    } else missing.push(name);
  }
  for (const name of Object.keys(mine)
    .filter((n) => n in theirs)
    .sort()) {
    const here = normalized(mine[name]);
    const there = normalized(theirs[name]);
    for (const attribute of shape) {
      const a = here[attribute] ?? defaults[attribute];
      const b = there[attribute] ?? defaults[attribute];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        other.push(
          `field "${name}" has ${attribute} ${show(a)} here and ${show(b)} on the server`,
        );
      }
    }
  }

  const requiredThere = requiredSet(served).filter(
    (n) => n in mine || !inherited.includes(n),
  );
  for (const name of required.filter(
    (n) => n in theirs && !requiredThere.includes(n),
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
  const compatible = names(carried.compatible_with);
  const compatibleThere = names(served["compatible_with"]);
  if (JSON.stringify(compatible) !== JSON.stringify(compatibleThere)) {
    other.push(
      `compatible_with is ${show(compatible)} here and ${show(compatibleThere)} on the server`,
    );
  }
  const linkThere = served["link_field"] ?? undefined;
  if (carried.link_field !== linkThere) {
    other.push(
      `link_field is ${show(carried.link_field)} here and ${show(linkThere)} on the server`,
    );
  }
  return { missing, other };
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
      "source_type_constraints",
      sorted(carried.source_type_constraints),
      sorted(served.source_type_constraints),
    ],
    [
      "target_type_constraints",
      sorted(carried.target_type_constraints),
      sorted(served.target_type_constraints),
    ],
    ["reverse_name", carried.reverse_name, served.reverse_name],
    ["written_at", carried.written_at ?? "source", served.written_at],
  ];
  return pairs
    .filter(([, here, there]) => JSON.stringify(here) !== JSON.stringify(there))
    .map(
      ([name, here, there]) =>
        `${name} is ${show(here)} here and ${show(there)} on the server`,
    );
}
