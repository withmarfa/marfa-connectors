import { expect, it } from "vitest";
import { readerExportPassage, type Source } from "../src/export.js";

it("keeps an explicitly active export passage beside a deleted historical alias", () => {
  const source: Source = {
    user_book_id: 7,
    source: "reader",
    external_id: "doc",
    is_deleted: false,
    highlights: [
      {
        id: 41,
        external_id: "hi",
        is_deleted: true,
        text: "Historical passage",
      },
      { id: 42, external_id: "hi", is_deleted: false, text: "Current passage" },
    ],
  };
  expect(
    readerExportPassage([source], {
      sourceId: 7,
      highlightId: 42,
      readerId: "hi",
      parentId: "doc",
    }),
  ).toBe("Current passage");
  const historical = source.highlights[0];
  if (historical === undefined) throw new Error("missing historical highlight");
  historical.is_deleted = false;
  expect(() =>
    readerExportPassage([source], {
      sourceId: 7,
      highlightId: 42,
      readerId: "hi",
      parentId: "doc",
    }),
  ).toThrow(/identity/);
});
