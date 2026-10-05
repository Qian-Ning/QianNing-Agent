import { useEffect, useState } from "react";
import { elapsedBetween, formatElapsed } from "../lib/subagent-elapsed";

/**
 * Elapsed time that keeps ticking while the call is in flight.
 *
 * The interval exists only while `running`: a settled transcript leaves no timer
 * behind, which matters because this hook sits on every tool row (D302 follow
 * scrolling already keeps those rows live, and a second always-on ticker per row
 * would be pure cost).
 */
export function useElapsedLabel(
  startedAt?: string,
  endedAt?: string,
  running = false,
): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const ms = elapsedBetween(startedAt, endedAt, now);
  return ms === undefined ? "" : formatElapsed(ms);
}
