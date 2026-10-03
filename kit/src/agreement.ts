import type { Entry } from "./define.js";
import { cleaned, fingerprint, instant } from "./values.js";

/** A row's own time, beside its properties; no property starts with `@`. */
export const occurredKey = "@occurred_at";

export type AgreedState = "active" | "archived" | "trashed";

/** What the two sides last held for one row, apart since they can rightly
 *  differ: a read-only field edited, or a value the vendor normalizes. */
export interface Agreement {
  vendor: Record<string, string>;
  marfa: Record<string, string>;
  state: AgreedState;
  stateBy?: "vendor" | "cascade";
  /** When that happened, so a replayed frame from before it cannot undo it. */
  stateAt?: string;
  link?: string;
  changedAt?: string;
  waiting?: Record<string, string>;
  attempted?: string;
  connections?: Record<string, string[]>;
  pending?: Record<string, string[]>;
  file?: { key: string; ref: string; mime: string };
  /** The change the vendor refused, as a mark of what it sent, and why,
   *  where the reason fits. */
  refused?: { change: string; reason?: string };
}

export function mark(value: unknown): string {
  return value === undefined || value === null
    ? ""
    : fingerprint(value).slice(0, 16);
}

function at(side: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(side, key) ? (side[key] ?? "") : "";
}

export function held(
  properties: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  return Object.hasOwn(properties, field) ? properties[field] : undefined;
}

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

/** Not naming a time loses, and a tie counts as not later. */
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

export function changedInMarfa(
  agreement: Agreement,
  fields: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): string[] {
  return fields.filter(
    (field) => mark(held(properties, field)) !== at(agreement.marfa, field),
  );
}

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
  readonly state?: string | undefined;
}

/** Revoked counts as trashed. */
export function agreedState(state: string): AgreedState {
  return state === "active" || state === "archived" ? state : "trashed";
}

export interface MergeInput {
  readonly fields: readonly string[];
  readonly readOnly: (field: string) => boolean;
  readonly agreement: Agreement | undefined;
  readonly row: Row;
  readonly entry: Entry;
}

export interface Merged {
  readonly properties: Record<string, unknown>;
  readonly occurredAt: string | undefined;
  readonly write: boolean;
  readonly agreement: Agreement;
  readonly lost: readonly string[];
  readonly kept: readonly string[];
  readonly putBack: readonly string[];
  readonly seeded: readonly string[];
}

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
    state: agreement?.state ?? agreedState(row.state ?? "active"),
    ...(agreement?.stateBy !== undefined && { stateBy: agreement.stateBy }),
    ...(agreement?.stateAt !== undefined && { stateAt: agreement.stateAt }),
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
  readonly properties: Readonly<Record<string, unknown>>;
  readonly state: AgreedState;
  readonly changed: readonly string[];
  readonly answered: Entry | undefined;
}

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

// Throwaway change to exercise draft gating.
