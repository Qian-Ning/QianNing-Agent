import type {
  Mode,
  ProviderPublic,
  SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  generationModelRefs,
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  isGenerationModel,
} from "@pi-desktop/shared";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  composerModelsForProvider,
  sameComposerModelId,
} from "../../../../lib/composer-models";
import { composerActiveEntryIndex } from "../../../../lib/composer-model-selector";
import {
  providerDisplayName,
  providerSearchText,
} from "../../../../lib/provider-display";
import { providerThinkingLevels } from "../../../../lib/session-thinking";
import { useAppStore } from "../../../../stores/app-store";
import {
  reasoningPickerLevels,
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../model";
import { createLatestCommitQueue } from "../thinking-commit-queue";
import { useComposerModelSelector } from "./useComposerModelSelector";

type UseComposerModelMenuOptions = {
  mode: Mode;
  activeSessionId: string | null | undefined;
  provider: ProviderPublic | undefined;
  modelId: string | undefined;
  thinkingProvider: ProviderPublic | null | undefined;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
  configureActiveSession: (configuration: {
    mode: Mode; providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel;
  }) => Promise<void>;
};

/**
 * Shared state and commit logic for the composer's two separate pills — the
 * model picker and the reasoning-level picker (D629). Each menu owns its own
 * open flag so one can be open while the other is closed, but both share the
 * selection writes, the latest-wins reasoning commit queue, and the keyboard
 * contract so a model switch and a reasoning change stay consistent.
 */
export function useComposerModelMenu({
  mode,
  activeSessionId,
  provider,
  modelId,
  thinkingProvider: resolvedThinkingProvider,
  thinkingLevel,
  controlsBlocked,
  configureActiveSession,
}: UseComposerModelMenuOptions) {
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const generationCandidates = useMemo(() => generationModelRefs(settings), [settings]);
  const providerModels = useAppStore((s) => s.providerModels);
  const loadProviderModels = useAppStore((s) => s.loadProviderModels);
  const showToast = useAppStore((s) => s.showToast);
  const [modelOpen, setModelOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [modelHighlight, setModelHighlight] = useState(-1);
  const [thinkingHighlight, setThinkingHighlight] = useState(-1);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const thinkingListRef = useRef<HTMLDivElement>(null);
  const thinkingConfigRef = useRef({
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  });
  thinkingConfigRef.current = {
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  };
  const thinkingQueueRef = useRef<ReturnType<typeof createLatestCommitQueue<SessionThinkingLevel>> | null>(
    null,
  );
  if (!thinkingQueueRef.current) {
    thinkingQueueRef.current = createLatestCommitQueue<SessionThinkingLevel>({
      send: async (level) => {
        const current = thinkingConfigRef.current;
        await current.configureActiveSession({
          mode: current.mode,
          providerId: current.providerId,
          modelId: current.modelId,
          thinkingLevel: level,
        });
      },
      onError: (error) => {
        const current = thinkingConfigRef.current;
        current.showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      },
    });
  }

  const thinkingProvider =
    resolvedThinkingProvider ??
    thinkingProviderForModel(
      provider,
      modelId,
      provider ? providerModels[provider.id] : undefined,
    );
  const availableThinkingLevels = providerThinkingLevels(thinkingProvider);
  const thinkingMenuLevels = reasoningPickerLevels(availableThinkingLevels);
  // The reasoning pill is ALWAYS shown so the control is never hidden (D630):
  // a model with a published ladder gets its ladder; a model that publishes no
  // ladder (non-reasoning, or one whose catalog metadata is missing/stale)
  // still gets the full canonical ladder and simply defaults to `off`.
  const hasReasoning = true;
  const modelPublishesReasoning = availableThinkingLevels.length > 0;
  const modelGroups = useMemo(
    () =>
      providers
        .filter(
          (candidate) =>
            candidate.enabled &&
            (candidate.hasSecret || candidate.authKind === "none"),
        )
        .map((candidate) => {
          const models = composerModelsForProvider(
            candidate,
            providerModels[candidate.id],
            generationCandidates,
          );
          return {
            provider: candidate,
            providerDisplayName: providerDisplayName(candidate),
            providerSearchText: providerSearchText(candidate),
            models,
          };
        })
        .filter((group) => group.models.length > 0),
    [providers, providerModels, generationCandidates],
  );
  // Favorites, recents, capability filters and the active rail source live in a
  // dedicated hook; the pane it derives IS the flat, keyboard-navigable list.
  const selector = useComposerModelSelector({
    groups: modelGroups,
    query,
    menuOpen: modelOpen,
    selectedProviderId: provider?.id,
    selectedModelId: modelId,
  });
  const flatModels = selector.paneEntries;
  const flatModelsKey = useMemo(
    () => flatModels.map((entry) => entry.key).join("|"),
    [flatModels],
  );
  const activeFlatIndex = useMemo(
    () => composerActiveEntryIndex(flatModels, provider?.id, modelId),
    [flatModels, provider?.id, modelId],
  );

  const closeMenus = () => {
    setModelOpen(false);
    setReasoningOpen(false);
  };

  useEffect(() => {
    if (!modelOpen) return;
    setModelHighlight(
      selector.paneSearching ? (flatModels.length ? 0 : -1) : activeFlatIndex,
    );
  }, [activeFlatIndex, flatModels.length, flatModelsKey, modelOpen, selector.paneSearching]);

  useEffect(() => {
    if (!reasoningOpen) return;
    setThinkingHighlight(
      thinkingLevel ? thinkingMenuLevels.indexOf(thinkingLevel) : -1,
    );
  }, [reasoningOpen, thinkingLevel, thinkingMenuLevels]);

  useEffect(() => {
    if (!modelOpen) return;
    for (const candidate of providers) {
      if (candidate.enabled && (candidate.hasSecret || candidate.authKind === "none")) {
        void loadProviderModels(candidate.id);
      }
    }
  }, [loadProviderModels, modelOpen, providers]);

  useEffect(() => {
    if (modelOpen) return;
    setQuery("");
    setModelHighlight(-1);
  }, [modelOpen]);
  useEffect(() => {
    if (reasoningOpen) return;
    setThinkingHighlight(-1);
  }, [reasoningOpen]);
  useEffect(() => {
    thinkingQueueRef.current?.invalidate();
  }, [activeSessionId, provider?.id, modelId]);

  useEffect(() => {
    if (!controlsBlocked) return;
    closeMenus();
    thinkingQueueRef.current?.invalidate();
  }, [controlsBlocked]);

  useEffect(() => {
    if (!modelOpen) return;
    requestAnimationFrame(() => {
      modelSearchRef.current?.focus();
      if (modelHighlight >= 0) {
        modelListRef.current
          ?.querySelector(`[data-model-index="${modelHighlight}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    });
  }, [modelOpen]);

  useEffect(() => {
    if (!reasoningOpen) return;
    requestAnimationFrame(() => {
      thinkingListRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      if (thinkingHighlight >= 0) {
        thinkingListRef.current
          ?.querySelector(`[data-thinking-index="${thinkingHighlight}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    });
  }, [reasoningOpen]);

  useEffect(() => {
    if (!modelOpen || modelHighlight < 0) return;
    modelListRef.current
      ?.querySelector(`[data-model-index="${modelHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelHighlight, modelOpen]);

  useEffect(() => {
    if (!reasoningOpen || thinkingHighlight < 0) return;
    thinkingListRef.current
      ?.querySelector(`[data-thinking-index="${thinkingHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [reasoningOpen, thinkingHighlight]);

  const selectModel = async (candidate: ProviderPublic, nextModelId: string) => {
    thinkingQueueRef.current?.invalidate();
    await thinkingQueueRef.current?.idle();
    if (isGenerationModel(
      generationModelRefs(useAppStore.getState().settings),
      candidate.id,
      nextModelId,
    )) return;
    try {
      const nextModelProvider = thinkingProviderForModel(
        candidate,
        nextModelId,
        providerModels[candidate.id],
      );
      const nextBinding = candidate.models.find((entry) =>
        sameComposerModelId(entry.id, nextModelId),
      );
      const nextModel = providerModels[candidate.id]?.find((entry) =>
        sameComposerModelId(entry.modelId, nextModelId),
      );
      const selectedSameModel =
        activeSessionId &&
        candidate.id === provider?.id &&
        sameComposerModelId(modelId ?? "", nextModelId);
      const nextThinkingLevel = selectedSameModel
        ? thinkingLevelForProvider(nextModelProvider, thinkingLevel)
        : (nextModel
          ? initialThinkingLevelForBinding(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            )
          : initialThinkingLevelForUnmatchedModel(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            ));
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
      selector.markRecent(candidate.id, nextModelId);
      setQuery("");
      setModelOpen(false);
      setModelHighlight(-1);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  /**
   * Commit a reasoning level without leaving the menu surface. Latest-wins:
   * a drag that crosses several stops only persists the last pending level
   * after the in-flight write settles. Returns false when the configuration
   * is rejected or invalidated by a session/model change.
   */
  const commitThinkingLevel = (level: SessionThinkingLevel) => {
    const queue = thinkingQueueRef.current;
    if (!queue) return Promise.resolve(false);
    return queue.commit(level);
  };

  const selectThinkingLevel = async (level: SessionThinkingLevel) => {
    if (!(await commitThinkingLevel(level))) return;
    setReasoningOpen(false);
    setThinkingHighlight(-1);
  };

  const onModelMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setModelOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        const entry = flatModels[modelHighlight];
        if (entry) {
          event.preventDefault();
          void selectModel(entry.provider, entry.model.modelId);
        }
      }
      return;
    }
    event.preventDefault();
    if (!flatModels.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setModelHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : flatModels.length) : current;
      return (base + delta + flatModels.length) % flatModels.length;
    });
  };

  const onReasoningMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setReasoningOpen(false);
      return;
    }
    if (event.key === "Enter") {
      const level = thinkingMenuLevels[thinkingHighlight] ?? thinkingMenuLevels[0];
      if (level) {
        event.preventDefault();
        void selectThinkingLevel(level);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!thinkingMenuLevels.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setThinkingHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : thinkingMenuLevels.length) : current;
      return (base + delta + thinkingMenuLevels.length) % thinkingMenuLevels.length;
    });
  };

  return {
    modelOpen,
    setModelOpen,
    reasoningOpen,
    setReasoningOpen,
    closeMenus,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    thinkingHighlight,
    setThinkingHighlight,
    modelSearchRef,
    modelListRef,
    thinkingListRef,
    selector,
    flatModels,
    thinkingMenuLevels,
    hasReasoning,
    modelPublishesReasoning,
    selectModel,
    commitThinkingLevel,
    selectThinkingLevel,
    onModelMenuKeyDown,
    onReasoningMenuKeyDown,
    controlsBlocked,
  };
}
