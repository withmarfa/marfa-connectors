import { parsePage, type ExportPage } from "./export.js";
import { ReadwiseHttp } from "./http.js";
export interface Query {
  updatedAfter?: string;
  cursor?: string;
  sourceId?: number;
}
export interface ExportClient {
  page(query: Query): Promise<ExportPage>;
  sourceForHighlight(id: number): Promise<number | undefined>;
}
export class Client extends ReadwiseHttp implements ExportClient {
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
}
