import { CONTRACT_VERSION, createClient } from "@withmarfa/client";
import { check } from "./check.js";
import { bootServer } from "./server.js";

const server = await bootServer();
const stopOnSignal = (): void => {
  void server.stop().finally(() => process.exit(1));
};
process.once("SIGINT", stopOnSignal);
process.once("SIGTERM", stopOnSignal);

try {
  console.log(`server at monorepo ${server.commit}, ${server.url}`);
  const marfa = createClient({ baseUrl: server.url, credential: server.key });

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
