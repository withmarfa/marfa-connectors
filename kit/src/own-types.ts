import type { components } from "@withmarfa/client";
import type { TypeDefinition } from "./define.js";
import { causeOf, Refusal, type Key, type Marfa } from "./marfa.js";
import { typeDifferences, type TypeDifferences } from "./type-check.js";

type TypeUpdate = components["schemas"]["TypeDefinitionUpdate"];

/** The fields the connector writes without, by type, since the server's
 *  type lacks them and the key may not add them. */
export interface Narrowed {
  /** The key's id, which the fix names. */
  readonly key: string;
  readonly fields: ReadonlyMap<string, readonly string[]>;
}

export interface TypeStep {
  readonly problem: string | undefined;
  readonly narrowed: Narrowed | undefined;
}

type Outcome =
  { readonly problem: string } | { readonly omitted: readonly string[] };

const replacing = "schema.write";

/** Fields no row can be written without as the connector means it. */
const fileFields = ["blob_ref", "mime_type"];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function grant(key: string): string {
  return `\`marfa keys update ${key} --permission ${replacing}\``;
}

export function narrowedCondition(
  type: string,
  fields: readonly string[],
  key: string,
): string {
  const them = fields.length === 1 ? "it" : "them";
  return `grant the key ${key} ${replacing} with ${grant(key)}, and the connector adds ${them} on its next start or scheduled run; until then it writes the type ${type} without ${fields.join(", ")}, which this connector declares, the server's type lacks and the key may not add`;
}

function operatorFix(id: string): string {
  return `an operator who means the change replaces the type with the connector's definition, \`marfa types update ${id} --file <definition>\`, and the rows it holds keep their values until their next write`;
}

function listed(differences: TypeDifferences): string {
  return [
    ...differences.other,
    ...differences.missing.map(
      (name) => `field "${name}" is missing on the server`,
    ),
  ].join("; ");
}

/** The parent's merge policy, resolved, which a served type's answer
 *  carries beside its own entries. */
function ownPolicy(
  served: unknown,
  parent: unknown,
): Record<string, unknown> | undefined {
  const policy = record(served);
  if (Object.keys(policy).length === 0) return undefined;
  if (parent === undefined) return policy;
  const above = record(parent);
  const aboveFields = record(above["fields"]);
  const fields = Object.fromEntries(
    Object.entries(record(policy["fields"])).filter(
      ([name, strategy]) => aboveFields[name] !== strategy,
    ),
  );
  const own: Record<string, unknown> = {};
  if (Object.keys(fields).length > 0) own["fields"] = fields;
  if (
    policy["default"] !== undefined &&
    policy["default"] !== above["default"]
  ) {
    own["default"] = policy["default"];
  }
  return Object.keys(own).length === 0 ? undefined : own;
}

/** The parent's version policy, resolved, which a served type's answer
 *  merges with its own entries key by key. */
function ownVersionPolicy(
  served: unknown,
  parent: unknown,
): Record<string, unknown> | undefined {
  const policy = record(served);
  const above = record(parent);
  const own = Object.fromEntries(
    Object.entries(policy).filter(
      ([name, value]) => JSON.stringify(above[name]) !== JSON.stringify(value),
    ),
  );
  return Object.keys(own).length === 0 ? undefined : own;
}

/** The roles a served type carries beyond its ancestors', since its answer
 *  holds the union across the parent chain. */
function ownRoles(served: unknown, parent: unknown): string[] | undefined {
  const above = new Set(Array.isArray(parent) ? parent : []);
  const own = (Array.isArray(served) ? served : []).filter(
    (role): role is string => typeof role === "string" && !above.has(role),
  );
  return own.length === 0 ? undefined : own;
}

/**
 * The connector's own definition, with what the server holds that is not
 * the connector's to change: the fields neither it nor the parent
 * declares, the version, and the type's own version policy, roles and merge
 * policy. The served answer resolves the parent, so it is never sent back
 * whole.
 */
export function replacement(
  type: TypeDefinition,
  served: Record<string, unknown>,
  parent: Record<string, unknown> | undefined,
): TypeUpdate {
  const declared = record(type.fields);
  const inherited = record(parent?.["fields"]);
  const kept = Object.fromEntries(
    Object.entries(record(served["fields"])).filter(
      ([name]) => !(name in declared) && !(name in inherited),
    ),
  );
  const definition: Record<string, unknown> = { ...type };
  for (const name of [
    "id",
    "version",
    "version_policy",
    "roles",
    "merge_policy",
  ]) {
    Reflect.deleteProperty(definition, name);
  }
  const policy = ownPolicy(served["merge_policy"], parent?.["merge_policy"]);
  const versions = ownVersionPolicy(
    served["version_policy"],
    parent?.["version_policy"],
  );
  const roles = ownRoles(served["roles"], parent?.["roles"]);
  return {
    ...definition,
    fields: { ...type.fields, ...kept } as TypeUpdate["fields"],
    ...(typeof served["version"] === "number" && {
      version: served["version"],
    }),
    ...(versions !== undefined && {
      version_policy: versions,
    }),
    ...(roles !== undefined && { roles }),
    ...(policy !== undefined && {
      merge_policy: policy,
    }),
  };
}

