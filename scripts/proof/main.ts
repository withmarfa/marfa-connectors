import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONTRACT_VERSION, createClient } from "@withmarfa/client";
import {
  check,
  Failed,
  interrupt,
  interrupted,
  statementsHeld,
} from "./check.js";
import { witnessTypeAnswers } from "./connector.js";
import { proveInbound } from "./inbound.js";
import { proveRss } from "./rss.js";
import { proveTodoist } from "./todoist.js";
import { proveTracker } from "./tracker.js";
import { ProofServer, type Booted } from "./server.js";

/**
 * Every statement the proof makes, so one dropped or skipped leaves the
 * proof short, and a short proof fails.
 */
const statements = 52;

const server = new ProofServer();
let booting: Promise<unknown> = Promise.resolve();
let stopping = false;

// Armed before the boot, and kept armed: a signal during the boot waits for
// it to settle, so the server it started is the one stopped, and a second
// signal while that happens must not end the process with the server up.
const onSignal = (signal: NodeJS.Signals): void => {
  interrupt();
  if (stopping) return;
  stopping = true;
  console.log(`stopping on ${signal}`);
  void booting
    .catch(() => undefined)
    .then(() => server.stop())
    .finally(() => process.exit(1));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  const pin = (
    await readFile(
      resolve(import.meta.dirname, "../../monorepo.commit"),
      "utf8",
    )
  ).trim();
  let booted: Booted | undefined;
  await check("the pinned server boots", async () => {
    const boot = server.boot();
    booting = boot;
    booted = await boot;
    if (booted.commit !== pin) {
      throw new Error(`the checkout is at ${booted.commit}, the pin is ${pin}`);
    }
    return `monorepo ${booted.commit}, ${booted.url}`;
  });
  if (booted === undefined) throw new Error("the boot answered nothing");
  const marfa = createClient({ baseUrl: booted.url, credential: booted.key });

  await check("the server speaks the client's contract", async () => {
    const { data } = await marfa.GET("/");
    if (data === undefined) throw new Error("the root was refused");
    if (data.contract !== CONTRACT_VERSION) {
      throw new Error(
        `contract ${String(data.contract)}, client ${String(CONTRACT_VERSION)}`,
      );
    }
    if (!data.features.includes("connectors")) {
      throw new Error(
        `features ${data.features.join(", ")} name no connectors`,
      );
    }
    return `contract ${String(data.contract)}, features include connectors`;
  });

  await check(
    "the server answers a type's parent, its fields and its compatible_with",
    () => witnessTypeAnswers(marfa),
  );

  await proveRss(marfa, booted.url);
  await proveTodoist(marfa, booted.url);
  await proveInbound(marfa, booted.url);
  await proveTracker(marfa, booted.url);
  if (statementsHeld() !== statements) {
    throw new Error(
      `${String(statementsHeld())} statements held, where the proof makes ${String(statements)}`,
    );
  }
  console.log(`ok   all ${String(statements)} statements held`);
} catch (error) {
  // A statement that failed has said so; anything else has not.
  if (!(error instanceof Failed) && !interrupted()) {
    console.log(
      `FAIL the proof: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
} finally {
  await server.stop();
}
