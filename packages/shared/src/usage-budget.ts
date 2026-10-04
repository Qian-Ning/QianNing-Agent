/**
 * The usage dashboard's monthly spend ceiling (D657).
 *
 * This is a display preference and nothing else: the runtime never reads it,
 * reaching the ceiling blocks no turn, and clearing it costs nothing. It exists
 * so the dashboard can answer "am I over budget this month?" against the same
 * priced-turn ledger it already reports.
 *
 * Three boundaries normalize through here — the renderer, the Electron main
 * process, and the Rust host — so the accepted range and the canonical shape
 * are defined once. A value inside the range is kept; anything else is replaced
 * by "no ceiling", because a stale ceiling is worse than none.
 */

/** A ceiling below one cent cannot be spent against. */
export const MIN_USAGE_BUDGET_USD = 0.01;

/** Above this the entry is a typo, not a budget. */
export const MAX_USAGE_BUDGET_USD = 100_000_000;

/** `settings.usageBudget`. */
export type UsageBudgetSettings = {
  /**
   * Ceiling in USD for one local calendar month. `null` means no ceiling: the
   * dashboard shows no progress bar and raises no alert.
   */
  monthlyUsd: number | null;
};

/** The canonical "no ceiling" value, and what an unusable entry decays to. */
export const NO_USAGE_BUDGET: UsageBudgetSettings = { monthlyUsd: null };

/**
 * Whether one `monthlyUsd` is usable: `null` (no ceiling), or a finite number
 * inside the accepted range.
 *
 * Rejects `NaN` and the infinities explicitly — both survive `typeof ===
 * "number"` and would poison every comparison the dashboard makes, so a check
 * that only asked "is it a number?" would let them through.
 */
export function isValidUsageBudgetUsd(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return value >= MIN_USAGE_BUDGET_USD && value <= MAX_USAGE_BUDGET_USD;
}

/**
 * Keep only the fields this preference defines, with a usable value.
 *
 * An absent section stays absent — the dashboard reads absence as "no ceiling"
 * and there is no reason to write a key the user never set. A present section
 * always comes back in the canonical shape, so a caller can rely on
 * `monthlyUsd` existing once the object does.
 */
export function normalizeUsageBudget(value: unknown): UsageBudgetSettings | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return { ...NO_USAGE_BUDGET };
  const monthly = (value as { monthlyUsd?: unknown }).monthlyUsd;
  return isValidUsageBudgetUsd(monthly)
    ? { monthlyUsd: monthly === null ? null : (monthly as number) }
    : { ...NO_USAGE_BUDGET };
}

/**
 * The ceiling a stored section asks for, or `null` when none applies.
 *
 * One reader for both shapes: an absent section, a `null` section, and a
 * section whose amount did not survive normalization all mean the same thing to
 * the dashboard.
 */
export function usageBudgetCeiling(value: unknown): number | null {
  const normalized = normalizeUsageBudget(value);
  const monthly = normalized?.monthlyUsd;
  return typeof monthly === "number" ? monthly : null;
}
