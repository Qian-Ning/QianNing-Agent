import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  Mode,
  PermissionMode,
} from "@pi-desktop/shared";
import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  generationModelRefs,
  isGenerationModel,
  normalizeLargePasteThreshold,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import { isActivePlanExecution } from "../lib/plan-mode-state";
import { headAsk, queuedAskCount } from "../lib/pending-asks";
import type { QueuedPrompt } from "../lib/queued-prompts";
import { composerModelDisplayName, sameComposerModelId } from "../lib/composer-models";
import {
  resolveComposerThinkingProvider,
} from "../lib/session-thinking";
import {
  useComposerAutocomplete,
} from "../hooks/use-composer-autocomplete";
import { ComposerAutocomplete } from "./ComposerAutocomplete";
import { AskToolCard } from "./AskToolCard";
import { PlanApprovalBar } from "./PlanApprovalBar";
import { SubagentRunStrip } from "../features/chat/composer/SubagentRunStrip";
import {
  COMPOSER_MAX_VISIBLE_ROWS,
  COMPOSER_MIN_HEIGHT_PX,
  PLACEHOLDER_KEYS,
  cssPixels,
  isPermissionMode,
  isThinkingLevel,
  reasoningLevelLabelKey,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerPrefill,
} from "../features/chat/composer/model";
import {
  createFileReference,
  editorSelectionRange,
  isImageFilePath,
  nextChipToken,
} from "../features/chat/composer/editor";
import { useComposerAttachments } from "../features/chat/composer/hooks/useComposerAttachments";
import { useComposerDraft } from "../features/chat/composer/hooks/useComposerDraft";
import { useComposerInputHistory } from "../features/chat/composer/hooks/useComposerInputHistory";
import { useComposerSubmit } from "../features/chat/composer/hooks/useComposerSubmit";
import { ComposerImageAttachments } from "../features/chat/composer/ComposerImageAttachments";
import { ComposerInput } from "../features/chat/composer/ComposerInput";
import { useComposerModelMenu } from "../features/chat/composer/hooks/useComposerModelMenu";
import { useComposerPromptCards } from "../features/chat/composer/hooks/useComposerPromptCards";
import { ComposerPromptCards } from "../features/chat/composer/ComposerPromptCards";
import {
  exportPromptCards as serializePromptCards,
  COMPOSER_PROMPT_CARDS_EXPORT_FILENAME,
} from "../lib/composer-prompt-cards";
import { ComposerToolbar } from "../features/chat/composer/ComposerToolbar";
import { useVoiceInput } from "../features/voice/useVoiceInput";
import { VoiceOverlay } from "../features/voice/VoiceOverlay";
import "../styles/voice.css";
import { ComposerStatus } from "../features/chat/composer/ComposerStatus";

const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = [];

export {
  THINKING_LEVELS,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerPrefill,
} from "../features/chat/composer/model";

