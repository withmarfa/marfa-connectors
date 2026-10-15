import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export interface ReaderFixtureDocument {
  id: string;
  category: string;
  parent_id?: string;
  title?: string;
  content?: string;
  notes?: string;
  location?: string;
  tags?: Record<string, { name: string }>;
  html_content?: string;
  updated_at?: string;
  url?: string;
  source_url?: string;
  author?: string;
}
export interface ReaderFixtureSource {
  user_book_id: number;
  source: string;
  external_id: string;
  title: string;
  highlights: {
    id: number;
    external_id: string;
    text: string;
    note?: string;
    is_deleted?: boolean;
  }[];
}
export async function readerVendor() {
  const documents = new Map<string, ReaderFixtureDocument>();
  const sources: ReaderFixtureSource[] = [];
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  const requests: string[] = [];
  let uncertain = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      requests.push(`${request.method ?? ""} ${url.pathname}${url.search}`);
      if (request.headers.authorization !== "Token reader-fixture-token") {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/v2/export/") {
        const results = sources.filter(
          (source) =>
            !url.searchParams.has("ids") ||
            String(source.user_book_id) === url.searchParams.get("ids"),
        );
        response.end(
          JSON.stringify({
            count: results.length,
            nextPageCursor: null,
            results,
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v3/list/") {
        const id = url.searchParams.get("id");
        const results = [...documents.values()]
          .filter((document) => id === null || document.id === id)
          .map((document) => {
            const value = { ...document };
            if (url.searchParams.get("withHtmlContent") !== "true")
              delete value.html_content;
            return value;
          });
        response.end(
          JSON.stringify({
            count: results.length,
            nextPageCursor: null,
            results,
          }),
        );
        return;
      }
      if (
        request.method === "PATCH" ||
        request.method === "POST" ||
        request.method === "DELETE"
      ) {
        let text = "";
        for await (const chunk of request) text += String(chunk);
        const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
        writes.push({ method: request.method, path: url.pathname, body });
        const match = /^\/v3\/(?:update|delete)\/([^/]+)\/?$/.exec(
          url.pathname,
        );
        const id = match?.[1];
        if (id && documents.has(id)) {
          if (request.method === "DELETE") documents.delete(id);
          else {
            const changes = { ...body };
            if (Array.isArray(changes["tags"]))
              changes["tags"] = Object.fromEntries(
                changes["tags"].map((tag: unknown) => [
                  String(tag),
                  { name: String(tag) },
                ]),
              );
            Object.assign(documents.get(id) ?? {}, changes);
          }
          if (uncertain) {
            uncertain = false;
            request.socket.destroy();
            return;
          }
          response.end(JSON.stringify({ id }));
          return;
        }
        if (url.pathname === "/v3/save/") {
          const created = {
            ...body,
            id: "created",
            category: "article",
            source_url:
              typeof body["url"] === "string" ? body["url"] : undefined,
          } as ReaderFixtureDocument;
          documents.set(created.id, created);
          if (uncertain) {
            uncertain = false;
            request.socket.destroy();
            return;
          }
          response.end(
            JSON.stringify({
              id: created.id,
              url: "https://read.readwise.io/read/created",
            }),
          );
          return;
        }
      }
      response
        .writeHead(404)
        .end(JSON.stringify({ error: "fixture route absent" }));
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    documents,
    sources,
    writes,
    requests,
    base,
    uncertain: () => {
      uncertain = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
