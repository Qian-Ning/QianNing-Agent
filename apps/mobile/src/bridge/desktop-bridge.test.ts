import { describe, expect, it } from "vitest";
import { PhoneBridge } from "./desktop-bridge";
import { MemoryStore } from "../agent/store";

function bridgeWith(sessions: Array<{ id: string; title: string; updatedAt: string }> = []) {
  const store = new MemoryStore();
  for (const session of sessions) {
    store.writeSession({ ...session, createdAt: session.updatedAt });
  }
  return { bridge: new PhoneBridge({ store, platform: "android", version: "2.2.0" }), store };
}

describe("PhoneBridge", () => {
  it("answers in the renderer's envelope, never with a raw value", async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.invoke("pi-desktop/app/health");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ ok: true, version: "2.2.0" });
  });

  it("lists the phone's own sessions in the shape the sidebar reads", async () => {
    const { bridge, store } = bridgeWith([
      { id: "s1", title: "整理发布清单", updatedAt: "2026-10-28T02:00:00.000Z" },
    ]);
    store.writeMessages("s1", [
      { itemId: "m1", role: "user", text: "你好", status: "done", createdAt: "2026-10-28T01:00:00.000Z" },
    ]);

    const result = await bridge.invoke("pi-desktop/session/list");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { sessions: Array<Record<string, unknown>> };
    expect(value.sessions).toHaveLength(1);
    expect(value.sessions[0]).toMatchObject({ id: "s1", title: "整理发布清单", messageCount: 1, mode: "agent" });
  });

  it("names a channel it does not implement instead of pretending it is empty", async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.invoke("pi-desktop/workbench/render", { id: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("bridge/unavailable");
    expect(result.error.message).toContain("workbench/render");
  });

  it("reports a throwing handler as an error, never as a rejection the shell cannot catch", async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.invoke("pi-desktop/session/history", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bridge/failed");
  });

  it("delivers host events to subscribers and stops on unsubscribe", () => {
    const { bridge } = bridgeWith();
    const seen: unknown[] = [];
    const off = bridge.on("pi-desktop/agent/event", (payload) => seen.push(payload));

    bridge.emit("agent/event", { kind: "turn.started" });
    bridge.emit("pi-desktop/agent/event", { kind: "turn.completed" });
    off();
    bridge.emit("agent/event", { kind: "ignored" });

    expect(seen).toHaveLength(2);
  });

  it("exposes exactly the surface the preload promises", () => {
    const { bridge } = bridgeWith();
    const api = bridge.toWindowApi();
    expect(api.platform).toBe("android");
    const surface = api as unknown as Record<string, unknown>;
    for (const key of ["invoke", "on", "off", "once", "send"]) expect(typeof surface[key]).toBe("function");
  });
});
