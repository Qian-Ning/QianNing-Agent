import type {
  TokenUsageBucket,
  TokenUsageHistoryItem,
  TokenUsageHistoryResult,
  UsageBreakdownResult,
} from "@pi-desktop/shared";

/**
 * Pure presentation math for the usage dashboard.
 *
 * Everything here takes the payloads the host already returns and produces
 * either a value or a string. There is no React, no DOM, and no clock read
 * beyond the explicit arguments, so each function is directly testable and the
 * page stays a rendering surface.
 */

/** One day in the calendar heatmap, in the dense order the grid renders. */
export type HeatmapCell = {
  /** Local `YYYY-MM-DD`, matching the host's bucket key. */
  date: string;
  tokens: number;
  /** 0 = Sunday … 6 = Saturday, from the `YYYY-MM-DD` key. */
  weekday: number;
  /** 0 is an empty day; 1–4 are the quartiles of the busiest day in view. */
  level: 0 | 1 | 2 | 3 | 4;
};

export type UsageForecast = {
  /** Buckets the projection covers (a week for daily data). */
  horizon: number;
  /** Mean tokens per bucket over the baseline the fit used. */
  perBucket: number;
  /** Projected tokens across the horizon, never negative. */
  totalTokens: number;
  /** How many buckets with data informed the fit; 0 means "not enough". */
  basisCount: number;
  /** True when the projection is below the window's own average. */
  declining: boolean;
};

export type UsageAnomaly = {
  date: string;
  tokens: number;
  /** How many robust deviations above the baseline the bucket sits. */
  score: number;
};

/**
 * A 7-row calendar of the trailing `weeks` days, newest data last.
 *
 * The rows are weekdays and the columns are weeks, which is the shape the CSS
 * grid expects. The host returns a dense, ordered series for `day` buckets, so
 * this is a re-projection rather than a lookup — a missing day is a zero, not a
 * gap.
 */
export function buildCalendarHeatmap(
  items: TokenUsageHistoryItem[],
  weeks: number,
): HeatmapCell[] {
  const span = Math.max(1, Math.floor(weeks)) * 7;
  const daily = items.filter((item) => typeof item.date === "string");
  const window = daily.slice(-span);

  let peak = 0;
  for (const item of window) {
    if (item.totalTokens > peak) peak = item.totalTokens;
  }
  const quartile = peak / 4;

  return window.map((item) => {
    const tokens = Math.max(0, item.totalTokens);
    let level: HeatmapCell["level"] = 0;
    if (tokens > 0 && peak > 0) {
      level = tokens <= quartile ? 1 : tokens <= quartile * 2 ? 2 : tokens <= quartile * 3 ? 3 : 4;
    }
    return {
      date: item.date,
      tokens,
      weekday: weekdayOf(item.date),
      level,
    };
  });
}

/**
 * Weekday index for a `YYYY-MM-DD` key, read as a calendar date rather than a
 * local instant so the column cannot shift with the viewer's timezone.
 */
function weekdayOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return 0;
  }
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Least-squares projection of the next `horizon` buckets, from the trailing
 * window of buckets that carry data.
 *
 * The fit deliberately ignores empty buckets: a weekend, a paused project, or
 * an idle night is not evidence that spend is falling. Two points is the
 * minimum a slope can be read from; below that the caller shows nothing.
 */
export function forecastUsage(
  items: TokenUsageHistoryItem[],
  horizon: number,
): UsageForecast | null {
  const points: Array<{ index: number; tokens: number }> = [];
  items.forEach((item, index) => {
    if (item.totalTokens > 0) points.push({ index, tokens: item.totalTokens });
  });
  if (points.length < 2) return null;

  const n = points.length;
  const meanIndex = points.reduce((sum, p) => sum + p.index, 0) / n;
  const meanTokens = points.reduce((sum, p) => sum + p.tokens, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.index - meanIndex) * (point.tokens - meanTokens);
    denominator += (point.index - meanIndex) ** 2;
  }
  // Every bucket in a single index is impossible with n >= 2 distinct points,
  // but a guard keeps the division honest if that ever changes.
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanTokens - slope * meanIndex;

  const span = Math.max(1, Math.floor(horizon));
  const lastIndex = items.length - 1;
  let total = 0;
  for (let step = 1; step <= span; step += 1) {
    const projected = intercept + slope * (lastIndex + step);
    total += Math.max(0, projected);
  }

  const windowMean = items.length > 0 ? sumTokens(items) / items.length : 0;
  const perBucket = total / span;
  return {
    horizon: span,
    perBucket,
    totalTokens: total,
    basisCount: n,
    declining: perBucket < windowMean,
  };
}

function sumTokens(items: TokenUsageHistoryItem[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.totalTokens), 0);
}

/** Median of an already-sorted-or-not list; returns 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Buckets that stand out from their own recent baseline, worst first.
 *
 * Uses the median absolute deviation rather than the mean and standard
 * deviation, because a single enormous day is exactly the observation being
 * hunted and it would inflate the very spread it is measured against. The
 * 0.6745 factor rescales the MAD to a standard-deviation equivalent, so the
 * 3.5 threshold is the conventional robust-outlier cut.
 *
 * When more than half the window is identical — a mostly idle account with one
 * spike — the MAD is 0 and every deviation is "infinite". The fallback treats
 * anything strictly above that flat baseline as notable, which is the only
 * honest reading of such a window.
 */
