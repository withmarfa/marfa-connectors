import type { Connector, EnvDeclaration } from "./define.js";
import { nodeRuntime, type Runtime } from "./runtime.js";

/** Runs the connector as the arguments say and answers the exit code. */
export function start<E extends EnvDeclaration>(
  connector: Connector<E>,
  runtime: Runtime,
): Promise<number> {
  void connector;
  void runtime;
  return Promise.reject(new Error("not built"));
}

export async function main<E extends EnvDeclaration>(
  connector: Connector<E>,
): Promise<void> {
  process.exitCode = await start(connector, nodeRuntime());
}
