/**
 * The model the phone talks to when it runs the agent itself.
 *
 * Any OpenAI-compatible endpoint works, which covers the providers that matter
 * here without shipping a provider list that goes stale. The key lives in the
 * app's own storage and never leaves the device except as a request header.
 */

import type { ProviderConfig } from "./host";

const KEY = "qn.local.provider";

const EMPTY: ProviderConfig = { baseUrl: "", apiKey: "", modelId: "" };

export function loadProvider(): ProviderConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
    if (!parsed.baseUrl || !parsed.modelId || !parsed.apiKey) return null;
    return {
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      modelId: parsed.modelId,
    };
  } catch {
    return null;
  }
}

export function saveProvider(config: ProviderConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearProvider(): void {
  localStorage.removeItem(KEY);
}

export function isComplete(config: ProviderConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.modelId.trim() && config.apiKey.trim());
}

export { EMPTY as emptyProvider };