export function detectAnomalies(
  items: TokenUsageHistoryItem[],
  limit = 5,
): UsageAnomaly[] {
  if (items.length < 4) return [];
  const tokens = items.map((item) => Math.max(0, item.totalTokens));
  const centre = median(tokens);
  const deviations = tokens.map((value) => Math.abs(value - centre));
  const mad = median(deviations);

  const outliers: UsageAnomaly[] = [];
  items.forEach((item, index) => {
    const value = tokens[index];
    let score = 0;
    if (mad > 0) {
      score = (0.6745 * (value - centre)) / mad;
    } else if (value > centre && value > 0) {
      score = Number.POSITIVE_INFINITY;
    }
    if (score >= 3.5) outliers.push({ date: item.date, tokens: value, score });
  });

  return outliers
    .sort((a, b) => b.score - a.score || b.tokens - a.tokens)
    .slice(0, Math.max(0, limit));
}

/**
 * Approximate USD cost for display. Sub-cent figures keep more precision so a
 * genuinely tiny spend does not collapse to "$0.00".
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Escape one CSV field, quoting only when the content requires it. */
function csvField(value: string | number | null | undefined): string {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * RFC 4180-style CSV with a CRLF record separator and a UTF-8 BOM.
 *
 * Excel on a Chinese-locale Windows reads a BOM-less UTF-8 file as GBK, which
 * turns every non-ASCII project name into mojibake; the BOM is what makes the
 * export open correctly in the tool users actually have.
 */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return `\uFEFF${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

const HISTORY_HEADER = [
  "bucket",
  "date",
  "timestamp",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "turnCount",
];

/** The trend series as CSV, one row per bucket. */
export function historyToCsv(result: TokenUsageHistoryResult): string {
  const rows: Array<Array<string | number>> = [HISTORY_HEADER];
  for (const item of result.items) {
    rows.push([
      result.bucket,
      item.date,
      item.timestamp,
      item.inputTokens,
      item.outputTokens,
      item.cacheReadTokens,
      item.cacheWriteTokens,
      item.reasoningTokens,
      item.totalTokens,
      item.turnCount,
    ]);
  }
  return toCsv(rows);
}

/**
 * The breakdown as one CSV: provider, model, and project sections, each with its
 * own header row and a blank line between them.
 *
 * A single flat table cannot carry three different groupings without inventing
 * a "kind" column the host never returns, so the sections keep each grouping
 * honest when the file is opened in a spreadsheet.
 */
export function breakdownToCsv(result: UsageBreakdownResult): string {
  const sections: Array<Array<Array<string | number | null>>> = [];

  sections.push([
    ["group", "id", "name", "turnCount", "successCount", "totalTokens", "costUsd", "unpricedTurns"],
    ...result.byProvider.map((row) => [
      "provider" as const,
      row.providerId,
      row.providerId,
      row.turnCount,
      row.successCount,
      row.totalTokens,
      row.costUsd,
      row.unpricedTurns,
    ]),
  ]);

  sections.push([
    ["group", "id", "name", "turnCount", "successCount", "totalTokens", "costUsd", "unpricedTurns"],
    ...result.byModel.map((row) => [
      "model" as const,
      row.modelId,
      row.providerId,
      row.turnCount,
      row.successCount,
      row.totalTokens,
      row.costUsd,
      row.unpricedTurns,
    ]),
  ]);

  sections.push([
    ["group", "id", "name", "turnCount", "successCount", "totalTokens", "costUsd", "unpricedTurns"],
    ...result.byProject.map((row) => [
      "project" as const,
      row.projectId == null ? "" : String(row.projectId),
      row.projectName,
      row.turnCount,
      row.successCount,
      row.totalTokens,
      row.costUsd,
      row.unpricedTurns,
    ]),
  ]);

  return `${"\uFEFF"}${sections
    .map((rows) => rows.map((row) => row.map(csvField).join(",")).join("\r\n"))
    .join("\r\n\r\n")}\r\n`;
}

/**
 * Both tables in one CSV: the bucket series first, the grouping sections after.
 *
 * Exactly one BOM, at the very front — the exporters above each carry their own
 * for standalone use, and two of them concatenated would put a stray mark in the
 * middle of the file.
 */
export function usageCsv(payload: {
  history: TokenUsageHistoryResult | null;
  breakdown: UsageBreakdownResult | null;
}): string {
  const parts: string[] = [];
  if (payload.history) parts.push(historyToCsv(payload.history).replace(/^\uFEFF/, ""));
  if (payload.breakdown) parts.push(breakdownToCsv(payload.breakdown).replace(/^\uFEFF/, ""));
  return `\uFEFF${parts.join("\r\n\r\n")}\r\n`;
}

/** A filename stem that sorts chronologically and names the window it covers. */
export function usageExportStem(
  rangeId: string,
  now: Date = new Date(),
): string {
  const stamp = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, "0"),
    `${now.getDate()}`.padStart(2, "0"),
  ].join("-");
  return `qianning-usage-${rangeId}-${stamp}`;
}

/** Serialize both payloads as one pretty-printed JSON document. */
export function usageToJson(payload: {
  rangeId: string;
  bucket: TokenUsageBucket;
  history: TokenUsageHistoryResult | null;
  breakdown: UsageBreakdownResult | null;
}): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
