import type {
  ModelInfo,
  Mode,
  PermissionMode,
  ProviderPublic,
  SessionThinkingLevel,
  ThinkingLevel,
} from "@pi-desktop/shared";
import {
  isSessionThinkingLevel,
  PERMISSION_MODES,
  sessionThinkingMenuLevels,
} from "@pi-desktop/shared";
import { sameComposerModelId } from "../../../lib/composer-models.ts";
import { providerThinkingLevels } from "../../../lib/session-thinking.ts";

export const COMPOSER_MIN_HEIGHT_PX = 28;
export const COMPOSER_MAX_VISIBLE_ROWS = 7;

export const PLACEHOLDER_KEYS = {
  home: [
    "chat.placeholderHome",
    "chat.placeholderHomeHint",
    "chat.placeholderShortcut",
  ],
  docked: [
    "chat.placeholder",
    "chat.placeholderHint",
    "chat.placeholderShortcut",
  ],
} as const;

export const MODE_CYCLE: readonly Mode[] = ["agent", "plan", "goal"];

export const MODE_LABEL_KEYS: Record<Mode, string> = {
  agent: "settings.modeAgent",
  plan: "settings.modePlan",
  goal: "settings.modeGoal",
};

export { PERMISSION_MODE_I18N_KEYS } from "../../../lib/permission-mode-labels.ts";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ComposerPrefill = {
  text: string;
  token: number;
};

export type ComposerFileReference = {
  id: string;
  sessionId: string;
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  token?: string;
};

/**
 * i18n key for a reasoning level's short label. The composer shows these
 * localized (关闭/最小/低/中/高/极高/最高/默认) on the reasoning pill and in its
 * menu; the wire value stays the canonical English token.
 */
const REASONING_LEVEL_LABEL_KEYS: Record<SessionThinkingLevel, string> = {
  off: "chat.reasoningLevelOff",
  minimal: "chat.reasoningLevelMinimal",
  low: "chat.reasoningLevelLow",
  medium: "chat.reasoningLevelMedium",
  high: "chat.reasoningLevelHigh",
  xhigh: "chat.reasoningLevelXhigh",
  max: "chat.reasoningLevelMax",
  omit: "chat.reasoningLevelOmit",
};

export function reasoningLevelLabelKey(level: string): string {
  return (
    REASONING_LEVEL_LABEL_KEYS[level as SessionThinkingLevel] ??
    "chat.reasoningLevelOff"
  );
}

/**
 * Levels the reasoning pill offers (D630). When the model publishes a ladder,
 * use it (do-not-send first, then the enabled levels). When it does not, the
 * pill still shows the full canonical ladder so the control is never hidden —
 * a non-reasoning model simply starts at `off`, and the user can force a level
 * up for a model whose catalog metadata is missing or stale (local / proxy /
 * newly released). The wire value stays canonical; only the label is localized.
 */
export function reasoningPickerLevels(
  available: readonly ThinkingLevel[] | undefined,
): SessionThinkingLevel[] {
  if (available && available.length > 0) {
    return sessionThinkingMenuLevels(available);
  }
  return [...THINKING_LEVELS];
}

export function nextMode(mode: Mode): Mode {
  const index = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "agent";
}

export function isThinkingLevel(value: unknown): value is SessionThinkingLevel {
  return isSessionThinkingLevel(value);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    PERMISSION_MODES.includes(value as PermissionMode)
  );
}

/**
 * Preserve the current level when changing providers, but never carry a
 * reasoning level into a provider that cannot accept it.
 */
export function thinkingLevelForProvider(
  provider: ProviderPublic | null | undefined,
  current: SessionThinkingLevel,
): SessionThinkingLevel {
  const available = providerThinkingLevels(provider);
  if (!provider?.supportsReasoning) return "off";
  if (current === "omit") return "omit";
  if (available.includes(current)) return current;
  const requestedIndex = THINKING_LEVELS.indexOf(current);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  return "off";
}

/**
 * Project the selected catalog model onto a provider for draft sessions.
 *
 * Persisted sessions receive these exact capabilities from Electron main.
 * Before the first message creates a session, the provider row only describes
 * its default model, so use the selected catalog record and exact model
 * binding when one is available.
 */
export function thinkingProviderForModel(
  provider: ProviderPublic | null | undefined,
  modelId: string | undefined,
  modelCatalog: readonly ModelInfo[] | undefined,
): ProviderPublic | null | undefined {
  if (!provider || !modelId) return provider;
  const model = modelCatalog?.find((candidate) => sameComposerModelId(candidate.modelId, modelId));

  const binding = provider.models.find((candidate) =>
    sameComposerModelId(candidate.id, modelId),
  );
  const configuredLevels = binding
    ? THINKING_LEVELS.filter((level) => binding.thinkingLevels.includes(level))
    : undefined;

  if (!model) {
    // No catalog match: all thinking levels selectable, default off.
    // A binding override still takes precedence when present.
    // An empty binding is the generic seed for an unknown model, not an
    // explicit disable; `off` is the persisted opt-out for that case.
    const unmatchedLevels = configuredLevels?.length ? configuredLevels : undefined;
    const supportsReasoning = unmatchedLevels
      ? unmatchedLevels.some((level) => level !== "off")
      : true;
    return {
      ...provider,
      supportsReasoning,
      supportedThinkingLevels:
        unmatchedLevels ?? [...THINKING_LEVELS],
    };
  }

  const supportsReasoning = configuredLevels
    ? configuredLevels.some((level) => level !== "off")
    : model.reasoning === true || model.capabilities.includes("reasoning");
  return {
    ...provider,
    supportsReasoning,
    supportedThinkingLevels:
      configuredLevels ?? model.supportedThinkingLevels ?? provider.supportedThinkingLevels,
  };
}

export function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export { sessionThinkingMenuLevels };
