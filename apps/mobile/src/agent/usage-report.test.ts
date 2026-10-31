import { describe, expect, it } from "vitest";
import {
  collectTurns,
  isUsageMessage,
  tokenUsageHistory,
  usageBreakdown,
  type UsageTurn,
} from "./usage-report";
import type { StoredMessage, StoredSession } from "./store";

function turn(overrides: Partial<UsageTurn> & { timestamp: number }): UsageTurn {
  return {
    sessionId: "s1",
    providerId: "happycoding",
    modelId: "deepseek-v4.1-flash",
    projectName: null,
    projectKey: null,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 120,
    costUsd: 0.001,
    ...overrides,
  };
}

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    itemId: "m1",
    role: "assistant",
    text: "hello",
    status: "complete",
    createdAt: "2026-10-31T04:00:00.000Z",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 120,
      cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
    ...overrides,
  };
}

describe("usage history", () => {
  it("buckets by hour inside one day and sums both totals", () => {
    const turns = [
      turn({ timestamp: new Date(2026, 9, 31, 1, 10).getTime() }),
      turn({ timestamp: new Date(2026, 9, 31, 1, 50).getTime(), totalTokens: 80, costUsd: 0.002 }),
      turn({ timestamp: new Date(2026, 9, 31, 5, 5).getTime(), totalTokens: 40 }),
    ];
    const result = tokenUsageHistory(turns, {
      startDate: new Date(2026, 9, 31, 0, 0, 0).getTime(),
      endDate: new Date(2026, 9, 31, 23, 59, 59).getTime(),
      bucket: "hour",
    });
    // A full day of hours is present; two of them carry the turns.
    expect(result.items).toHaveLength(24);
    expect(result.items[1]?.turnCount).toBe(2);
    expect(result.items[1]?.totalTokens).toBe(200);
    expect(result.items[5]?.totalTokens).toBe(40);
    expect(result.totals.totalTokens).toBe(240);
    expect(result.totals.turnCount).toBe(3);
  });

  it("drops turns outside the window", () => {
    const turns = [
      turn({ timestamp: new Date(2026, 8, 1, 1).getTime() }),
      turn({ timestamp: new Date(2026, 9, 31, 1).getTime() }),
    ];
    const result = tokenUsageHistory(turns, {
      startDate: new Date(2026, 9, 30, 0, 0, 0).getTime(),
      endDate: new Date(2026, 9, 31, 23, 59, 59).getTime(),
      bucket: "day",
    });
    expect(result.totals.turnCount).toBe(1);
    // Dense days: both days in the window are present, the empty one is zeroed.
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.totalTokens).toBe(0);
    expect(result.items[1]?.totalTokens).toBe(120);
  });

  it("fills a dense day series so the calendar has a cell for every day", () => {
    const result = tokenUsageHistory([], {
      startDate: new Date(2026, 9, 1).getTime(),
      endDate: new Date(2026, 9, 7).getTime(),
      bucket: "day",
    });
    expect(result.items).toHaveLength(7);
    expect(result.items.every((item) => item.turnCount === 0)).toBe(true);
    expect(result.totals.totalTokens).toBe(0);
  });

  it("keeps the hour series dense enough for one day of buckets", () => {
    const result = tokenUsageHistory([], {
      startDate: new Date(2026, 9, 31, 0, 0, 0).getTime(),
      endDate: new Date(2026, 9, 31, 5, 30, 0).getTime(),
      bucket: "hour",
    });
    expect(result.items.length).toBeGreaterThanOrEqual(6);
    expect(result.items[0]?.timestamp).toBe(new Date(2026, 9, 31, 0).getTime());
  });
});

