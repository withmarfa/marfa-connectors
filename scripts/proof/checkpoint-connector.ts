import { defineConnector, main, type Entry } from "@withmarfa/connector";

export interface Action {
  scope: string;
  type?: "proof.checkpoint.issue" | "proof.checkpoint.comment";
  entries?: Entry[];
  key?: string;
  value?: unknown;
  mapEntry?: string;
  observe?: string;
  fail?: true;
  alias?: true;
}

function mapValue(map: unknown, key: string): { page: number } {
  const value = (map as Record<string, { page: number }>)[key];
  if (value === undefined) throw new Error("missing proof map entry");
  return value;
}

void main(
  defineConnector({
    name: "proof-checkpoint",
    description: "The proof's scoped progress reader.",
    source: "proof-checkpoint",
    types: ["proof.checkpoint.issue", "proof.checkpoint.comment"].map((id) => ({
      type: {
        id,
        label: id,
        description: "A checkpoint proof row.",
        fields: { title: { type: "string" as const, required: true } },
      },
      fields: ["title"],
    })),
    connections: [
      {
        id: "proof.checkpoint.related",
        cardinality: "many-to-many",
        source_type_constraints: [
          "proof.checkpoint.issue",
          "proof.checkpoint.comment",
        ],
        target_type_constraints: ["proof.checkpoint.issue"],
      },
    ],
    env: { PROOF_CONTROL_URL: "required" },
    async run(context) {
      const actions = (await (
        await fetch(context.env.PROOF_CONTROL_URL, { signal: context.signal })
      ).json()) as Action[];
      for (const action of actions) {
        const scope = context.forScope(action.scope);
        if (action.entries !== undefined)
          await scope.upsert(
            action.type ?? "proof.checkpoint.issue",
            action.entries,
          );
        let result: unknown;
        if (action.key !== undefined) {
          const candidate =
            action.mapEntry === undefined
              ? action.value
              : {
                  ...(scope.state.get(action.key) as
                    Record<string, unknown> | undefined),
                  [action.mapEntry]: action.value,
                };
          result = await scope.state.checkpoint(action.key, candidate);
          if (action.alias) {
            (action.value as { page: number }).page = 999;
            if (action.mapEntry === undefined)
              (scope.state.get(action.key) as { page: number }).page = 998;
            else
              mapValue(scope.state.get(action.key), action.mapEntry).page = 998;
            if (action.mapEntry === undefined)
              (context.state.get(action.key) as { page: number }).page = 997;
            else
              mapValue(context.state.get(action.key), action.mapEntry).page =
                997;
          }
        }
        if (action.observe !== undefined) {
          const answer = await fetch(context.env.PROOF_CONTROL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: action.observe,
              result,
              acknowledged:
                action.key === undefined
                  ? undefined
                  : scope.state.get(action.key),
            }),
            signal: context.signal,
          });
          if (!answer.ok) throw new Error("the proof observation was refused");
        }
        if (action.fail) throw new Error("a later scope failed deliberately");
      }
    },
  }),
);
