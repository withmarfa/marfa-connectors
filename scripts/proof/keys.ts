import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  keyBody,
  lastRun,
  type Minted,
} from "./connector.js";
import { serveThings } from "./inbound.js";

const entry = resolve(import.meta.dirname, "inbound-connector.js");

/** A key for the inbound connector, whose source is `proof-inbound`. */
async function mint(
  marfa: MarfaClient,
  source: string,
  sources: string[],
): Promise<Minted> {
  const { data, error } = await marfa.POST("/keys", {
    body: {
      ...keyBody({ label: source, source, typePermission: "proof.thing" }),
      sources,
    },
  });
  if (data === undefined)
    throw new Error(`the key was refused: ${JSON.stringify(error)}`);
  return data;
}

async function update(
  marfa: MarfaClient,
  id: string,
  body: { sources?: string[]; metadata_permissions?: Record<string, "read"> },
): Promise<void> {
  const { error, response } = await marfa.PATCH("/keys/{id}", {
    params: { path: { id } },
    body,
  });
  if (!response.ok)
    throw new Error(`the update was refused: ${JSON.stringify(error)}`);
}

function lineOf(output: string, said: string): string {
  return (
    output
      .split("\n")
      .find((line) => line.includes(said))
      ?.trim() ?? ""
  );
}

