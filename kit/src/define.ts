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
  /**
   * The link the row was known by before the vendor moved it, such as an
   * issue transferred to another repository: the row is found by it and
   * takes the entry's link.
   */
  movedFrom?: string | undefined;
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
  /**
   * What the vendor said changed, as the ids its deliveries named: fetch
   * these and write them, and leave alone any cursor into the vendor, such
   * as a sync token, since the rest was not read. `undefined` asks for
   * everything, as a run on the schedule does, and as one does whose
   * deliveries asked for it. An empty set, from deliveries that named
   * nothing, asks for nothing.
   */
  readonly hints: ReadonlySet<string> | undefined;
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
 * What happened to a row in Marfa since the vendor last had it: created,
 * which the vendor has not been told about; updated, its fields; a
 * transition to archived or trashed, or a restore out of either; a purge.
 */
export type ChangeKind =
  "created" | "updated" | "restored" | "archived" | "trashed" | "purged";

export interface Change {
  readonly kind: ChangeKind;
  /** The row as it stands. */
  readonly item: Item;
  /**
   * The fields changed in Marfa and not yet carried, the read-only ones and
   * the link left out; any kind may carry some, a trash and a purge none.
   */
  readonly changed: ReadonlySet<string>;
  /**
   * For a create: when one was sent before and no link came back, so the
   * vendor may hold what it made; look for it there before making another.
   */
  readonly attempted?: string;
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

/** A request a sender made to one of the connector's webhook endpoints. */
export interface Delivery {
  readonly id: string;
  readonly endpointId: string;
  readonly receivedAt: string;
  /** `[name, value]` pairs in the order and case they arrived. */
  readonly headers: readonly (readonly [string, string])[];
  /** The first value of a header, its name matched whatever its case. */
  header(name: string): string | undefined;
  readonly query: string;
  /** The body byte for byte, which is what a signature is over. */
  readonly body: Uint8Array;
}

/** How a connector reads what its vendor posts to it. */
export interface Inbound<E extends EnvDeclaration> {
  /**
   * Whether the delivery came from the vendor, by its signature: one that
   * did not, or that throws, is marked rejected for good and changes
   * nothing, so a check that can fail for a passing reason, such as one
   * reaching the network, rejects deliveries that were genuine. `signal`
   * aborts on a stop, or once the check has run for ten seconds, which
   * leaves the delivery waiting for a later run.
   */
  verify(
    delivery: Delivery,
    env: EnvValues<E>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  /**
   * What the delivery says changed, as ids the run can fetch, or
   * `"everything"`, which a throw also means. A delivery is a hint, never
   * the vendor's state.
   */
  hints(delivery: Delivery): readonly string[] | "everything";
}

export interface Connector<E extends EnvDeclaration = EnvDeclaration> {
  /** The registration's name, as the server lists it. */
  readonly name: string;
  readonly description?: string;
  /** Named on every create and on every read of the connector's own rows. */
  readonly source: string;
  readonly type: TypeDefinition;
  /**
   * The properties the vendor holds for a row: every entry's are among them,
   * and the rest of a row's are Marfa's own, which the kit never touches.
   */
  readonly fields: readonly string[];
  /**
   * Fields the vendor holds that are never carried back: Marfa mirrors them,
   * and a change made to one in Marfa is put back from the vendor. Every
   * field is read-only for a connector without `onChange`, and the link is
   * for every connector.
   */
  readonly readOnly?: readonly string[];
  /**
   * The property on the type that holds the vendor's own id for a row. With a
   * link, every row of the type is the connector's to read and write,
   * whoever created it: an entry finds its row by this property first and by
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
   * Carries a change made in Marfa to the vendor, once per row: a `created`
   * change before `run` reads the vendor, the rest after. It may answer the
   * vendor's entry as the write left it, which the kit takes as what the
   * vendor now holds; otherwise the carried values are taken as the
   * vendor's. Resolving means the change landed or was abandoned with a
   * condition; throwing fails the run, and the change waits for the next.
   */
  onChange?(
    change: Change,
    context: WatchContext<E>,
  ): Promise<Entry | undefined | void>;
  /**
   * Makes a restored row again at a vendor that no longer has it, and links
   * the row to what it made. Asked before `run` reads the vendor, so a run
   * that fails between the vendor's answer and the link cannot read the
   * vendor's copy first and create the row's twin. Answers whether it made
   * the row; one the vendor still has is carried by `onChange` after the
   * read.
   */
  remake?(change: Change, context: WatchContext<E>): Promise<boolean>;
  /**
   * Reads what the vendor posts to the connector's webhook endpoints. Each
   * run first collects what arrived, and under `--every` the kit looks
   * between runs and starts one for what waits, handing `run` the hints. A
   * connector with `onChange` is handed none: its run for deliveries reads
   * the vendor whole and carries back as a scheduled one does.
   */
  readonly inbound?: Inbound<E>;
}

export function defineConnector<
  const E extends EnvDeclaration = EnvDeclaration,
>(connector: Connector<E>): Connector<E> {
  return connector;
}
