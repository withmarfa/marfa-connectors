import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface Issue {
  id: string;
  title: string;
  body: string;
  state: "open" | "closed";
  updated_at: string;
  sub_issues: string[];
  attachments: { id: string; etag: string }[];
}

export interface Attachment {
  id: string;
  bytes: Buffer;
  mime_type: string;
}

export interface Asked {
  method: string;
  path: string;
  body: unknown;
}

export const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export class Tracker {
  readonly issues = new Map<string, Issue>();
  readonly attachments = new Map<string, Attachment>();
  readonly asked: Asked[] = [];
  readonly hidden = new Set<string>();
  slowList = 0;
  url = "";
  private next = 100;
  private clock = 0;
  private readonly http = createServer((req, res) => {
    void this.answer(req).then(
      ([status, body, type]) => {
        res.writeHead(status, {
          "Content-Type": type ?? "application/json",
        });
        res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
      },
      (error: unknown) => {
        res.writeHead(500).end(String(error));
      },
    );
  });

  async start(): Promise<this> {
    await new Promise<void>((done) =>
      this.http.listen(0, "127.0.0.1", () => {
        done();
      }),
    );
    this.url = `http://127.0.0.1:${String((this.http.address() as AddressInfo).port)}/`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((done) => {
      this.http.closeAllConnections();
      this.http.close(() => {
        done();
      });
    });
  }

  touch(): string {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }

  add(title: string, fields: Partial<Issue> = {}): Issue {
    this.next += 1;
    const issue: Issue = {
      id: `i${String(this.next)}`,
      title,
      body: "",
      state: "open",
      updated_at: this.touch(),
      sub_issues: [],
      attachments: [],
      ...fields,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  attach(issue: Issue, bytes: Buffer, mimeType: string): Attachment {
    this.next += 1;
    const attachment = {
      id: `a${String(this.next)}`,
      bytes,
      mime_type: mimeType,
    };
    this.attachments.set(attachment.id, attachment);
    issue.attachments.push({
      id: attachment.id,
      etag: `"${String(this.next)}"`,
    });
    issue.updated_at = this.touch();
    return attachment;
  }

  writes(): string[] {
    return this.asked
      .filter((asked) => asked.method !== "GET")
      .map((asked) => `${asked.method} ${asked.path}`);
  }

  private async answer(
    req: IncomingMessage,
  ): Promise<[number, unknown, string?]> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    this.asked.push({ method, path, body });
    const input = (body ?? {}) as Record<string, unknown>;
    const parts = path.split("/").filter((part) => part !== "");

    if (method === "GET" && path === "/issues") {
      if (this.slowList > 0) {
        await new Promise((done) => setTimeout(done, this.slowList));
      }
      return [
        200,
        [...this.issues.values()].filter((issue) => !this.hidden.has(issue.id)),
      ];
    }
    if (parts[0] === "attachments" && parts[1] !== undefined) {
      const attachment = this.attachments.get(parts[1]);
      if (attachment === undefined) return [404, {}];
      return [200, attachment.bytes, attachment.mime_type];
    }
    if (method === "POST" && path === "/issues") {
      const issue = this.add(String(input["title"]), {
        body: typeof input["body"] === "string" ? input["body"] : "",
      });
      return [201, issue];
    }
    const issue =
      parts[1] === undefined || this.hidden.has(parts[1])
        ? undefined
        : this.issues.get(parts[1]);
    if (parts[0] !== "issues" || issue === undefined) return [404, {}];
    if (method === "GET" && parts.length === 2) return [200, issue];
    if (method === "PATCH" && parts.length === 2) {
      if (typeof input["title"] === "string") issue.title = input["title"];
      if (typeof input["body"] === "string") issue.body = input["body"];
      if (input["state"] === "open" || input["state"] === "closed") {
        issue.state = input["state"];
      }
      issue.updated_at = this.touch();
      return [200, issue];
    }
    if (parts[2] === "sub_issues") {
      const sub = String(parts[3] ?? input["sub_issue_id"]);
      issue.sub_issues =
        method === "POST"
          ? [...new Set([...issue.sub_issues, sub])]
          : issue.sub_issues.filter((id) => id !== sub);
      issue.updated_at = this.touch();
      return [200, issue];
    }
    return [404, {}];
  }
}
