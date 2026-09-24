import type { TypeDefinition } from "./define.js";

/** What makes a field what it is; its description and label do not. */
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

/** A top-level list and per-field flags are two spellings of one thing. */
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

/**
 * How the server's type differs from the one a connector carries, in shape:
 * fields, what each field is, which are required, its parent and what it
 * declares itself compatible with. An empty list means they agree.
 */
export function typeDifferences(
  carried: TypeDefinition,
  served: Record<string, unknown>,
): string[] {
  const differences: string[] = [];
  const mine = record(carried.fields);
  const theirs = record(served["fields"]);

  for (const name of Object.keys(mine)
    .filter((n) => !(n in theirs))
    .sort()) {
    differences.push(`field "${name}" is missing on the server`);
  }
  for (const name of Object.keys(theirs)
    .filter((n) => !(n in mine))
    .sort()) {
    differences.push(
      `field "${name}" is on the server and not in this connector`,
    );
  }
  for (const name of Object.keys(mine)
    .filter((n) => n in theirs)
    .sort()) {
    const here = record(mine[name]);
    const there = record(theirs[name]);
    for (const attribute of shape) {
      const a = here[attribute] ?? defaults[attribute];
      const b = there[attribute] ?? defaults[attribute];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        differences.push(
          `field "${name}" has ${attribute} ${show(a)} here and ${show(b)} on the server`,
        );
      }
    }
  }

  const required = requiredSet(carried);
  const requiredThere = requiredSet(served);
  for (const name of required.filter((n) => !requiredThere.includes(n))) {
    differences.push(`field "${name}" is required here and not on the server`);
  }
  for (const name of requiredThere.filter((n) => !required.includes(n))) {
    differences.push(`field "${name}" is required on the server and not here`);
  }

  if ((carried.parent ?? undefined) !== (served["parent"] ?? undefined)) {
    differences.push(
      `parent is ${show(carried.parent)} here and ${show(served["parent"])} on the server`,
    );
  }
  const compatible = names(carried.compatible_with);
  const compatibleThere = names(served["compatible_with"]);
  if (JSON.stringify(compatible) !== JSON.stringify(compatibleThere)) {
    differences.push(
      `compatible_with is ${show(compatible)} here and ${show(compatibleThere)} on the server`,
    );
  }
  return differences;
}
