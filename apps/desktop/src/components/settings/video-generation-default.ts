/**
 * Keeping the app's default video model across a provider save.
 *
 * `settings.videoGeneration` is the binding `GenerateVideos` runs, while
 * `settings.videoGenerationModels` only lists the candidates the picker offers.
 * Saving a provider may extend that list, but adding one must not take over the
 * default: the chat default's rule applies here too — the stored choice
 * survives while a configured provider can actually run it, and only an
 * unrunnable or explicitly deselected one is replaced.
 *
 * "Can run it" is one rule everywhere: this file, the picker row
 * (`VideoGenerationModelRow.tsx`) and the runtime
 * (`electron/main/services/video-generation-service.ts`) all require an
 * enabled, non-OAuth provider with a base URL, a usable credential and a
 * configured model exactly matching the binding. A binding that only looks
 * present — disabled provider, missing key, OAuth-only row, or a model id the
 * provider does not configure — fails at send time, so it must never be kept as
 * the default either.
 */
import {
  MAX_VIDEO_GENERATION_MODELS,
  modelWireIdsEqual as sameComposerModelId,
  videoGenerationBindings,
  type ProviderPublic,
  type VideoGenerationBinding,
} from "@pi-desktop/shared";

/**
 * True when `provider` can actually run `modelId` for video generation now.
 *
 * The single source of truth for video availability, mirroring the image rule
 * and the service's own guard: a disabled row, an OAuth account, a missing
 * credential or a model the row does not configure all fail at send time.
 */
export function videoGenerationBindingAvailable(
  provider: ProviderPublic | undefined,
  modelId: string,
): boolean {
  if (!provider || !provider.enabled) return false;
  return (
    provider.authKind !== "oauth" &&
    !!provider.baseUrl &&
    (provider.hasSecret || provider.authKind === "none") &&
    provider.models.some((model) => model.id === modelId)
  );
}

/** True when the binding can be run by the enabled provider it names. */
export function resolvesVideoGenerationDefault(
  binding: VideoGenerationBinding | null | undefined,
  providers: readonly ProviderPublic[],
): boolean {
  if (!binding) return false;
  const provider = providers.find((candidate) => candidate.id === binding.providerId);
  return videoGenerationBindingAvailable(provider, binding.modelId);
}

export type VideoGenerationDefaultDraft = {
  videoGenerationModels?: readonly VideoGenerationBinding[] | null;
  videoGeneration?: VideoGenerationBinding | null;
};

export type VideoGenerationDefaultPlan = {
  videoGenerationModels: VideoGenerationBinding[];
  videoGeneration: VideoGenerationBinding | null;
};

/**
 * Trim the candidate list to the host's cap without dropping the active
 * binding: the settings channel rejects a longer list outright, and losing the
 * default's own row would leave the picker unable to show what runs.
 */
function cappedVideoGenerationCandidates(
  candidates: readonly VideoGenerationBinding[],
  active: VideoGenerationBinding | null,
): VideoGenerationBinding[] {
  if (candidates.length <= MAX_VIDEO_GENERATION_MODELS) return [...candidates];
  const activeIndex = active
    ? candidates.findIndex((candidate) =>
        candidate.providerId === active.providerId &&
        sameComposerModelId(candidate.modelId, active.modelId),
      )
    : -1;
  if (activeIndex < MAX_VIDEO_GENERATION_MODELS - 1) {
    return candidates.slice(0, MAX_VIDEO_GENERATION_MODELS);
  }
  const head = candidates
    .filter((_, index) => index !== activeIndex)
    .slice(0, MAX_VIDEO_GENERATION_MODELS - 1);
  return [...head, candidates[activeIndex]];
}

/**
 * The candidate list and active default a saved provider should leave behind.
 *
 * The saved provider's selection replaces its own earlier candidates, while the
 * candidates of other providers stay listed — minus the rows whose provider is
 * gone. The active default moves only when explicitly deselected or no longer
 * runnable, and then to the first candidate that is, so a newly added provider
 * claims the default exactly when nothing else can hold it. Clearing every
 * video model on the provider that holds the default leaves it unchecked
 * instead. When nothing can run, the default stays empty rather than naming a
 * binding that would fail on the next request.
 */
export function planVideoGenerationDefaults(
  current: VideoGenerationDefaultDraft,
  savedProviderId: string,
  selectedModelIds: readonly string[],
  providers: readonly ProviderPublic[],
  removedDefaultModel = false,
): VideoGenerationDefaultPlan {
  const existing = videoGenerationBindings(
    current.videoGenerationModels,
    current.videoGeneration,
  );
  const selected = [...new Set(selectedModelIds)].map((modelId) => ({
    providerId: savedProviderId,
    modelId,
  }));
  const previous = current.videoGeneration ?? null;
  const active = previous?.providerId === savedProviderId &&
    !selected.some((binding) => sameComposerModelId(binding.modelId, previous.modelId))
    ? null
    : previous;
  const videoGenerationModels = cappedVideoGenerationCandidates(
    [...existing.filter((binding) => binding.providerId !== savedProviderId), ...selected]
      .filter((binding) =>
        providers.some((provider) => provider.id === binding.providerId),
      ),
    active,
  );
  const fallback = videoGenerationModels.find((binding) =>
    resolvesVideoGenerationDefault(binding, providers)
  ) ?? null;
  const clearedActiveProvider =
    selected.length === 0 && previous?.providerId === savedProviderId;
  return {
    videoGenerationModels,
    videoGeneration: removedDefaultModel || clearedActiveProvider
      ? null
      : resolvesVideoGenerationDefault(active, providers) ? active : fallback,
  };
}
