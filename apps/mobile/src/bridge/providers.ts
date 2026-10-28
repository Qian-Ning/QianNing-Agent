/**
 * The phone's model services, in the shape the desktop settings page expects.
 *
 * The desktop host stores providers in SQLite and encrypts keys; the phone keeps
 * its own record in local storage and hands the key to the agent host directly.
 * What both must agree on is the *shape*: `providers/*` answers `ProviderPublic`
 * rows, `providers/listModels` answers `ModelInfo` rows, and the composer reads
 * `defaultProviderId` / `defaultModelId` from settings (ADR 0339).
 *
 * One provider is active at a time; that is the one the agent host runs. The
 * list still holds every service the user added, so switching back does not
 * require re-entering a key.
 */

import type { ModelBinding, ModelInfo, ProviderPublic } from "@pi-desktop/shared";

const STORE_KEY = "qn.local.providers";
const ACTIVE_KEY = "qn.local.activeProvider";

/** What a phone provider row is, before it is dressed up as a desktop one. */
export type PhoneProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiStyle: string;
  /** Model ids this service has been told about, in the order they were added. */
  models: string[];
  defaultModelId: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderStore = {
  readValue(key: string): string | null;
  writeValue(key: string, value: string): void;
};

const LIMITS = { contextWindow: 128_000, maxTokens: 8_192 };

/** A provider row as the settings page sees it. Never carries the key itself. */
export function toPublic(provider: PhoneProvider): ProviderPublic {
  const models: ModelBinding[] = provider.models.map((id) => ({
    id,
    contextWindow: LIMITS.contextWindow,
    maxTokens: LIMITS.maxTokens,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  }));

  return {
    id: provider.id,
    name: provider.name,
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai-completions",
    enabled: true,
    baseUrl: provider.baseUrl,
    authKind: "api_key",
    hasSecret: provider.apiKey.length > 0,
    models,
    defaultModelId: provider.defaultModelId || models[0]?.id,
    apiStyle: provider.apiStyle,
    supportsReasoning: false,
    supportedThinkingLevels: [],
    supportsVision: false,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function readJson(store: ProviderStore, key: string): PhoneProvider[] {
  const raw = store.readValue(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is PhoneProvider => {
      const candidate = row as Partial<PhoneProvider>;
      return typeof candidate?.id === "string" && typeof candidate?.baseUrl === "string";
    });
  } catch {
    return [];
  }
}

export class ProviderBook {
  constructor(private readonly store: ProviderStore) {}

  list(): PhoneProvider[] {
    return readJson(this.store, STORE_KEY);
  }

  get(id: string): PhoneProvider | null {
    return this.list().find((provider) => provider.id === id) ?? null;
  }

  /** The service a turn runs against: the chosen one, else the first. */
  active(): PhoneProvider | null {
    const providers = this.list();
    const activeId = this.store.readValue(ACTIVE_KEY);
    return providers.find((provider) => provider.id === activeId) ?? providers[0] ?? null;
  }

  setActive(id: string): void {
    if (this.get(id)) this.store.writeValue(ACTIVE_KEY, id);
  }

  create(input: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    apiStyle?: string;
    models?: Array<{ id: string }>;
    defaultModelId?: string;
  }): PhoneProvider {
    const now = new Date().toISOString();
    const models = (input.models ?? []).map((model) => model.id).filter(Boolean);
    const provider: PhoneProvider = {
      id: `pv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: input.name?.trim() || hostOf(input.baseUrl ?? "") || "AI 服务",
      baseUrl: (input.baseUrl ?? "").trim().replace(/\/+$/, ""),
      apiKey: input.apiKey ?? "",
      apiStyle: input.apiStyle ?? "openai-completions",
      models,
      defaultModelId: input.defaultModelId ?? models[0] ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.save([...this.list(), provider]);
    if (!this.store.readValue(ACTIVE_KEY)) this.store.writeValue(ACTIVE_KEY, provider.id);
    return provider;
  }

  update(input: {
    id: string;
    name?: string;
    baseUrl?: string;
    apiStyle?: string;
    models?: Array<{ id: string }>;
    defaultModelId?: string;
    enabled?: boolean;
  }): PhoneProvider | null {
    const providers = this.list();
    const index = providers.findIndex((provider) => provider.id === input.id);
    if (index < 0) return null;

    const current = providers[index];
    const models = input.models ? input.models.map((model) => model.id).filter(Boolean) : current.models;
    const next: PhoneProvider = {
      ...current,
      name: input.name?.trim() || current.name,
      baseUrl: input.baseUrl?.trim().replace(/\/+$/, "") ?? current.baseUrl,
      apiStyle: input.apiStyle ?? current.apiStyle,
      models,
      defaultModelId: input.defaultModelId ?? current.defaultModelId,
      updatedAt: new Date().toISOString(),
    };
    providers[index] = next;
    this.save(providers);
    return next;
  }

  /** Sets or clears the key. The value never leaves this call. */
  setSecret(id: string, secretValue: string | undefined): PhoneProvider | null {
    const providers = this.list();
    const index = providers.findIndex((provider) => provider.id === id);
    if (index < 0) return null;
    providers[index] = {
      ...providers[index],
      apiKey: secretValue ?? "",
      updatedAt: new Date().toISOString(),
    };
    this.save(providers);
    return providers[index];
  }

  remove(id: string): void {
    this.save(this.list().filter((provider) => provider.id !== id));
    if (this.store.readValue(ACTIVE_KEY) === id) {
      const next = this.list()[0];
      this.store.writeValue(ACTIVE_KEY, next ? next.id : "");
    }
  }

  private save(providers: PhoneProvider[]): void {
    this.store.writeValue(STORE_KEY, JSON.stringify(providers));
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/**
 * Asks the service what it serves.
 *
 * Returns an empty list with an error instead of throwing: the settings page
 * shows the reason next to the refresh button, and a provider that cannot list
 * models can still be used with a hand-typed id.
 */
export async function listModels(input: {
  baseUrl?: string;
  apiKey?: string;
  provider?: PhoneProvider | null;
}): Promise<{ models: ModelInfo[]; source: "remote" | "fallback"; error?: string }> {
  const baseUrl = (input.baseUrl ?? input.provider?.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = input.apiKey ?? input.provider?.apiKey ?? "";
  if (!baseUrl) return { models: [], source: "fallback", error: "baseUrl is required" };

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!response.ok) {
      return { models: [], source: "fallback", error: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    const rows = (body as { data?: unknown }).data;
    if (!Array.isArray(rows)) return { models: [], source: "fallback", error: "unexpected model list" };

    const models: ModelInfo[] = rows
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => ({
        modelId: id,
        displayName: id,
        providerId: input.provider?.id ?? "",
        // What we can honestly claim without a catalog lookup: a chat model.
        capabilities: ["text" as const],
        source: "discovered" as const,
      }));

    return { models, source: "remote" };
  } catch (cause) {
    return {
      models: [],
      source: "fallback",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
