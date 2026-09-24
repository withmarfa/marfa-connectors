/** Set when the proof is told to stop, so what that interrupts is not reported as a failure. */
export const interruption = { signalled: false };

/**
 * One statement of the proof: printed with what it observed when it holds,
 * and thrown when it does not, because every later statement stands on the
 * ones before it.
 */
export async function check(
  statement: string,
  observe: () => Promise<string>,
): Promise<void> {
  if (interruption.signalled) throw new Error("stopped before this statement");
  let observed: string;
  try {
    observed = await observe();
  } catch (error) {
    if (!interruption.signalled) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${statement}: ${reason}`);
    }
    throw error;
  }
  console.log(`ok   ${statement}: ${observed}`);
}
