import { defineConnector, main } from "@withmarfa/connector";

const id = "proof.adoption.child";
void main(
  defineConnector({
    name: "proof-adoption",
    source: "proof-adoption",
    types: [
      {
        type: {
          id,
          parent: "proof.adoption.parent",
          label: "Adoption row",
          fields: {
            title: { type: "string", required: true },
            link: { type: "string", format: "url" },
            ...(process.env["PROOF_ADDITION"] === "true" && {
              note: { type: "string" as const },
            }),
          },
        },
        fields: [
          "title",
          "link",
          ...(process.env["PROOF_ADDITION"] === "true" ? ["note"] : []),
        ],
      },
    ],
    env: { PROOF_MODE: "required" },
    async run(context) {
      const mode = context.env.PROOF_MODE;
      if (mode === "type") return;
      if (mode === "fail")
        context.log.condition("vendor:A", "Vendor A is unavailable");
      if (mode === "skip") context.log.unreached({ keys: ["vendor:A"] });
      await context
        .forScope("B")
        .upsert(id, [
          { source_id: "B", properties: { title: "Independent B" } },
        ]);
      const cut = await context.forScope("B").state.checkpoint("B", 1);
      if (!cut.committed) throw new Error(`checkpoint refused: ${cut.reason}`);
      if (mode === "fail") throw new Error("later vendor failure");
      if (mode === "recover")
        await context.upsert(id, [
          { source_id: "A", properties: { title: "Recovered A" } },
        ]);
    },
  }),
);
