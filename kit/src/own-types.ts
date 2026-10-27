import type { components } from "@withmarfa/client";
import type { TypeDefinition } from "./define.js";
import { causeOf, Refusal, type Key, type Marfa } from "./marfa.js";
import { typeDifferences, type TypeDifferences } from "./type-check.js";

type TypeUpdate = components["schemas"]["TypeDefinitionUpdate"];

/** The fields the connector writes without, by type, since the server's
 *  type lacks them and the key may not add them. */
export interface Narrowed {
  readonly fields: ReadonlyMap<string, readonly string[]>;
  /** What each type's run raises, since the way out differs by type. */
  readonly conditions: ReadonlyMap<string, string>;
}

/** Why the key may not add the fields: it lacks the scope that replaces a
 *  type, or the server refused the replacement as beyond that scope. */
export type Withheld =
  | { readonly kind: "grant"; readonly key: string; readonly command: string }
  | { readonly kind: "refused"; readonly changes: readonly string[] };

export interface TypeStep {
  readonly problem: string | undefined;
  readonly narrowed: Narrowed | undefined;
}

type Outcome =
  | { readonly problem: string }
  | { readonly omitted: readonly string[]; readonly withheld?: Withheld };

/** Fields no row can be written without as the connector means it. */
const fileFields = ["blob_ref", "mime_type"];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The command that sets one level of a key's metadata map. An update replaces
 * a map with the entries it names, so the command names every entry the key
 * keeps, with the one level changed.
 */
export function metadataCommand(
  key: Key,
  level: Record<string, "read" | "write">,
): string {
  const kept = { ...key.metadata_permissions };
  for (const [name, value] of Object.entries(level)) kept[name] = value;
  const entries = Object.entries(kept).map(
    ([name, value]) => `--metadata-permission ${name}=${value}`,
  );
  return `marfa keys update ${key.id} ${entries.join(" ")}`;
}

function grantCommand(key: Key): string {
  return metadataCommand(key, { types: "write" });
}

/** The fix comes first, since a condition is cut at 500 characters. */
export function narrowedCondition(
  type: string,
  fields: readonly string[],
  withheld: Withheld,
): string {
  const them = fields.length === 1 ? "it" : "them";
  const until = `until then it writes the type ${type} without ${fields.join(", ")}, which this connector declares and the server's type lacks`;
  if (withheld.kind === "grant") {
    return `grant the key ${withheld.key} metadata types=write with \`${withheld.command}\`, and the connector adds ${them} on its next start or scheduled run; ${until}, and the key may not add ${them}`;
  }
  return `an operator replaces the type with the connector's definition, \`marfa types replace ${type} --file <definition>\`, and the connector then writes ${them} on its next start or scheduled run; ${until}, and the server refused the key the change to ${withheld.changes.join(", ")}, which needs schema.write`;
}

function grantWithheld(key: Key): Withheld {
  return { kind: "grant", key: key.id, command: grantCommand(key) };
}

function operatorFix(id: string): string {
  return `an operator who means the change replaces the type with the connector's definition, \`marfa types replace ${id} --file <definition>\`, and the rows it holds keep their values until their next write`;
}

/** The members the server named when it refused a replacement as beyond the
 *  key's scope; none when it named no change, as when the key holds neither
 *  scope. */
function refusedChanges(error: unknown): readonly string[] | undefined {
  if (!(error instanceof Refusal) || error.status !== 403) return undefined;
  if (error.details["required_scope"] !== "schema.write") return undefined;
  const changes: unknown = error.details["changes"];
  return Array.isArray(changes) &&
    changes.length > 0 &&
    changes.every((change): change is string => typeof change === "string")
    ? changes
    : [];
}

function listed(differences: TypeDifferences): string {
  return [
    ...differences.other,
    ...differences.missing.map(
      (name) => `field "${name}" is missing on the server`,
    ),
  ].join("; ");
}

