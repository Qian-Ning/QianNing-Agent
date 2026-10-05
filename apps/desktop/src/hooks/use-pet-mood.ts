import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../stores/app-store";
import { headPermission } from "../lib/pending-permissions";
import {
  derivePetMood,
  PET_DONE_MS,
  PET_SLEEP_MS,
  type PetMood,
} from "../lib/pet-mood";

/**
 * Subscribe to the active session's live agent state and reduce it to one pet
 * mood (D664). This is a read-only projection: it never calls a store action or
 * touches the agent. The heavy lifting is the pure `derivePetMood`; the hook
 * only gathers the snapshot, tracks the "last activity" clock for the sleep
 * timer, and re-evaluates on a coarse timer so the transient "done" window and
 * the idle→sleep transition happen without an event to hang them on.
 */
export function usePetMood(): PetMood {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const isRunning = useAppStore((s) =>
    s.activeSessionId ? (s.runningSessions[s.activeSessionId] ?? false) : false,
  );
  const activityPhase = useAppStore((s) =>
    s.activeSessionId ? s.agentStatuses[s.activeSessionId]?.activity?.phase : undefined,
  );
  const recentOutcome = useAppStore((s) =>
    s.activeSessionId ? s.sessionOutcomes[s.activeSessionId] : undefined,
  );
  const outcomeAt = useAppStore((s) =>
    s.activeSessionId ? s.latestTurnResults[s.activeSessionId]?.finishedAt : undefined,
  );
  const hasError = useAppStore((s) => Boolean(s.error));
  const hasPendingPermission = useAppStore((s) =>
    Boolean(s.activeSessionId && headPermission(s.pendingPermissions, s.activeSessionId)),
  );

  // "Last activity" resets whenever the session runs or the user switches to a
  // different conversation, so the sleep timer measures genuine quiet.
  const idleSinceRef = useRef(Date.now());
  useEffect(() => {
    idleSinceRef.current = Date.now();
  }, [activeSessionId, isRunning, hasPendingPermission]);

  // A cheap re-render pulse so time-based transitions (done→idle after
  // PET_DONE_MS, idle→sleep after PET_SLEEP_MS) fire without a store event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, []);

  return useMemo(
    () =>
      derivePetMood({
        isRunning,
        hasPendingPermission,
        activityPhase,
        hasError,
        recentOutcome,
        outcomeAt,
        idleSince: idleSinceRef.current,
        now: Date.now(),
        doneWindowMs: PET_DONE_MS,
        sleepAfterMs: PET_SLEEP_MS,
      }),
    // idleSinceRef.current is intentionally read at call time; the 1s tick and
    // these deps together cover every transition.
    [isRunning, hasPendingPermission, activityPhase, hasError, recentOutcome, outcomeAt],
  );
}
