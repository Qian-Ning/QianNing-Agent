/**
 * Whether the first-run screens have been shown.
 *
 * Kept in local storage beside the other per-device choices, and versioned so a
 * future flow that asks something new can run again without wiping the rest of
 * the app's state.
 */
const KEY = "qn.onboarding.v1";

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    // Private mode with storage disabled: showing it is safer than hiding it.
    return false;
  }
}

export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    // Nothing to recover: the screens simply appear next launch.
  }
}