export function Composer({
  variant = "docked",
  prefill,
}: {
  variant?: "home" | "docked";
  prefill?: ComposerPrefill | null;
}) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const steerPrompt = useAppStore((s) => s.steerPrompt);
  const removeQueuedPrompt = useAppStore((s) => s.removeQueuedPrompt);
  const moveQueuedPrompt = useAppStore((s) => s.moveQueuedPrompt);
  const editQueuedPrompt = useAppStore((s) => s.editQueuedPrompt);
  const sendQueuedNow = useAppStore((s) => s.sendQueuedNow);
  const abort = useAppStore((s) => s.abort);
  const isRunning = useAppStore((s) => s.isRunning);
  const planningState = useAppStore((s) =>
    s.activeSessionId ? s.planningStates[s.activeSessionId] : undefined,
  );
  const settings = useAppStore((s) => s.settings);
  const generationCandidates = useMemo(
    () => generationModelRefs(settings),
    [settings?.imageGenerationModels, settings?.imageGeneration],
  );
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeSessionSummary = sessions.find(
    (session) => session.id === activeSessionId,
  );
  const nativeSession = activeSessionSummary?.source === "pi-native";
  const nativeReadOnly =
    nativeSession && activeSessionSummary.capabilities?.canPrompt !== true;
  const nativeInputBlocked = nativeReadOnly || (nativeSession && isRunning);
  const workspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const liveMessages = useAppStore((s) => s.messages);
  const sessionCompactions = useAppStore((s) =>
    s.activeSessionId ? s.sessionCompactions[s.activeSessionId] : undefined,
  );
  // One inspector in the composer toolbar, always the newest turn with usage.
  const composerContextUsage = useMemo(
    () =>
      latestTurnContextInspector(
        liveMessages,
        providerModels,
        providers,
        sessionCompactions,
      ),
    [liveMessages, providerModels, providers, sessionCompactions],
  );
  const configureActiveSession = useAppStore((s) => s.configureActiveSession);
  const showToast = useAppStore((s) => s.showToast);
  const composerPrefill = useAppStore((s) => s.composerPrefill);
  const clearComposerPrefill = useAppStore((s) => s.clearComposerPrefill);
  const planCheckpoint = useAppStore((s) =>
    s.activeSessionId ? s.planCheckpoints[s.activeSessionId] : undefined,
  );
  const pendingAsk = useAppStore((s) =>
    headAsk(s.pendingAsks, s.activeSessionId),
  );
  const queuedAsks = useAppStore((s) =>
    queuedAskCount(s.pendingAsks, s.activeSessionId),
  );
  const queuedPrompts = useAppStore((s) =>
    s.activeSessionId
      ? s.queuedPrompts[s.activeSessionId] ?? EMPTY_QUEUED_PROMPTS
      : EMPTY_QUEUED_PROMPTS,
  );

  const [permissionOpen, setPermissionOpen] = useState(false);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const publishedDockHeightRef = useRef(-1);

  const draft = useComposerDraft({
    variant,
    activeSessionId,
    workspacePath,
    sessions,
    composerPrefill,
    clearComposerPrefill,
    prefill,
    t,
    inputBlocked: planCheckpoint?.status === "pending" || nativeInputBlocked,
  });
  const {
    ref,
    draftKey,
    referenceSessionId,
    value,
    setValue,
    valueRef,
    cursor,
    setCursor,
    composing,
    setComposing,
    inputFocused,
    setInputFocused,
    placeholderIndex,
    activeFileReferences,
    fileReferencesRef,
    applyEditorDraft,
    snapshotReferences,
    draftSnapshot,
    draftRevision,
    clearDraftForKey,
    restoreDraftForKey,
    persistDraft,
    commitEditorDom,
    readLiveDraft,
    insertNewlineInEditor,
    handleInput,
  } = draft;
  const inputHistory = useComposerInputHistory({
    draftKey,
    referenceSessionId,
    draft,
  });

  const approvalPending = planCheckpoint?.status === "pending";
  const largePasteThreshold = normalizeLargePasteThreshold(
    settings?.largePasteThreshold,
  );
  const attachments = useComposerAttachments({
    inputBlocked: approvalPending || nativeSession,
    activeSessionId,
    draftKey,
    largePasteThreshold,
    t,
    draft: {
      ref,
      valueRef,
      fileReferencesRef: draft.fileReferencesRef,
      applyEditorDraft,
      snapshotReferences,
      commitEditorDom,
    },
  });
  const {
    pasting,
    dropTargetActive,
    droppedDirectories,
    pickAndAttach,
    pasteClipboardFiles,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    openDroppedFolderAsProject,
    insertDroppedDirectoryPaths,
    dismissDroppedDirectories,
  } = attachments;
  const executionActive = isActivePlanExecution(planCheckpoint);
  const runActive = isRunning || executionActive;
  const inputBlocked = approvalPending || pasting || nativeInputBlocked;
  const controlsBlocked = approvalPending || nativeSession;
  const sendBlocked = approvalPending || pasting || nativeInputBlocked;
  // Edit returns one queued row to the composer. The row is removed and its
  // captured draft becomes the input, so the input must be empty first: the
  // live read is the only current source (the draft cache is not per keystroke).
  const handleEditQueuedPrompt = (id: string) => {
    if (readLiveDraft().trim() || activeFileReferences.length) {
      showToast(t("chat.editQueuedPromptBusy"), { variant: "info" });
      return;
    }
    editQueuedPrompt(id);
  };
  const placeholderKeys = PLACEHOLDER_KEYS[variant];
  const placeholderKey =
    placeholderKeys[placeholderIndex % placeholderKeys.length] ?? placeholderKeys[0];
  const placeholderText = t(placeholderKey);

  const textareaMetricsRef = useRef<{ lineHeight: number; verticalChrome: number } | null>(null);
  const appliedHeightRef = useRef<number | null>(null);
  const appliedOverflowRef = useRef<string | null>(null);
  useEffect(() => {
    textareaMetricsRef.current = null;
    appliedHeightRef.current = null;
    appliedOverflowRef.current = null;
  }, [variant]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let metrics = textareaMetricsRef.current;
    if (!metrics) {
      const style = window.getComputedStyle(el);
      metrics = {
        lineHeight: cssPixels(style.lineHeight) || COMPOSER_MIN_HEIGHT_PX,
        verticalChrome:
          cssPixels(style.paddingTop) +
          cssPixels(style.paddingBottom) +
          cssPixels(style.borderTopWidth) +
          cssPixels(style.borderBottomWidth),
      };
      textareaMetricsRef.current = metrics;
    }
    const maxHeight = Math.ceil(
      metrics.lineHeight * COMPOSER_MAX_VISIBLE_ROWS + metrics.verticalChrome,
    );
    const applied =
      appliedHeightRef.current !== null &&
      el.style.height === `${appliedHeightRef.current}px`
        ? appliedHeightRef.current
        : null;
    let content = applied === null ? -1 : el.scrollHeight;
    if (
      applied === null ||
      (content <= el.clientHeight && applied > COMPOSER_MIN_HEIGHT_PX)
    ) {
      el.style.height = "auto";
      content = el.scrollHeight;
    }
    const next = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(content, maxHeight));
    const overflowY = content > maxHeight ? "auto" : "hidden";
    if (appliedHeightRef.current !== next || el.style.height !== `${next}px`) {
      el.style.height = `${next}px`;
      appliedHeightRef.current = next;
    }
    if (appliedOverflowRef.current !== overflowY) {
      el.style.overflowY = overflowY;
      appliedOverflowRef.current = overflowY;
    }
  }, [value]);


  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const draftConfiguration = useAppStore((s) => s.draftConfiguration);
  const mode: Mode = activeSession
    ? activeSession.mode
    : (draftConfiguration?.mode ?? settings?.defaultMode ?? "agent");
  const planningLive =
    isRunning &&
    planningState === "planning" &&
    (mode === "plan" || mode === "goal");
  // Permission mode (D115/D132): inherited sessions still resolve through the
  // global setting, but the composer presents only the effective mode.
  const globalPermissionMode: PermissionMode =
    settings?.defaultPermissionMode ?? "ask";
  const sessionPermissionMode: PermissionMode = activeSession
    ? isPermissionMode(activeSession.permissionMode)
      ? activeSession.permissionMode
      : "inherit"
    : isPermissionMode(draftConfiguration?.permissionMode)
      ? draftConfiguration.permissionMode
      : "inherit";
  const effectivePermissionMode: Exclude<PermissionMode, "inherit"> =
    sessionPermissionMode === "inherit"
      ? (globalPermissionMode as Exclude<PermissionMode, "inherit">)
      : sessionPermissionMode;
  const composerPermissionMode: Exclude<PermissionMode, "inherit"> =
    mode === "goal" ? "auto" : effectivePermissionMode;
  const provider = providers.find(
    (candidate) =>
      candidate.id ===
      (activeSession?.providerId ??
        (!activeSession ? draftConfiguration?.providerId : undefined) ??
        settings?.defaultProviderId),
  );
  const modelId =
    activeSession?.modelId ??
    (!activeSession ? draftConfiguration?.modelId : undefined) ??
    (settings?.defaultModelId?.trim() || provider?.models?.[0]?.id || provider?.defaultModelId);
  const selectedModelCatalog = provider ? providerModels[provider.id] : undefined;
  const catalogThinkingProvider = thinkingProviderForModel(
    provider,
    modelId,
    selectedModelCatalog,
  );
  const thinkingProvider = resolveComposerThinkingProvider({
    provider,
    modelId,
    activeSession,
    catalogThinkingProvider,
  });
  const selectedBinding = provider?.models.find((candidate) =>
    sameComposerModelId(candidate.id, modelId ?? ""),
  );
  const selectedModelInfo = selectedModelCatalog?.find((candidate) =>
    sameComposerModelId(candidate.modelId, modelId ?? ""),
  );
  // A draft without a session starts at the selected model's stored default
  // thinking level, clamped onto that binding's enabled ladder.
  const draftThinkingLevel = selectedModelInfo
    ? initialThinkingLevelForBinding(
        selectedBinding,
        thinkingProvider?.supportedThinkingLevels,
      )
    : initialThinkingLevelForUnmatchedModel(
        selectedBinding,
        thinkingProvider?.supportedThinkingLevels,
      );
  const sessionThinkingLevel =
    activeSession?.thinkingLevel ??
    (!activeSession ? draftConfiguration?.thinkingLevel : undefined) ??
    draftThinkingLevel;
  const configuredThinkingLevel = isThinkingLevel(sessionThinkingLevel)
    ? sessionThinkingLevel
    : "off";
  const thinkingLevel = thinkingLevelForProvider(
    thinkingProvider,
    configuredThinkingLevel,
  );
  const thinkingLabel = t(reasoningLevelLabelKey(thinkingLevel));
  const modelLabel = modelId
    ? composerModelDisplayName(provider, modelId, selectedModelInfo?.displayName)
    : t("chat.model");
  const modelMenu = useComposerModelMenu({
    configureActiveSession,
    mode,
    activeSessionId,
    provider,
    modelId,
    thinkingProvider,
    thinkingLevel,
    controlsBlocked,
  });
  const modelReady = nativeSession
    ? activeSessionSummary.capabilities?.canPrompt === true
    : !!provider &&
      provider.enabled &&
      !!modelId &&
      !isGenerationModel(generationCandidates, provider.id, modelId) &&
      (provider.hasSecret || provider.authKind === "none");
  const enterToSend = settings?.enterToSend ?? true;
  const hasDraftContent = Boolean(value.trim() || activeFileReferences.length);

  useEffect(() => {
    if (!controlsBlocked) return;
    setPermissionOpen(false);
  }, [controlsBlocked]);

  const submitController = useComposerSubmit({
    value,
    draftKey,
    activeSessionId,
    modelReady,
    sendBlocked,
    pasting,
    activeFileReferences,
    t,
    sendPrompt,
    steerPrompt,
    showToast,
    recordHistory: inputHistory.record,
    draft: {
      ref,
      draftSnapshot,
      draftRevision,
      clearDraftForKey,
      restoreDraftForKey,
      setValue,
      setCursor,
    },
  });
  const { submit } = submitController;

  // Both submit entry points (the composer's Enter and the toolbar's Send)
  // leave history browsing before the draft is cleared.
  const submitFromComposer = (steering?: boolean) => {
    inputHistory.exitBrowsing();
    return submit(steering);
  };

  const voiceEnabled = !!settings?.voice?.enabled;
  const voice = useVoiceInput({
    enabled: voiceEnabled,
    onTranscriptionComplete: (text) => {
      // Insert transcribed text into Composer
      const current = readLiveDraft();
      if (!current.trim()) {
        applyEditorDraft(text, fileReferencesRef.current, text.length);
      } else {
        const next = current + " " + text;
        applyEditorDraft(next, fileReferencesRef.current, next.length);
      }
    },
  });
  const composerAc = useComposerAutocomplete({
    value,
    cursor,
    composing,
    enabled: !inputBlocked,
  });
  const promptCards = useComposerPromptCards();

  // Insert a saved quick prompt into the draft: it starts the draft when empty
  // and appends on its own line otherwise, keeping any text already typed.
  const insertPromptCard = (text: string) => {
    if (inputBlocked) return;
    const current = readLiveDraft();
    const next = current.trim() ? `${current}\n${text}` : text;
    applyEditorDraft(next, fileReferencesRef.current, next.length);
  };

  const savePromptCardFromDraft = () => {
    const saved = promptCards.save(readLiveDraft());
    showToast(
      t(saved ? "chat.promptCardSaved" : "chat.promptCardSaveEmpty"),
      { variant: saved ? "success" : "info" },
    );
  };

  // Download the saved quick prompts as a shareable JSON file. A Blob + object
  // URL anchor is the renderer-local path: there is no host file dialog on the
  // preload surface, and the CSP already allows blob: for this kind of save.
  const exportPromptCards = () => {
    if (promptCards.cards.length === 0) {
      showToast(t("chat.promptCardsExportEmpty"), { variant: "info" });
      return;
    }
    try {
      const json = serializePromptCards(promptCards.cards);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = COMPOSER_PROMPT_CARDS_EXPORT_FILENAME;
      anchor.click();
      // Revoke on the next tick so the click's navigation has consumed the URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      showToast(t("chat.promptCardsImportFailed"), { variant: "error" });
    }
  };

  const importPromptCardsFromFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = promptCards.importText(String(reader.result ?? ""));
      if (!result.ok) {
        showToast(t("chat.promptCardsImportFailed"), { variant: "error" });
        return;
      }
      showToast(
        t("chat.promptCardsImported", {
          added: result.added,
          skipped: result.skipped,
        }),
        { variant: result.added > 0 ? "success" : "info" },
      );
    };
    reader.onerror = () => {
      showToast(t("chat.promptCardsImportFailed"), { variant: "error" });
    };
    reader.readAsText(file);
  };

  const acceptCompletion = (index: number) => {
    const result = composerAc.accept(index);
    if (!result) return;
    // File accept strips the @ token (empty insert) and used to store a
    // token-less chip above the textarea. Inline chips only paint when a
    // sentinel is in the draft, so Enter looked like the reference vanished.
    const acceptedFileReference = result.fileReference;
    if (!acceptedFileReference) {
      applyEditorDraft(result.value, fileReferencesRef.current, result.cursor);
      return;
    }
    const token = nextChipToken();
    const nextText =
      result.value.slice(0, result.cursor) + token + result.value.slice(result.cursor);
    applyEditorDraft(
      nextText,
      [
        ...fileReferencesRef.current,
        createFileReference(
          acceptedFileReference.path,
          acceptedFileReference.name,
          referenceSessionId,
          {
            kind: isImageFilePath(acceptedFileReference.path) ? "image" : "file",
            token,
          },
        ),
      ],
      result.cursor + token.length,
    );
  };

  // Keep the transcript's bottom reserve in sync with the composer's real
  // height (it grows with multi-line input) so the last message sits just
  // above the box instead of far below it.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    // Setting a custom property on documentElement invalidates style for the
    // whole document, so an unchanged dock height must not be republished.
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h === publishedDockHeightRef.current) return;
      publishedDockHeightRef.current = h;
      document.documentElement.style.setProperty(
        "--composer-dock-height",
        `${h}px`,
      );
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [variant]);

  return (
    <div
      ref={dockRef}
      className={`composer-dock composer-dock-${variant}`}
      data-composer-dock={variant}
    >
      <div className="composer-stack">
        {planCheckpoint?.status === "pending" ? (
          <PlanApprovalBar proposal={planCheckpoint} />
        ) : null}
        {pendingAsk ? (
          <AskToolCard key={pendingAsk.requestId} request={pendingAsk} queued={queuedAsks} />
        ) : null}
        {nativeReadOnly ? (
          <div className="composer-status" role="status">
            Native Pi session is read-only: {activeSessionSummary?.readOnlyReason ?? "continuation unavailable"}.
          </div>
        ) : null}
        <ComposerStatus
          t={t}
          queuedPrompts={queuedPrompts}
          removeQueuedPrompt={removeQueuedPrompt}
          moveQueuedPrompt={moveQueuedPrompt}
          editQueuedPrompt={handleEditQueuedPrompt}
          sendQueuedNow={sendQueuedNow}
          approvalPending={approvalPending}
          droppedDirectories={droppedDirectories}
          openDroppedFolderAsProject={openDroppedFolderAsProject}
          insertDroppedDirectoryPaths={insertDroppedDirectoryPaths}
          dismissDroppedDirectories={dismissDroppedDirectories}
        />
        <SubagentRunStrip />
        <ComposerImageAttachments controller={draft.imagePreview} onRemove={draft.removeImage} disabled={inputBlocked} />
        <ComposerPromptCards
          t={t}
          cards={promptCards.cards}
          draftText={value}
          disabled={inputBlocked}
          onInsert={insertPromptCard}
          onSave={savePromptCardFromDraft}
          onRemove={promptCards.remove}
          onExport={exportPromptCards}
          onImportFile={importPromptCardsFromFile}
        />
        <div
          ref={composerShellRef}
          className={`composer-shell${inputBlocked ? " is-gated" : ""}${
            dropTargetActive ? " is-drop-target" : ""
          }`}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {inputFocused ? (
            <ComposerAutocomplete
              anchorRef={composerShellRef}
              ac={composerAc}
              onAccept={acceptCompletion}
            />
          ) : null}
          <ComposerInput
            imagePreview={draft.imagePreview}
            inputRef={ref}
            value={value}
            placeholderText={placeholderText}
            placeholderKey={`${variant}-${placeholderIndex}-${placeholderText}`}
            inputBlocked={inputBlocked}
            pasting={pasting}
            enterToSend={enterToSend}
            runActive={runActive}
            composerAc={composerAc}
            onPaste={pasteClipboardFiles}
            onAcceptCompletion={acceptCompletion}
            onSubmit={(steering) => void submitFromComposer(steering)}
            onInsertNewline={insertNewlineInEditor}
            onInput={(source, caret) => {
              inputHistory.exitBrowsing();
              handleInput(source, caret);
            }}
            onHistoryNavigate={inputHistory.navigate}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              draft.updateCursor(editorSelectionRange(event.currentTarget).start);
            }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => {
              setInputFocused(false);
              persistDraft();
            }}
          />
          <VoiceOverlay t={t} state={voice.state} onCancel={voice.cancel} />
          <ComposerToolbar
            t={t}
            mode={mode}
            planningLive={planningLive}
            providerId={provider?.id}
            modelId={modelId}
            thinkingLevel={thinkingLevel}
            composerPermissionMode={composerPermissionMode}
            permissionOpen={permissionOpen}
            setPermissionOpen={setPermissionOpen}
            controlsBlocked={controlsBlocked}
            pasting={pasting}
            pickAndAttach={pickAndAttach}
            configureActiveSession={configureActiveSession}
            showToast={showToast}
            modelMenu={modelMenu}
            modelLabel={modelLabel}
            thinkingLabel={thinkingLabel}
            contextUsage={composerContextUsage ?? null}
            value={value}
            modelReady={modelReady}
            sendBlocked={sendBlocked}
            runActive={runActive}
            hasDraftContent={hasDraftContent}
            abort={abort}
            submit={submitFromComposer}
            voicePhase={voice.state.phase}
            voiceEnabled={voiceEnabled}
            onVoiceToggle={voice.toggle}
            onVoiceCancel={voice.cancel}
          />
        </div>
      </div>
    </div>
  );
}
