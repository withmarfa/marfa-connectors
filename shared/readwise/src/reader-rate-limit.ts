const windowMs = 60_000;
const requestsPerWindow = 20;
const starts = new Map<string, number[]>();

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Reader LIST wait canceled"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** LIST and direct lookups share Reader's per-token budget across clients. */
export async function readerListPermit(
  token: string,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const now = performance.now();
    for (const [key, requests] of starts)
      if ((requests.at(-1) ?? 0) <= now - windowMs) starts.delete(key);
    const requests = (starts.get(token) ?? []).filter(
      (start) => start > now - windowMs,
    );
    starts.set(token, requests);
    if (requests.length < requestsPerWindow) {
      requests.push(now);
      return;
    }
    // No future permit is reserved: a canceled waiter consumes no budget.
    await sleep((requests[0] ?? now) + windowMs - now + 1, signal);
  }
}
