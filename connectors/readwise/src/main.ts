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
    connections: [
      {
        id: "references",
        label: "References",
        cardinality: "many-to-many",
        source_type_constraints: [highlightType.id],
        target_type_constraints: [sourceType.id],
      },
      {
        id: "attached-to",
        label: "Attached to",
        cardinality: "many-to-many",
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
