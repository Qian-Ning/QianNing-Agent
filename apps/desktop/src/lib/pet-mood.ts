/**
 * Pure state → mood mapping for the desktop companion ("千凝" pet, D633).
 *
 * The pet is a passive mirror of the active session's agent state. Keeping the
 * decision here — a pure function over a plain snapshot — is what lets it be
 * unit-tested without a renderer, a store, or a running agent (AGENTS.md §12).
 * The hook (`use-pet-mood`) collects the snapshot from the store and supplies
 * `now`; this module owns the rules and the timing constants.
 */

export type PetMood =
  | "idle"
  | "thinking"
  | "working"
  | "done"
  | "error"
  | "permission"
  | "sleep";

/**
 * Runtime activity phases (see `AgentActivity` in shared) that mean the agent
 * is waiting on the model or housekeeping rather than actively running a tool.
 * These read as "thinking"; an absent phase or a subagent wait reads as
 * "working" because the turn is doing visible work.
 */
export const THINKING_PHASES: ReadonlySet<string> = new Set([
  "starting",
  "waiting-model",
  "preparing",
  "compacting",
  "recovering",
  "retrying",
]);

/** How long the transient "done" celebration stays up after a turn completes. */
export const PET_DONE_MS = 3200;
/** Idle time with no run and no interaction before the pet falls asleep. */
export const PET_SLEEP_MS = 90_000;

export type PetMoodInput = {
  /** The visible session is running a turn. */
  isRunning: boolean;
  /** A permission request is waiting on the user for the visible session. */
  hasPendingPermission: boolean;
  /** `agentStatuses[active].activity?.phase`, when a turn is active. */
  activityPhase?: string;
  /** An unresolved error is shown for the visible session. */
  hasError: boolean;
  /** Latest terminal outcome for the visible session. */
  recentOutcome?: "completed" | "failed";
  /** When that outcome landed (epoch ms); gates the transient done window. */
  outcomeAt?: number;
  /** Epoch ms of the last run/interaction; gates the sleep timer. */
  idleSince?: number;
  now: number;
  /** Overridable for tests. */
  doneWindowMs?: number;
  sleepAfterMs?: number;
};

/**
 * Resolve the pet's mood from a state snapshot. Priority, highest first:
 * a permission block (the agent is stuck on the user) → the live run
 * (thinking vs working) → a shown error → a just-finished turn (transient
 * celebration) → a long idle (sleep) → plain idle.
 */
export function derivePetMood(input: PetMoodInput): PetMood {
  const {
    isRunning,
    hasPendingPermission,
    activityPhase,
    hasError,
    recentOutcome,
    outcomeAt,
    idleSince,
    now,
    doneWindowMs = PET_DONE_MS,
    sleepAfterMs = PET_SLEEP_MS,
  } = input;

  if (hasPendingPermission) return "permission";

  if (isRunning) {
    if (activityPhase && THINKING_PHASES.has(activityPhase)) return "thinking";
    return "working";
  }

  if (hasError) return "error";

  if (
    recentOutcome === "completed" &&
    outcomeAt !== undefined &&
    now - outcomeAt < doneWindowMs
  ) {
    return "done";
  }

  if (idleSince !== undefined && now - idleSince >= sleepAfterMs) {
    return "sleep";
  }

  return "idle";
}

/** The seven shipping animation clips; the pet plays one looping WebP per mood. */
export type PetAnim =
  | "idle"
  | "thinking"
  | "working"
  | "success"
  | "error"
  | "sleep"
  | "searching";

/**
 * Mood → animation clip. Each clip is a foot-aligned transparent WebP rendered
 * from the mascot state videos. `done` reuses the celebratory `success` clip,
 * and `permission` reuses `searching` (the fox looks around / toward the user),
 * since that reads best as "waiting on you" among the available clips.
 */
export const PET_MOOD_ANIM: Record<PetMood, PetAnim> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  done: "success",
  error: "error",
  permission: "searching",
  sleep: "sleep",
};
