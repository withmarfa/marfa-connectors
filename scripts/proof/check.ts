let signaled = false;
let held = 0;

export function interrupt(): void {
  signaled = true;
}

// A function so `check` re-reads `signaled` after each await; TypeScript
// would otherwise narrow it to false.
export function interrupted(): boolean {
  return signaled;
}

export class Failed extends Error {}

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

export function statementsHeld(): number {
  return held;
}