describe("usage breakdown", () => {
  const at = (iso: string) => Date.parse(iso);
  const base = { startDate: at("2026-10-01T00:00:00.000Z"), endDate: at("2026-10-31T23:59:59.000Z") };

  it("groups by provider and model, and splits priced from unpriced turns", () => {
    const turns = [
      turn({ timestamp: at("2026-10-31T01:00:00.000Z") }),
      turn({ timestamp: at("2026-10-31T02:00:00.000Z"), costUsd: null, totalTokens: 60 }),
      turn({
        timestamp: at("2026-10-31T03:00:00.000Z"),
        providerId: "amd",
        modelId: "qwen",
        totalTokens: 300,
        costUsd: 0.01,
      }),
    ];
    const result = usageBreakdown(turns, { ...base, recentLimit: 2 });
    expect(result.byProvider).toHaveLength(2);
    expect(result.byProvider[0]?.providerId).toBe("amd");
    expect(result.byProvider[1]?.turnCount).toBe(2);
    expect(result.byProvider[1]?.unpricedTurns).toBe(1);
    expect(result.byModel.map((row) => row.modelId)).toEqual([
      "qwen",
      "deepseek-v4.1-flash",
    ]);
    expect(result.pricedTurns).toBe(2);
    expect(result.unpricedTurns).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.011, 6);
    expect(result.recent).toHaveLength(2);
  });

  it("keeps unpriced turns in the token totals but out of the cost", () => {
    // Month-to-date is a local-calendar question, so this window is built from
    // local components: a UTC instant near the month's edge straddles the local
    // boundary and would put the turn in the previous month.
    const turns = [turn({ timestamp: new Date(2026, 9, 15, 10).getTime(), costUsd: null })];
    const result = usageBreakdown(turns, {
      startDate: new Date(2026, 9, 1).getTime(),
      endDate: new Date(2026, 9, 20).getTime(),
    });
    expect(result.totalCostUsd).toBe(0);
    expect(result.monthToDateCostUsd).toBe(0);
    expect(result.byProvider[0]?.totalTokens).toBe(120);
    expect(result.monthToDateUnpricedTurns).toBe(1);
  });

  it("filters by provider when the page narrows the window", () => {
    const turns = [
      turn({ timestamp: at("2026-10-31T01:00:00.000Z") }),
      turn({ timestamp: at("2026-10-31T02:00:00.000Z"), providerId: "amd", modelId: "qwen" }),
    ];
    const result = usageBreakdown(turns, { ...base, providerId: "amd" });
    expect(result.byProvider).toHaveLength(1);
    expect(result.pricedTurns).toBe(1);
  });

  it("names the project a turn belongs to", () => {
    const turns = [
      turn({ timestamp: at("2026-10-31T01:00:00.000Z"), projectKey: "projects/novel", projectName: "novel" }),
      turn({ timestamp: at("2026-10-31T02:00:00.000Z") }),
    ];
    const result = usageBreakdown(turns, base);
    expect(result.byProject[0]?.projectName).toBe("novel");
    expect(result.byProject[1]?.projectName).toBeNull();
  });
});

describe("collecting turns from transcripts", () => {
  const session: StoredSession = {
    id: "s1",
    title: "chat",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T05:00:00.000Z",
    projectPath: "projects/novel",
  };

  it("reads only messages that carry usage and stamps the session's model", () => {
    const messages = [
      message({ itemId: "u1", role: "user", usage: undefined }),
      message({ itemId: "a1" }),
      message({ itemId: "t1", role: "tool", usage: undefined }),
    ];
    expect(messages.filter(isUsageMessage)).toHaveLength(1);
    const turns = collectTurns([session], () => messages, () => ({
      providerId: "happycoding",
      modelId: "deepseek-v4.1-flash",
    }));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.modelId).toBe("deepseek-v4.1-flash");
    expect(turns[0]?.projectName).toBe("novel");
  });

  it("prefers the identity recorded on the message over the session default", () => {
    const messages = [message({ providerId: "amd", modelId: "qwen" })];
    const turns = collectTurns([session], () => messages, () => ({
      providerId: "happycoding",
      modelId: "deepseek-v4.1-flash",
    }));
    expect(turns[0]?.providerId).toBe("amd");
    expect(turns[0]?.modelId).toBe("qwen");
  });

  it("carries a priced turn's cost through to the breakdown", () => {
    const turns = collectTurns([session], () => [message()], () => ({
      providerId: "happycoding",
      modelId: "deepseek-v4.1-flash",
    }));
    const result = usageBreakdown(turns, {
      startDate: Date.parse("2026-10-01T00:00:00.000Z"),
      endDate: Date.parse("2026-10-31T23:59:59.000Z"),
    });
    expect(result.pricedTurns).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.001, 6);
  });
});
