import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageDeliverySummary } from "@pi-desktop/agent-host";

import { CARD_MERGE_MS, MessagingCard } from "./messaging-card.js";
import { MessagingCards } from "./messaging-cards.js";

function summary(
  kind: MessageDeliverySummary["kind"],
  turnId = "turn-1",
  note?: string,
): MessageDeliverySummary {
  return {
    eventId: `event-${kind}-${turnId}`,
    kind,
    scope: "session",
    sessionId: "session-1",
    turnId,
    epoch: "epoch-1",
    revision: 1,
    ...(note !== undefined ? { note } : {}),
    occurredAt: "2026-11-01T00:00:00.000Z",
  };
}

function harness() {
  const call = vi.fn(async (_method: string, _params: unknown) => ({}));
  const cards = new MessagingCards(() => new MessagingCard({ call }, "telegram"));
  return { call, cards };
}

describe("MessagingCards", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens one card per turn and keeps a second turn apart", () => {
    const { call, cards } = harness();

    expect(cards.absorb(summary("turn.started", "turn-1"))).toBe(true);
    expect(cards.absorb(summary("turn.started", "turn-2"))).toBe(true);

    expect(cards.size).toBe(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("says it did not absorb a turn whose opening was never seen", () => {
    const { call, cards } = harness();

    expect(cards.absorb(summary("turn.completed"))).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("finishes the card and lets the turn go", () => {
    const { call, cards } = harness();
    cards.absorb(summary("turn.started"));
    cards.absorb(summary("tool.progress", "turn-1", "step 1"));
    call.mockClear();

    expect(cards.absorb(summary("turn.completed"))).toBe(true);
    expect(cards.size).toBe(0);

    const [, params] = call.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params["operation"]).toBe("edit");
    expect((params["payload"] as MessageDeliverySummary).kind).toBe("turn.completed");

    // A frame arriving after the close cannot reopen anything.
    expect(cards.absorb(summary("tool.progress", "turn-1", "late"))).toBe(false);
    vi.advanceTimersByTime(CARD_MERGE_MS * 2);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("turns a tool step into a merged frame on the open card", async () => {
    const { call, cards } = harness();
    cards.absorb(summary("turn.started"));
    call.mockClear();

    cards.absorb(summary("tool.progress", "turn-1", "step 1"));
    cards.absorb(summary("tool.progress", "turn-1", "step 2"));
    await vi.advanceTimersByTimeAsync(CARD_MERGE_MS);

    expect(call).toHaveBeenCalledTimes(1);
    const [, params] = call.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect((params["payload"] as MessageDeliverySummary).note).toBe("step 2");
  });
});
