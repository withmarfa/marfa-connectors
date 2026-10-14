import { defineConnector, main } from "@withmarfa/connector";
import { endpoint } from "./client.js";
import { identity } from "./mapping.js";
import { env, sync } from "./sync.js";
import {
  sourceType,
  highlightType,
  sourceFields,
  highlightFields,
} from "./types.js";

await main(
  defineConnector({
    name: "readwise",
    source: "readwise",
    description:
      "Sources and complete highlights from one Readwise account, read only.",
    readme: "connectors/readwise/README.md",
    types: [
      { type: sourceType, fields: sourceFields },
      { type: highlightType, fields: highlightFields },
    ],
    connections: [
      {
        id: "references",
        label: "References",
        cardinality: "many-to-many",
        source_type_constraints: [highlightType.id],
        target_type_constraints: [sourceType.id],
      },
    ],
    env,
    checkEnv(values) {
      identity(values.READWISE_ACCOUNT, "source", 1);
      endpoint(values.READWISE_API_URL);
    },
    run: sync,
  }),
);
