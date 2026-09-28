import type { Connector, EnvDeclaration } from "./define.js";

/** A start refused before anything reached the server. */
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export interface Environment {
  url: string;
  key: string;
  values: Record<string, string | undefined>;
  /** Every value that is never to be printed, the key included. */
  secrets: string[];
}

const reservedSourcePrefixes = ["oauth:", "connector:"];

/**
 * Shorter than this, a secret cannot be redacted without the redaction
 * showing where each of its characters falls in ordinary text.
 */
export const shortestSecret = 8;

/** An address a request can be sent to: no credentials, query or fragment. */
function isServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      !/[?#]/.test(value)
    );
  } catch {
    return false;
  }
}

export function readEnvironment<E extends EnvDeclaration>(
  connector: Connector<E>,
  env: Readonly<Record<string, string | undefined>>,
): Environment {
  const missing: string[] = [];
  const present = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  const need = (name: string): string => {
    const value = present(name);
    if (value === undefined) missing.push(name);
    return value ?? "";
  };

  const url = need("MARFA_URL");
  const key = need("MARFA_KEY");
  const values: Record<string, string | undefined> = {};
  const secrets = new Map([["MARFA_KEY", key]]);
  for (const [name, kind] of Object.entries(connector.env ?? {})) {
    if (kind === "optional") {
      values[name] = present(name);
      continue;
    }
    const value = need(name);
    values[name] = value;
    if (kind === "secret") secrets.set(name, value);
  }
  if (missing.length > 0) {
    throw new ConfigurationError(
      `cannot start without ${missing.join(", ")} in the environment`,
    );
  }
  // Named and not shown: a value pasted into the wrong variable is often
  // the key itself.
  if (!isServerUrl(url)) {
    throw new ConfigurationError(
      "MARFA_URL is not an http or https address without credentials, a query or a fragment",
    );
  }
  const short = [...secrets].filter(
    ([, value]) => value.length < shortestSecret,
  );
  if (short.length > 0) {
    throw new ConfigurationError(
      `${short.map(([name]) => name).join(", ")} is shorter than ${String(shortestSecret)} characters, too short to keep out of the logs`,
    );
  }
  return { url, key, values, secrets: [...secrets.values()] };
}

/**
 * The kit's own rules for a connector's definition: the server's bounds on
 * a registration and a source.
 */
export function checkDefinition<E extends EnvDeclaration>(
  connector: Connector<E>,
): void {
  const problems: string[] = [];
  if (connector.name.length < 1 || connector.name.length > 200) {
    problems.push("a name of 1 to 200 characters");
  }
  if ((connector.description?.length ?? 0) > 2000) {
    problems.push("a description of at most 2000 characters");
  }
  const source = connector.source.trim();
  if (source === "" || source.length > 200) {
    problems.push("a source of 1 to 200 characters");
  }
  const lowered = source.toLowerCase();
  if (reservedSourcePrefixes.some((prefix) => lowered.startsWith(prefix))) {
    problems.push(
      `a source outside the reserved ${reservedSourcePrefixes.join(" and ")} prefixes`,
    );
  }
  const ids = connector.types.map((kind) => kind.type.id);
  if (ids.length < 1 || ids.length > 10) {
    problems.push("one to ten types, as far as the log's type filter reaches");
  }
  if (new Set(ids).size !== ids.length) problems.push("each type once");
  for (const kind of connector.types) {
    const outside = [
      ...(kind.readOnly ?? []),
      ...(kind.type.link_field === undefined ? [] : [kind.type.link_field]),
    ].filter((field) => !kind.fields.includes(field));
    if (outside.length > 0) {
      problems.push(
        `${kind.type.id}'s link and read-only fields among its fields, where ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not`,
      );
    }
  }
  if (problems.length > 0) {
    throw new ConfigurationError(`the connector needs ${problems.join("; ")}`);
  }
}
