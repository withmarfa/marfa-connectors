import type { Entry } from "./define.js";
import { cleaned, fingerprint, instant } from "./values.js";

/** A row's own time, agreed beside its properties; no property name starts with `@`. */
export const occurredKey = "@occurred_at";

/** The state a row is agreed at: a state the log shows, or none yet. */
export type AgreedState = "active" | "archived" | "trashed";

/**
 * What the two sides last held for one row. Each side is kept on its own,
 * since they may rightly differ: a read-only field a person edited, or a
 * value the vendor normalizes.
 */
export interface Agreement {
  /** The vendor's last values, field by field, by {@link mark}. */
  vendor: Record<string, string>;
  /** The values the kit last wrote to Marfa or carried from it. */
  marfa: Record<string, string>;
  state: AgreedState;
  /** The vendor's own id for the row, which is the connector's to keep. */
  link?: string;
  /** The vendor's time on the entry last agreed. */
  changedAt?: string;
  /** Changes in Marfa not yet carried, each with when it was first seen. */
  waiting?: Record<string, string>;
  /** When a create was sent to the vendor and no link came back. */
  attempted?: string;
}

/** A short name for a value; the empty string for one the side does not hold. */
export function mark(value: unknown): string {
  return value === undefined || value === null
    ? ""
    : fingerprint(value).slice(0, 16);
}

function at(side: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(side, key) ? (side[key] ?? "") : "";
}

/** A property the object holds itself, never one every object answers for its name. */
export function held(
  properties: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  return Object.hasOwn(properties, field) ? properties[field] : undefined;
}

/** The marks of the named fields, leaving out the ones the side does not hold. */
export function sideOf(
  fields: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const side: Record<string, string> = {};
  for (const field of fields) {
    const value = mark(held(properties, field));
    if (value !== "") side[field] = value;
  }
  return side;
}

/** Which of two times is later; a side that names no time loses, and a tie is not later. */
export function laterThan(
  candidate: string | undefined,
  other: string | undefined,
): boolean {
  if (candidate === undefined) return false;
  if (other === undefined) return true;
  const a = Date.parse(candidate);
  const b = Date.parse(other);
  return !Number.isNaN(a) && (Number.isNaN(b) || a > b);
}

/** Whether the entry holds what the vendor last held, field by field. */
export function unchangedAtVendor(
  agreement: Agreement,
  fields: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): boolean {
  const theirs = cleaned(properties);
  return fields.every(
    (field) => mark(held(theirs, field)) === at(agreement.vendor, field),
  );
}

/** The fields whose value in Marfa differs from what the kit last wrote or carried. */
export function changedInMarfa(
  agreement: Agreement,
  fields: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): string[] {
  return fields.filter(
    (field) => mark(held(properties, field)) !== at(agreement.marfa, field),
  );
}

/**
 * The waiting fields for a row as the log now shows it: each keeps the time
 * it was first seen, and a field back where it was agreed waits no more.
 */
export function noteWaiting(
  agreement: Agreement,
  fields: readonly string[],
  properties: Readonly<Record<string, unknown>>,
  seenAt: string,
): Record<string, string> | undefined {
  const waiting: Record<string, string> = {};
  for (const field of changedInMarfa(agreement, fields, properties)) {
    waiting[field] = agreement.waiting?.[field] ?? seenAt;
  }
  return Object.keys(waiting).length === 0 ? undefined : waiting;
}

export interface Row {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly occurred_at: string | undefined;
  readonly updated_at: string | undefined;
}

export interface MergeInput {
  /** The fields the vendor holds for this type. */
  readonly fields: readonly string[];
  /** A field the connector never carries back, which Marfa mirrors. */
  readonly readOnly: (field: string) => boolean;
  readonly agreement: Agreement | undefined;
  readonly row: Row;
  readonly entry: Entry;
}

export interface Merged {
  /** The row's properties as they should stand. */
  readonly properties: Record<string, unknown>;
  /** The row's own time to write, where the vendor moved it. */
  readonly occurredAt: string | undefined;
  /** Whether the row must be written. */
  readonly write: boolean;
  /** The agreement once the write lands. */
  readonly agreement: Agreement;
  /** Fields both sides changed where the vendor's later change won. */
  readonly lost: readonly string[];
  /** Fields both sides changed where the change in Marfa won. */
  readonly kept: readonly string[];
  /** Read-only fields a change in Marfa was put back on. */
  readonly putBack: readonly string[];
  /** Fields that took the vendor's value because nothing was agreed yet. */
  readonly seeded: readonly string[];
}

/**
 * The entry merged into the row field by field: one side's change wins, both
 * sides' goes to the later, a tie and nothing agreed yet as the rules say.
 */
