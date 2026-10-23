import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
  readonly ifMatch: string | undefined;
  readonly body: Json | undefined;
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

/** Stands in for Google's Calendar API: the calendar list and its entries,
 *  and the events, one event and the instances of a series, with sync tokens
 *  and paging, and the writes: insert under a given id, patch, delete and
 *  move, each held to `If-Match`. */
export class CalendarStub {
  readonly calls: Call[] = [];
  calendars: Json[] = [];
  /** Calendars on the account's list that one listing leaves out. */
  unlisted: Json[] = [];
  /** How many items a page holds. */
  pageSize = 2500;
  /** Whether a `GET` for a cancelled event answers it as cancelled, where
   *  Google may answer `410` instead. */
  getsCancelled = false;
  private readonly stores = new Map<string, Map<string, Stored>>();
  private readonly expired = new Map<string, number>();
  private readonly failures: Failure[] = [];
  private readonly losing: ((call: Call) => boolean)[] = [];
  private clock = 0;
  private server!: Server;
  url = "";

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        this.handle(
          request,
          text === "" ? undefined : (JSON.parse(text) as Json),
          response,
        );
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
    return this;
  }

  private handle(
    request: import("node:http").IncomingMessage,
    body: Json | undefined,
    response: import("node:http").ServerResponse,
  ): void {
    const url = new URL(request.url ?? "/", "http://stub");
    const ifMatch = request.headers["if-match"];
    const call: Call = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
      ifMatch: typeof ifMatch === "string" ? ifMatch : undefined,
      body,
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
    const lost = this.losing.findIndex((one) => one(call));
    if (lost !== -1) {
      // The write lands and its answer is lost on the way back.
      this.losing.splice(lost, 1);
      this.answer(call);
      response.destroy();
      return;
    }
    const [status, answer] = this.answer(call);
    send(response, status, answer);
  }

  /** The calls that change something. */
  writes(): Call[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  /** The next write that matches lands, and its answer never arrives. */
  loseAnswer(match: (call: Call) => boolean): void {
    this.losing.push(match);
  }

  /** The event as the stub holds it. */
  event(calendar: string, id: string): Json | undefined {
    return this.store(calendar).get(id)?.event;
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

  /** An event is made or changed. A change always gets a new etag and
   *  `updated`, as in Google, even when given the event's old ones. */
  put(calendar: string, event: Json): void {
    this.clock += 1;
    const store = this.store(calendar);
    const id = String(event["id"]);
    const fresh = {
      updated: this.updated(),
      etag: `"${String(this.clock)}"`,
    };
    store.set(id, {
      event: store.has(id)
        ? { status: "confirmed", ...event, ...fresh }
        : { ...fresh, status: "confirmed", ...event },
      version: this.clock,
    });
  }

  /** Google's `updated` for a change now: later with every change. */
  private updated(): string {
    return new Date(Date.UTC(2026, 8, 1, 8) + this.clock * 1000).toISOString();
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
    if (call.method !== "GET") return this.change(call, path);
    const entry = /^\/users\/me\/calendarList\/([^/]+)$/.exec(path);
    if (entry !== null) {
      const id = decodeURIComponent(entry[1] ?? "");
      const found = [...this.calendars, ...this.unlisted].find(
        (one) => one["id"] === id,
      );
      return found === undefined
        ? [404, { error: { code: 404, message: "Not Found" } }]
        : [200, found];
    }
    const match =
      /^\/calendars\/([^/]+)\/events(?:\/([^/]+)(\/instances)?)?$/.exec(path);
    if (match === null) return [404, { error: { code: 404, message: path } }];
    const calendar = decodeURIComponent(match[1] ?? "");
    const id =
      match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    const store = this.store(calendar);
    if (id === undefined) return this.listing(call, calendar, store);
    if (match[3] !== undefined && call.query["originalStart"] !== undefined) {
      return this.page(
        call,
        this.occurrences(store, id, call.query["originalStart"]),
        undefined,
        {},
      );
    }
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
    const found = store.get(id) ?? this.madeUp(store, id);
    if (found === undefined) {
      return [404, { error: { code: 404, message: "Not Found" } }];
    }
    if (
      found.event["status"] === "cancelled" &&
      call.query["showDeleted"] !== "true" &&
      !this.getsCancelled
    ) {
      return [
        410,
        { error: { code: 410, message: "Resource has been deleted" } },
      ];
    }
    return [200, found.event];
  }

  private change(call: Call, path: string): [number, Json] {
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+)(\/move)?)?$/.exec(
      path,
    );
    if (match === null) return [404, { error: { code: 404, message: path } }];
    const calendar = decodeURIComponent(match[1] ?? "");
    const id =
      match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    const store = this.store(calendar);
    if (id === undefined) {
      if (call.method !== "POST") return refusal(405, "method");
      return this.insert(calendar, store, call.body ?? {});
    }
    const found =
      store.get(id) ??
      (call.method === "PATCH" ? this.madeUp(store, id) : undefined);
    if (found === undefined) return refusal(404, "Not Found");
    if (call.ifMatch !== undefined && call.ifMatch !== found.event["etag"]) {
      return refusal(412, "Precondition Failed", "conditionNotMet");
    }
    if (match[3] !== undefined) return this.moved(call, calendar, id, found);
    if (call.method === "DELETE") {
      if (found.event["status"] === "cancelled") {
        return refusal(410, "Resource has been deleted", "deleted");
      }
      this.write(store, { ...found.event, status: "cancelled" });
      return [204, {}];
    }
    if (call.method !== "PATCH") return refusal(405, "method");
    const next = merged(found.event, call.body ?? {});
    return [200, this.write(store, next)];
  }

  private insert(
    calendar: string,
    store: Map<string, Stored>,
    body: Json,
  ): [number, Json] {
    const id = body["id"];
    if (typeof id !== "string" || !/^[0-9a-v]{5,1024}$/.test(id)) {
      return refusal(400, "Invalid resource id value.", "invalid");
    }
    if (store.has(id)) {
      return refusal(
        409,
        "The requested identifier already exists.",
        "duplicate",
      );
    }
    if (!isObject(body["start"]) || !isObject(body["end"])) {
      return refusal(400, "Missing end time.", "required");
    }
    const made = this.write(store, {
      status: "confirmed",
      ...body,
      organizer: { email: calendar, self: true },
      creator: { email: calendar, self: true },
      htmlLink: `https://calendar.example.test/${id}`,
      iCalUID: `${id}@google.com`,
      eventType: "default",
    });
    return [200, made];
  }

  private moved(
    call: Call,
    calendar: string,
    id: string,
    found: Stored,
  ): [number, Json] {
    const destination = call.query["destination"];
    if (destination === undefined) return refusal(400, "Missing destination.");
    if ((found.event["eventType"] ?? "default") !== "default") {
      return refusal(
        400,
        "Cannot change the organizer of this event.",
        "eventTypeRestriction",
      );
    }
    this.write(this.store(calendar), {
      id,
      status: "cancelled",
      ...(found.event["recurringEventId"] !== undefined && {
        recurringEventId: found.event["recurringEventId"],
      }),
    });
    const there = this.write(this.store(destination), {
      ...found.event,
      organizer: { email: destination, self: true },
    });
    return [200, there];
  }

  /** Stores a change, with a new etag and `updated`. */
  private write(store: Map<string, Stored>, event: Json): Json {
    this.clock += 1;
    const next = {
      ...event,
      etag: `"${String(this.clock)}"`,
      updated: this.updated(),
    };
    store.set(String(event["id"]), { event: next, version: this.clock });
    return next;
  }

  /** The occurrences of a series that began at `start`, made up from the
   *  series where Google holds no instance of its own. */
  private occurrences(
    store: Map<string, Stored>,
    series: string,
    start: string,
  ): Json[] {
    const at = Date.parse(start);
    const held = [...store.values()]
      .map((one) => one.event)
      .filter(
        (event) =>
          event["recurringEventId"] === series && original(event) === at,
      );
    if (held.length > 0) return held;
    const master = store.get(series)?.event;
    if (master === undefined || !Number.isFinite(at)) return [];
    const suffix = /^\d{4}-\d{2}-\d{2}$/.test(start)
      ? start.replaceAll("-", "")
      : new Date(at)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")
          .replace(/[-:]/g, "");
    const virtual = this.virtual(store, `${series}_${suffix}`);
    return virtual === undefined ? [] : [virtual];
  }

  private madeUp(store: Map<string, Stored>, id: string): Stored | undefined {
    const event = this.virtual(store, id);
    return event === undefined ? undefined : { event, version: 0 };
  }

  /** An occurrence Google makes up from its series, which holds no instance
   *  of its own until it is changed, and which carries the series' fields. */
  private virtual(store: Map<string, Stored>, id: string): Json | undefined {
    const at = id.lastIndexOf("_");
    if (at <= 0) return undefined;
    const master = store.get(id.slice(0, at))?.event;
    if (master === undefined || !Array.isArray(master["recurrence"])) {
      return undefined;
    }
    const tail = id.slice(at + 1);
    const day = /^(\d{4})(\d{2})(\d{2})$/.exec(tail);
    const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(tail);
    const start = master["start"] as Json;
    const end = master["end"] as Json;
    const zone = start["timeZone"];
    const carried: Json = { ...master };
    for (const key of ["id", "etag", "recurrence", "start", "end"]) {
      Reflect.deleteProperty(carried, key);
    }
    if (day !== null) {
      const date = `${day[1] ?? ""}-${day[2] ?? ""}-${day[3] ?? ""}`;
      const next = new Date(Date.parse(date) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      return {
        ...carried,
        id,
        status: "confirmed",
        recurringEventId: master["id"],
        originalStartTime: { date, timeZone: zone },
        start: { date, timeZone: zone },
        end: { date: next, timeZone: zone },
        etag: '"0"',
      };
    }
    if (time === null) return undefined;
    const ms = Date.UTC(
      Number(time[1]),
      Number(time[2]) - 1,
      Number(time[3]),
      Number(time[4]),
      Number(time[5]),
      Number(time[6]),
    );
    const length =
      Date.parse(String(end["dateTime"])) -
      Date.parse(String(start["dateTime"]));
    const instant = (value: number) =>
      new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
    return {
      ...carried,
      id,
      status: "confirmed",
      recurringEventId: master["id"],
      originalStartTime: { dateTime: instant(ms), timeZone: zone },
      start: { dateTime: instant(ms), timeZone: zone },
      end: { dateTime: instant(ms + length), timeZone: zone },
      etag: '"0"',
    };
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

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusal(
  status: number,
  message: string,
  reason?: string,
): [number, Json] {
  return [
    status,
    {
      error: {
        code: status,
        message,
        ...(reason !== undefined && { errors: [{ reason, message }] }),
      },
    },
  ];
}

/** A patch as Google takes one: a nested object merged into the one held,
 *  an array in place of the one held, and null clearing a field. */
function merged(held: Json, patch: Json): Json {
  const out: Json = { ...held };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) Reflect.deleteProperty(out, key);
    else if (isObject(value) && isObject(out[key])) {
      out[key] = merged(out[key], value);
    } else out[key] = value;
  }
  return out;
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: Json,
): void {
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
