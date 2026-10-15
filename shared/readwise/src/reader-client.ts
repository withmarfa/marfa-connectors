import { ReadwiseHttp } from "./http.js";
import { readerListPermit } from "./reader-rate-limit.js";
import {
  parseReaderPage,
  type ReaderDocument,
  type ReaderPage,
} from "./reader.js";
export interface ReaderQuery {
  id?: string;
  updatedAfter?: string;
  cursor?: string;
  location?: string;
  category?: string;
  withHtmlContent?: boolean;
  withRawSourceUrl?: boolean;
}
export interface ReaderReader {
  page(query?: ReaderQuery): Promise<ReaderPage>;
  document(id: string): Promise<ReaderDocument | undefined>;
}
export class ReaderClient extends ReadwiseHttp implements ReaderReader {
  constructor(
    base: string,
    private readonly listToken: string,
    private readonly listSignal: AbortSignal,
    options: ConstructorParameters<typeof ReadwiseHttp>[3] = {},
  ) {
    super(base, listToken, listSignal, options);
  }
  protected override beforeRequest(): Promise<void> {
    return readerListPermit(this.listToken, this.listSignal);
  }
  async page(query: ReaderQuery = {}): Promise<ReaderPage> {
    const url = new URL("list/", this.base);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined)
        url.searchParams.set(
          key === "cursor" ? "pageCursor" : key,
          String(value),
        );
    return parseReaderPage(await this.get(url, query.cursor !== undefined));
  }
  async document(id: string): Promise<ReaderDocument | undefined> {
    const page = await this.page({ id });
    if (
      page.nextPageCursor !== null ||
      page.count !== page.results.length ||
      ![0, 1].includes(page.count) ||
      page.results.some((row) => row.id !== id)
    )
      throw new Error(
        "Reader direct lookup returned unrelated documents or an incomplete page",
      );
    return page.results[0];
  }
}
