import type { Connector, EnvDeclaration } from "./define.js";

/** A start refused before anything reached the server. */
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export interface Environment {
  url: string;
  key: string;
  stateDir: string;
  values: Record<string, string | undefined>;
  /** Every value that is never to be printed, the key included. */
  secrets: string[];
}

const reservedSourcePrefixes = ["oauth:", "connector:"];

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
  const stateDir = need("MARFA_STATE_DIR");
  const values: Record<string, string | undefined> = {};
  const secrets = [key];
  for (const [name, kind] of Object.entries(connector.env ?? {})) {
    if (kind === "optional") {
      values[name] = present(name);
      continue;
    }
    const value = need(name);
    values[name] = value;
    if (kind === "secret") secrets.push(value);
  }
  if (missing.length > 0) {
    throw new ConfigurationError(
      `cannot start without ${missing.join(", ")} in the environment`,
    );
  }
  return { url, key, stateDir, values, secrets: secrets.filter((s) => s !== "") };
}

/** What the server would refuse later, refused before it is asked. */
export function checkDefinition<E extends EnvDeclaration>(
  connector: Connector<E>,
): void {
  const problems: string[] = [];
  if (connector.name.length < 1 || connector.name.length > 200) {
    problems.push("a name of 1 to 200 characters");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(connector.name)) {
    problems.push("a name of lowercase letters, digits, dots, hyphens and underscores, which names its state file");
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
    problems.push(`a source outside the reserved ${reservedSourcePrefixes.join(" and ")} prefixes`);
  }
  if (problems.length > 0) {
    throw new ConfigurationError(`the connector needs ${problems.join("; ")}`);
  }
}
