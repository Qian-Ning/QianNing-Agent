/**
 * Delegation timing.
 *
 * `createdAt` is when the `Task` call went out; `toolCompletedAt` is stamped when
 * it came back. Both already ride on the message, so a card needs no new field —
 * only the arithmetic, kept out of the components so it can be tested directly.
 */

/**
 * Milliseconds a call has been running, or `undefined` when it cannot be known.
 *
 * A missing or unparseable `startedAt` yields `undefined` rather than `0`: an
 * absent timestamp must not render as "0s", which would read as "just started"
 * instead of "unknown".
 */
export function elapsedBetween(
  startedAt?: string,
  endedAt?: string,
  now: number = Date.now(),
): number | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = endedAt ? Date.parse(endedAt) : now;
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/** Compact enough for one chip: 4s, 1m 07s, 2h 03m. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
