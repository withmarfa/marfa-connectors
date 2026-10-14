import { parsePage, type ExportPage } from "./export.js";

export function endpoint(value = "https://readwise.io/api/v2/"): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new Error(
      "READWISE_API_URL must use HTTPS (or local HTTP for tests), without credentials, query or fragment",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}
export interface Query {
  updatedAfter?: string;
  cursor?: string;
  sourceId?: number;
}
export interface ExportClient {
  page(query: Query): Promise<ExportPage>;
  sourceForHighlight(id: number): Promise<number | undefined>;
}
export class RateLimited extends Error {
  constructor(readonly until: string) {
    super(`Readwise rate limit: retry after ${until}`);
  }
}
export class InvalidCursor extends Error {
  constructor() {
    super("Readwise rejected the export page cursor");
  }
}
export class Client implements ExportClient {
  private readonly base: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  constructor(
    base: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
    options: { now?: () => number; timeoutMs?: number; maxBytes?: number } = {},
  ) {
    this.base = endpoint(base);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }
  async page(query: Query): Promise<ExportPage> {
    const url = new URL("export/", this.base);
    url.searchParams.set("includeDeleted", "true");
    if (query.updatedAfter !== undefined)
      url.searchParams.set("updatedAfter", query.updatedAfter);
    if (query.cursor !== undefined)
      url.searchParams.set("pageCursor", query.cursor);
    if (query.sourceId !== undefined)
      url.searchParams.set("ids", String(query.sourceId));
    return parsePage(await this.get(url, query.cursor !== undefined));
  }
  async sourceForHighlight(id: number): Promise<number | undefined> {
    const result = await this.get(
      new URL(`highlights/${String(id)}/`, this.base),
      false,
      true,
    );
    if (result === undefined) return undefined;
    if (
      typeof result !== "object" ||
      result === null ||
      !("id" in result) ||
      result.id !== id ||
      !("book_id" in result) ||
      typeof result.book_id !== "number" ||
      !Number.isSafeInteger(result.book_id) ||
      result.book_id <= 0
    )
      throw new Error("Readwise returned an invalid highlight detail");
    return result.book_id;
  }
  private async get(
    url: URL,
    hasCursor: boolean,
    allowMissing = false,
  ): Promise<unknown> {
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Token ${this.token}`,
        Accept: "application/json",
      },
      redirect: "manual",
      signal,
    });
    if (response.status === 429) {
      await response.body?.cancel();
      const header = response.headers.get("Retry-After");
      const now = this.now();
      const milliseconds =
        header !== null && /^\d+(?:\.\d+)?$/.test(header)
          ? now + Number(header) * 1000
          : header?.endsWith("GMT")
            ? Date.parse(header)
            : NaN;
      if (
        !Number.isFinite(milliseconds) ||
        milliseconds < now ||
        milliseconds > 8.64e15
      )
        throw new Error(
          "Readwise rate limit has missing or invalid Retry-After guidance",
        );
      throw new RateLimited(new Date(milliseconds).toISOString());
    }
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (
      !response.ok &&
      !(hasCursor && [400, 404, 422].includes(response.status))
    ) {
      await response.body?.cancel();
      throw new Error(
        `Readwise request failed (HTTP ${String(response.status)})`,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader !== undefined) {
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const value: unknown = result.value;
          if (!(value instanceof Uint8Array))
            throw new Error("Readwise returned an invalid response chunk");
          size += value.byteLength;
          if (size > this.maxBytes)
            throw new Error("Readwise response exceeds the size limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (
      hasCursor &&
      response.status === 400 &&
      /^Invalid format on 'pageCursor'\.?$/.test(text.trim())
    )
      throw new InvalidCursor();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `Readwise returned invalid JSON (HTTP ${String(response.status)})`,
      );
    }
    if (!response.ok) {
      const detail =
        typeof body === "object" &&
        body !== null &&
        "detail" in body &&
        typeof body.detail === "string"
          ? body.detail
          : "";
      if (
        hasCursor &&
        /(?:invalid|expired|unknown|unrecognized).{0,30}(?:page.?cursor|cursor)|(?:page.?cursor|cursor).{0,30}(?:invalid|expired|unknown|unrecognized)/i.test(
          detail,
        )
      )
        throw new InvalidCursor();
      throw new Error(
        `Readwise request failed (HTTP ${String(response.status)})`,
      );
    }
    return body;
  }
}
