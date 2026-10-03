import { defineConnector, main, type Entry } from "@withmarfa/connector";
export interface RetryConfig {
  mode?: "refetch" | "replay";
  context: string;
  maxLength: number;
  page: number;
  entries: Entry[];
  retrySaved: boolean;
  rootState?: boolean;
  conditions?: number;
}
const source = process.env["PROOF_SOURCE"] ?? "proof-retry";
const url = process.env["PROOF_CONTROL_URL"];
if (url === undefined) throw new Error("no owned retry source");
const config = (await (await fetch(url)).json()) as RetryConfig;
const type = `proof.${source}.item`,
  related = `proof.${source}.related`;
await main(
  defineConnector({
    name: source,
    source,
    description: "Durable inbound retry proof",
    types: [
      {
        type: {
          id: type,
          label: "Retry item",
          link_field: "vendor_id",
          fields: {
            title: {
              type: "string",
              required: true,
              maxLength: config.maxLength,
            },
            vendor_id: { type: "string" },
            note: { type: "string" },
          },
        },
        fields: ["title", "vendor_id", "note"],
      },
    ],
    connections: [
      {
        id: related,
        cardinality: "many-to-many",
        source_type_constraints: [type],
        target_type_constraints: [type],
      },
    ],
    env: { PROOF_CONTROL_URL: "required" },
    async run(context) {
      for (let index = 0; index < (config.conditions ?? 0); index++)
        context.log.condition(
          `generic-${String(index)}`,
          `Generic ${String(index)}`,
        );
      if (config.rootState === true) {
        context.state.set("page", config.page);
        return;
      }
      const scope = context.forScope(
        "page",
        config.mode === undefined
          ? undefined
          : { retry: { mode: config.mode, context: config.context } },
      );
      const current = new Set(config.entries.map((entry) => entry.source_id));
      const attempts = [...config.entries];
      if (config.retrySaved)
        for (const { record, due } of scope.refusals.pending()) {
          if (!due || current.has(record.identity.sourceId)) continue;
          if (record.mode === "replay") attempts.push(record.intent.entry);
          else {
            const response = await fetch(
              `${context.env.PROOF_CONTROL_URL}/refetch/${encodeURIComponent(record.identity.sourceId)}`,
            );
            if (response.ok) attempts.push((await response.json()) as Entry);
          }
        }
      await scope.upsert(type, attempts);
      const result = await scope.state.checkpoint("page", config.page);
      await fetch(context.env.PROOF_CONTROL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, pending: scope.refusals.pending() }),
      });
      if (!result.committed)
        throw new Error(`Checkpoint blocked: ${result.reason}`);
    },
  }),
);
