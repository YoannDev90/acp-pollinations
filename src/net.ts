/**
 * Shared HTTP retry helpers.
 *
 * The chat stream and the model catalogue meet the same transient failures —
 * a rate limit, a proxy answering 502 while the upstream restarts, a socket
 * that resets mid-connect — and answer them the same way. The backoff lives
 * here so the two cannot drift into different notions of "worth retrying".
 */

/** Whether a failed response is worth retrying (rate limits, transient 5xx). */
export function isRetryableStatus(status: number, body: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return /too many requests|rate limit/i.test(body);
}

/** Delay before the next retry attempt. */
export function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds) * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

/** Resolves after `ms`, or rejects early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(new Error("aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      rejectPromise(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
