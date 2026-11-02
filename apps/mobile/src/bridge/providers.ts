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

import {
  discoveryProbeUrl,
  discoveryStyleForApiStyle,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { hasNativeHttp, nativeRequest } from "./native-http";

const STORE_KEY = "qn.local.providers";
const ACTIVE_KEY = "qn.local.activeProvider";
/**
 * The last answer each service gave to "what do you serve?", kept on the phone.
 *
 * The desktop answers the settings page from a persisted catalogue, paints it
 * at once, and refreshes in the background — that is why its list appears in
 * about a second. The phone used to keep only the model ids the user had typed,
 * so every visit waited on the network. This is the same cache the desktop has,
 * in the place the phone can keep it.
 */
const CATALOG_KEY = "qn.local.modelCatalog";

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

type CatalogEntry = { models: ModelInfo[]; fetchedAt: string };
type Catalog = Record<string, CatalogEntry>;

function readCatalog(store: ProviderStore): Catalog {
  const raw = store.readValue(CATALOG_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Catalog = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const candidate = entry as Partial<CatalogEntry>;
      if (!Array.isArray(candidate?.models)) continue;
      out[id] = {
        models: candidate.models.filter(
          (model): model is ModelInfo =>
            typeof (model as Partial<ModelInfo>)?.modelId === "string",
        ),
        fetchedAt: typeof candidate.fetchedAt === "string" ? candidate.fetchedAt : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCatalog(store: ProviderStore, catalog: Catalog): void {
  store.writeValue(CATALOG_KEY, JSON.stringify(catalog));
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

  /**
   * The models this service answered with last time, from the phone's cache.
   *
   * Empty when the service has never been asked. The settings page treats a
   * non-empty answer as "paint now, refresh behind it", which is the whole
   * point: the list is on screen before the network is consulted.
   */
  knownModels(providerId: string): ModelInfo[] {
    return readCatalog(this.store)[providerId]?.models ?? [];
  }

  /** Records what a service answered, so the next visit paints from disk. */
  rememberModels(providerId: string, models: ModelInfo[]): void {
    if (!providerId || models.length === 0) return;
    const catalog = readCatalog(this.store);
    catalog[providerId] = {
      models,
      fetchedAt: new Date().toISOString(),
    };
    writeCatalog(this.store, catalog);
  }

  /** Drops a service's cached list, for when its address or key changes. */
  forgetModels(providerId: string): void {
    const catalog = readCatalog(this.store);
    if (!(providerId in catalog)) return;
    delete catalog[providerId];
    writeCatalog(this.store, catalog);
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
 * How long one model-list probe may take.
 *
 * The desktop answers in about a second; a phone on a slow link needs more than
 * the eight seconds that used to be enough to prove "stuck", but a probe that
 * never returns leaves the page pinned on "connecting". The ceiling here is
 * the point where the page reports the failure and stays usable.
 */
const MODEL_PROBE_TIMEOUT_MS = 60_000;

/**
 * Asks the service what it serves.
 *
 * The URL and the auth headers come from the shared discovery rules, the same
 * ones the desktop probe uses, so a provider that loads on the desktop loads
 * on the phone too: an Anthropic-style base URL is asked at `/v1/models` with
 * `x-api-key`, a Google-style one at `/models?pageSize=1000&key=...`, and an
 * OpenAI-compatible one at `/models` with a bearer token.
 */
async function probeFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

/**
 * The plugin's own call: no localhost proxy, no mixed-content rule, and a
 * connect budget separate from the read budget so a dead endpoint fails in
 * seconds instead of pinning the page.
 */
async function probeNative(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const response = await nativeRequest(url, {
    method: "GET",
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    connectTimeoutMs: 8_000,
    readTimeoutMs: timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return typeof response.data === "string" ? (JSON.parse(response.data) as unknown) : response.data;
}

export async function listModels(input: {
  baseUrl?: string;
  apiKey?: string;
  apiStyle?: string;
  provider?: PhoneProvider | null;
}): Promise<{ models: ModelInfo[]; source: "remote" | "fallback"; error?: string }> {
  const baseUrl = (input.baseUrl ?? input.provider?.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = input.apiKey ?? input.provider?.apiKey ?? "";
  const apiStyle = input.apiStyle ?? input.provider?.apiStyle;
  if (!baseUrl) return { models: [], source: "fallback", error: "baseUrl is required" };

  const discoveryStyle = discoveryStyleForApiStyle(apiStyle);
  let url = discoveryProbeUrl(baseUrl, discoveryStyle);
  const headers: Record<string, string> = {};
  if (apiKey) {
    if (discoveryStyle === "anthropic_models") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (discoveryStyle === "google_models") {
      // Google carries the key in the query string, not in a header.
      const params = new URLSearchParams({ pageSize: "1000", key: apiKey });
      url = `${url}?${params}`;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  try {
    // On the phone the patched `fetch` goes through the local http proxy and
    // never settles; the plugin itself is the path that works. Desktop/CI keep
    // plain fetch, which is what the tests exercise.
    const body = hasNativeHttp()
      ? await probeNative(url, headers, MODEL_PROBE_TIMEOUT_MS)
      : await probeFetch(url, headers, MODEL_PROBE_TIMEOUT_MS);
    const rows = (body as { data?: unknown; models?: unknown }).data ??
      (body as { models?: unknown }).models;
    const list = Array.isArray(rows) ? rows : [];
    const models: ModelInfo[] = list
      .map((row) => {
        if (typeof row === "string") return row;
        const item = row as { id?: unknown; slug?: unknown; display_name?: unknown };
        const id = typeof item.id === "string" && item.id
          ? item.id
          : typeof item.slug === "string"
            ? item.slug
            : "";
        return id;
      })
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
