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

  it("asks an Anthropic-style address at /v1/models with its own auth header", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-sonnet-4-6" }] }),
    }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await listModels({
        baseUrl: "https://api.anthropic.test",
        apiKey: "secret-value",
        apiStyle: "anthropic_messages",
      });

      expect(result.source).toBe("remote");
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.test/v1/models");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("secret-value");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers.Authorization).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries a Google-style key in the query string", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "gemini-3-pro" }] }),
    }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await listModels({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "secret-value",
        apiStyle: "google_generative_ai",
      });

      expect(result.source).toBe("remote");
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("key=secret-value");
      expect(url).toContain("pageSize=1000");
      expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads a slug-shaped id from a Responses-style list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ slug: "glm-5.3" }, { id: "gpt-6.1" }] }),
      })),
    );
    try {
      const result = await listModels({ baseUrl: "https://api.example/v1" });
      expect(result.models.map((model) => model.modelId)).toEqual(["glm-5.3", "gpt-6.1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("provider channels", () => {
  it("returns an empty boot cache and keeps explicit refresh remote", async () => {
    const store = new MemoryStore();
    const provider = new ProviderBook(store).create({ name: "Empty", baseUrl: "https://offline.example/v1" });
    const api = new PhoneBridge({ store, platform: "android", version: "2.2.0" });
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "remote-model" }] }) }));
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await api.invoke("pi-desktop/providers/listModels", { providerId: provider.id, source: "cache" }))
        .toEqual({ ok: true, data: { source: "cache", models: [] } });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await api.invoke("pi-desktop/providers/listModels", { providerId: provider.id, source: "refresh" }))
        .toMatchObject({ ok: true, data: { source: "remote", models: [{ modelId: "remote-model" }] } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads boot model cache without contacting an unavailable provider", async () => {
    const store = new MemoryStore();
    const provider = new ProviderBook(store).create({
      name: "Offline", baseUrl: "https://offline.example/v1", models: [{ id: "cached-model" }],
    });
    const api = new PhoneBridge({ store, platform: "android", version: "2.2.0" });
    const fetcher = vi.fn(async () => { throw new Error("network must not be used"); });
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await api.invoke("pi-desktop/providers/listModels", { providerId: provider.id, source: "cache" });
      expect(result).toMatchObject({ ok: true, data: { source: "cache", models: [{ modelId: "cached-model", providerId: provider.id }] } });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  it("deletes a session addressed by a bare id", async () => {
    // `deleteSession` sends the id as the argument itself.
    const api = bridge();
    const created = await api.invoke("pi-desktop/session/create", { title: "旧对话" });
    const id = (created as unknown as { data: { session: { id: string } } }).data.session.id;

    const result = await api.invoke("pi-desktop/session/delete", id);
    expect((result as unknown as { data: { deleted: boolean } }).data.deleted).toBe(true);

    const listed = await api.invoke("pi-desktop/session/list");
    const sessions = (listed as unknown as { data: { sessions: Array<{ id: string }> } }).data.sessions;
    expect(sessions.some((session) => session.id === id)).toBe(false);
  });

  it("configures a session addressed by a bare id", async () => {
    // `configureSession` sends (id, config) positionally.
    const api = bridge();
    const created = await api.invoke("pi-desktop/providers/create", {
      name: "Agnes",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      secretValue: "k",
      models: [{ id: "agnes-3.0-flash" }],
    });
    const providerId = (created as unknown as { data: { provider: { id: string } } }).data.provider.id;
    const session = await api.invoke("pi-desktop/session/create", { title: "对话" });
    const id = (session as unknown as { data: { session: { id: string } } }).data.session.id;

    const result = await api.invoke("pi-desktop/session/configure", id, {
      providerId,
      modelId: "agnes-3.0-flash",
    });
    expect((result as unknown as { data: { session: { modelId: string } } }).data.session.modelId).toBe(
      "agnes-3.0-flash",
    );
  });

  it("stores a per-conversation system prompt and reads it back", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/session/create", { title: "对话" });
    const id = (created as unknown as { data: { session: { id: string } } }).data.session.id;

    await api.invoke("pi-desktop/session/setSystemPrompt", id, "  只用中文回答。 ");

    const detail = await api.invoke("pi-desktop/session/get", { id });
    const session = (detail as unknown as { data: { session: { systemPrompt?: string } } }).data.session;
    expect(session.systemPrompt).toBe("只用中文回答。");

    await api.invoke("pi-desktop/session/setSystemPrompt", id, "   ");
    const cleared = await api.invoke("pi-desktop/session/get", { id });
    const after = (cleared as unknown as { data: { session: { systemPrompt?: string } } }).data.session;
    expect(after.systemPrompt ?? null).toBeNull();
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

/*
  The phone keeps the last discovery answer. Without it every visit to the
  settings page started from an empty list and waited on the network, which is
  why the desktop (which answers from a persisted catalogue) showed its models
  in a second and the phone did not.
*/
describe("discovered model catalogue", () => {
  const discovered = (id: string) => ({
    modelId: id,
    displayName: id,
    providerId: "pv_1",
    capabilities: ["text" as const],
    source: "discovered" as const,
  });

  it("keeps what a service answered and returns it on the next visit", () => {
    const providers = book();
    providers.rememberModels("pv_1", [discovered("agnes-3.0-flash")]);

    expect(providers.knownModels("pv_1").map((model) => model.modelId)).toEqual([
      "agnes-3.0-flash",
    ]);
  });

  it("survives a restart, because the cache outlives the object", () => {
    const store = new MemoryStore();
    new ProviderBook(store).rememberModels("pv_1", [discovered("agnes-3.0-pro")]);

    expect(new ProviderBook(store).knownModels("pv_1")).toHaveLength(1);
  });

  it("has nothing to say about a service it never asked", () => {
    expect(book().knownModels("pv_unknown")).toEqual([]);
  });

  it("does not remember an empty answer, which is not a catalogue", () => {
    const providers = book();
    providers.rememberModels("pv_1", [discovered("agnes-3.0-flash")]);
    providers.rememberModels("pv_1", []);

    expect(providers.knownModels("pv_1")).toHaveLength(1);
  });

  it("forgets a service's list when asked to", () => {
    const providers = book();
    providers.rememberModels("pv_1", [discovered("agnes-3.0-flash")]);
    providers.forgetModels("pv_1");

    expect(providers.knownModels("pv_1")).toEqual([]);
  });
});
