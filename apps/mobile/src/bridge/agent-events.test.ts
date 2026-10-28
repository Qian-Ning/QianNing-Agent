import { describe, expect, it } from "vitest";
import { messageText, toDesktopEvents } from "./agent-events";

const NOW = 1_700_000_000_000;

const assistantItem = (text: string) => ({
  itemType: "message",
  itemId: "m_1",
  event: { message: { role: "assistant", content: [{ type: "text", text }] } },
});

describe("messageText", () => {
  it("joins only text parts, in order", () => {
    expect(
      messageText({
        event: { message: { content: [{ type: "thinking" }, { type: "text", text: "你" }, { type: "text", text: "好" }] } },
      }),
    ).toBe("你好");
  });

  it("is empty when the payload has no message", () => {
    expect(messageText(undefined)).toBe("");
  });
});

describe("toDesktopEvents", () => {
  it("opens a turn with the events the renderer expects", () => {
    const events = toDesktopEvents({ sessionId: "s1", turnId: "t1", kind: "turn.started" }, NOW);
    expect(events.map((e) => e.event.type)).toEqual(["agent_start", "turn_start"]);
    expect(events[0]).toMatchObject({ sessionId: "s1", turnId: "t1", ts: NOW });
  });

  it("starts a streaming assistant row", () => {
    const [event] = toDesktopEvents(
      { sessionId: "s1", turnId: "t1", kind: "item.started", payload: assistantItem("") },
      NOW,
    );
    expect(event.event.type).toBe("message_start");
    expect(event.event.message).toMatchObject({ id: "m_1", role: "assistant", content: "", status: "streaming" });
  });

  it("carries deltas as append-only frames", () => {
    const [event] = toDesktopEvents(
      {
        sessionId: "s1",
        turnId: "t1",
        kind: "item.delta",
        payload: { itemType: "message", itemId: "m_1", event: { deltaText: "你", deltaThinking: "" } },
      },
      NOW,
    );
    expect(event.event).toMatchObject({ type: "message_update", deltaText: "你", stream: "delta" });
  });

  it("closes the row with the full text", () => {
    const [event] = toDesktopEvents(
      { sessionId: "s1", turnId: "t1", kind: "item.completed", payload: assistantItem("你好，这是离线测试。") },
      NOW,
    );
    expect(event.event).toMatchObject({ type: "message_end" });
    expect((event.event.message as { content: string }).content).toBe("你好，这是离线测试。");
  });

  it("ends the turn after the last message", () => {
    const events = toDesktopEvents({ sessionId: "s1", turnId: "t1", kind: "turn.completed" }, NOW);
    expect(events.map((e) => e.event.type)).toEqual(["turn_end", "agent_end"]);
  });

  it("turns a failed turn into an error the interface can show", () => {
    const events = toDesktopEvents(
      { sessionId: "s1", turnId: "t1", kind: "turn.failed", payload: { message: "provider 401" } },
      NOW,
    );
    expect(events[0].event).toMatchObject({ type: "error", error: { code: "AGENT_TURN_FAILED", message: "provider 401" } });
    expect(events[1].event.type).toBe("turn_end");
  });

  it("ignores what it cannot translate instead of inventing it", () => {
    expect(toDesktopEvents({ sessionId: "s1", kind: "item.started", payload: { itemType: "tool", itemId: "x" } }, NOW)).toEqual([]);
    expect(toDesktopEvents({ sessionId: "s1", kind: "item.completed", payload: { ...assistantItem("x"), event: { message: { role: "user" } } } }, NOW)).toEqual([]);
    expect(toDesktopEvents({ sessionId: "s1", kind: "something.new" }, NOW)).toEqual([]);
  });
});
