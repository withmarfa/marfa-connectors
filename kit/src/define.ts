import type { components } from "@withmarfa/client";

/**
 * A type as `POST /types` takes it. The check on start compares it with the
 * server's in the form the server stores: a format that is a field type of
 * its own, such as `url`, counts as that type, and a `required` list as
 * per-field flags.
 */
export type TypeDefinition = components["schemas"]["TypeDefinitionInput"];

export type Item = components["schemas"]["Item"];

/**
 * A kind of connection between the connector's own rows, as `POST
 * /edge-types` takes it: both ends constrained to the connector's types, and
 * nothing cascading, so a trash in Marfa never takes a vendor's row with it.
 */
export type ConnectionDefinition = components["schemas"]["EdgeTypeRequest"];

export interface Target {
  readonly type: string;
  readonly id: string;
}

export interface FileSource {
  readonly key: string;
  readonly load: (
    signal: AbortSignal,
  ) => Promise<{ bytes: Uint8Array; mime_type: string }>;
}

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

export interface Entry {
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
  /**
   * The bytes of a row of a file type, uploaded as its `blob_ref` and
   * `mime_type`, which its kind lists among its fields; loaded only when
   * `key` differs from the one last uploaded.
   */
  file?: FileSource | undefined;
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

export type Secret = (value: string) => void;

export interface RunContext<E extends EnvDeclaration> {
  readonly env: EnvValues<E>;
  readonly signal: AbortSignal;
  readonly state: State;
  readonly log: Log;
  readonly secret: Secret;
  /**
   * What to fetch, by type: the ids the deliveries named, beside the links
   * of rows with a change waiting. Leave alone any cursor into the vendor,
   * such as a sync token, since the rest was not read. `undefined` asks for
   * everything, as a run on the schedule does.
   */
  readonly hints: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  readonly upsert: (type: string, entries: readonly Entry[]) => Promise<void>;
  /**
   * Archives the named rows of the type that are active: by link value where
   * the type names a `link_field`, by source id where it does not. A trashed
   * row is left alone, and one archived here comes back when the vendor
   * sends it again.
   */
  readonly archive: (type: string, keys: readonly string[]) => Promise<void>;
  /**
   * The active rows of the type that hold a connection of the kind to the
   * target: what Marfa has under something, such as a repository's issues,
   * to find what the vendor no longer lists: only rows of the type itself
   * the vendor has been told about. Empty where Marfa lacks the target.
   * Connections a run names are written once it ends, so a row this run's
   * entries connect shows from the next, and one they or an answer move
   * elsewhere is left out now. A target in the bin still answers its rows.
   */
  readonly linked: (
    type: string,
    connection: string,
    target: Target,
  ) => Promise<Item[]>;
}

export type ChangeKind =
  "created" | "updated" | "restored" | "archived" | "trashed" | "purged";

export interface Change {
  readonly kind: ChangeKind;
  readonly item: Item;
  /**
   * The fields changed in Marfa and not yet carried, the read-only ones and
   * the link left out; any kind may carry some, a trash and a purge none.
   */
  readonly changed: ReadonlySet<string>;
  /**
   * For a create, the trash of a row whose create got no link, or a remake:
   * when it was first sent, so the vendor may hold what it made; look for
   * it there before making another. It can be long ago, for a create abandoned then
   * sent again, so a match may belong to another row, which `setLink`
   * refuses.
   */
  readonly attempted?: string;
  readonly was?: "trashed" | "archived";
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
  readonly secret: Secret;
  /**
   * Writes the vendor's own id for the row onto its link property, at the
   * version the change showed, retrying once if the row moved since. A
   * value another row of the type already carries is refused, and the
   * refusal names both rows.
   */
  readonly setLink: (item: Item, value: string) => Promise<void>;
}

export interface LocalCallback {
  readonly url: string;
  readonly callback: string;
  readonly redirected: Promise<URLSearchParams>;
  /**
   * Sends the browser, held at the callback, on to a web address, such as
   * the page where the vendor asks for the next step; asked before the
   * browser arrives, it throws. A browser not sent on is told when setup
   * ends that it is done, or that it failed. The callback answers once.
   */
  readonly onward: (address: string) => void;
}

export interface SetupContext<E extends EnvDeclaration> {
  readonly env: { readonly [K in keyof E]?: string | undefined };
  readonly signal: AbortSignal;
  readonly log: Pick<Log, "info" | "warn">;
  readonly secret: Secret;
  /**
   * Serves `page` at a local address, and waits for the vendor's redirect.
   * A page that must name where the vendor sends the browser back, such
   * as a manifest's `redirect_url`, is made from that address.
   */
  readonly listen: (
    page?: string | ((callback: string) => string),
  ) => Promise<LocalCallback>;
  /**
   * Makes a webhook endpoint for the connector: its path in full this once,
   * and the address as the kit reaches the instance, which a vendor may
   * need replaced with the instance's public one.
   */
  readonly endpoint: (options?: {
    label?: string;
    duplicateHeader?: string;
  }) => Promise<{ path: string; url: string }>;
}

export interface Delivery {
  readonly id: string;
  readonly endpointId: string;
  readonly receivedAt: string;
  readonly headers: readonly (readonly [string, string])[];
  header(name: string): string | undefined;
  readonly query: string;
  readonly body: Uint8Array;
}

export interface Hint {
  readonly type: string;
  readonly id: string;
}

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
   * carried back is read-only, and so is the link. It may also name
   * connection types from the kind's rows, such as the project an issue
   * sits in: mirrored the same way, but handed to a create and to
   * `remake`, which they place, and a create waits until the vendor has
   * been told about each of their targets.
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
  readonly name: string;
  readonly description?: string;
  readonly source: string;
  /** The kinds of item the connector writes, at most ten. */
  readonly types: readonly Kind[];
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
  /**
   * Run once, by hand, with `--setup <file>`: registers the connector with
   * its vendor and answers the secrets that made, by the environment
   * variable each is read from. They are written to the file, which must
   * not exist, readable by its owner alone, and moved into the secret store.
   */
  readonly setup?: (
    context: SetupContext<E>,
  ) => Promise<Readonly<Record<string, string>>>;
  run(context: RunContext<E>): Promise<void>;
  /**
   * Carries a change made in Marfa to the vendor, once per row: a `created`
   * change before `run` reads the vendor, the rest after. It may answer the
   * vendor's entry as the write left it, which the kit takes as what the
   * vendor now holds, connections included, so one the vendor would not
   * take is taken back in Marfa; otherwise the carried values are taken as
   * the vendor's. Resolving means the change landed or was abandoned with a
   * condition; throwing fails the run, and the change waits for the next,
   * but throwing `Unreachable` leaves the run going on.
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
   * read. Where a remake failed before, `change.attempted` says when it was
   * first asked; it may throw `Unreachable` as `onChange` may.
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
