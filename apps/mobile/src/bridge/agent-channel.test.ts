import { describe, expect, it } from "vitest";
import { PhoneBridge, type AgentHostLike } from "./desktop-bridge";
import { MemoryStore } from "../agent/store";
import type { LocalEvent } from "./agent-events";

const NOW = 1_700_000_000_000;
const AGENT_EVENT = "pi-desktop/agent/event/message";

/** A host that records what it was asked to do and can replay events. */
function fakeHost() {
  const sent: Array<{ sessionId: string; text: string }> = [];
  const listeners = new Set<(event: LocalEvent) => void>();
  let failWith: Error | null = null;
  let interrupted = 0;

  const host: AgentHostLike = {
    send: async (sessionId, text) => {
      sent.push({ sessionId, text });
      if (failWith) throw failWith;
    },
    subscribe: (_sessionId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interrupt: () => {
      interrupted += 1;
    },
  };

  return {
    host,
    sent,
    replay: (event: LocalEvent) => listeners.forEach((listener) => listener(event)),
    failWith: (error: Error | null) => {
      failWith = error;
    },
    interrupted: () => interrupted,
  };
}

function bridgeWithHost() {
  const store = new MemoryStore();
  const fake = fakeHost();
  const bridge = new PhoneBridge({ store, platform: "android", version: "2.2.0", host: fake.host, now: () => NOW });
  return { bridge, fake, store };
}

describe("agent prompt channel", () => {
  it("accepts a prompt and hands it to the phone host", async () => {
    const { bridge, fake } = bridgeWithHost();
    const result = await bridge.invoke("pi-desktop/agent/prompt", { sessionId: "s1", content: "你好" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ accepted: true });
    expect(fake.sent).toEqual([{ sessionId: "s1", text: "你好" }]);
  });

  it("translates the turn's events onto the desktop bus", async () => {
    const { bridge, fake } = bridgeWithHost();
    const seen: Array<Record<string, unknown>> = [];
    bridge.on(AGENT_EVENT, (payload) => seen.push((payload as { event: Record<string, unknown> }).event));

    await bridge.invoke("pi-desktop/agent/prompt", { sessionId: "s1", content: "你好" });
    fake.replay({ sessionId: "s1", turnId: "t1", kind: "turn.started" });
    fake.replay({
      sessionId: "s1",
      turnId: "t1",
      kind: "item.completed",
      payload: { itemType: "message", itemId: "m1", event: { message: { role: "assistant", content: [{ type: "text", text: "在" }] } } },
    });

    expect(seen.map((event) => event.type)).toEqual(["agent_start", "turn_start", "message_end"]);
  });

  it("subscribes to a session once, however many prompts it takes", async () => {
    const { bridge, fake } = bridgeWithHost();
    const seen: unknown[] = [];
    bridge.on(AGENT_EVENT, (payload) => seen.push(payload));

    await bridge.invoke("pi-desktop/agent/prompt", { sessionId: "s1", content: "一" });
    await bridge.invoke("pi-desktop/agent/prompt", { sessionId: "s1", content: "二" });
    fake.replay({ sessionId: "s1", kind: "turn.started" });

    // Two prompts, one subscription: two events per turn, not four.
    expect(seen).toHaveLength(2);
  });

  it("reports a rejected prompt as an error event instead of silence", async () => {
    const { bridge, fake } = bridgeWithHost();
    fake.failWith(new Error("provider 401"));
    const seen: Array<Record<string, unknown>> = [];
    bridge.on(AGENT_EVENT, (payload) => seen.push((payload as { event: Record<string, unknown> }).event));

    await bridge.invoke("pi-desktop/agent/prompt", { sessionId: "s1", content: "你好" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen[0]).toMatchObject({ type: "error", error: { message: "provider 401" } });
  });

  it("refuses a prompt the host cannot run, by name", async () => {
    const store = new MemoryStore();
    const bridge = new PhoneBridge({ store, platform: "android", version: "2.2.0" });
    const result = await bridge.invoke("pi-desktop/agent/prompt", { sessionId: "s1", content: "你好" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no agent runtime");
  });

  it("stops a turn through the host", async () => {
    const { bridge, fake } = bridgeWithHost();
    const result = await bridge.invoke("pi-desktop/agent/stop", { sessionId: "s1" });
    expect(result.ok).toBe(true);
    expect(fake.interrupted()).toBe(1);
  });
});