export async function proveKeys(
  marfa: MarfaClient,
  url: string,
  operator: MarfaClient,
): Promise<void> {
  const vendor = await serveThings();
  try {
    const runner = (key: Minted): ConnectorUnderProof =>
      new ConnectorUnderProof(
        "proof-inbound",
        url,
        key.key,
        {
          PROOF_VENDOR_URL: vendor.url,
          PROOF_WEBHOOK_SECRET: "proof-webhook-secret-value",
        },
        entry,
      );

    // Only the operator key grants a claim on a source a caller does not
    // hold, and the boot hands the proof a working key, which grants its own
    // source and its claims. So the connector's key goes, freeing its source,
    // and a key of that source claiming the boot key's own mints the rest. A
    // mint passes on no permission its minter lacks, so it holds
    // schema.write too.
    let minter = marfa;
    let elsewhere = "";
    await check(
      "keys: the connector's source is taken over by a key that may mint keys claiming it and one other source",
      async () => {
        const current = await marfa.GET("/keys/current");
        const listed = await marfa.GET("/keys");
        const inbound = listed.data?.data.find(
          (key) => key.source === "proof-inbound",
        );
        if (current.data === undefined || inbound === undefined)
          throw new Error("the boot key or the connector's key is not listed");
        elsewhere = current.data.source;
        const revoked = await marfa.DELETE("/keys/{id}", {
          params: { path: { id: inbound.id } },
        });
        if (!revoked.response.ok) throw new Error("the revoke was refused");
        const { data, error } = await marfa.POST("/keys", {
          body: {
            ...keyBody({
              label: "proof-inbound-minter",
              source: "proof-inbound",
              typePermission: "proof.thing",
            }),
            sources: [elsewhere],
            permissions: ["keys.mint", "schema.write"],
          },
        });
        if (data === undefined)
          throw new Error(`the minter was refused: ${JSON.stringify(error)}`);
        minter = createClient({ baseUrl: url, credential: data.key });
        return `revoked ${inbound.id}; ${data.id} holds proof-inbound and claims ${elsewhere}`;
      },
    );

    await check(
      "keys: a key that may mint keys and does not hold schema.write cannot mint a connector's key, which does",
      async () => {
        const { data: narrow, error } = await marfa.POST("/keys", {
          body: {
            ...keyBody({
              label: "proof-mint-narrow",
              source: "proof-mint-narrow",
              typePermission: "proof.thing",
            }),
            permissions: ["keys.mint"],
          },
        });
        if (narrow === undefined)
          throw new Error(`the minter was refused: ${JSON.stringify(error)}`);
        const narrowMinter = createClient({
          baseUrl: url,
          credential: narrow.key,
        });
        const refused = await narrowMinter.POST("/keys", {
          body: keyBody({
            label: "proof-mint-narrow-child",
            source: "proof-mint-narrow-child",
            typePermission: "proof.thing",
          }),
        });
        await marfa.DELETE("/keys/{id}", {
          params: { path: { id: narrow.id } },
        });
        const said = JSON.stringify(refused.error);
        if (refused.response.status !== 403 || !said.includes("schema.write")) {
          throw new Error(
            `answered ${String(refused.response.status)}: ${said}`,
          );
        }
        return `403: ${said}`;
      },
    );

    let second: Minted | undefined;
    await check(
      "keys: a second account's key, of its own source and claiming the connector's, starts, and is told types=write is no longer needed",
      async () => {
        second = await mint(minter, "proof-inbound-second", ["proof-inbound"]);
        const { code, output } = await runner(second).once();
        const warned = lineOf(output, "no longer needs metadata types=write");
        if (
          code !== 0 ||
          !warned.includes(
            `marfa keys update ${second.id} --metadata-permission types=read`,
          )
        ) {
          throw new Error(`exited ${String(code)}: ${output}`);
        }
        return `exited 0, warning: ${warned.slice(warned.indexOf("every"))}`;
      },
    );

    await check(
      "keys: narrowed as the warning says, the server keeps the key's other reach and the connector starts without the warning",
      async () => {
        if (second === undefined) throw new Error("no second key");
        await update(minter, second.id, {
          metadata_permissions: { types: "read" },
        });
        const { data } = await minter.GET("/keys");
        const held = data?.data.find((key) => key.id === second?.id);
        const { code, output } = await runner(second).once();
        if (
          code !== 0 ||
          output.includes("--metadata-permission") ||
          JSON.stringify(held?.metadata_permissions) !== '{"types":"read"}' ||
          JSON.stringify(held?.type_permissions) !==
            '{"proof.thing":"write"}' ||
          JSON.stringify(held?.sources) !== '["proof-inbound"]'
        ) {
          throw new Error(
            `exited ${String(code)}, key ${JSON.stringify(held)}: ${output}`,
          );
        }
        return `metadata ${JSON.stringify(held?.metadata_permissions)}, type ${JSON.stringify(held?.type_permissions)}, claims ${JSON.stringify(held?.sources)}; exited 0 with no warning`;
      },
    );

    await check(
      "keys: a key claiming a source besides the connector's is refused at start, naming it and how to narrow, and starts once narrowed so",
      async () => {
        const wide = await mint(minter, "proof-inbound-wide", [
          "proof-inbound",
          elsewhere,
        ]);
        const refused = await runner(wide).once();
        const error = (await lastRun(operator, wide.id)).error ?? "";
        const narrow = `marfa keys update ${wide.id} --claim proof-inbound`;
        if (
          refused.code !== 1 ||
          !error.includes(`refused: ${elsewhere}.`) ||
          !error.includes(narrow)
        ) {
          throw new Error(
            `exited ${String(refused.code)}, reported ${error}: ${refused.output}`,
          );
        }
        await update(minter, wide.id, { sources: ["proof-inbound"] });
        const narrowed = await runner(wide).once();
        if (narrowed.code !== 0) {
          throw new Error(
            `narrowed, it exited ${String(narrowed.code)}: ${narrowed.output}`,
          );
        }
        return `exited 1, reporting: ${error}; narrowed, exited 0`;
      },
    );

    await check(
      "keys: a key of another source claiming nothing is refused at start, saying how to claim the connector's, and starts once it claims it",
      async () => {
        const foreign = await mint(minter, "proof-foreign", []);
        const refused = await runner(foreign).once();
        const error = (await lastRun(operator, foreign.id)).error ?? "";
        if (
          refused.code !== 1 ||
          !error.includes("own source proof-foreign") ||
          !error.includes(
            `marfa keys update ${foreign.id} --claim proof-inbound`,
          )
        ) {
          throw new Error(
            `exited ${String(refused.code)}, reported ${error}: ${refused.output}`,
          );
        }
        await update(minter, foreign.id, { sources: ["proof-inbound"] });
        const claimed = await runner(foreign).once();
        if (claimed.code !== 0) {
          throw new Error(
            `claiming it, it exited ${String(claimed.code)}: ${claimed.output}`,
          );
        }
        return `exited 1, reporting: ${error}; claiming it, exited 0`;
      },
    );
  } finally {
    await vendor.close();
  }
}
