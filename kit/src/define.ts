import type { components } from "@withmarfa/client";

/**
 * A type as `POST /types` takes it. The check on start compares it with the
 * server's in the form the server stores: a format that is a field type of
 * its own, such as `url`, counts as that type, and a `required` list as
 * per-field flags.
 */
export type TypeDefinition = components["schemas"]["TypeDefinitionInput"];

/**
 * How the kit treats an environment variable a connector names: `secret`
 * and `required` fail the start when absent, and a secret's value is
 * redacted from every log line and report.
 */
export type EnvKind = "secret" | "required" | "optional";

export type EnvDeclaration = Readonly<Record<string, EnvKind>>;

export type EnvValues<E extends EnvDeclaration> = {
  readonly [K in keyof E]: E[K] extends "optional"
    ? string | undefined
    : string;
};

/** One row as the vendor has it, before it is compared with the server's. */
export interface Entry {
  /** Unique within the connector's source, the vendor account included. */
  source_id: string;
  /** A property that is absent or `null` is cleared from the row. */
  properties: Readonly<Record<string, unknown>>;
  occurred_at?: string | undefined;
}

export interface State {
  get(key: string): unknown;
  /** Kept only if every write in the run lands. */
  set(key: string, value: unknown): void;
}

export interface Log {
  info(message: string): void;
  warn(message: string): void;
  /**
   * Something that lasts across runs, such as a feed that stopped answering.
   * A connector raises it on every run it holds; it is reported on the first
   * and said to be cleared on the first run that does not raise it.
   */
  condition(key: string, message: string): void;
}

export interface RunContext<E extends EnvDeclaration> {
  readonly env: EnvValues<E>;
  /** Aborted when the process is asked to stop. */
  readonly signal: AbortSignal;
  readonly state: State;
  readonly log: Log;
  /** Writes what differs from the connector's own rows, and nothing else. */
  upsert(entries: readonly Entry[]): Promise<void>;
  /** Archives the named rows that are active. A trashed row is left alone. */
  archive(sourceIds: readonly string[]): Promise<void>;
}

export interface Connector<E extends EnvDeclaration = EnvDeclaration> {
  /** The registration's name, and the name of the state file. */
  readonly name: string;
  readonly description?: string;
  /** Named on every write and on every read of the connector's own rows. */
  readonly source: string;
  readonly type: TypeDefinition;
  readonly env?: E;
  run(context: RunContext<E>): Promise<void>;
}

export function defineConnector<
  const E extends EnvDeclaration = EnvDeclaration,
>(connector: Connector<E>): Connector<E> {
  return connector;
}
