import {
  defineConnector,
  main,
  Refused,
  Unreachable,
  type Entry,
} from "@withmarfa/connector";

const source = process.env["PROOF_SOURCE"] ?? "proof-watch";
const type = "proof.watch.item";
async function observe(url: string, signal: AbortSignal, event: object) {
  const response = await fetch(`${url}/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    signal,
  });
  if (!response.ok) throw new Error("watch proof observation refused");
}
void main(
  defineConnector({
    name: "proof-watch",
    description: "Watch prerequisite acknowledgment proof",
    source,
    types: [
      {
        type: {
          id: type,
          label: "Watch item",
          link_field: "vendor_id",
          fields: {
            title: { type: "string", required: true },
            note: { type: "string" },
            vendor_id: { type: "string" },
          },
        },
        fields: ["title", "note", "vendor_id"],
      },
    ],
    env: { PROOF_CONTROL_URL: "required" },
    async run(context) {
      const url = context.env.PROOF_CONTROL_URL;
      const response = await fetch(`${url}/entries`, {
        signal: context.signal,
      });
      const config = (await response.json()) as {
        entries: Entry[];
        checkpoint: boolean;
      };
      const scope = context.forScope("list");
      await observe(url, context.signal, { stage: "before-rescan" });
      await scope.upsert(type, config.entries);
      await observe(url, context.signal, { stage: "after-rescan" });
      if (config.checkpoint) {
        const page = scope.state.get("page") as number | undefined;
        const result = await scope.state.checkpoint("page", (page ?? 0) + 1);
        await observe(url, context.signal, { stage: "checkpoint", result });
        if (!result.committed)
          throw new Error(`checkpoint refused: ${result.reason}`);
      }
    },
    async onChange(change, context) {
      const response = await fetch(`${context.env.PROOF_CONTROL_URL}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...change, changed: [...change.changed] }),
        signal: context.signal,
      });
      if (response.status === 400)
        throw new Refused("owned vendor refuses this change");
      if (response.status === 503)
        throw new Unreachable("owned vendor temporarily unreachable", {
          scope: "owned vendor",
        });
      if (!response.ok) throw new Error("watch proof vendor failed");
      return (await response.json()) as Entry;
    },
  }),
);
