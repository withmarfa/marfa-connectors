import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client, endpoint, RateLimited, InvalidCursor } from "../src/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function server(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const http = createServer(answer);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => {
        resolve();
      });
    });
  return `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/api/v2/`;
}
const empty = { count: 0, nextPageCursor: null, results: [] };
const signal = () => new AbortController().signal;

describe("Readwise GET client", () => {
  it("uses authenticated GET, explicit tombstones and encoded export parameters", async () => {
    const base = await server((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe("Token test-readwise-token");
      const url = new URL(request.url ?? "", "http://example.com");
      expect(url.pathname).toBe("/api/v2/export/");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        includeDeleted: "true",
        updatedAfter: "2026-10-14T00:00:00Z",
        pageCursor: "a+b/=",
        ids: "42",
      });
      response.end(JSON.stringify(empty));
    });
    expect(
      await new Client(base, "test-readwise-token", signal()).page({
        updatedAfter: "2026-10-14T00:00:00Z",
        cursor: "a+b/=",
        sourceId: 42,
      }),
    ).toEqual(empty);
  });
  it("distinguishes valid empty accounts from authentication and malformed answers", async () => {
    let status = 200;
    let body = JSON.stringify(empty);
    const base = await server((_, response) =>
      response.writeHead(status).end(body),
    );
    const client = new Client(base, "token", signal());
    expect((await client.page({})).results).toEqual([]);
    status = 401;
    await expect(client.page({})).rejects.toThrow("401");
    status = 200;
    body = "{}";
    await expect(client.page({})).rejects.toThrow("Readwise export");
    body = "bad json";
    await expect(client.page({})).rejects.toThrow("JSON");
  });
  it("retains rate-limit deadlines and rejects missing or malformed guidance", async () => {
    let header: string | undefined = "120";
    const base = await server((_, response) =>
      response
        .writeHead(429, header === undefined ? {} : { "Retry-After": header })
        .end(),
    );
    const client = new Client(base, "token", signal(), {
      now: () => Date.parse("2026-10-14T00:00:00Z"),
    });
    await expect(client.page({})).rejects.toMatchObject({
      until: "2026-10-14T00:02:00.000Z",
    });
    header = "Wed, 14 Oct 2026 00:05:00 GMT";
    await expect(client.page({})).rejects.toBeInstanceOf(RateLimited);
    for (header of [undefined, "soon", "20garbage", "-1"])
      await expect(client.page({})).rejects.toThrow("Retry-After");
  });
  it("restarts only an explicitly rejected cursor and never an unrelated bad request", async () => {
    let body = { detail: "Invalid page cursor" };
    const base = await server((_, response) =>
      response.writeHead(400).end(JSON.stringify(body)),
    );
    const client = new Client(base, "token", signal());
    await expect(client.page({ cursor: "opaque" })).rejects.toBeInstanceOf(
      InvalidCursor,
    );
    body = { detail: "Invalid request" };
    await expect(client.page({ cursor: "opaque" })).rejects.not.toBeInstanceOf(
      InvalidCursor,
    );
  });
  it("recognizes the provider's observed plain-text invalid cursor answer", async () => {
    const base = await server((_, response) =>
      response
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end("Invalid format on 'pageCursor'"),
    );
    const client = new Client(base, "token", signal());
    await expect(client.page({ cursor: "invalid" })).rejects.toBeInstanceOf(
      InvalidCursor,
    );
    await expect(client.page({})).rejects.not.toBeInstanceOf(InvalidCursor);
  });
  it("refuses redirects without forwarding credentials", async () => {
    let requests = 0;
    const base = await server((_, response) => {
      requests++;
      response.writeHead(302, { Location: "/elsewhere" }).end();
    });
    await expect(new Client(base, "token", signal()).page({})).rejects.toThrow(
      "302",
    );
    expect(requests).toBe(1);
  });
  it("bounds request time and responds to cancellation", async () => {
    const base = await server(() => undefined);
    await expect(
      new Client(base, "token", signal(), { timeoutMs: 20 }).page({}),
    ).rejects.toThrow();
    const abort = new AbortController();
    const request = new Client(base, "token", abort.signal).page({});
    abort.abort();
    await expect(request).rejects.toThrow();
  });
  it("bounds response bodies without treating truncation as empty", async () => {
    const base = await server((_, response) => response.end("x".repeat(4096)));
    await expect(
      new Client(base, "token", signal(), { maxBytes: 1024 }).page({}),
    ).rejects.toThrow("size limit");
  });
  it("resolves a pending highlight to its source without inferring deletion from 404", async () => {
    let status = 200;
    let body = { id: 7, book_id: 42 };
    const base = await server((request, response) => {
      expect(request.url).toBe("/api/v2/highlights/7/");
      response.writeHead(status).end(JSON.stringify(body));
    });
    const client = new Client(base, "token", signal());
    expect(await client.sourceForHighlight(7)).toBe(42);
    status = 404;
    expect(await client.sourceForHighlight(7)).toBeUndefined();
    status = 200;
    body = { id: 8, book_id: 42 };
    await expect(client.sourceForHighlight(7)).rejects.toThrow(
      "highlight detail",
    );
  });
  it("rejects credential-bearing and insecure nonlocal endpoints", () => {
    for (const value of [
      "http://example.com/",
      "https://user:pass@example.com/",
      "https://example.com/?token=x",
      "https://example.com/#x",
    ])
      expect(() => endpoint(value)).toThrow();
    expect(endpoint()).toBe("https://readwise.io/api/v2/");
  });
});
