import { CONTRACT_VERSION, createClient } from "@withmarfa/client";
import { check, interrupt } from "./check.js";
import { ProofServer, type Booted } from "./server.js";

const server = new ProofServer();
let booting: Promise<unknown> = Promise.resolve();

// Armed before the boot: a signal during it waits for the boot to settle,
// so the server it started is the one stopped.
const onSignal = (signal: NodeJS.Signals): void => {
  interrupt();
  console.log(`stopping on ${signal}`);
  void booting
    .catch(() => undefined)
    .then(() => server.stop())
    .finally(() => process.exit(1));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  let booted: Booted | undefined;
  await check("the pinned server boots", async () => {
    const boot = server.boot();
    booting = boot;
    booted = await boot;
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
} catch {
  process.exitCode = 1;
} finally {
  await server.stop();
}
