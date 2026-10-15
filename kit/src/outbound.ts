import type { Agreement } from "./agreement.js";
import type { Carried } from "./connections.js";
import type { Change, Entry, JsonValue, OutboundIntent } from "./define.js";
import { checkedJson, digest } from "./inbound-retry.js";

type CapturedChange = Omit<Change, "changed" | "unagreed"> & {
  changed: string[];
  unagreed?: string[];
};

export interface OutboundRecord {
  token: string;
  change: CapturedChange;
  request: JsonValue;
  baseline: JsonValue;
  agreement?: Agreement;
  moved?: Carried;
  operation: "change" | "remake";
  acknowledged: boolean;
  answer?: Entry;
  confirmationAgreement?: Agreement;
}

export function captureChange(change: Change): CapturedChange {
  const { changed, unagreed, ...rest } = change;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      changed: [...changed],
      ...(unagreed !== undefined && { unagreed: [...unagreed] }),
    }),
  ) as CapturedChange;
}

export function restoreChange(change: CapturedChange): Change {
  const { changed, unagreed, ...rest } = structuredClone(change);
  return {
    ...rest,
    changed: new Set(changed),
    ...(unagreed !== undefined && { unagreed: new Set(unagreed) }),
  };
}

export function publicIntent(record: OutboundRecord): OutboundIntent {
  return {
    token: record.token,
    change: restoreChange(record.change),
    request: structuredClone(record.request),
    baseline: structuredClone(record.baseline),
    acknowledged: record.acknowledged,
  };
}

export function outboundToken(
  record: Omit<
    OutboundRecord,
    "token" | "acknowledged" | "answer" | "confirmationAgreement"
  >,
): string {
  return digest(record);
}

/** A corrupt journal cannot be treated as no pending vendor work. */
function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

export function readOutbound(value: unknown): OutboundRecord[] {
  if (value === undefined) return [];
  checkedJson(value);
  if (!Array.isArray(value)) throw new Error("invalid outbound journal");
  const ids = new Set<string>();
  for (const raw of value) {
    const record = raw as OutboundRecord | null;
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.token !== "string" ||
      typeof record.acknowledged !== "boolean" ||
      !["change", "remake"].includes(record.operation) ||
      !isObject(record.change) ||
      !isObject(record.change.item) ||
      ![
        "created",
        "updated",
        "restored",
        "archived",
        "trashed",
        "purged",
      ].includes(record.change.kind) ||
      typeof record.change.item.id !== "string" ||
      typeof record.change.item.type !== "string" ||
      !Array.isArray(record.change.changed) ||
      record.change.changed.some((field) => typeof field !== "string") ||
      (record.change.unagreed !== undefined &&
        (!Array.isArray(record.change.unagreed) ||
          record.change.unagreed.some((field) => typeof field !== "string"))) ||
      !Object.hasOwn(record, "request") ||
      !Object.hasOwn(record, "baseline")
    )
      throw new Error("invalid outbound journal record");
    const intent = { ...record };
    for (const field of [
      "token",
      "acknowledged",
      "answer",
      "confirmationAgreement",
    ])
      Reflect.deleteProperty(intent, field);
    if (
      record.token !== outboundToken(intent) ||
      ids.has(record.change.item.id)
    )
      throw new Error("invalid outbound journal identity");
    ids.add(record.change.item.id);
  }
  return structuredClone(value) as OutboundRecord[];
}

export function retryDeadline(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("invalid outbound retry deadline");
  return new Date(value).toISOString();
}
