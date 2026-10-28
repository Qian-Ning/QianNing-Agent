import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../agent/store";
import { PhoneBridge } from "./desktop-bridge";
import { ProviderBook, listModels, toPublic } from "./providers";

function book() {
  return new ProviderBook(new MemoryStore());
}

describe("ProviderBook", () => {
  it("adds a service and makes the first one active", () => {
    const providers = book();
    const created = providers.create({
      name: "Agnes",
      baseUrl: "https://apihub.agnes-ai.com/v1/",
      apiKey: "k",
      models: [{ id: "agnes-3.0-flash" }],
    });

    expect(created.baseUrl).toBe("https://apihub.agnes-ai.com/v1");
    expect(providers.active()?.id).toBe(created.id);
    expect(providers.list()).toHaveLength(1);
  });

  it("names a service from its host when the user leaves the name empty", () => {
    const providers = book();
    const created = providers.create({ baseUrl: "https://api.example.com/v1" });
    expect(created.name).toBe("api.example.com");
  });

  it("keeps the key out of the row the settings page sees", () => {
    const providers = book();
    const created = providers.create({ name: "x", baseUrl: "https://a.example/v1", apiKey: "sk-secret" });
    const published = toPublic(created);

    expect(published.hasSecret).toBe(true);
    expect(JSON.stringify(published)).not.toContain("sk-secret");
  });

  it("switches the active service without losing the other one", () => {
    const providers = book();
    const first = providers.create({ name: "one", baseUrl: "https://one.example/v1" });
    const second = providers.create({ name: "two", baseUrl: "https://two.example/v1" });

    providers.setActive(second.id);
    expect(providers.active()?.id).toBe(second.id);
    expect(providers.list()).toHaveLength(2);
    expect(providers.get(first.id)?.name).toBe("one");
  });

  it("clears a key through setSecret and reports it as missing", () => {
    const providers = book();
    const created = providers.create({ name: "x", baseUrl: "https://a.example/v1", apiKey: "sk" });

    const cleared = providers.setSecret(created.id, undefined);

    expect(cleared?.apiKey).toBe("");
    expect(toPublic(cleared!).hasSecret).toBe(false);
  });

  it("falls back to the next service when the active one is deleted", () => {
    const providers = book();
    const first = providers.create({ name: "one", baseUrl: "https://one.example/v1" });
    const second = providers.create({ name: "two", baseUrl: "https://two.example/v1" });

    providers.remove(first.id);
    expect(providers.active()?.id).toBe(second.id);
  });
});

describe("listModels", () => {
  it("reads the ids the service publishes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "agnes-3.0-flash" }, { id: "agnes-2.5-flash" }] }),
      })),
    );

    const result = await listModels({ baseUrl: "https://api.example/v1", apiKey: "k" });

    expect(result.source).toBe("remote");
    expect(result.models.map((model) => model.modelId)).toEqual(["agnes-3.0-flash", "agnes-2.5-flash"]);
    vi.unstubAllGlobals();
  });

  it("reports the status instead of throwing when the endpoint refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));

    const result = await listModels({ baseUrl: "https://api.example/v1" });

    expect(result.models).toEqual([]);
    expect(result.error).toContain("401");
    vi.unstubAllGlobals();
  });

  it("says what is missing when there is no address", async () => {
    const result = await listModels({ baseUrl: "" });
    expect(result.error).toContain("baseUrl");
  });
});

describe("provider channels", () => {
  function bridge() {
    const store = new MemoryStore();
    return new PhoneBridge({ store, platform: "android", version: "2.2.0", now: () => 1_700_000_000_000 });
  }

  it("creates a provider and exposes it in the list", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/providers/create", {
      name: "Agnes",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      secretValue: "k",
      models: [{ id: "agnes-3.0-flash" }],
    });

    expect(created.ok).toBe(true);
    const listed = await api.invoke("pi-desktop/providers/list");
    expect((listed as unknown as { data: { providers: Array<{ name: string }> } }).data.providers[0].name).toBe("Agnes");
  });

  it("reports the active provider as the default the composer reads", async () => {
    const api = bridge();
    await api.invoke("pi-desktop/providers/create", {
      name: "Agnes",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      secretValue: "k",
      models: [{ id: "agnes-3.0-flash" }],
    });

    const settings = await api.invoke("pi-desktop/settings/get");
    const value = (settings as unknown as { data: { defaultProviderId: string; defaultModelId: string } }).data;
    expect(value.defaultProviderId).toMatch(/^pv_/);
    expect(value.defaultModelId).toBe("agnes-3.0-flash");
  });

  it("opens a session with its transcript", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/session/create", { title: "对话" });
    const id = (created as unknown as { data: { session: { id: string } } }).data.session.id;

    const opened = await api.invoke("pi-desktop/session/get", { sessionId: id });
    const detail = (opened as unknown as { data: { session: { title: string; messages: unknown[] } } }).data.session;

    expect(detail.title).toBe("对话");
    expect(detail.messages).toEqual([]);
  });

  it("answers the renderer's argument name for a session", async () => {
    // lib/api.ts sends `{ id }`; other channels use `{ sessionId }`.
    const api = bridge();
    const created = await api.invoke("pi-desktop/session/create", { title: "对话" });
    const id = (created as unknown as { data: { session: { id: string } } }).data.session.id;

    const opened = await api.invoke("pi-desktop/session/get", { id });
    expect((opened as unknown as { data: { session: { id: string } } }).data.session.id).toBe(id);
  });

  it("keeps the model the composer picked for a conversation", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/providers/create", {
      name: "Agnes",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      secretValue: "k",
      models: [{ id: "agnes-3.0-flash" }, { id: "agnes-2.5-flash" }],
    });
    const providerId = (created as unknown as { data: { provider: { id: string } } }).data.provider.id;
    const session = await api.invoke("pi-desktop/session/create", { title: "对话" });
    const sessionId = (session as unknown as { data: { session: { id: string } } }).data.session.id;

    await api.invoke("pi-desktop/session/configure", { id: sessionId }, {
      providerId,
      modelId: "agnes-2.5-flash",
      thinkingLevel: "high",
    });

    const settings = await api.invoke("pi-desktop/settings/get");
    const value = (settings as unknown as { data: { defaultModelId: string } }).data;
    expect(value.defaultModelId).toBe("agnes-2.5-flash");
  });

  it("renames a session", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/session/create", { title: "旧名" });
    const id = (created as unknown as { data: { session: { id: string } } }).data.session.id;

    await api.invoke("pi-desktop/session/rename", { sessionId: id, title: "新名" });
    const opened = await api.invoke("pi-desktop/session/get", { sessionId: id });

    expect((opened as unknown as { data: { session: { title: string } } }).data.session.title).toBe("新名");
  });
});
