import { GoogleError, type Google } from "@withmarfa/google";

export type Json = Readonly<Record<string, unknown>>;

export function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(from: Json | undefined, key: string): string | undefined {
  const value = from?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function flag(from: Json | undefined, key: string): boolean | undefined {
  const value = from?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function object(from: Json | undefined, key: string): Json | undefined {
  const value = from?.[key];
  return isJson(value) ? value : undefined;
}

export function list(from: Json | undefined, key: string): unknown[] {
  const value = from?.[key];
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Every page of a listing: its items, and the token the last page ends with. */
export interface Listing {
  readonly items: Json[];
  readonly syncToken: string | undefined;
}

const mostPages = 10_000;

/** Google's Calendar API, within the sign-in's token and time limit. */
export class CalendarApi {
  constructor(
    private readonly google: Google,
    private readonly base: string,
  ) {}

  private async get(path: string, query: Record<string, string>) {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const body = await this.google.json(url);
    if (!isJson(body)) {
      throw new GoogleError("Google answered an empty page", "passing");
    }
    return body;
  }

  private async pages(
    path: string,
    query: Record<string, string>,
  ): Promise<Listing> {
    const items: Json[] = [];
    let token: string | undefined;
    for (let page = 0; page < mostPages; page += 1) {
      const body = await this.get(path, {
        ...query,
        ...(token !== undefined && { pageToken: token }),
      });
      for (const item of list(body, "items"))
        if (isJson(item)) items.push(item);
      token = text(body, "nextPageToken");
      if (token === undefined) {
        return { items, syncToken: text(body, "nextSyncToken") };
      }
    }
    throw new GoogleError("Google kept answering pages", "passing");
  }

  /** Every calendar of the account, hidden ones too. */
  calendars(): Promise<Listing> {
    return this.pages("/users/me/calendarList", {
      showHidden: "true",
      maxResults: "250",
    });
  }

  /** The events of a calendar, whole or since the sync token. Deleted ones
   *  are always asked for: a read since a token must have them. A token
   *  Google no longer holds answers 410, which throws. */
  events(calendarId: string, syncToken?: string): Promise<Listing> {
    return this.pages(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      singleEvents: "false",
      showDeleted: "true",
      maxResults: "2500",
      ...(syncToken !== undefined && { syncToken }),
    });
  }

  /** One event, or `"gone"` where Google says it is deleted or was never
   *  there. */
  async event(calendarId: string, eventId: string): Promise<Json | "gone"> {
    try {
      return await this.get(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {},
      );
    } catch (error) {
      if (isGone(error)) return "gone";
      throw error;
    }
  }

  /** The cancelled occurrences of a series between two moments. */
  async cancelled(
    calendarId: string,
    seriesId: string,
    from: string,
    to: string,
  ): Promise<Json[]> {
    const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(seriesId)}/instances`;
    try {
      const { items } = await this.pages(path, {
        showDeleted: "true",
        maxResults: "2500",
        timeMin: from,
        timeMax: to,
        fields:
          "items(id,status,recurringEventId,originalStartTime),nextPageToken",
      });
      return items.filter((item) => item["status"] === "cancelled");
    } catch (error) {
      if (isGone(error)) return [];
      throw error;
    }
  }
}

export function isGone(error: unknown): boolean {
  return (
    error instanceof GoogleError &&
    (error.status === 404 || error.status === 410)
  );
}

/** Google no longer holds the sync token. */
export function tokenExpired(error: unknown): boolean {
  return error instanceof GoogleError && error.status === 410;
}
