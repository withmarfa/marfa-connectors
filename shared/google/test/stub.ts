import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Log, State } from "@withmarfa/connector";
import type { GoogleContext } from "../src/google.js";

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Never answers, so the caller's time limit is what ends the call. */
  hang?: true;
}

export interface Received {
  method: string;
  path: string;
  authorization: string | undefined;
  form: URLSearchParams;
}

export function idToken(sub: string): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({ sub, iss: "https://accounts.google.com" })}.c2lnbmF0dXJl`;
}

/** Stands in for Google's authorization, token, userinfo and API hosts. */
export class GoogleStub {
  readonly token: Received[] = [];
  readonly userinfo: Received[] = [];
  readonly api: Received[] = [];
  sub = "sub-1111111111";
  scope: string | undefined = "openid https://www.googleapis.com/auth/a";
  withIdToken = true;
  expiresIn = 3600;
  onToken: (call: Received) => Reply | undefined = () => undefined;
  onApi: (call: Received) => Reply | undefined = () => undefined;
  onUserinfo: (call: Received) => Reply | undefined = () => undefined;
  private server!: Server;
  private issued = 0;
  url = "";

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://stub");
        const call: Received = {
          method: request.method ?? "GET",
          path: url.pathname,
          authorization: request.headers.authorization,
          form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
        };
        const reply = this.answer(call);
        if (reply.hang === true) return;
        response.writeHead(reply.status ?? 200, {
          "Content-Type":
            reply.text === undefined ? "application/json" : "text/html",
          ...reply.headers,
        });
        response.end(reply.text ?? JSON.stringify(reply.json ?? {}));
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((done) => this.server.close(done));
  }

  get endpoints() {
    return {
      authorization: `${this.url}/auth`,
      token: `${this.url}/token`,
      userinfo: `${this.url}/userinfo`,
      api: this.url,
    };
  }

  private answer(call: Received): Reply {
    if (call.path === "/token") {
      this.token.push(call);
      return this.onToken(call) ?? this.granted();
    }
    if (call.path === "/userinfo") {
      this.userinfo.push(call);
      return this.onUserinfo(call) ?? { json: { sub: this.sub } };
    }
    this.api.push(call);
    return this.onApi(call) ?? { json: { ok: true } };
  }

  /** A good answer, with an access token of its own each time. */
  granted(extra: Record<string, unknown> = {}): Reply {
    this.issued += 1;
    return {
      json: {
        access_token: `ya29.access-token-number-${String(this.issued)}`,
        expires_in: this.expiresIn,
        token_type: "Bearer",
        ...(this.scope !== undefined && { scope: this.scope }),
        ...(this.withIdToken && { id_token: idToken(this.sub) }),
        ...extra,
      },
    };
  }
}

export interface Captured {
  readonly context: GoogleContext;
  readonly lines: string[];
  readonly conditions: Map<string, string>;
  readonly secrets: string[];
  readonly state: Map<string, unknown>;
  abort(): void;
}

/** What a run hands a connector, with everything it logs and keeps captured. */
export function captured(
  env: Record<string, string | undefined>,
  state = new Map<string, unknown>(),
): Captured {
  const lines: string[] = [];
  const conditions = new Map<string, string>();
  const secrets: string[] = [];
  const controller = new AbortController();
  const log: Pick<Log, "info" | "warn" | "condition"> = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    condition: (key, message) => {
      conditions.set(key, message);
    },
  };
  const kept: State = {
    get: (key) => state.get(key),
    set: (key, value) => {
      state.set(key, value);
    },
  };
  return {
    context: {
      env,
      signal: controller.signal,
      state: kept,
      log,
      secret: (value) => {
        if (value.length < 8) throw new Error("too short to keep secret");
        secrets.push(value);
      },
    },
    lines,
    conditions,
    secrets,
    state,
    abort: () => {
      controller.abort();
    },
  };
}

export const clientEnv = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-client-secret-value",
} as const;

let counter = 0;
/** A refresh token no earlier test used, so a test starts with a new grant,
 *  as a restarted connector does. */
export function freshToken(): string {
  counter += 1;
  return `1//refresh-token-for-test-number-${String(counter)}`;
}
