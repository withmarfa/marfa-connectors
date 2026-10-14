import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { connect, type AddressInfo, type Socket } from "node:net";
import { gunzipSync } from "node:zlib";

interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

export interface ReceivedSpan {
  name: string;
  traceId: string;
  spanId: string;
  status?: { code?: number; message?: string };
  attributes: Record<string, string>;
  events: { name: string; attributes: Record<string, string> }[];
  resource: Record<string, string>;
}

export interface ReceivedLogRecord {
  body: string;
  severityText?: string;
  traceId?: string;
  spanId?: string;
  resource: Record<string, string>;
}

export interface Post {
  path: string;
  headers: IncomingHttpHeaders;
  /** The body as it arrived, unzipped where it was zipped. */
  text: string;
}

export interface Collector {
  /** The base URL, which a test gives as the OTLP endpoint. */
  readonly url: string;
  readonly posts: Post[];
  spans(): ReceivedSpan[];
  logRecords(): ReceivedLogRecord[];
  close(): Promise<void>;
}

function attributes(list: OtlpAttribute[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of list ?? []) {
    out[key] = String(
      value.stringValue ?? value.intValue ?? value.boolValue ?? "",
    );
  }
  return out;
}

interface Body {
  resourceSpans?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: {
      spans?: (Omit<ReceivedSpan, "attributes" | "events" | "resource"> & {
        attributes?: OtlpAttribute[];
        events?: { name: string; attributes?: OtlpAttribute[] }[];
      })[];
    }[];
  }[];
  resourceLogs?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeLogs?: {
      logRecords?: {
        body?: OtlpValue;
        severityText?: string;
        traceId?: string;
        spanId?: string;
      }[];
    }[];
  }[];
}

/**
 * A local HTTP server that takes OTLP/HTTP posts as a collector does and
 * keeps each one whole. `hang` holds every post open without an answer, as
 * a collector that has stopped responding does.
 */
export async function startCollector(
  mode: "answer" | "hang" = "answer",
): Promise<Collector> {
  const posts: Post[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      posts.push({
        path: request.url ?? "",
        headers: request.headers,
        text:
          request.headers["content-encoding"] === "gzip"
            ? gunzipSync(raw).toString("utf8")
            : raw.toString("utf8"),
      });
      if (mode === "hang") {
        held.push(response);
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const bodies = (signal: "traces" | "logs"): Body[] =>
    posts
      .filter((post) => post.path.endsWith(`/${signal}`))
      .map((post) => JSON.parse(post.text) as Body);
  return {
    url: `http://127.0.0.1:${String(port)}`,
    posts,
    spans: () =>
      bodies("traces").flatMap((body) =>
        (body.resourceSpans ?? []).flatMap((resource) =>
          (resource.scopeSpans ?? []).flatMap((scope) =>
            (scope.spans ?? []).map((span) => ({
              ...span,
              attributes: attributes(span.attributes),
              events: (span.events ?? []).map((event) => ({
                name: event.name,
                attributes: attributes(event.attributes),
              })),
              resource: attributes(resource.resource?.attributes),
            })),
          ),
        ),
      ),
    logRecords: () =>
      bodies("logs").flatMap((body) =>
        (body.resourceLogs ?? []).flatMap((resource) =>
          (resource.scopeLogs ?? []).flatMap((scope) =>
            (scope.logRecords ?? []).map((record) => ({
              body: record.body?.stringValue ?? "",
              ...(record.severityText !== undefined && {
                severityText: record.severityText,
              }),
              ...(record.traceId !== undefined && { traceId: record.traceId }),
              ...(record.spanId !== undefined && { spanId: record.spanId }),
              resource: attributes(resource.resource?.attributes),
            })),
          ),
        ),
      ),
    close: () =>
      new Promise((resolve) => {
        for (const response of held.splice(0)) response.destroy();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** An address on this machine that nothing listens on. */
export async function closedAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}`;
}

export interface BlackHole {
  /** An OTLP endpoint whose connections never complete. */
  readonly url: string;
  close(): void;
}

/** Whether a connection to the address is still opening after a while. */
async function staysOpening(host: string, port: number): Promise<boolean> {
  const socket = connect({ host, port });
  socket.on("error", () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const opening = socket.connecting && !socket.destroyed;
  socket.destroy();
  return opening;
}

/**
 * An address where a connection is never completed, as at a collector
 * behind a firewall that drops packets. A non-routable address does that
 * on most networks; where it is refused instead, a listener that has
 * stopped accepting, with its queue full, does it on Linux, which drops
 * the connection's opening packets rather than refusing them.
 */
export async function blackHole(): Promise<BlackHole> {
  if (await staysOpening("10.255.255.1", 4318)) {
    return { url: "http://10.255.255.1:4318", close: () => undefined };
  }
  const listener = spawn(
    process.execPath,
    [
      "-e",
      'const s = require("node:net").createServer(); s.listen({ port: 0, host: "127.0.0.1", backlog: 1 }, () => console.log(s.address().port));',
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise<number>((resolve) => {
    listener.stdout.once("data", (data: Buffer) => {
      resolve(Number(data.toString("utf8").trim()));
    });
  });
  listener.kill("SIGSTOP");
  const filling: Socket[] = [];
  for (let tries = 0; tries < 16; tries += 1) {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    filling.push(socket);
  }
  const close = (): void => {
    for (const socket of filling) socket.destroy();
    listener.kill("SIGKILL");
  };
  if (!(await staysOpening("127.0.0.1", port))) {
    close();
    throw new Error(
      "no address here leaves a connection opening, so a collector that drops packets cannot be stood in for",
    );
  }
  return { url: `http://127.0.0.1:${String(port)}`, close };
}
