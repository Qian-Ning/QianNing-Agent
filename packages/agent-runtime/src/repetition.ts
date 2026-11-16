/**
 * Repetition detection: is the model spinning in place?
 *
 * A degraded model repeats itself character for character — a template token, a
 * paragraph, a line — regardless of what the content is. So this looks only at
 * structure: a substring repeated verbatim with an exact period. Lists with
 * increasing numbers and tables whose rows differ do not qualify.
 *
 * Two consumers: the streaming guard (stop a reply that is already looping) and
 * the compaction gate (never store a looping summary as the conversation's
 * memory).
 */

export interface RepetitionHit {
  /** Where the repeated region starts, counting its first copy. */
  start: number;
  /** Length of the repeated unit, in characters. */
  period: number;
  /** Total length of the repeated region, in characters. */
  span: number;
}

/** The longest unit still recognised as a repetition: a paragraph fits inside. */
const MAX_PERIOD = 1000;

/**
 * Two thresholds, either one enough. Both are stated in characters rather than
 * "lines" because CJK text packs a sentence into a fraction of an English one.
 *
 *  - the same paragraph at least 4 times, 250+ characters in a row;
 *  - the same short unit at least 10 times, 200+ characters in a row.
 *
 * Calibrated against ~21k real model outputs (replies, thinking, tool arguments)
 * with zero hits: numbered lists, per-row status tables and 64-zero hex runs all
 * stayed below the bar.
 */
const RULES: readonly { minSpan: number; minCount: number }[] = [
  { minSpan: 250, minCount: 4 },
  { minSpan: 200, minCount: 10 },
];

function qualifies(span: number, period: number): boolean {
  return RULES.some((rule) => span >= rule.minSpan && span / period >= rule.minCount);
}

/** Shortest region a unit of this period must cover to count as repetition. */
function minSpanFor(period: number): number {
  return Math.min(...RULES.map((rule) => Math.max(rule.minSpan, rule.minCount * period)));
}

/**
 * The longest repeated region anywhere in the text, or null.
 *
 * For each candidate period, `run` counts characters matching the text one
 * period back; the region is that run plus its first copy.
 */
export function findRepetition(text: string): RepetitionHit | null {
  const length = text.length;
  const maxPeriod = Math.min(MAX_PERIOD, Math.floor(length / 2));
  let best: RepetitionHit | null = null;
  for (let period = 1; period <= maxPeriod; period += 1) {
    let run = 0;
    for (let index = period; index <= length; index += 1) {
      if (index < length && text.charCodeAt(index) === text.charCodeAt(index - period)) {
        run += 1;
        continue;
      }
      if (run > 0) {
        const span = run + period;
        if (qualifies(span, period) && (!best || span > best.span)) {
          best = { start: index - span, period, span };
        }
        run = 0;
      }
    }
  }
  return best;
}

/**
 * Whether the text is repeating *right now*, at its end.
 *
 * Only the region that ends the text is considered, and the smallest qualifying
 * period wins, so the caller can cut the reply at `start`. Ordinary text costs
 * about MAX_PERIOD comparisons per period tried and stops at the first mismatch.
 */
export function trailingRepetition(text: string): RepetitionHit | null {
  const length = text.length;
  const maxPeriod = Math.min(MAX_PERIOD, Math.floor(length / 2));
  for (let period = 1; period <= maxPeriod; period += 1) {
    const needed = minSpanFor(period) - period;
    if (needed > length - period) continue;
    let run = 0;
    while (
      run < needed &&
      text.charCodeAt(length - 1 - run) === text.charCodeAt(length - 1 - run - period)
    ) {
      run += 1;
    }
    if (run < needed) continue;
    while (
      run < length - period &&
      text.charCodeAt(length - 1 - run) === text.charCodeAt(length - 1 - run - period)
    ) {
      run += 1;
    }
    return { start: length - run - period, period, span: run + period };
  }
  return null;
}

/** How much new text accumulates before the tail is checked again. */
const WATCH_STEP = 32;

/**
 * How much of the tail the guard keeps. A qualifying region spans at most
 * `minSpanFor(MAX_PERIOD)` characters, so a guard that keeps that much can still
 * see it when the whole tail is looping.
 */
const WATCH_TAIL = 4096;

/**
 * A streaming guard: feed it text as it arrives, get a hit when the reply has
 * started looping.
 *
 * One guard per channel — the reply and the reasoning trail each get their own,
 * because a repeat in either is a degraded model. The returned offsets are
 * relative to the guard's retained tail; call `trailingRepetition` on the full
 * text to learn where to cut.
 */
export function watchRepetition(): (delta: string) => RepetitionHit | null {
  let tail = "";
  let pending = 0;
  return (delta) => {
    tail += delta;
    pending += delta.length;
    if (tail.length > WATCH_TAIL * 2) tail = tail.slice(-WATCH_TAIL);
    if (pending < WATCH_STEP) return null;
    pending = 0;
    return trailingRepetition(tail);
  };
}
