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
 * A kind of connection between the connector's own rows, as `POST
 * /edge-types` takes it: both ends constrained to the connector's types, and
 * nothing cascading, so a trash in Marfa never takes a vendor's row with it.
 */
export type ConnectionDefinition = components["schemas"]["EdgeTypeRequest"];

/** A row a connection points at: its type, and its link, or its natural key where the type names none. */
export interface Target {
  readonly type: string;
  readonly id: string;
}

/** A connection type's changes in Marfa, as the rows at the other end. */
export interface Connected {
  readonly added: readonly Item[];
  readonly removed: readonly Item[];
}

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
  /**
   * Every connection of each type named, from this row, as the vendor holds
   * them; a type left out is left as it is. A target Marfa does not hold yet
   * is connected once it arrives.
   */
  connections?: Readonly<Record<string, readonly Target[]>> | undefined;
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
   * What to fetch, by type: the ids the deliveries named, beside the links
   * of rows with a change waiting. Leave alone any cursor into the vendor,
   * such as a sync token, since the rest was not read. `undefined` asks for
   * everything, as a run on the schedule does.
   */
  readonly hints: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** Writes what differs from the connector's own rows of the type, and nothing else. */
  readonly upsert: (type: string, entries: readonly Entry[]) => Promise<void>;
  /**
   * Archives the named rows of the type that are active: by link value where
   * the type names a `link_field`, by source id where it does not. A trashed
   * row is left alone, and one archived here comes back when the vendor
   * sends it again.
   */
  readonly archive: (type: string, keys: readonly string[]) => Promise<void>;
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
  /**
   * The connections made or removed in Marfa since the vendor last had them,
   * by connection type; a target the vendor has not been told about waits
   * until it has, and one purged is never carried.
   */
  readonly connections?: Readonly<Record<string, Connected>>;
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

/** One thing a delivery names: its type, and the id `run` fetches it by. */
export interface Hint {
  readonly type: string;
  readonly id: string;
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
   * What the delivery says changed, as the type and id of each thing the
   * run can fetch, or `"everything"`, which a throw also means. A delivery
   * is a hint, never the vendor's state.
   */
  hints(delivery: Delivery): readonly Hint[] | "everything";
}

/** One kind of item a connector writes. */
export interface Kind {
  /**
   * Its `link_field`, where it names one, holds the vendor's own id for a
   * row: every row of the type is then the connector's, whoever created it,
   * found by the link first and by its natural key second, and a row without
   * a value is one the vendor has not been told about.
   */
  readonly type: TypeDefinition;
  /**
   * The properties the vendor holds for a row: every entry's are among
   * them, and the rest of a row's are Marfa's own, never touched.
   */
  readonly fields: readonly string[];
  /**
   * Fields the vendor holds that are never carried back: Marfa mirrors
   * them, putting back a change made in Marfa. Every field of a kind not
   * carried back is read-only, and so is the link.
   */
  readonly readOnly?: readonly string[];
  /**
   * A row in the bin comes back when the vendor changes it, once its trash
   * has reached the vendor. Carrying that trash must answer the vendor's
   * entry, or the vendor's own close reads as a change.
   */
  readonly revive?: boolean;
}

export interface Connector<E extends EnvDeclaration = EnvDeclaration> {
  /** The registration's name, as the server lists it. */
  readonly name: string;
  readonly description?: string;
  /** Named on every create and on every read of the connector's own rows. */
  readonly source: string;
  /** The kinds of item the connector writes, at most ten. */
  readonly types: readonly Kind[];
  /** The kinds of connection it writes between its rows, from the rows at their source. */
  readonly connections?: readonly ConnectionDefinition[];
  /**
   * The types whose changes go back to the vendor, from the environment, so
   * any kind can run read only; every type where the connector has
   * `onChange` and says nothing.
   */
  readonly carries?: (env: EnvValues<E>) => readonly string[];
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
   * For a purge, the answer's `changed_at` keeps the purge remembered past
   * the vendor's own change, such as a close.
   */
  onChange?(
    change: Change,
    context: WatchContext<E>,
  ): Promise<Entry | undefined>;
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
   * run first collects what arrived, and under `--look-every` the kit looks
   * between runs and starts one for what waits, handing `run` the hints.
   */
  readonly inbound?: Inbound<E>;
}

export function defineConnector<
  const E extends EnvDeclaration = EnvDeclaration,
>(connector: Connector<E>): Connector<E> {
  return connector;
}
