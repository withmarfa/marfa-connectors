let signaled = false;
let held = 0;

/** Marks the proof as told to stop, so what that interrupts is not reported. */
export function interrupt(): void {
  signaled = true;
}

/** Read through a call, since a signal can arrive while a statement waits. */
export function interrupted(): boolean {
  return signaled;
}

/** A statement that did not hold, already reported as it failed. */
export class Failed extends Error {}

/**
 * One statement of the proof: printed with what it observed when it holds,
 * and thrown when it does not, because every later statement stands on the
 * ones before it. Once the proof is told to stop, no statement is reported
 * either way.
 */
export async function check(
  statement: string,
  observe: () => Promise<string> | string,
): Promise<void> {
  if (interrupted()) throw new Error("stopped before this statement");
  let observed: string;
  try {
    observed = await observe();
  } catch (error) {
    if (interrupted()) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${statement}: ${reason}`);
    throw new Failed(statement, { cause: error });
  }
  if (interrupted()) throw new Error("stopped during this statement");
  console.log(`ok   ${statement}: ${observed}`);
  held += 1;
}

/** How many statements have held so far. */
export function statementsHeld(): number {
  return held;
}
