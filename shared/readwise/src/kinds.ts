import type { TypeDefinition } from "@withmarfa/connector";

type Kind = "url" | "datetime" | "date";

function digits(text: string, limit?: number): boolean {
  return /^\d+$/.test(text) && (limit === undefined || Number(text) < limit);
}
/** A calendar date, as the server takes one. */
export function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  return days !== undefined && day > 0 && day <= days;
}
/** A calendar date, or that date with a time and an offset, as the server takes one. */
export function isDatetime(text: string): boolean {
  if (isDate(text)) return true;
  if (text.length < 17 || text[10] !== "T" || !isDate(text.slice(0, 10)))
    return false;
  let end = text.length - 1;
  if (!text.endsWith("Z")) {
    end = text.length - 6;
    const sign = text[end];
    if (
      (sign !== "+" && sign !== "-") ||
      text[end + 3] !== ":" ||
      !digits(text.slice(end + 1, end + 3), 24) ||
      !digits(text.slice(end + 4), 60)
    )
      return false;
  }
  const time = text.slice(11, end);
  if (
    time.length < 5 ||
    time[2] !== ":" ||
    !digits(time.slice(0, 2), 24) ||
    !digits(time.slice(3, 5), 60)
  )
    return false;
  if (time.length === 5) return true;
  if (time.length < 8 || time[5] !== ":" || !digits(time.slice(6, 8), 60))
    return false;
  return time.length === 8 || (time[8] === "." && digits(time.slice(9)));
}
/** The value the server stores for a URL, or undefined when it refuses one. */
export function urlValue(text: string): string | undefined {
  const trimmed = text.trim();
  return URL.canParse(trimmed) ? trimmed.replace(/[\t\n\r]/g, "") : undefined;
}

export function kindsOf(
  type: TypeDefinition,
  inherited: Readonly<Record<string, Kind>> = {},
): ReadonlyMap<string, Kind> {
  const kinds = new Map<string, Kind>(Object.entries(inherited));
  for (const [name, field] of Object.entries(type.fields)) {
    const kind = field.type === "string" ? field.format : field.type;
    if (kind === "url" || kind === "datetime" || kind === "date")
      kinds.set(name, kind);
  }
  return kinds;
}

/**
 * Fits each value to its field's kind, so one value Readwise sends in
 * another shape never stops the row being written. A blank value is left
 * out. Any other value the kind refuses is left out of its field and kept,
 * as sent, under `original_values`.
 */
export function fitKinds(
  values: Record<string, unknown>,
  kinds: ReadonlyMap<string, Kind>,
): void {
  const previous = values["original_values"];
  const originals: Record<string, unknown> =
    typeof previous === "object" &&
    previous !== null &&
    !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {};
  for (const [field, kind] of kinds) {
    const value = values[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") {
      Reflect.deleteProperty(values, field);
      continue;
    }
    const fitted =
      typeof value !== "string"
        ? undefined
        : kind === "url"
          ? urlValue(value)
          : (kind === "date" ? isDate : isDatetime)(value)
            ? value
            : undefined;
    if (fitted === undefined) {
      originals[field] = value;
      Reflect.deleteProperty(values, field);
    } else {
      values[field] = fitted;
      Reflect.deleteProperty(originals, field);
    }
  }
  if (Object.keys(originals).length) values["original_values"] = originals;
  else delete values["original_values"];
}