export function replacement(
  type: TypeDefinition,
  served: Record<string, unknown>,
): TypeUpdate {
  const definition = {
    ...served,
    ...type,
    fields: { ...record(served["fields"]), ...type.fields },
  };
  Reflect.deleteProperty(definition, "id");
  for (const name of ["version", "version_policy", "roles", "merge_policy"]) {
    Reflect.deleteProperty(definition, name);
    if (Object.hasOwn(served, name))
      Object.defineProperty(definition, name, {
        value: served[name],
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return definition as TypeUpdate;
}

/**
 * Registers each type the instance does not hold, and holds each it does
 * to what the connector carries. A key holding `metadata.types:write` adds
 * the optional fields the server lacks itself, and sets the `label`,
 * `description` and `display_hints` the type declares differently itself,
 * in one replacement, when the server allows that key the change; one that
 * lacks the scope, or is refused, runs without them. Every other difference
 * stops the start, so two versions of a connector never rewrite each
 * other's structure. Nothing orders presentation between versions: each
 * start writes the connector's own, so two versions running at once with
 * different labels would swap them on every start. `again` is a registration
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
  const conditions = new Map<string, string>();
  for (const type of types) {
    const snapshot = await marfa.normalizeType(type);
    const served = snapshot.resolved_type;
    const outcome =
      served === null
        ? await register(type, marfa, key, again, say)
        : await reconcile(type, marfa, key, snapshot, say, true);
    if ("problem" in outcome) {
      return { problem: outcome.problem, narrowed: undefined };
    }
    if (outcome.omitted.length > 0) {
      fields.set(type.id, outcome.omitted);
      conditions.set(
        type.id,
        narrowedCondition(
          type.id,
          outcome.omitted,
          outcome.withheld ?? grantWithheld(key),
        ),
      );
    }
  }
  return {
    problem: undefined,
    narrowed: fields.size === 0 ? undefined : { fields, conditions },
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
      const now = await marfa.normalizeType(type);
      if (now.resolved_type !== null) {
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
  snapshot: components["schemas"]["NormalizedType"],
  say: (message: string) => void,
  deletable: boolean,
): Promise<Outcome> {
  const served = snapshot.registered_type;
  const resolved = snapshot.resolved_type;
  if (served === null || resolved === null)
    throw new Error("invalid normalized type snapshot");
  const differences = typeDifferences(snapshot.type, resolved, served);
  if (differences.other.length > 0) {
    return {
      problem: `the type ${type.id} on the server differs from the one this connector carries, and is not rewritten: ${listed(differences)}. ${capitalized(operatorFix(type.id))}`,
    };
  }
  const { missing, presentation } = differences;
  if (missing.length === 0 && presentation.length === 0) {
    return { omitted: [] };
  }
  const needed = missing.filter(
    (name) => name === type.link_field || fileFields.includes(name),
  );
  const withheld = (reason: Withheld): Outcome => {
    if (presentation.length > 0) {
      say(
        reason.kind === "grant"
          ? `the type ${type.id} on the server differs from this connector's ${presentation.join(", ")}, and the key ${reason.key} may not change it; grant it metadata types=write with \`${reason.command}\` and the connector sets it on its next start`
          : `the server refused the key the change to the ${presentation.join(", ")} of the type ${type.id}, which this connector carries; it runs on with the server's`,
      );
    }
    if (needed.length === 0) return { omitted: missing, withheld: reason };
    const fix =
      reason.kind === "grant"
        ? `grant it metadata types=write with \`${grantCommand(key)}\`, or ${operatorFix(type.id)}`
        : `the server refused the key the change to ${reason.changes.join(", ")}, which needs schema.write, so ${operatorFix(type.id)}`;
    return {
      problem: `the type ${type.id} on the server lacks ${needed.join(", ")}, without which this connector cannot write its rows, and the key ${key.id} may not add ${needed.length === 1 ? "it" : "them"}: ${fix}`,
    };
  };
  if (key.metadata_permissions["types"] !== "write") {
    return withheld(grantWithheld(key));
  }
  const gone = async (): Promise<Outcome> =>
    deletable
      ? register(type, marfa, key, true, say)
      : {
          problem: `the type ${type.id} was deleted from the instance while it was brought up to date`,
        };
  try {
    await marfa.replaceType(type.id, replacement(snapshot.type, served));
  } catch (error) {
    if (causeOf(error) === "marfa") throw error;
    if (error instanceof Refusal && error.status === 404) return gone();
    if (
      error instanceof Refusal &&
      missing.length === 0 &&
      refusedChanges(error) === undefined
    ) {
      return withheld({ kind: "refused", changes: [...presentation] });
    }
    const changes = refusedChanges(error);
    if (changes !== undefined) {
      return withheld(
        changes.length === 0
          ? grantWithheld(key)
          : { kind: "refused", changes },
      );
    }
    return {
      problem: `the type ${type.id} could not be brought up to date with ${missing.join(", ")}, which this connector declares and the server lacks: ${said(error)}`,
    };
  }
  if (missing.length > 0) {
    say(
      `added ${missing.join(", ")} to the type ${type.id}, which this connector declares and the server lacked`,
    );
  }
  if (presentation.length > 0) {
    say(
      `changed the ${presentation.join(", ")} of the type ${type.id} to the ones this connector carries`,
    );
  }
  const now = await marfa.normalizeType(type);
  if (now.resolved_type === null) return gone();
  if (now.registered_type === null)
    throw new Error("invalid normalized type snapshot");
  const left = typeDifferences(
    now.type,
    now.resolved_type,
    now.registered_type,
  );
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
