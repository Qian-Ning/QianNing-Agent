/**
 * Presentation math for the usage dashboard's monthly spend ceiling (D657).
 *
 * Pure and framework-free: no React, no DOM, no fetch. The persisted shape and
 * its accepted range live in `@pi-desktop/shared` (`usage-budget.ts`); this
 * module turns a ceiling and a month-to-date figure into the words and numbers
 * the card shows, so the arithmetic is unit-testable on its own.
 */
import { isValidUsageBudgetUsd } from "@pi-desktop/shared";

/**
 * Where the month sits against its ceiling.
 *
 * `approaching` exists because a ceiling that only speaks at 100% arrives too
 * late to act on: at four fifths spent there is still a decision to make.
 */
export type BudgetLevel = "none" | "ok" | "approaching" | "over";

/** Share of the ceiling at which the card starts warning. */
export const APPROACHING_BUDGET_RATIO = 0.8;

/**
 * The smallest amount of money the dashboard treats as real.
 *
 * Prices are per-million-token rates, so a tenth of a microdollar is rounding
 * noise, not spend. Without this, summing floats can put a month that spent
 * exactly its ceiling a hair *over* it and make the card claim a deficit of
 * ``.00``.
 */
export const BUDGET_EPSILON_USD = 1e-6;

export type BudgetState = {
  level: BudgetLevel;
  /** Spend / ceiling, clamped to 0–1 so a progress bar cannot overrun. */
  ratio: number;
  /** Uncapped ratio, so a caller can print "137%" without recomputing. */
  rawRatio: number;
  spentUsd: number;
  /** `null` when no ceiling is set. */
  ceilingUsd: number | null;
  /** Spend left before the ceiling; `null` when there is no ceiling. */
  remainingUsd: number | null;
  /** Spend beyond the ceiling; 0 until it is crossed. */
  overspendUsd: number;
};

/**
 * Grade a month-to-date figure against a ceiling.
 *
 * A spent figure is never negative — a refund or a clock skew would otherwise
 * read as headroom that does not exist. A ceiling of zero or below is treated
 * as no ceiling rather than as instantly over: the host and both front ends
 * refuse such a value, so reaching here means the store was hand-edited, and
 * "no budget" is the honest reading of a number that cannot be a budget.
 */
export function budgetState(spentUsd: number, ceilingUsd: number | null): BudgetState {
  const spent = Number.isFinite(spentUsd) ? Math.max(0, spentUsd) : 0;
  if (ceilingUsd === null || !isValidUsageBudgetUsd(ceilingUsd)) {
    return {
      level: "none",
      ratio: 0,
      rawRatio: 0,
      spentUsd: spent,
      ceilingUsd: null,
      remainingUsd: null,
      overspendUsd: 0,
    };
  }
  const rawRatio = spent / ceilingUsd;
  const difference = ceilingUsd - spent;
  const beyond = difference < -BUDGET_EPSILON_USD;
  const level: BudgetLevel = beyond
    ? "over"
    : rawRatio >= APPROACHING_BUDGET_RATIO
      ? "approaching"
      : "ok";
  return {
    level,
    ratio: Math.min(1, Math.max(0, rawRatio)),
    rawRatio,
    spentUsd: spent,
    ceilingUsd,
    remainingUsd: beyond ? 0 : Math.max(0, difference),
    overspendUsd: beyond ? -difference : 0,
  };
}

/** What a typed ceiling field means, before it is saved. */
export type BudgetInput = { kind: "clear" } | { kind: "amount"; usd: number } | { kind: "invalid" };

/**
 * Read a ceiling out of a text field.
 *
 * An empty field clears the ceiling rather than being invalid — that is the
 * only way a keyboard user can remove one. A comma is accepted as a decimal
 * separator, because half the shipped locales write `12,50`. The parser is
 * strict about the rest: a trailing `$`, a thousands separator, or a partial
 * exponent is a typo the user wants to see rejected, not silently reinterpreted.
 */
export function parseBudgetInput(raw: string): BudgetInput {
  const text = raw.trim();
  if (text === "") return { kind: "clear" };
  const normalized = text.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { kind: "invalid" };
  const usd = Number(normalized);
  if (!isValidUsageBudgetUsd(usd)) return { kind: "invalid" };
  return { kind: "amount", usd };
}

/**
 * The month the ceiling is measured over, spelled in the reader's language.
 *
 * The host hands back the local start of the month, so this only formats.
 * `Intl` with an explicit locale is used instead of the i18n catalog because a
 * month name is data, not copy: a translator would have to add twelve keys per
 * language to say what the platform already knows.
 */
export function monthLabel(monthStart: number, locale: string): string {
  const date = new Date(monthStart);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date);
  } catch {
    // An unknown locale tag must not take the page down with it.
    return new Intl.DateTimeFormat("en", { year: "numeric", month: "long" }).format(date);
  }
}
