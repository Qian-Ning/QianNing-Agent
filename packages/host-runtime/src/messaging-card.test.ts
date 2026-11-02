import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageDeliverySummary } from "@pi-desktop/agent-host";

import { CARD_MERGE_MS, MessagingCard } from "./messaging-card.js";

function summary(kind: MessageDeliverySummary["kind"], note?: string): MessageDeliverySummary {
  return {
    eventId: `event-${kind}`,
    kind,
    scope: "session",
    sessionId: "session-1",
    turnId: "turn-1",
    epoch: "epoch-1",
    revision: 1,
    ...(note !== undefined ? { note } : {}),
    occurredAt: "2026-11-01T00:00:00.000Z",
  };
}

function port() {
  const call = vi.fn(async (_method: string, _params: unknown) => ({}));
  return { call };
}

function ids(...names: string[]) {
  let index = 0;
  return () => names[index++] ?? `id-${index}`;
}

describe("MessagingCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the card as a send under an id it minted before the delivery existed", () => {
    const rpc = port();
    const card = new MessagingCard(rpc, "telegram", undefined, ids("card-1"));

    card.open(summary("turn.started"));

    expect(card.deliveryId).toBe("card-1");
    expect(rpc.call).toHaveBeenCalledTimes(1);
    const [method, params] = rpc.call.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(method).toBe("messaging.enqueue");
    expect(params["id"]).toBe("card-1");
    expect(params["operation"]).toBe("send");
    expect(params["cardOf"]).toBeUndefined();
  });

  it("merges a burst of frames into one edit carrying the newest state", async () => {
    const rpc = port();
    const card = new MessagingCard(rpc, "telegram", undefined, ids("card-1", "edit-1"));
    card.open(summary("turn.started"));
    rpc.call.mockClear();

    card.frame(summary("tool.progress", "step 1"));
    card.frame(summary("tool.progress", "step 2"));
    card.frame(summary("tool.progress", "step 3"));

    expect(rpc.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CARD_MERGE_MS);

    expect(rpc.call).toHaveBeenCalledTimes(1);
    const [, params] = rpc.call.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params["operation"]).toBe("edit");
    expect(params["cardOf"]).toBe("card-1");
    expect((params["payload"] as MessageDeliverySummary).note).toBe("step 3");
  });

  it("sends the final answer immediately instead of waiting behind the merge window", () => {
    const rpc = port();
    const card = new MessagingCard(rpc, "telegram", undefined, ids("card-1", "edit-1", "edit-2"));
    card.open(summary("turn.started"));
    rpc.call.mockClear();

    card.frame(summary("tool.progress", "step 1"));
    card.close(summary("turn.completed"));

    expect(rpc.call).toHaveBeenCalledTimes(1);
    const [, params] = rpc.call.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params["operation"]).toBe("edit");
    expect((params["payload"] as MessageDeliverySummary).kind).toBe("turn.completed");

    // The frame that was waiting is dropped: the answer supersedes it.
    vi.advanceTimersByTime(CARD_MERGE_MS * 2);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("never opens a card after it is closed", () => {
    const rpc = port();
    const card = new MessagingCard(rpc, "telegram", undefined, ids("card-1"));
    card.open(summary("turn.started"));
    card.close(summary("turn.completed"));
    rpc.call.mockClear();

    card.open(summary("turn.started"));
    card.frame(summary("tool.progress", "late"));
    vi.advanceTimersByTime(CARD_MERGE_MS * 2);

    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("reports a refused hand-off instead of throwing it into the turn", async () => {
    const onError = vi.fn();
    const rpc = {
      call: vi.fn(async () => {
        throw new Error("no such channel");
      }),
    };
    const card = new MessagingCard(rpc, "telegram", onError, ids("card-1"));

    expect(() => card.open(summary("turn.started"))).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});
