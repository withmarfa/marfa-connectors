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

  /** One calendar of the account's list, or `"gone"` where Google says it
   *  is no longer on it. */
  async calendar(calendarId: string): Promise<Json | "gone"> {
    try {
      return await this.get(
        `/users/me/calendarList/${encodeURIComponent(calendarId)}`,
        {},
      );
    } catch (error) {
      if (isGone(error)) return "gone";
      throw error;
    }
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

  private async write(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    query: Record<string, string>,
    body?: Json,
    etag?: string,
  ): Promise<Json | undefined> {
    const url = new URL(`${this.base}${path}`);
    // Google never emails guests about a change Marfa makes.
    url.searchParams.set("sendUpdates", "none");
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (etag !== undefined) headers["If-Match"] = etag;
    const answer = await this.google.json(url, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return isJson(answer) ? answer : undefined;
  }

  private eventPath(calendarId: string, eventId?: string): string {
    const events = `/calendars/${encodeURIComponent(calendarId)}/events`;
    return eventId === undefined
      ? events
      : `${events}/${encodeURIComponent(eventId)}`;
  }

  /** Makes an event under the id given, which Google answers 409 where the
   *  calendar already holds it, deleted or not. */
  async insert(calendarId: string, event: Json): Promise<Json> {
    const made = await this.write(
      "POST",
      this.eventPath(calendarId),
      {},
      event,
    );
    if (made === undefined) {
      throw new GoogleError("Google answered an empty event", "passing");
    }
    return made;
  }

  /** Changes the fields named, and only those, while the event is still at
   *  `etag`; Google answers 412 where it changed since. */
  async patch(
    calendarId: string,
    eventId: string,
    fields: Json,
    etag: string | undefined,
  ): Promise<Json> {
    const changed = await this.write(
      "PATCH",
      this.eventPath(calendarId, eventId),
      {},
      fields,
      etag,
    );
    if (changed === undefined) {
      throw new GoogleError("Google answered an empty event", "passing");
    }
    return changed;
  }

  /** Deletes an event while it is still at `etag`. One Google no longer has
   *  is already deleted. */
  async remove(
    calendarId: string,
    eventId: string,
    etag: string | undefined,
  ): Promise<void> {
    try {
      await this.write(
        "DELETE",
        this.eventPath(calendarId, eventId),
        {},
        undefined,
        etag,
      );
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  /** Moves an event to another calendar, keeping its id. */
  async move(
    calendarId: string,
    eventId: string,
    destination: string,
  ): Promise<Json> {
    const moved = await this.write(
      "POST",
      `${this.eventPath(calendarId, eventId)}/move`,
      { destination },
    );
    if (moved === undefined) {
      throw new GoogleError("Google answered an empty event", "passing");
    }
    return moved;
  }

  /** The occurrences of a series that began at `originalStart`, cancelled
   *  ones included. */
  async occurrence(
    calendarId: string,
    seriesId: string,
    originalStart: string,
  ): Promise<Json[]> {
    try {
      const { items } = await this.pages(
        `${this.eventPath(calendarId, seriesId)}/instances`,
        { showDeleted: "true", originalStart, maxResults: "2500" },
      );
      return items;
    } catch (error) {
      if (isGone(error)) return [];
      throw error;
    }
  }

  /** The ids of the events a calendar still holds. */
  async live(calendarId: string): Promise<Set<string>> {
    const { items } = await this.pages(this.eventPath(calendarId), {
      singleEvents: "false",
      showDeleted: "true",
      maxResults: "2500",
      fields: "items(id,status),nextPageToken,nextSyncToken",
    });
    return new Set(
      items.flatMap((item) =>
        item["status"] !== "cancelled" && typeof item["id"] === "string"
          ? [item["id"]]
          : [],
      ),
    );
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
