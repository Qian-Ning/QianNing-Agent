/**
 * A CDP capture can hang forever when the guest stalls or the session is torn
 * down mid-flight, and a screenshot that never settles blocks the caller with
 * no way back. Race every capture against a deadline instead: the deadline
 * rejects with a `TIMEOUT`-coded error and runs `onTimeout`, which detaches the
 * CDP session so the next capture rebuilds it rather than reusing a stuck one.
 */
export const BROWSER_SCREENSHOT_TIMEOUT_MS = 30_000;

export function withScreenshotDeadline<T>(
  capture: () => Promise<T>,
  onTimeout: () => void,
  timeoutMs: number = BROWSER_SCREENSHOT_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = Object.assign(
        new Error(`browser screenshot timed out after ${timeoutMs}ms`),
        { code: "TIMEOUT" },
      );
      reject(error);
      try {
        onTimeout();
      } catch {
        // Preserve the timeout result if the guest is already shutting down.
      }
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(capture), timedOut]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
