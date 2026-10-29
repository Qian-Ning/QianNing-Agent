import { describe, expect, it } from "vitest";
import { usageFromPi } from "./usage";
import { toDesktopEvents } from "../bridge/agent-events";

describe("usageFromPi", () => {
  it("translates pi's counters into the shared shape", () => {
    expect(
      usageFromPi({ input: 1200, output: 340, cacheRead: 60, reasoning: 12, totalTokens: 1612 }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 60,
      reasoningTokens: 12,
      totalTokens: 1612,
    });
  });

  it("adds the counters when the provider omits a total", () => {
    const usage = usageFromPi({ input: 100, output: 50, cacheWrite: 25 });
    expect(usage?.totalTokens).toBe(175);
    expect(usage?.cacheReadTokens).toBeUndefined();
  });

  it("keeps a cost only when every field is a real number", () => {
    expect(
      usageFromPi({
        input: 1,
        output: 1,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      })?.cost,
    ).toEqual({ input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 });

    expect(
      usageFromPi({ input: 1, output: 1, cost: { input: 0.1 } })?.cost,
    ).toBeUndefined();
  });

  it("reports nothing for an empty or missing usage", () => {
    expect(usageFromPi(undefined)).toBeUndefined();
    expect(usageFromPi({})).toBeUndefined();
    expect(usageFromPi({ input: 0, output: 0 })).toBeUndefined();
    expect(usageFromPi("nope")).toBeUndefined();
  });
});

describe("message_end events", () => {
  it("carries usage so the context ring can measure the turn", () => {
    const [envelope] = toDesktopEvents(
      {
        sessionId: "s1",
        kind: "item.completed",
        payload: {
          itemType: "message",
          itemId: "m1",
          event: { message: { role: "assistant", usage: { input: 900, output: 100 } } },
        },
      },
      1_700_000_000_000,
    );
    expect(envelope.event).toMatchObject({
      type: "message_end",
      message: { id: "m1", usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } },
    });
  });

  it("leaves usage off when the provider reported none", () => {
    const [envelope] = toDesktopEvents(
      {
        sessionId: "s1",
        kind: "item.completed",
        payload: { itemType: "message", itemId: "m1", event: { message: { role: "assistant" } } },
      },
      1,
    );
    const message = (envelope.event as { message: Record<string, unknown> }).message;
    expect("usage" in message).toBe(false);
  });
});
