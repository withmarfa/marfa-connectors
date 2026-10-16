import { createClient } from "@withmarfa/client";
import { ProofServer } from "./server.js";
import { statementsHeld } from "./check.js";
import { proveReadwiseReader } from "./readwise-reader.js";
const statements = 12;
const server = new ProofServer();
let booting: Promise<unknown> = Promise.resolve();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void booting
      .catch(() => undefined)
      .then(() => server.stop())
      .finally(() => process.exit(1));
  });
try {
  const boot = server.boot();
  booting = boot;
  const instance = await boot;
  console.log(`Reader fixture proof server ${instance.commit}`);
  const admin = createClient({
    baseUrl: instance.url,
    credential: instance.key,
  });
  await proveReadwiseReader(
    admin,
    instance.url,
    (body) => server.mintKey(body),
    (id, body) => server.updateKey(id, body),
  );
  if (statementsHeld() !== statements)
    throw new Error(
      `${String(statementsHeld())} Reader statements held; expected ${String(statements)}`,
    );
  console.log(`ok   all ${String(statements)} Reader statements held`);
} finally {
  await server.stop();
}
