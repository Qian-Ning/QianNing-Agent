/**
 * Everything the phone remembers about how its agent should behave.
 *
 * The provider is one record because a half-filled provider is not a provider.
 * The rest is a separate record so changing a prompt or a token cap does not
 * rewrite the credential, and so a failed read of one cannot corrupt the other.
 */

import type { ProviderConfig } from "./host";
import type { ThinkingLevel } from "../lib/racp";

const KEY = "qn.local.provider";
const PREFS_KEY = "qn.local.prefs";

const EMPTY: ProviderConfig = { baseUrl: "", apiKey: "", modelId: "" };

export type AgentPrefs = {
  /** Appended to the built-in instructions; empty means "use them as they are". */
  systemPrompt?: string;
  /** Upper bound for one answer. */
  maxTokens?: number;
};

export const DEFAULT_PREFS: AgentPrefs = { systemPrompt: "", maxTokens: 4096 };

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
      ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
    };
  } catch {
    return null;
  }
}

export function saveProvider(config: ProviderConfig): void {
  // Thinking is part of the provider row: it is chosen per model, not globally.
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearProvider(): void {
  localStorage.removeItem(KEY);
}

export function isComplete(config: ProviderConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.modelId.trim() && config.apiKey.trim());
}

export function loadPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<AgentPrefs>;
    return {
      systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "",
      maxTokens:
        typeof parsed.maxTokens === "number" && parsed.maxTokens > 0
          ? Math.min(parsed.maxTokens, 128_000)
          : DEFAULT_PREFS.maxTokens,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: AgentPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export type { ThinkingLevel };
export { EMPTY as emptyProvider };
