import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
  const pin = (
    await readFile(
      resolve(import.meta.dirname, "../../monorepo.commit"),
      "utf8",
    )
  ).trim();
  assert.equal(
    commit,
    pin,
    "The proof server does not match the committed pin",
  );
  console.log(`Connection evolution proof server ${commit}`);
  await proveConnectionEvolution(
    url,
    (body) => server.mintKey(body),
    (id, body) => server.updateKey(id, body),
  );
} finally {
  await server.stop();
}
