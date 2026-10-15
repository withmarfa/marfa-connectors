import type { Entry, Item, RowPolicy } from "@withmarfa/connector";
import {
  isReaderManaged,
  readerMutableSourceFields,
  readerMutableHighlightFields,
} from "@withmarfa/readwise";
export function readerPolicy(
  type: string,
  account: string | undefined,
  item?: Item,
  entry?: Entry,
  inboundOnly = false,
): RowPolicy {
  if (
    account === undefined ||
    (item !== undefined && item.properties["account"] !== account)
  )
    return { owned: false };
  const incoming =
    entry !== undefined && isReaderManaged(type, entry.properties, account);
  const managed =
    item !== undefined && isReaderManaged(type, item.properties, account);
  const properties = item?.properties;
  const kind = type === "readwise.source" ? "document" : "highlight";
  const link = properties?.["canonical_key"];
  const explicit =
    properties?.["reader_create"] === true &&
    properties["account"] === account &&
    properties["reader_id"] == null &&
    (link == null ||
      (typeof link === "string" &&
        link.startsWith(`${account}:reader-${kind}:`)));
  if (!incoming && !managed && !explicit) return { owned: false };
  return {
    owned: true,
    firstAgreement: "hold",
    ...(inboundOnly && {
      fields: Object.fromEntries(
        (type === "readwise.source"
          ? readerMutableSourceFields
          : readerMutableHighlightFields
        ).map((field) => [field, "observe" as const]),
      ),
    }),
  };
}
