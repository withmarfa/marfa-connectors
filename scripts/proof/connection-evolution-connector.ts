import { defineConnector, main } from "@withmarfa/connector";

const source = "proof-connection-evolution";
const type = "proof.evolution.entry";
const extra = "proof.evolution.extra";
const connection = "proof.evolution.in-repository";

const widened = process.env["PROOF_EVOLUTION"] === "widened";

void main(
  defineConnector({
    name: source,
    description: "The proof's connection definition upgrade reader.",
    source,
    types: [type, extra].map((id) => ({
      type: {
        id,
        label: id,
        description: "An endpoint evolution proof row.",
        fields: { title: { type: "string" as const, required: true } },
      },
      fields: ["title"],
    })),
    connections: [
      {
        id: connection,
        label: "Proof repository",
        description: "A connection kept during an endpoint upgrade.",
        cardinality: "many-to-one",
        source_type_constraints: widened ? [type, extra] : [type],
        target_type_constraints: [type],
      },
    ],
    async run(context) {
      await context.upsert(type, [
        { source_id: "target", properties: { title: "Target" } },
        {
          source_id: "original",
          properties: { title: "Original source" },
          connections: { [connection]: [{ type, id: "target" }] },
        },
      ]);
      if (widened)
        await context.upsert(extra, [
          {
            source_id: "new",
            properties: { title: "New source" },
            connections: { [connection]: [{ type, id: "target" }] },
          },
        ]);
    },
  }),
);
