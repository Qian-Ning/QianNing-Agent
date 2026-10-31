/**
 * Usage statistics, computed from what the phone actually stored.
 *
 * The desktop reads a turn ledger out of SQLite; the phone has no ledger — it
 * has the transcript, and every assistant message carries the token counts pi
 * reported for that turn. That is the same information one level lower, so the
 * page's two queries are answered by folding the transcripts instead of asking
 * a database that does not exist here.
 */

import type { StoredMessage, StoredSession } from "./store";
import type {
  TokenUsageBucket,
  TokenUsageHistoryItem,
  TokenUsageHistoryResult,
  UsageBreakdownResult,
  UsageModelStat,
  UsageProjectStat,
  UsageProviderStat,
  UsageRecentTurn,
} from "@pi-desktop/shared";

export type PhoneUsage = NonNullable<StoredMessage["usage"]>;

export type UsageTurn = {
  timestamp: number;
  sessionId: string;
  providerId: string | null;
  modelId: string | null;
  projectName: string | null;
  projectKey: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** USD for this turn when pi priced it, null when the model is unpriced. */
  costUsd: number | null;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

function bucketStart(at: number, bucket: TokenUsageBucket): number {
  const date = new Date(at);
  switch (bucket) {
    case "hour":
      date.setMinutes(0, 0, 0);
      return date.getTime();
    case "week": {
      const day = date.getDay();
      const monday = new Date(date);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - ((day + 6) % 7));
      return monday.getTime();
    }
    case "month":
      return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    case "day":
    default:
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
}

function bucketLabel(at: number, bucket: TokenUsageBucket): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  if (bucket === "hour") return `${month}-${day} ${`${date.getHours()}`.padStart(2, "0")}:00`;
  if (bucket === "month") return `${date.getFullYear()}-${month}`;
  if (bucket === "week") return `${date.getFullYear()}-${month}-${day}`;
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A message is a turn when it has usage: the assistant's own record of it. */
export function isUsageMessage(message: StoredMessage): message is StoredMessage & {
  usage: PhoneUsage;
} {
  return Boolean(message.usage) && message.role !== "user";
}

export function turnFromMessage(
  message: StoredMessage & { usage: PhoneUsage },
  context: {
    sessionId: string;
    providerId: string | null;
    modelId: string | null;
    projectName: string | null;
    projectKey: string | null;
  },
): UsageTurn {
  const usage = message.usage;
  const created = Date.parse(message.createdAt);
  return {
    timestamp: Number.isFinite(created) ? created : Date.now(),
    sessionId: context.sessionId,
    providerId: message.providerId ?? context.providerId,
    modelId: message.modelId ?? context.modelId,
    projectName: context.projectName,
    projectKey: context.projectKey,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens,
    costUsd: typeof usage.cost?.total === "number" ? usage.cost.total : null,
  };
}

function inWindow(turn: UsageTurn, start: number, end: number): boolean {
  return turn.timestamp >= start && turn.timestamp <= end;
}

export function tokenUsageHistory(
  turns: UsageTurn[],
  query: { startDate?: number; endDate?: number; bucket?: TokenUsageBucket } = {},
): TokenUsageHistoryResult {
  const bucket: TokenUsageBucket = query.bucket ?? "day";
  const rangeEnd = query.endDate ?? Date.now();
  const rangeStart = query.startDate ?? rangeEnd - 29 * DAY;

  const buckets = new Map<number, TokenUsageHistoryItem>();
  for (const turn of turns) {
    if (!inWindow(turn, rangeStart, rangeEnd)) continue;
    const key = bucketStart(turn.timestamp, bucket);
    const item = buckets.get(key) ?? {
      date: bucketLabel(key, bucket),
      timestamp: key,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      turnCount: 0,
    };
    item.inputTokens += turn.inputTokens;
    item.outputTokens += turn.outputTokens;
    item.totalTokens += turn.totalTokens;
    item.cacheReadTokens += turn.cacheReadTokens;
    item.cacheWriteTokens += turn.cacheWriteTokens;
    item.reasoningTokens += turn.reasoningTokens;
    item.turnCount += 1;
    buckets.set(key, item);
  }

  /*
   * A `day` series is dense: the heatmap reads one cell per day and treats a
   * zero as "no usage that day", which is only true if every day is present.
   * The desktop host returns the same shape, so the two surfaces agree.
   */
  const denseLimit = 400;
  const span =
    bucket === "hour" ? HOUR : bucket === "week" ? 7 * DAY : bucket === "month" ? 30 * DAY : DAY;
  const first = bucketStart(rangeStart, bucket);
  const steps = Math.floor((rangeEnd - first) / span) + 1;
  if (steps > 0 && steps <= denseLimit) {
    for (let index = 0; index < steps; index += 1) {
      const at = bucketStart(first + index * span, bucket);
      if (buckets.has(at)) continue;
      buckets.set(at, {
        date: bucketLabel(at, bucket),
        timestamp: at,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        turnCount: 0,
      });
    }
  }

  const items = [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turnCount: 0,
  };
  for (const item of items) {
    totals.inputTokens += item.inputTokens;
    totals.outputTokens += item.outputTokens;
    totals.totalTokens += item.totalTokens;
    totals.cacheReadTokens += item.cacheReadTokens;
    totals.cacheWriteTokens += item.cacheWriteTokens;
    totals.reasoningTokens += item.reasoningTokens;
    totals.turnCount += item.turnCount;
  }
  return { bucket, rangeStart, rangeEnd, items, totals };
}

type Group = {
  turnCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedTurns: number;
};

function emptyGroup(): Group {
  return { turnCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedTurns: 0 };
}

function addToGroup(group: Group, turn: UsageTurn): void {
  group.turnCount += 1;
  group.totalTokens += turn.totalTokens;
  group.inputTokens += turn.inputTokens;
  group.outputTokens += turn.outputTokens;
  if (turn.costUsd === null) group.unpricedTurns += 1;
  else group.costUsd += turn.costUsd;
}

function startOfMonth(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function usageBreakdown(
  turns: UsageTurn[],
  query: {
    startDate?: number;
    endDate?: number;
    providerId?: string;
    modelId?: string;
    recentLimit?: number;
  } = {},
): UsageBreakdownResult {
  const rangeEnd = query.endDate ?? Date.now();
  const rangeStart = query.startDate ?? rangeEnd - 29 * DAY;

  const byProvider = new Map<string, Group & { successCount: number }>();
  const byModel = new Map<string, Group & { providerId: string | null }>();
  const byProject = new Map<string, Group & { projectKey: string | null; name: string | null }>();

  for (const turn of turns) {
    if (!inWindow(turn, rangeStart, rangeEnd)) continue;
    if (query.providerId && turn.providerId !== query.providerId) continue;
    if (query.modelId && turn.modelId !== query.modelId) continue;

    const providerKey = turn.providerId ?? "";
    const provider = byProvider.get(providerKey) ?? { ...emptyGroup(), successCount: 0 };
    addToGroup(provider, turn);
    provider.successCount += 1;
    byProvider.set(providerKey, provider);

    const modelKey = turn.modelId ?? "";
    const model = byModel.get(modelKey) ?? { ...emptyGroup(), providerId: turn.providerId };
    addToGroup(model, turn);
    byModel.set(modelKey, model);

    const projectKey = turn.projectKey ?? "";
    const project =
      byProject.get(projectKey) ??
      { ...emptyGroup(), projectKey: turn.projectKey, name: turn.projectName };
    addToGroup(project, turn);
    byProject.set(projectKey, project);
  }

  const providerStats: UsageProviderStat[] = [...byProvider.entries()]
    .map(([providerId, group]) => ({
      providerId,
      turnCount: group.turnCount,
      successCount: group.successCount,
      successRate: group.turnCount === 0 ? 0 : group.successCount / group.turnCount,
      totalTokens: group.totalTokens,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      costUsd: group.costUsd,
      unpricedTurns: group.unpricedTurns,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const modelStats: UsageModelStat[] = [...byModel.entries()]
    .map(([modelId, group]) => ({
      modelId,
      providerId: group.providerId,
      turnCount: group.turnCount,
      successCount: group.turnCount,
      totalTokens: group.totalTokens,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      costUsd: group.costUsd,
      unpricedTurns: group.unpricedTurns,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const projectStats: UsageProjectStat[] = [...byProject.entries()]
    .map(([, group]) => ({
      // A phone project is keyed by its folder; the page only reads the name,
      // so the numeric id stays null exactly like an unattributed desktop turn.
      projectId: null,
      projectName: group.name,
      turnCount: group.turnCount,
      successCount: group.turnCount,
      totalTokens: group.totalTokens,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      costUsd: group.costUsd,
      unpricedTurns: group.unpricedTurns,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const inWindowTurns = turns
    .filter((turn) => inWindow(turn, rangeStart, rangeEnd))
    .filter((turn) => !query.providerId || turn.providerId === query.providerId)
    .filter((turn) => !query.modelId || turn.modelId === query.modelId)
    .sort((a, b) => b.timestamp - a.timestamp);

  const recent: UsageRecentTurn[] = inWindowTurns
    .slice(0, Math.max(0, query.recentLimit ?? 20))
    .map((turn) => ({
      timestamp: turn.timestamp,
      providerId: turn.providerId,
      modelId: turn.modelId,
      status: "success",
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheTokens: turn.cacheReadTokens + turn.cacheWriteTokens,
      durationMs: 0,
      costUsd: turn.costUsd,
    }));

  const pricedTurns = inWindowTurns.filter((turn) => turn.costUsd !== null);
  const monthStart = startOfMonth(rangeEnd);
  const monthTurns = turns.filter(
    (turn) => turn.timestamp >= monthStart && turn.timestamp <= rangeEnd,
  );

  return {
    rangeStart,
    rangeEnd,
    byProvider: providerStats,
    byModel: modelStats,
    byProject: projectStats,
    recent,
    totalCostUsd: pricedTurns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    pricedTurns: pricedTurns.length,
    unpricedTurns: inWindowTurns.length - pricedTurns.length,
    monthToDateCostUsd: monthTurns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    monthToDateUnpricedTurns: monthTurns.filter((turn) => turn.costUsd === null).length,
    monthStart,
  };
}

/** Every stored turn, newest session first, ready for the two queries above. */
export function collectTurns(
  sessions: StoredSession[],
  readMessages: (sessionId: string) => StoredMessage[],
  identity: (sessionId: string) => { providerId: string | null; modelId: string | null },
): UsageTurn[] {
  const turns: UsageTurn[] = [];
  for (const session of sessions) {
    const who = identity(session.id);
    const projectKey = session.projectPath?.trim() ? session.projectPath.trim() : null;
    for (const message of readMessages(session.id)) {
      if (!isUsageMessage(message)) continue;
      turns.push(
        turnFromMessage(message, {
          sessionId: session.id,
          providerId: who.providerId,
          modelId: who.modelId,
          projectName: projectKey ? projectKey.split("/").filter(Boolean).pop() ?? projectKey : null,
          projectKey,
        }),
      );
    }
  }
  return turns;
}

export { HOUR };
