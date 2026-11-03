import {
  defineConnector,
  main,
  type Item,
  type Entry,
} from "@withmarfa/connector";
import { contentMaxBytes, endpoint } from "@withmarfa/readwise";
import { identity } from "@withmarfa/readwise";
import { highlightsPolicy } from "./coexistence.js";
import { env, sync } from "./sync.js";
import {
  sourceType,
  highlightType,
  sourceFields,
  highlightFields,
  readerFileType,
  readerFileFields,
  readerFilePolicy,
} from "@withmarfa/readwise";

let account: string | undefined;
await main(
  defineConnector({
    name: "readwise",
    source: "readwise",
    sourceName: "Readwise",
    description:
      "Sources and complete highlights from one Readwise account, read only.",
    readme: "connectors/readwise/README.md",
    types: [
      {
        type: sourceType,
        fields: sourceFields,
        policy: (item: Item | undefined, entry?: Entry) =>
          highlightsPolicy(sourceType.id, item, entry),
      },
      {
        type: highlightType,
        fields: highlightFields,
        policy: (item: Item | undefined, entry?: Entry) =>
          highlightsPolicy(highlightType.id, item, entry),
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
        source_type_constraints: [highlightType.id],
        target_type_constraints: [sourceType.id],
      },
      // Retired: cleared on every highlight written, so one synced before holds
      // only `excerpt-of`.
      {
        id: "references",
        cardinality: "many-to-many",
        source_type_constraints: [highlightType.id],
        target_type_constraints: [sourceType.id],
      },
      {
        id: "attached-to",
        label: "Attached to",
        cardinality: "many-to-many",
        cascade_on_delete: "with-hosts",
        source_type_constraints: [readerFileType.id],
        target_type_constraints: [sourceType.id, highlightType.id],
      },
    ],
    env,
    checkEnv(values) {
      identity(values.READWISE_ACCOUNT, "source", 1);
      account = values.READWISE_ACCOUNT;
      endpoint(values.READWISE_API_URL);
      contentMaxBytes(values.READWISE_CONTENT_MAX_BYTES);
    },
    run: sync,
  }),
);
