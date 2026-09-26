import type { components } from "@withmarfa/client";

/**
 * A type as `POST /types` takes it. The check on start compares it with the
 * server's in the form the server stores: a format that is a field type of
 * its own, such as `url`, counts as that type, and a `required` list as
 * per-field flags.
 */
export type TypeDefinition = components["schemas"]["TypeDefinitionInput"];

/** A row as the server answers it. */
export type Item = components["schemas"]["Item"];

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
  /**
   * When the vendor last changed the entry. Read where a row in Marfa has
   * changed since the connector's own write: the later of the two changes
   * wins, and a vendor that names no time loses.
   */
  changed_at?: string | undefined;
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
  readonly upsert: (entries: readonly Entry[]) => Promise<void>;
  /**
   * Archives the named rows that are active: by link value where the
   * connector declares a link, by source id where it does not. A trashed
   * row is left alone.
   */
  readonly archive: (keys: readonly string[]) => Promise<void>;
}

/**
 * What happened to a row in Marfa since the connector last looked, as the
 * log names it: a transition to archived or trashed, a restore, a purge,
 * or a create or an update of its properties.
 */
export type ChangeKind =
  "created" | "updated" | "restored" | "archived" | "trashed" | "purged";

export interface Change {
  readonly kind: ChangeKind;
  /** The row as the log last showed it. */
  readonly item: Item;
}

export interface WatchContext<E extends EnvDeclaration> {
  readonly env: EnvValues<E>;
  readonly signal: AbortSignal;
  readonly state: State;
  readonly log: Log;
  /**
   * Writes the vendor's own id for the row onto its link property, at the
   * version the change showed, retrying once if the row moved since. A
   * value another row of the type already carries is refused, and the
   * refusal names both rows.
   */
  readonly setLink: (item: Item, value: string) => Promise<void>;
}

export interface Connector<E extends EnvDeclaration = EnvDeclaration> {
  /** The registration's name, as the server lists it. */
  readonly name: string;
  readonly description?: string;
  /** Named on every create and on every read of the connector's own rows. */
  readonly source: string;
  readonly type: TypeDefinition;
  /**
   * The property on the type that holds the vendor's own id for a row. With a
   * link, every row of the type is the connector's to read and write,
   * whoever created it: an entry finds its row by this field first and by
   * its natural key under the connector's source second, and a row that
   * carries no value is one the vendor has not been told about.
   */
  readonly link?: string;
  readonly env?: E;
  /**
   * Refuses, by throwing, an environment the connector can tell on sight it
   * cannot run with, such as a malformed address list. The start stops as it
   * does for a missing value, before anything reaches the server.
   */
  readonly checkEnv?: (env: EnvValues<E>) => void | Promise<void>;
  run(context: RunContext<E>): Promise<void>;
  /**
   * Carries a change made in Marfa to the vendor. Called once per row that
   * changed since the last run, in the order the log records: a `created`
   * change before `run` reads the vendor, the rest after `run` has written
   * what the vendor had. Resolving means the change landed or
   * was consciously abandoned with a condition; throwing fails the run and
   * holds the cursor, so the change is offered again next run.
   */
  onChange?(change: Change, context: WatchContext<E>): Promise<void>;
}

export function defineConnector<
  const E extends EnvDeclaration = EnvDeclaration,
>(connector: Connector<E>): Connector<E> {
  return connector;
}
