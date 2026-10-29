/**
 * Token accounting for a phone turn.
 *
 * The shared context ring reads `MessageUsage` off the last assistant message
 * (`apps/desktop/src/lib/context-usage.ts`). pi reports usage in its own shape —
 * `input` / `output` / `cacheRead` / `cacheWrite` / `reasoning` plus a cost
 * object — so it has to be translated here or the phone shows a permanently
 * empty meter.
 */

export type PhoneUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Returns undefined for a missing or empty report, so a stale zero never wins. */
export function usageFromPi(raw: unknown): PhoneUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = count(usage.input);
  const outputTokens = count(usage.output);
  const cacheReadTokens = count(usage.cacheRead);
  const cacheWriteTokens = count(usage.cacheWrite);
  const reasoningTokens = count(usage.reasoning);
  const totalTokens =
    count(usage.totalTokens) ||
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;

  const costRaw = usage.cost as Record<string, unknown> | undefined;
  const costNumbers =
    costRaw &&
    ["input", "output", "cacheRead", "cacheWrite", "total"].every(
      (key) => typeof costRaw[key] === "number" && Number.isFinite(costRaw[key]) && (costRaw[key] as number) >= 0,
    )
      ? {
          input: costRaw.input as number,
          output: costRaw.output as number,
          cacheRead: costRaw.cacheRead as number,
          cacheWrite: costRaw.cacheWrite as number,
          total: costRaw.total as number,
        }
      : undefined;

  if (totalTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    totalTokens,
    ...(costNumbers ? { cost: costNumbers } : {}),
  };
}
