import { defineConnector } from "@withmarfa/connector";
import {
  sourceType,
  highlightType,
  sourceFields,
  highlightFields,
  readerMutableSourceFields,
  readerMutableHighlightFields,
  readerFileType,
  readerFileFields,
  readerFilePolicy,
} from "@withmarfa/readwise";
import { env, parseConfig } from "./config.js";
import { sync, readerArchived } from "./sync.js";
import { onChange, preflight } from "./outbound.js";
import { readerPolicy } from "./policy.js";
export function connector() {
  let account: string | undefined;
  let inboundOnly = false;
  return defineConnector({
    name: "readwise-reader",
    source: "readwise",
    sourceName: "Readwise",
    description:
      "Reader documents, highlights, annotations, and retained content with supported two-way edits.",
    readme: "connectors/readwise-reader/README.md",
    env,
    checkEnv(values) {
      const config = parseConfig(values);
      account = config.account;
      inboundOnly = config.inboundOnly;
    },
    types: [
      {
        type: sourceType,
        fields: sourceFields,
        readOnly: sourceFields.filter(
          (field) =>
            !(readerMutableSourceFields as readonly string[]).includes(field),
        ),
        policy: (item, entry) =>
          readerPolicy(sourceType.id, account, item, entry, inboundOnly),
        archived: readerArchived,
      },
      {
        type: highlightType,
        fields: highlightFields,
        readOnly: highlightFields.filter(
          (field) =>
            !(readerMutableHighlightFields as readonly string[]).includes(
              field,
            ),
        ),
        policy: (item, entry) =>
          readerPolicy(highlightType.id, account, item, entry, inboundOnly),
      },
      {
        type: readerFileType,
        fields: readerFileFields,
        policy: (item, entry) => readerFilePolicy(account, item, entry),
      },
    ],
    retired: [{ type: highlightType.id, connection: "references" }],
    connections: [
      {
        id: "excerpt-of",
        label: "Excerpt of",
        cardinality: "many-to-one",
        from_type_constraints: [highlightType.id],
        to_type_constraints: [sourceType.id],
      },
      // Retired: cleared on every highlight written, so one synced before holds
      // only `excerpt-of`.
      {
        id: "references",
        cardinality: "many-to-many",
        from_type_constraints: [highlightType.id],
        to_type_constraints: [sourceType.id],
      },
      {
        id: "attached-to",
        label: "Attached to",
        cardinality: "many-to-many",
        cascade_on_delete: "with-hosts",
        from_type_constraints: [readerFileType.id],
        to_type_constraints: [sourceType.id, highlightType.id],
      },
    ],
    carries: (values) =>
      parseConfig(values).inboundOnly ? [] : [sourceType.id, highlightType.id],
    run: sync,
    preflight,
    onChange,
  });
}
