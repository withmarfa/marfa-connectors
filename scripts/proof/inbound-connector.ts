import { writeFile } from "node:fs/promises";
import { defineConnector, main, verifyHmac } from "@withmarfa/connector";

interface Thing {
  id: string;
  title: string;
}

const connector = defineConnector({
  name: "proof-inbound",
  description: "Things from the proof's stub vendor, and its webhooks.",
  source: "proof-inbound",
  types: [
    {
      type: {
        id: "proof.thing",
        label: "Thing",
        description: "A thing from the proof's stub vendor.",
        fields: { title: { type: "string", required: true } },
      },
      fields: ["title"],
    },
  ],
  env: {
    PROOF_VENDOR_URL: "required",
    PROOF_WEBHOOK_SECRET: "secret",
    PROOF_SETUP_PATH_FILE: "optional",
    PROOF_SETUP_FAILS: "optional",
  },
  // Hands the proof the address it made, which the kit keeps out of the
  // log, so the proof can post to it.
  async setup({ env, endpoint }) {
    const made = await endpoint({
      label: "stub vendor",
      duplicateHeader: "X-GitHub-Delivery",
    });
    if (env.PROOF_SETUP_PATH_FILE !== undefined) {
      await writeFile(env.PROOF_SETUP_PATH_FILE, made.path);
    }
    if (env.PROOF_SETUP_FAILS === "true") {
      throw new Error("the stub vendor refused the setup");
    }
    return { PROOF_WEBHOOK_SECRET: "proof-setup-webhook-secret" };
  },
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
            [...(hints.get("proof.thing") ?? [])].map(
              async (id) =>
                (await fetched(`things/${encodeURIComponent(id)}`)) as Thing,
            ),
          );
    await upsert(
      "proof.thing",
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
      return [{ type: "proof.thing", id: said.id }];
    },
  },
});

await main(connector);
