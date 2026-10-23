import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export interface Call {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
}

interface Stored {
  event: Json;
  version: number;
}

interface Failure {
  readonly match: (call: Call) => boolean;
  readonly status: number;
  readonly body?: Json;
}

/** Stands in for Google's Calendar API: the calendar list, and the events,
 *  one event and the instances of a series, with sync tokens and paging. */
export class CalendarStub {
  readonly calls: Call[] = [];
  calendars: Json[] = [];
  /** How many items a page holds. */
  pageSize = 2500;
  private readonly stores = new Map<string, Map<string, Stored>>();
  private readonly expired = new Map<string, number>();
  private readonly failures: Failure[] = [];
  private clock = 0;
  private server!: Server;
  url = "";

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://stub");
      const call: Call = {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.authorization,
      };
      this.calls.push(call);
      const failure = this.failures.findIndex((one) => one.match(call));
      if (failure !== -1) {
        const [one] = this.failures.splice(failure, 1);
        send(
          response,
          one?.status ?? 500,
          one?.body ?? {
            error: { code: one?.status, message: "scripted" },
          },
        );
        return;
      }
      const [status, body] = this.answer(call);
      send(response, status, body);
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((done) => this.server.close(done));
  }

  /** The next call that matches fails with this status. */
  failNext(match: (call: Call) => boolean, status: number, body?: Json): void {
    this.failures.push({ match, status, ...(body !== undefined && { body }) });
  }

  store(calendar: string): Map<string, Stored> {
    let found = this.stores.get(calendar);
    if (found === undefined) {
      found = new Map();
      this.stores.set(calendar, found);
    }
    return found;
  }

  /** An event is made or changed. */
  put(calendar: string, event: Json): void {
    this.clock += 1;
    this.store(calendar).set(String(event["id"]), {
      event: {
        updated: "2026-09-01T08:00:00.000Z",
        status: "confirmed",
        ...event,
      },
      version: this.clock,
    });
  }

  /** Google's record of a deletion: the event stays, cancelled. */
  cancel(calendar: string, id: string, rest: Json = {}): void {
    this.clock += 1;
    this.store(calendar).set(id, {
      event: { id, status: "cancelled", ...rest },
      version: this.clock,
    });
  }

  /** Google has forgotten the event altogether, as it does a deletion old
   *  enough that no token reaches it. */
  forget(calendar: string, id: string): void {
    this.store(calendar).delete(id);
  }

  /** A token given before now is no longer held. */
  expire(calendar: string): void {
    this.expired.set(calendar, this.clock);
    this.clock += 1;
  }

  private answer(call: Call): [number, Json] {
    if (call.authorization === undefined) {
      return [401, { error: { code: 401, message: "no token" } }];
    }
    const prefix = "/calendar/v3";
    const path = call.path.slice(prefix.length);
    if (path === "/users/me/calendarList") {
      return [200, { items: this.calendars }];
    }
    const match =
      /^\/calendars\/([^/]+)\/events(?:\/([^/]+)(\/instances)?)?$/.exec(path);
    if (match === null) return [404, { error: { code: 404, message: path } }];
    const calendar = decodeURIComponent(match[1] ?? "");
    const id =
      match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    const store = this.store(calendar);
    if (id === undefined) return this.listing(call, calendar, store);
    if (match[3] !== undefined) {
      const from = call.query["timeMin"];
      const to = call.query["timeMax"];
      const items = [...store.values()]
        .map((one) => one.event)
        .filter((event) => event["recurringEventId"] === id)
        .filter((event) => {
          const at = original(event);
          return (
            at === undefined ||
            ((from === undefined || at >= Date.parse(from)) &&
              (to === undefined || at <= Date.parse(to)))
          );
        });
      return this.page(call, items, undefined, {});
    }
    const found = store.get(id);
    if (found === undefined) {
      return [404, { error: { code: 404, message: "Not Found" } }];
    }
    if (
      found.event["status"] === "cancelled" &&
      call.query["showDeleted"] !== "true"
    ) {
      return [
        410,
        { error: { code: 410, message: "Resource has been deleted" } },
      ];
    }
    return [200, found.event];
  }

  private listing(
    call: Call,
    calendar: string,
    store: Map<string, Stored>,
  ): [number, Json] {
    if (call.query["showDeleted"] !== "true") {
      return [
        400,
        { error: { code: 400, message: "showDeleted must be true" } },
      ];
    }
    if (call.query["singleEvents"] !== "false") {
      return [
        400,
        { error: { code: 400, message: "singleEvents must be false" } },
      ];
    }
    const token = call.query["syncToken"];
    let after = -1;
    if (token !== undefined) {
      after = Number(token.replace("sync-", ""));
      if ((this.expired.get(calendar) ?? -1) >= after) {
        return [
          410,
          { error: { code: 410, message: "Sync token is no longer valid" } },
        ];
      }
    }
    const items = [...store.values()]
      .filter((one) => one.version > after)
      .map((one) => one.event);
    const calendarZone = this.calendars.find((one) => one["id"] === calendar)?.[
      "timeZone"
    ];
    return this.page(call, items, `sync-${String(this.clock)}`, {
      timeZone: calendarZone ?? "UTC",
    });
  }

  private page(
    call: Call,
    items: Json[],
    syncToken: string | undefined,
    rest: Json,
  ): [number, Json] {
    const from = Number(
      (call.query["pageToken"] ?? "page-0").replace("page-", ""),
    );
    const slice = items.slice(from, from + this.pageSize);
    const more = from + this.pageSize < items.length;
    return [
      200,
      {
        ...rest,
        items: slice,
        ...(more && { nextPageToken: `page-${String(from + this.pageSize)}` }),
        ...(!more && syncToken !== undefined && { nextSyncToken: syncToken }),
      },
    ];
  }
}

function original(event: Json): number | undefined {
  const time = event["originalStartTime"] as
    { dateTime?: string; date?: string } | undefined;
  const text = time?.dateTime ?? time?.date;
  return text === undefined ? undefined : Date.parse(text);
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: Json,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
