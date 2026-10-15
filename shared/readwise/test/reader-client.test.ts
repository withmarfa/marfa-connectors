import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReaderClient,
  RateLimited,
  ReadwiseThrottleError,
  ReadwiseAuthorizationError,
} from "../src/index.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function respond(response: Response) {
  const mock = vi.fn<typeof fetch>(() => Promise.resolve(response));
  vi.stubGlobal("fetch", mock);
  return mock;
}
function client(options = {}) {
  return new ReaderClient(
    "https://example.com/api/v3/",
    "secret",
    new AbortController().signal,
    options,
  );
}
describe("Reader GET transport", () => {
  it("counts each retried GET against the shared LIST budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const mock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ count: 0, nextPageCursor: null, results: [] }),
        ),
      );
    mock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    const reader = new ReaderClient(
      "https://example.com/api/v3/",
      "retry-budget",
      new AbortController().signal,
      {
        waitUntil: () => Promise.resolve(),
      },
    );
    await reader.page();
    for (let index = 0; index < 18; index++)
      await reader.document(String(index));
    expect(mock).toHaveBeenCalledTimes(20);
    let complete = false;
    const next = reader.page().then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mock).toHaveBeenCalledTimes(20);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    await next;
    expect(mock).toHaveBeenCalledTimes(21);
  });
  it("uses bounded authenticated direct lookup and rejects unrelated rows", async () => {
    const mock = respond(
      new Response(
        JSON.stringify({
          count: 1,
          nextPageCursor: null,
          results: [{ id: "wrong", category: "article" }],
        }),
      ),
    );
    await expect(client().document("wanted")).rejects.toThrow(/unrelated/);
    expect(mock.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect((mock.mock.calls[0]?.[0] as URL).searchParams.get("id")).toBe(
      "wanted",
    );
    expect(mock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Token secret" },
    });
  });
  it("distinguishes empty success, unauthorized response and rate limits", async () => {
    respond(
      new Response(
        JSON.stringify({ count: 0, nextPageCursor: null, results: [] }),
      ),
    );
    await expect(client().document("missing")).resolves.toBeUndefined();
    respond(new Response("", { status: 401 }));
    await expect(client().document("missing")).rejects.toThrow("HTTP 401");
    respond(
      new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    );
    await expect(
      client({ now: () => 0 }).document("missing"),
    ).rejects.toBeInstanceOf(RateLimited);
  });
  it.each([
    { count: 1, results: [] },
    { count: 0, results: [{ id: "wanted", category: "article" }] },
    { count: 2, results: [{ id: "wanted", category: "article" }] },
  ])("rejects an inconsistent direct lookup count: %j", async (answer) => {
    respond(new Response(JSON.stringify({ ...answer, nextPageCursor: null })));
    await expect(client().document("wanted")).rejects.toThrow(/direct lookup/);
  });
  it("accepts exactly one matching document", async () => {
    respond(
      new Response(
        JSON.stringify({
          count: 1,
          nextPageCursor: null,
          results: [{ id: "wanted", category: "article" }],
        }),
      ),
    );
    await expect(client().document("wanted")).resolves.toMatchObject({
      id: "wanted",
    });
  });
  it.each([401, 403] as const)(
    "classifies HTTP %s as a global authentication failure",
    async (status) => {
      respond(new Response("", { status }));
      await expect(client().document("id")).rejects.toBeInstanceOf(
        ReadwiseAuthorizationError,
      );
    },
  );
  it("keeps an invalid throttle response global", async () => {
    respond(new Response("", { status: 429 }));
    await expect(client().document("id")).rejects.toBeInstanceOf(
      ReadwiseThrottleError,
    );
  });
  it("does not follow redirects or accept over-limit responses", async () => {
    respond(
      new Response("", {
        status: 302,
        headers: { Location: "https://elsewhere.example.com/" },
      }),
    );
    await expect(client().document("id")).rejects.toThrow("HTTP 302");
    respond(new Response("12345"));
    await expect(client({ maxBytes: 4 }).document("id")).rejects.toThrow(
      "size limit",
    );
  });
});
