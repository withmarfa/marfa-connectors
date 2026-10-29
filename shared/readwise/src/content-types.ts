import type {
  TypeDefinition,
  Item,
  Entry,
  RowPolicy,
} from "@withmarfa/connector";
export const readerFileType: TypeDefinition = {
  id: "readwise.file",
  label: "Readwise file",
  description:
    "Reader content retained independently of its upstream availability.",
  parent: "core.file",
  link_field: "canonical_key",
  fields: {
    canonical_key: { type: "string", required: true },
    account: { type: "string", required: true },
    document_key: { type: "string", required: true },
    resource_kind: { type: "string", required: true },
    content_key: { type: "string" },
    reader_revision: { type: "string" },
    preservation: { type: "string" },
    source_url: {
      type: "url",
      description:
        "Where a picture the document's HTML draws was fetched from, as the URL parser writes the address, so that a reader of the HTML finds the picture by its attachment and this address.",
    },
  },
};
export const readerFileFields = [
  "title",
  "blob_ref",
  "mime_type",
  "canonical_key",
  "account",
  "document_key",
  "resource_kind",
  "content_key",
  "reader_revision",
  "preservation",
  "source_url",
] as const;

/** File writes remain inside the explicitly configured Readwise account. */
export function readerFilePolicy(
  account: string | undefined,
  item?: Item,
  entry?: Entry,
): RowPolicy {
  if (
    account === undefined ||
    (item !== undefined && item.properties["account"] !== account)
  )
    return { owned: false };
  const properties = entry?.properties ?? item?.properties;
  return {
    // Both connectors retain these files. Only a fresh preservation write can
    // replace them; a watch must not replay its own older agreement.
    fields: Object.fromEntries(
      readerFileFields.map((field) => [
        field,
        entry === undefined ? "observe" : "mirror",
      ]),
    ),
    owned:
      properties?.["account"] === account &&
      typeof properties["document_key"] === "string" &&
      (properties["document_key"].startsWith(`${account}:reader-document:`) ||
        properties["document_key"].startsWith(`${account}:reader-highlight:`)),
  };
}
