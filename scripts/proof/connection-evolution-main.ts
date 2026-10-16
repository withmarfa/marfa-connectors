import { proveConnectionEvolution } from "./connection-evolution.js";
import { ProofServer } from "./server.js";

const server = new ProofServer();
let booting: Promise<unknown> = Promise.resolve();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void booting
    .catch(() => undefined)
    .then(() => server.stop())
    .finally(() => process.exit(1));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const boot = server.boot();
  booting = boot;
  const { url, commit } = await boot;
  console.log(`Connection evolution proof server ${commit}`);
  await proveConnectionEvolution(
    url,
    (body) => server.mintKey(body),
    (id, body) => server.updateKey(id, body),
  );
} finally {
  await server.stop();
}
