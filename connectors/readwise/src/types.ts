import type { TypeDefinition } from "@withmarfa/connector";
import source from "./readwise.source.json" with { type: "json" };
import highlight from "./readwise.highlight.json" with { type: "json" };
export const sourceType = source as TypeDefinition;
export const highlightType = highlight as TypeDefinition;
export const sourceFields = [
  "title",
  "author",
  "description",
  "notes",
  "url",
  "image_url",
  ...Object.keys(source.fields),
];
export const highlightFields = [
  "text",
  "note",
  "color",
  "locator_type",
  "start_location",
  "end_location",
  ...Object.keys(highlight.fields),
];