/**
 * Registers each type the instance does not hold, and holds each it does
 * to what the connector carries. A key holding `schema.write` adds the
 * optional fields the server lacks itself; one without it runs without
 * them. Every other difference stops the start, so two versions of a
 * connector never rewrite each other's type. `again` is a registration
 * made again, so a type missing now was deleted since it was registered.
 */
export async function ensureTypes(
  types: readonly TypeDefinition[],
  marfa: Marfa,
  key: Key,
  again: boolean,
  say: (message: string) => void,
): Promise<TypeStep> {
  const fields = new Map<string, readonly string[]>();
  for (const type of types) {
    const served = await marfa.type(type.id);
    const outcome =
      served === undefined
        ? await register(type, marfa, key, again, say)
        : await reconcile(type, marfa, key, served, say, true);
    if ("problem" in outcome) {
      return { problem: outcome.problem, narrowed: undefined };
    }
    if (outcome.omitted.length > 0) fields.set(type.id, outcome.omitted);
  }
  return {
    problem: undefined,
    narrowed: fields.size === 0 ? undefined : { key: key.id, fields },
  };
}

async function register(
  type: TypeDefinition,
  marfa: Marfa,
  key: Key,
  again: boolean,
  say: (message: string) => void,
): Promise<Outcome> {
  if (again && key.metadata_permissions["types"] !== "write") {
    return {
      problem: `the type ${type.id} was deleted from the instance and this key may not register it again; stop the connector or mint a key with types=write`,
    };
  }
  try {
    await marfa.registerType(type);
    return { omitted: [] };
  } catch (error) {
    if (causeOf(error) === "marfa") throw error;
    // Another process holding the key registered it first, which is as good
    // as registering it, if it is the same type.
    if (error instanceof Refusal && error.status === 409) {
      const now = await marfa.type(type.id);
      if (now !== undefined) {
        return reconcile(type, marfa, key, now, say, false);
      }
    }
    return {
      problem: `the type ${type.id} could not be registered: ${said(error)}`,
    };
  }
}

/** `deletable` registers the type again where it is deleted while it is
 *  put right, once. */
async function reconcile(
  type: TypeDefinition,
  marfa: Marfa,
  key: Key,
  served: Record<string, unknown>,
  say: (message: string) => void,
  deletable: boolean,
): Promise<Outcome> {
  const parent =
    type.parent === undefined ? undefined : await marfa.type(type.parent);
  const inherited = Object.keys(record(parent?.["fields"]));
  const differences = typeDifferences(type, served, inherited);
  if (differences.other.length > 0) {
    return {
      problem: `the type ${type.id} on the server differs from the one this connector carries, and is not rewritten: ${listed(differences)}. ${capitalized(operatorFix(type.id))}`,
    };
  }
  const { missing } = differences;
  if (missing.length === 0) return { omitted: [] };
  if (!key.permissions.includes(replacing)) {
    const needed = missing.filter(
      (name) => name === type.link_field || fileFields.includes(name),
    );
    if (needed.length === 0) return { omitted: missing };
    return {
      problem: `the type ${type.id} on the server lacks ${needed.join(", ")}, without which this connector cannot write its rows, and the key ${key.id} may not add ${needed.length === 1 ? "it" : "them"}: grant it ${replacing} with ${grant(key.id)}, or ${operatorFix(type.id)}`,
    };
  }
  const gone = async (): Promise<Outcome> =>
    deletable
      ? register(type, marfa, key, true, say)
      : {
          problem: `the type ${type.id} was deleted from the instance while it was brought up to date`,
        };
  try {
    await marfa.replaceType(type.id, replacement(type, served, parent));
  } catch (error) {
    if (causeOf(error) === "marfa") throw error;
    if (error instanceof Refusal && error.status === 404) return gone();
    return {
      problem: `the type ${type.id} could not be brought up to date with ${missing.join(", ")}, which this connector declares and the server lacks: ${said(error)}`,
    };
  }
  say(
    `added ${missing.join(", ")} to the type ${type.id}, which this connector declares and the server lacked`,
  );
  const now = await marfa.type(type.id);
  if (now === undefined) return gone();
  const left = typeDifferences(type, now, inherited);
  if (left.other.length > 0 || left.missing.length > 0) {
    return {
      problem: `the type ${type.id} on the server still differs from the one this connector carries after it was brought up to date, so another process may be changing it: ${listed(left)}`,
    };
  }
  return { omitted: [] };
}

/** Every error here is the server's answer, which carries no cause. */
function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
