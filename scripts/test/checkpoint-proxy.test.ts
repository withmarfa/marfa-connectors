import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Proxy } from "../proof/checkpoint.js";

let proxy: Proxy;
let upstream: Server;
let other: Server;
let reached: string[];
let escaped: string[];
let otherUrl: string;
let streamClosed: Promise<void>;
let closeStream: () => void;
async function start(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  return `http://127.0.0.1:${String(address.port)}`;
}
function send(
  path: string,
): Promise<{ status: number; text: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy.url);
    const req = request(
      { hostname: url.hostname, port: url.port, path },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text,
            ...(res.headers.location !== undefined && {
              location: res.headers.location,
            }),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
beforeEach(async () => {
  reached = [];
  escaped = [];
  streamClosed = new Promise<void>((resolve) => {
    closeStream = resolve;
  });
  other = createServer((req, res) => {
    escaped.push(req.url ?? "");
    res.end("other");
  });
  otherUrl = await start(other);
  upstream = createServer((req, res) => {
    reached.push(req.url ?? "");
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${otherUrl}/redirected` });
      res.end("redirect");
    } else if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.on("close", closeStream);
    } else res.end(req.url);
  });
  proxy = new Proxy(await start(upstream));
  await proxy.start();
});
afterEach(async () => {
  await proxy.stop();
  for (const server of [upstream, other]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
it("forwards intended paths and queries only to its configured upstream", async () => {
  expect(await send("/items?type=proof%2Eissue&label=a%2Fb")).toMatchObject({
    status: 200,
    text: "/items?type=proof%2Eissue&label=a%2Fb",
  });
  expect(reached).toEqual(["/items?type=proof%2Eissue&label=a%2Fb"]);
  expect(escaped).toEqual([]);
});
it.each(["absolute", "network", "backslash"])(
  "rejects %s targets without reaching another origin",
  async (kind) => {
    const address = new URL(otherUrl).host;
    const target =
      kind === "absolute"
        ? `${otherUrl}/escaped`
        : kind === "network"
          ? `//${address}/escaped`
          : `/\\${address}/escaped`;
    const response = await send(target);
    expect({ response, escaped, reached }).toEqual({
      response: {
        status: 400,
        text: JSON.stringify({
          error: {
            code: "validation_error",
            message: "proof proxy requires an origin-form target",
          },
        }),
      },
      escaped: [],
      reached: [],
    });
  },
);
it("returns redirects without fetching their other-origin destination", async () => {
  expect(await send("/redirect")).toEqual({
    status: 302,
    text: "redirect",
    location: `${otherUrl}/redirected`,
  });
  expect(reached).toEqual(["/redirect"]);
  expect(escaped).toEqual([]);
});
it("streams events before the upstream ends and cancels on disconnect", async () => {
  const response = await fetch(`${proxy.url}/events`);
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const first = await reader?.read();
  expect(new TextDecoder().decode(first?.value as Uint8Array | undefined)).toBe(
    "data: first\n\n",
  );
  await reader?.cancel();
  await streamClosed;
  expect(reached).toEqual(["/events"]);
  expect(escaped).toEqual([]);
});
