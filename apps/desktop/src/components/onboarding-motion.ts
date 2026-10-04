/**
 * Motion helpers for the first-run checklist (design-system §8, D652).
 *
 * The tick that marks a step done is the one moment in the app that is
 * genuinely rare: a machine sees each step complete at most once, and the
 * checklist never comes back. Rare only holds if the animation follows the
 * *change*, though — a checklist that re-renders because the user walked back
 * to the empty home must not replay ticks it has already played. Both rules
 * live here as plain functions so they can be tested without a DOM.
 */

/** One step of the first-run checklist, as the host reports it. */
export type OnboardingStep = { id: string; done: boolean };

/** Ids the host currently reports as done. */
export function doneIds(steps: readonly OnboardingStep[]): Set<string> {
  const done = new Set<string>();
  for (const step of steps) {
    if (step.done) done.add(step.id);
  }
  return done;
}

/**
 * Ids that flipped to done since `previous`, in the host's order.
 *
 * `null` means "this is the first render of this mount" and returns nothing on
 * purpose: steps that were already done when the checklist appeared are not
 * news, and animating them would make the celebration replay on every visit to
 * the empty home (§8.7 — an entrance plays once, driven by a state change).
 */
export function stepsJustCompleted(
  previous: ReadonlySet<string> | null,
  steps: readonly OnboardingStep[],
): string[] {
  if (previous === null) return [];
  const done = doneIds(steps);
  return [...done].filter((id) => !previous.has(id));
}

/**
 * How long the departing ring runs. The component clears its celebration flag
 * after this, so the ring has to be the longest of the three tick animations.
 */
export const ONBOARDING_RING_MS = 520;
