import { describe, expect, it } from "vitest";
import { PhoneBridge } from "./desktop-bridge";
import { MemoryStore } from "../agent/store";
import { bundledSkills } from "../agent/skills";

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
    if (result.ok) expect(result.data).toMatchObject({ ok: true, version: "2.2.0" });
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
    const value = result.data as { sessions: Array<Record<string, unknown>> };
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

  it("keeps the bundled skills out of the settings list but still readable by the runtime", async () => {
    const { bridge } = bridgeWith();
    const list = await bridge.invoke("pi-desktop/skill/list");
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.data as { skills: unknown[] }).skills).toEqual([]);

    const catalog = await bridge.invoke("pi-desktop/skill/catalog");
    if (catalog.ok) expect((catalog.data as { skills: unknown[] }).skills).toEqual([]);

    const bundled = bundledSkills()[0];
    const read = await bridge.invoke("pi-desktop/skill/read", { id: bundled.id });
    expect(read.ok).toBe(true);
    if (read.ok) expect((read.data as { body: string }).body).toBe(bundled.body);
  });

  it("exposes exactly the surface the preload promises", () => {
    const { bridge } = bridgeWith();
    const api = bridge.toWindowApi();
    expect(api.platform).toBe("android");
    const surface = api as unknown as Record<string, unknown>;
    for (const key of ["invoke", "on", "off", "once", "send"]) expect(typeof surface[key]).toBe("function");
  });
});

describe("PhoneBridge · ssh channels", () => {
  type FakePlugin = Record<string, (options?: Record<string, unknown>) => Promise<unknown>>;

  function withSsh(plugin: FakePlugin | null) {
    if (plugin) {
      (globalThis as unknown as { Capacitor: unknown }).Capacitor = {
        Plugins: { QnSsh: plugin },
      };
    } else {
      delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
    }
    return bridgeWith().bridge;
  }

  it("reports the machines and which ones are live", async () => {
    const bridge = withSsh({
      profiles: async () => ({
        profiles: [
          { id: "a", name: "Build box", host: "10.0.0.5", port: 22, user: "ci", enabled: true, auth: "key", fingerprint: "AA:BB", hasSecret: true },
        ],
      }),
      connect: async () => ({ sessionId: "a", fingerprint: "AA:BB" }),
      disconnect: async () => ({ ok: true }),
    });

    const before = await bridge.invoke("pi-desktop/ssh/profiles");
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.data).toMatchObject({ supported: true });

    await bridge.invoke("pi-desktop/ssh/connect", "a");
    const after = await bridge.invoke("pi-desktop/ssh/profiles");
    if (!after.ok) throw new Error("profiles failed");
    const value = after.data as { profiles: Array<{ connected: boolean }> };
    expect(value.profiles[0]?.connected).toBe(true);
  });

  it("says so instead of pretending when the build has no SSH client", async () => {
    const bridge = withSsh(null);
    const result = await bridge.invoke("pi-desktop/ssh/profiles");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ supported: false, profiles: [] });
  });

  it("hands a saved profile to the client with the typed fields", async () => {
    const seen: unknown[] = [];
    const bridge = withSsh({
      saveProfile: async (options) => {
        seen.push(options);
        return { id: "c", name: "box" };
      },
    });

    const result = await bridge.invoke("pi-desktop/ssh/save", {
      name: "box",
      host: "10.0.0.9",
      port: 2222,
      user: "me",
      auth: "key",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    });

    expect(result.ok).toBe(true);
    expect(seen[0]).toMatchObject({
      name: "box",
      host: "10.0.0.9",
      port: 2222,
      user: "me",
      auth: "key",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    });
  });

  it("refuses an empty command rather than opening a shell for nothing", async () => {
    const bridge = withSsh({
      shell: async () => ({ output: "", exitStatus: 0, cwd: "", timedOut: false }),
    });
    const result = await bridge.invoke("pi-desktop/ssh/run", { id: "a", command: "   " });
    expect(result.ok).toBe(false);
  });
});
