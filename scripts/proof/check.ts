/**
 * One statement of the proof: printed with what it observed when it holds,
 * and thrown when it does not, because every later statement stands on the
 * ones before it.
 */
export async function check(
  statement: string,
  observe: () => Promise<string>,
): Promise<void> {
  let observed: string;
  try {
    observed = await observe();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${statement}: ${reason}`);
    throw error;
  }
  console.log(`ok   ${statement}: ${observed}`);
}
