import { defineConnector, main, verifyHmac } from "@withmarfa/connector";

interface Thing {
  id: string;
  title: string;
}

/**
 * The connector the inbound proof runs as a process: it reads the stub
 * vendor's things, and a delivery signed as GitHub signs one names the
 * thing that changed, which the run fetches alone.
 */
const connector = defineConnector({
  name: "proof-inbound",
  description: "Things from the proof's stub vendor, and its webhooks.",
  source: "proof-inbound",
  type: {
    id: "proof.thing",
    label: "Thing",
    description: "A thing from the proof's stub vendor.",
    fields: { title: { type: "string", required: true } },
  },
  fields: ["title"],
  env: { PROOF_VENDOR_URL: "required", PROOF_WEBHOOK_SECRET: "secret" },
  async run({ env, signal, hints, upsert }) {
    const fetched = async (path: string): Promise<unknown> => {
      const response = await fetch(new URL(path, env.PROOF_VENDOR_URL), {
        signal,
      });
      if (!response.ok) {
        throw new Error(`the stub vendor answered ${String(response.status)}`);
      }
      return response.json();
    };
    const things =
      hints === undefined
        ? ((await fetched("things")) as Thing[])
        : await Promise.all(
            [...hints].map(
              async (id) =>
                (await fetched(`things/${encodeURIComponent(id)}`)) as Thing,
            ),
          );
    await upsert(
      things.map((thing) => ({
        source_id: thing.id,
        properties: { title: thing.title },
      })),
    );
  },
  inbound: {
    verify: (delivery, env) =>
      verifyHmac({
        secret: env.PROOF_WEBHOOK_SECRET,
        body: delivery.body,
        signature: delivery.header("X-Hub-Signature-256"),
        prefix: "sha256=",
      }),
    hints: (delivery) => {
      const said = JSON.parse(new TextDecoder().decode(delivery.body)) as {
        id: string;
      };
      return [said.id];
    },
  },
});

await main(connector);
