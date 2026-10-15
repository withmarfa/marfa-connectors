import { defineConnector, main } from "@withmarfa/connector";
import type { ReaderFixtureSource } from "./readwise-reader-stub.js";
const common = {
  account: { type: "string" as const, required: true },
  readwise_id: { type: "string" as const, required: true },
  external_id: { type: "string" as const },
};
await main(
  defineConnector({
    name: "readwise",
    source: "readwise",
    env: { READWISE_ACCOUNT: "required", PROOF_VENDOR_URL: "required" },
    types: [
      {
        type: {
          id: "readwise.source",
          label: "Readwise Source",
          parent: "core.media",
          fields: { ...common, readwise_source: { type: "string" } },
        },
        fields: [
          "account",
          "readwise_id",
          "external_id",
          "title",
          "readwise_source",
        ],
      },
      {
        type: {
          id: "readwise.highlight",
          label: "Readwise Highlight",
          parent: "core.highlight",
          fields: { ...common, readwise_source_id: { type: "string" } },
        },
        fields: [
          "account",
          "readwise_id",
          "external_id",
          "text",
          "note",
          "readwise_source_id",
        ],
      },
    ],
    connections: [
      {
        id: "references",
        label: "References",
        cardinality: "many-to-many",
        source_type_constraints: ["readwise.highlight"],
        target_type_constraints: ["readwise.source"],
      },
    ],
    async run(context) {
      const response = await fetch(
        `${context.env.PROOF_VENDOR_URL}/v2/export/`,
        {
          headers: { authorization: "Token reader-fixture-token" },
          signal: context.signal,
        },
      );
      if (!response.ok)
        throw new Error(`Fixture export failed: ${String(response.status)}`);
      const page = (await response.json()) as {
        results: ReaderFixtureSource[];
      };
      const account = context.env.READWISE_ACCOUNT;
      for (const source of page.results) {
        const natural = `${account}:source:${String(source.user_book_id)}`;
        await context.upsert("readwise.source", [
          {
            source_id: natural,
            properties: {
              account,
              readwise_id: String(source.user_book_id),
              external_id: source.external_id,
              title: source.title,
              readwise_source: "reader",
            },
          },
        ]);
        for (const highlight of source.highlights)
          await context.upsert("readwise.highlight", [
            {
              source_id: `${account}:highlight:${String(highlight.id)}`,
              properties: {
                account,
                readwise_id: String(highlight.id),
                external_id: highlight.external_id,
                readwise_source_id: String(source.user_book_id),
                text: highlight.text,
                note: highlight.note ?? "",
              },
              connections: {
                references: [{ type: "readwise.source", id: natural }],
              },
            },
          ]);
      }
    },
  }),
);
