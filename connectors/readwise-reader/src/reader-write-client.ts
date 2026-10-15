import { Refused, Unreachable } from "@withmarfa/connector";
import { ReaderClient, endpoint } from "@withmarfa/readwise";
export type ReaderBody = Record<string, string | string[]>;
export interface ReaderWriter extends ReaderClient {
  save(body: ReaderBody): Promise<string>;
  update(id: string, body: ReaderBody): Promise<void>;
  delete(id: string): Promise<void>;
}
export class ReaderWriteRefused extends Refused {}
export class ReaderWriteClient extends ReaderClient {
  private readonly writeBase: string;
  constructor(
    base: string,
    private readonly accessToken: string,
    private readonly stop: AbortSignal,
  ) {
    super(base, accessToken, stop);
    this.writeBase = endpoint(base);
  }
  async save(body: ReaderBody): Promise<string> {
    return this.write("POST", "save/", body);
  }
  async update(id: string, body: ReaderBody): Promise<void> {
    await this.write("PATCH", `update/${encodeURIComponent(id)}/`, body, id);
  }
  async delete(id: string): Promise<void> {
    await this.write(
      "DELETE",
      `delete/${encodeURIComponent(id)}/`,
      undefined,
      id,
    );
  }
  private async write(
    method: string,
    path: string,
    body?: ReaderBody,
    id?: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.writeBase), {
        method,
        headers: {
          Authorization: `Token ${this.accessToken}`,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.any([this.stop, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new Unreachable(
        "Reader write response was lost; the durable intent is retained",
      );
    }
    if (response.status === 429) {
      await response.body?.cancel();
      const guidance = response.headers.get("Retry-After");
      const now = Date.now();
      const until =
        guidance !== null && /^\d+(?:\.\d+)?$/.test(guidance)
          ? now + Number(guidance) * 1000
          : guidance?.endsWith("GMT")
            ? Date.parse(guidance)
            : NaN;
      if (!Number.isFinite(until) || until < now || until > 8.64e15)
        throw new Unreachable(
          "Reader rate limit has missing or invalid Retry-After guidance",
          { scope: "Reader", retryAt: new Date(now + 60000).toISOString() },
        );
      throw new Unreachable("Reader rate limit", {
        scope: "Reader",
        retryAt: new Date(until).toISOString(),
        requestNotApplied: true,
      });
    }
    if (method === "DELETE" && [204, 404].includes(response.status)) {
      await response.body?.cancel();
      return id ?? "";
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 500)
        throw new Unreachable(
          `Reader write uncertain (HTTP ${String(response.status)})`,
        );
      throw new ReaderWriteRefused(
        `Reader write refused (HTTP ${String(response.status)})`,
      );
    }
    if (![200, 201].includes(response.status)) {
      await response.body?.cancel();
      throw new Unreachable(
        "Reader write returned an unrecognized success status",
      );
    }
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      if (reader !== undefined)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const value: unknown = next.value;
          if (!(value instanceof Uint8Array)) throw new Error("invalid chunk");
          length += value.byteLength;
          if (length > 64 * 1024) throw new Error("too large");
          parts.push(value);
        }
      const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        value.id.length === 0 ||
        value.id.length > 512 ||
        (id !== undefined && value.id !== id)
      )
        throw new Error("invalid identity");
      return value.id;
    } catch {
      throw new Unreachable(
        "Reader write returned an unreadable confirmation; the durable intent is retained",
      );
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }
}
