import {
  API_STYLES,
  OPENCODE_GO_API_STYLE,
  matchNamedPreset,
  type CatalogApiStyle,
  type ProviderPublic,
} from "@pi-desktop/shared";

export function isAccountOnlyApiStyle(style?: string): boolean {
  return style === "openai_codex_responses" || style === "pi_messages";
}

/** The transport vocabulary also contains account-only and named-service APIs. */
export const CUSTOM_PROVIDER_API_STYLES = API_STYLES.filter(
  (style) => !isAccountOnlyApiStyle(style) && style !== OPENCODE_GO_API_STYLE,
);

/** Localized names for every transport in the catalog. */
export const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

export function needsCustomApiStyleChoice(
  style: CatalogApiStyle,
  savedStyle?: string,
): boolean {
  // Editing may retain a legacy value; creation/copy must explicitly choose.
  return isAccountOnlyApiStyle(style) && style !== savedStyle;
}

/**
 * Auth kind for a provider saved from the setup dialog.
 *
 * A local / self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM,
 * llama.cpp) authenticates nothing, so it is stored as `none`. That happens
 * when the custom endpoint is saved without a key, or when a keyless local
 * preset is chosen and left without one. Readiness
 * (`providerServesChatModels`), launch (`session-launch`), and the runtime
 * request key all already treat `none` as a keyless provider, and a key added
 * later still wins over the placeholder — so `none` is a safe superset of
 * "no key required". A cloud vendor, or any endpoint given a key, stays
 * `api_key_and_base_url`.
 */
export function providerAuthKindForSetup(input: {
  custom: boolean;
  localNoAuthPreset?: boolean;
  apiKey: string;
}): "none" | "api_key_and_base_url" {
  if (input.apiKey.trim()) return "api_key_and_base_url";
  return input.custom || input.localNoAuthPreset ? "none" : "api_key_and_base_url";
}

export function providerSetupPreset(provider?: ProviderPublic | null) {
  if (!provider || isAccountOnlyApiStyle(provider.apiStyle)) return undefined;
  const preset = matchNamedPreset({
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
  });
  // A published hostname does not override an explicitly saved wire format.
  return provider.apiStyle && preset?.apiStyle !== provider.apiStyle ? undefined : preset;
}