export function merge(input: MergeInput): Merged {
  const { fields, readOnly, agreement, row, entry } = input;
  const theirs = cleaned(entry.properties);
  const properties: Record<string, unknown> = { ...cleaned(row.properties) };
  const marfa: Record<string, string> = {};
  const waiting: Record<string, string> = {};
  const lost: string[] = [];
  const kept: string[] = [];
  const putBack: string[] = [];
  const seeded: string[] = [];
  const take = (field: string): void => {
    const value = held(theirs, field);
    if (value === undefined) Reflect.deleteProperty(properties, field);
    else properties[field] = value;
  };
  const keep = (field: string, since: string | undefined): void => {
    if (agreement === undefined) return;
    const agreed = at(agreement.marfa, field);
    if (agreed !== "") marfa[field] = agreed;
    if (mark(held(properties, field)) !== agreed && since !== undefined) {
      waiting[field] = since;
    }
  };

  for (const field of fields) {
    const vendorNow = mark(held(theirs, field));
    const marfaNow = mark(held(properties, field));
    if (agreement === undefined) {
      if (vendorNow !== marfaNow) {
        seeded.push(field);
        take(field);
      }
      if (vendorNow !== "") marfa[field] = vendorNow;
      continue;
    }
    if (vendorNow === marfaNow) {
      if (marfaNow !== "") marfa[field] = marfaNow;
      continue;
    }
    const vendorChanged = vendorNow !== at(agreement.vendor, field);
    const marfaChanged = marfaNow !== at(agreement.marfa, field);
    const since = agreement.waiting?.[field] ?? row.updated_at;
    if (!marfaChanged) {
      if (!vendorChanged) {
        keep(field, undefined);
        continue;
      }
      take(field);
      if (vendorNow !== "") marfa[field] = vendorNow;
      continue;
    }
    if (readOnly(field)) {
      putBack.push(field);
      take(field);
      if (vendorNow !== "") marfa[field] = vendorNow;
      continue;
    }
    if (!vendorChanged) {
      keep(field, since);
      continue;
    }
    if (laterThan(entry.changed_at, since)) {
      lost.push(field);
      take(field);
      if (vendorNow !== "") marfa[field] = vendorNow;
      continue;
    }
    kept.push(field);
    keep(field, since);
  }
  for (const [key, since] of Object.entries(agreement?.waiting ?? {})) {
    if (!fields.includes(key)) waiting[key] = since;
  }

  const occurredNow = instant(entry.occurred_at);
  const occurredMark = mark(occurredNow);
  const occurredMoved =
    occurredNow !== undefined &&
    occurredMark !==
      (agreement === undefined
        ? mark(instant(row.occurred_at))
        : at(agreement.vendor, occurredKey));
  const occurredAt =
    occurredMoved && mark(instant(row.occurred_at)) !== occurredMark
      ? occurredNow
      : undefined;

  const vendor = sideOf(fields, theirs);
  if (occurredMark !== "") vendor[occurredKey] = occurredMark;
  else if (agreement?.vendor[occurredKey] !== undefined) {
    vendor[occurredKey] = agreement.vendor[occurredKey];
  }
  const changedAt = entry.changed_at ?? agreement?.changedAt;
  const next: Agreement = {
    vendor,
    marfa,
    state: agreement?.state ?? "active",
    ...(agreement?.link !== undefined && { link: agreement.link }),
    ...(changedAt !== undefined && { changedAt }),
    ...(Object.keys(waiting).length > 0 && { waiting }),
  };
  const write =
    occurredAt !== undefined ||
    fields.some(
      (field) =>
        mark(held(properties, field)) !== mark(held(row.properties, field)),
    );
  return {
    properties,
    occurredAt,
    write,
    agreement: next,
    lost,
    kept,
    putBack,
    seeded,
  };
}

export interface CarriedInput {
  readonly fields: readonly string[];
  readonly agreement: Agreement | undefined;
  /** The row as it was carried. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly state: AgreedState;
  /** The fields carried; a field left out stays as it was agreed. */
  readonly changed: readonly string[];
  /** The vendor's entry after the carry, where the connector answered one. */
  readonly answered: Entry | undefined;
}

/**
 * The agreement once a change reached the vendor, without waiting marks:
 * Marfa's side takes what was carried, the vendor's its answer or else the
 * carried values.
 */
export function carried(input: CarriedInput): Agreement {
  const { fields, agreement, properties, state, changed, answered } = input;
  const marfa = { ...agreement?.marfa };
  const vendor = { ...agreement?.vendor };
  for (const field of changed) {
    const value = mark(held(properties, field));
    if (value === "") Reflect.deleteProperty(marfa, field);
    else marfa[field] = value;
    if (answered !== undefined) continue;
    if (value === "") Reflect.deleteProperty(vendor, field);
    else vendor[field] = value;
  }
  const answeredSide =
    answered === undefined
      ? undefined
      : sideOf(fields, cleaned(answered.properties));
  if (answeredSide !== undefined) {
    for (const field of fields) Reflect.deleteProperty(vendor, field);
    Object.assign(vendor, answeredSide);
  }
  const changedAt = answered?.changed_at ?? agreement?.changedAt;
  return {
    vendor,
    marfa,
    state,
    ...(agreement?.link !== undefined && { link: agreement.link }),
    ...(changedAt !== undefined && { changedAt }),
  };
}
