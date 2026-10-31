import { describe, expect, it } from "vitest";
import { MemoryStore } from "../agent/store";
import { PhoneBridge } from "./desktop-bridge";

describe("phone session configuration", () => {
  it("merges partial updates and restores every selector through a fresh bridge", async () => {
    const store = new MemoryStore();
    const bridge = () => new PhoneBridge({ store, platform: "android", version: "2.2.0" });
    const api = bridge();
    const created = await api.invoke("session/create", {
      title: "configuration roundtrip", mode: "plan", thinkingLevel: "high",
      permissionMode: "ask", providerId: "p1", modelId: "m1",
    });
    expect(created.ok).toBe(true);
    const id = (created as { data: { session: { id: string } } }).data.session.id;
    const expected = { mode: "plan", thinkingLevel: "high", permissionMode: "ask", providerId: "p1", modelId: "m1" };
    expect(created).toMatchObject({ data: { session: expected } });
    await api.invoke("session/configure", id, { mode: "goal" });
    await api.invoke("session/configure", { id }, { thinkingLevel: "omit" });
    const restored = { ...expected, mode: "goal", thinkingLevel: "omit" };
    expect(await bridge().invoke("session/get", { sessionId: id })).toMatchObject({ data: { session: restored } });
    expect(await bridge().invoke("session/list")).toMatchObject({ data: { sessions: [restored] } });
    expect(await bridge().invoke("session/configure", id, { permissionMode: "inherit" }))
      .toMatchObject({ data: { session: { ...restored, permissionMode: "inherit" } } });
  });

  it("ignores corrupt stored fields and rejects invalid updates without losing valid state", async () => {
    const store = new MemoryStore();
    store.writeSession({ id: "s1", title: "existing", createdAt: "now", updatedAt: "now" });
    store.writeValue("qn.local.sessionConfig.s1", JSON.stringify({ mode: "broken", thinkingLevel: "turbo", permissionMode: "root", modelId: "kept" }));
    const api = new PhoneBridge({ store, platform: "android", version: "2.2.0" });
    expect(await api.invoke("session/get", "s1")).toMatchObject({ data: { session: {
      mode: "agent", thinkingLevel: "medium", permissionMode: "inherit", modelId: "kept",
    } } });
    for (const patch of [{ mode: "broken" }, { thinkingLevel: "turbo" }, { permissionMode: "root" }]) {
      expect(await api.invoke("session/configure", "s1", patch)).toMatchObject({ ok: false });
    }
    expect(await api.invoke("session/get", "s1")).toMatchObject({ data: { session: { modelId: "kept" } } });
  });
});