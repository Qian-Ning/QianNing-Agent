/**
 * The media workbench.
 *
 * Generation as a craft surface rather than a chat side effect: pick the model,
 * set the parameters the provider actually accepts, watch each output arrive,
 * and keep iterating on what came back. The Agent tools stay what they are — a
 * model asking to generate; this page is the user generating.
 *
 * Two deliberate choices:
 *
 * - The model is chosen here, not inherited blindly. A workbench that always
 *   runs one blessed model is a demo, and image and video are different jobs:
 *   each capability remembers its own choice.
 * - Parameter tables live in `features/workbench/presets` and are validated
 *   against the shared contract before submit, because the one thing worse than
 *   fewer options is an option the provider rejects after the request is billed.
 *
 * The panel, the history list and the run lifecycle each live beside this file
 * (`WorkbenchForm`, `WorkbenchHistory`, `useWorkbenchRuns`); what is left here is
 * the draft state they share and the page layout.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ProviderPublic, detectGenerationCapability } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { type WorkbenchDraft, loadWorkbenchDrafts } from "../lib/workbench-draft";
import { IconImage, IconVideo } from "../components/icons";
import {
  composeFor,
  isLocalEndpoint,
  normalizeCount,
  ratioById,
  sizeValid,
} from "../features/workbench/presets";
import {
  type WorkbenchModelChoice,
  type WorkbenchModelOption,
} from "../features/workbench/WorkbenchModelPicker";
import { WorkbenchForm } from "../features/workbench/WorkbenchForm";
import { WorkbenchHistory } from "../features/workbench/WorkbenchHistory";
import { WorkbenchResults } from "../features/workbench/WorkbenchResults";
import { type Capability, useWorkbenchRuns } from "../features/workbench/useWorkbenchRuns";
import { useWorkbenchDraftPersistence } from "../features/workbench/useWorkbenchDraft";

const CUSTOM_SIZE = "__custom__";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A provider that can actually answer a generation request. */
function canGenerate(provider: ProviderPublic): boolean {
  return (
    provider.enabled &&
    provider.authKind !== "oauth" &&
    (provider.authKind === "none" || provider.hasSecret)
  );
}

/** Every model the user could run, with the configured ones marked and first. */
function modelOptionsFor(
  providers: readonly ProviderPublic[],
  defaultChoice: WorkbenchModelChoice | null,
  candidates: readonly WorkbenchModelChoice[],
  capability: Capability,
): WorkbenchModelOption[] {
  const options: WorkbenchModelOption[] = [];
  for (const provider of providers) {
    if (!canGenerate(provider)) continue;
    for (const model of provider.models) {
      const isCandidate = candidates.some(
        (candidate) => candidate.providerId === provider.id && candidate.modelId === model.id,
      );
      // The image tab offers models that render images, the video tab models that
      // render video. A model the user marked is trusted as-is; anything else has
      // to declare the capability in its own name, so one capability's tab never
      // lists the other's models.
      const declared = detectGenerationCapability(model.id);
      // A locally deployed provider is exempt: its model names are file names,
      // and hiding them would leave a self-hosted setup with an empty menu.
      const renders =
        isLocalEndpoint(provider.baseUrl) ||
        isCandidate ||
        (capability === "image" ? declared.image : declared.video);
      if (!renders) continue;
      options.push({
        providerId: provider.id,
        modelId: model.id,
        providerName: provider.name,
        label: model.alias?.trim() || model.id,
        isDefault:
          !!defaultChoice &&
          defaultChoice.providerId === provider.id &&
          defaultChoice.modelId === model.id,
        isCandidate,
        local: isLocalEndpoint(provider.baseUrl),
      });
    }
  }
  // Configured candidates first: they are the models the user already chose,
  // and a provider row can hold far more models than a person wants to scan.
  return options.sort((left, right) => Number(right.isCandidate) - Number(left.isCandidate));
}

export function WorkbenchPage() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setPage = useAppStore((state) => state.setPage);

  // What the page last composed, read once on open, so leaving the page or
  // restarting the app restores the prompt and parameters the user had set. The
  // mechanism is the renderer's own `localStorage` preference record, the same
  // one the sidebar and the composer model picker use; it is pure UI state and
  // never touches the host database.
  const [initialDrafts] = useState(loadWorkbenchDrafts);
  const [capability, setCapability] = useState<Capability>("image");
  // Image and video keep separate drafts: they are different pieces of work, and
  // one box shared between the tabs threw the other prompt away.
  const [prompts, setPrompts] = useState<Record<Capability, string>>({
    image: initialDrafts.image.prompt,
    video: initialDrafts.video.prompt,
  });
  const prompt = prompts[capability];
  const setPrompt = (value: string) =>
    setPrompts((current) => ({ ...current, [capability]: value }));
  // The count is kept as typed text so a wrong entry is visible and blocking
  // rather than silently rewritten while the user is still typing it.
  const [countDrafts, setCountDrafts] = useState<Record<Capability, string>>({
    image: initialDrafts.image.countDraft,
    video: initialDrafts.video.countDraft,
  });
  const countDraft = countDrafts[capability];
  const setCountDraft = (value: string) =>
    setCountDrafts((current) => ({ ...current, [capability]: value }));
  const countValue = normalizeCount(countDraft);
  const count = countValue ?? 1;
  const countInvalid = countValue === null;
  const [ratios, setRatios] = useState<Record<Capability, string>>({
    image: initialDrafts.image.ratio,
    video: initialDrafts.video.ratio,
  });
  const ratio = ratios[capability];
  const setRatio = (value: string) =>
    setRatios((current) => ({ ...current, [capability]: value }));
  const [resolutions, setResolutions] = useState<Record<Capability, string>>({
    image: initialDrafts.image.resolution,
    video: initialDrafts.video.resolution,
  });
  const resolution = resolutions[capability];
  const setResolution = (value: string) =>
    setResolutions((current) => ({ ...current, [capability]: value }));
  const [customValues, setCustomValues] = useState<Record<Capability, string>>({
    image: initialDrafts.image.customValue,
    video: initialDrafts.video.customValue,
  });
  const customValue = customValues[capability];
  const setCustomValue = (value: string) =>
    setCustomValues((current) => ({ ...current, [capability]: value }));
  const [durations, setDurations] = useState<Record<Capability, number>>({
    image: initialDrafts.image.duration,
    video: initialDrafts.video.duration,
  });
  const duration = durations[capability];
  const setDuration = (value: number) =>
    setDurations((current) => ({ ...current, [capability]: value }));
  // Frame and reference-image slots are not persisted: a file path the attachment
  // store owns for one session would rot when read back later.
  const [imageReferences, setImageReferences] = useState<string[]>([]);
  const [firstFrame, setFirstFrame] = useState("");
  const [lastFrame, setLastFrame] = useState("");
  const [frameFieldsFirst, setFrameFieldsFirst] = useState<Record<Capability, string>>({
    image: initialDrafts.image.frameFieldFirst,
    video: initialDrafts.video.frameFieldFirst,
  });
  const frameFieldFirst = frameFieldsFirst[capability];
  const setFrameFieldFirst = (value: string) =>
    setFrameFieldsFirst((current) => ({ ...current, [capability]: value }));
  const [frameFieldsLast, setFrameFieldsLast] = useState<Record<Capability, string>>({
    image: initialDrafts.image.frameFieldLast,
    video: initialDrafts.video.frameFieldLast,
  });
  const frameFieldLast = frameFieldsLast[capability];
  const setFrameFieldLast = (value: string) =>
    setFrameFieldsLast((current) => ({ ...current, [capability]: value }));
  const [advanced, setAdvanced] = useState(false);
  const [choices, setChoices] = useState<Record<Capability, WorkbenchModelChoice | null>>({
    image: initialDrafts.image.model,
    video: initialDrafts.video.model,
  });

  // Persist both capabilities together, debounced, so typing a prompt does not
  // write on every keystroke and the pair stays consistent in one record. A
  // successful run keeps the draft: the workbench is an iterative surface, the
  // compose panel never clears itself, and the run is already durably recorded in
  // the media library, so retaining the draft changes no existing behaviour while
  // leaving the user their prompt to re-roll.
  const persistDrafts = useWorkbenchDraftPersistence();
  useEffect(() => {
    const snapshotFor = (value: Capability): WorkbenchDraft => ({
      prompt: prompts[value],
      model: choices[value],
      countDraft: countDrafts[value],
      ratio: ratios[value],
      resolution: resolutions[value],
      customValue: customValues[value],
      duration: durations[value],
      frameFieldFirst: frameFieldsFirst[value],
      frameFieldLast: frameFieldsLast[value],
    });
    persistDrafts({ image: snapshotFor("image"), video: snapshotFor("video") });
  }, [
    persistDrafts,
    prompts,
    choices,
    countDrafts,
    ratios,
    resolutions,
    customValues,
    durations,
    frameFieldsFirst,
    frameFieldsLast,
  ]);

  const isImage = capability === "image";

  const defaultChoice = useMemo<WorkbenchModelChoice | null>(() => {
    const binding = isImage ? settings?.imageGeneration : settings?.videoGeneration;
    return binding ? { providerId: binding.providerId, modelId: binding.modelId } : null;
  }, [isImage, settings?.imageGeneration, settings?.videoGeneration]);

  const candidates = useMemo(
    () => (isImage ? settings?.imageGenerationModels : settings?.videoGenerationModels) ?? [],
    [isImage, settings?.imageGenerationModels, settings?.videoGenerationModels],
  );

  const modelOptions = useMemo(
    () => modelOptionsFor(providers, defaultChoice, candidates, capability),
    [providers, defaultChoice, candidates, capability],
  );

  const choice = choices[capability];
  const effectiveChoice = choice ?? defaultChoice;
  const configured =
    effectiveChoice !== null &&
    modelOptions.some(
      (option) =>
        option.providerId === effectiveChoice.providerId &&
        option.modelId === effectiveChoice.modelId,
    );

  // What will actually run: the menu's own label for the effective choice, so the
  // line under the control names the model rather than repeating the control's text.
  const resolvedModel = (() => {
    const option = modelOptions.find(
      (entry) =>
        entry.providerId === effectiveChoice?.providerId && entry.modelId === effectiveChoice?.modelId,
    );
    if (!option) return "";
    return option.providerName ? `${option.providerName} · ${option.label}` : option.label;
  })();

  // Shape and resolution are chosen separately and composed here, because that is
  // the one value the provider is sent.
  const activeRatio = ratio ? ratioById(capability, ratio) : null;
  const size =
    !activeRatio || !resolution
      ? ""
      : resolution === CUSTOM_SIZE
        ? customValue.trim()
        : composeFor(capability, activeRatio, Number(resolution));
  const sizeOk = sizeValid(capability, size);
  const lastFrameOk = !lastFrame || Boolean(firstFrame);

  const {
    run,
    setRun,
    progress,
    running,
    elapsed,
    succeeded,
    failed,
    outputs,
    savedPaths,
    scopedHistory,
    succeededHistory,
    failedHistory,
    libraryCount,
    removeLibraryEntries,
    clearLibraryHistory,
    revealLibrary,
    submit,
    cancel,
  } = useWorkbenchRuns({
    capability,
    isImage,
    sessionId: activeSessionId ?? "",
    prompt,
    count,
    size,
    sizeOk,
    lastFrameOk,
    choice,
    duration,
    firstFrame,
    lastFrame,
    frameFieldFirst,
    frameFieldLast,
    imageReferences,
  });

  const canSubmit =
    !countInvalid &&
    !running &&
    prompt.trim().length > 0 &&
    sizeOk &&
    lastFrameOk &&
    configured;

  const addFiles = useCallback(
    async (target: "references" | "first" | "last") => {
      const picked = await api.pickFiles();
      if (!picked?.token) return;
      const imported = await api.importFiles(activeSessionId ?? "", picked.token);
      const paths = imported.files.map((file) => file.path).filter(Boolean);
      if (!paths.length) return;
      if (target === "references")
        setImageReferences((current) => [...current, ...paths].slice(0, 4));
      if (target === "first") setFirstFrame(paths[0]);
      if (target === "last") setLastFrame(paths[0]);
    },
    [activeSessionId],
  );

  return (
    <div className="workbench">
      <header className="workbench-head">
        <div className="workbench-title">
          <h1>{t("workbench.title")}</h1>
          <p className="workbench-subtitle">{t("workbench.subtitle")}</p>
        </div>
      </header>

      <div className="workbench-tabs" role="tablist" aria-label={t("workbench.title")}>
        {(["image", "video"] as Capability[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={capability === value}
            tabIndex={capability === value ? 0 : -1}
            className={`workbench-tab${capability === value ? " is-active" : ""}`}
            onClick={() => setCapability(value)}
          >
            {value === "image" ? (
              <IconImage size={15} aria-hidden />
            ) : (
              <IconVideo size={15} aria-hidden />
            )}
            {t(value === "image" ? "workbench.imageTab" : "workbench.videoTab")}
          </button>
        ))}
      </div>

      <div className="workbench-body">
        <WorkbenchForm
          capability={capability}
          isImage={isImage}
          choice={choice}
          modelOptions={modelOptions}
          configured={configured}
          resolvedModel={resolvedModel}
          onModelChange={(next) =>
            setChoices((current) => ({ ...current, [capability]: next }))
          }
          onOpenSettings={() => setPage("settings")}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={() => void submit()}
          running={running}
          canSubmit={canSubmit}
          elapsed={elapsed}
          progress={progress}
          countDraft={countDraft}
          countInvalid={countInvalid}
          onCountDraftChange={setCountDraft}
          count={count}
          duration={duration}
          onDurationChange={setDuration}
          ratio={ratio}
          resolution={resolution}
          customValue={customValue}
          sizeOk={sizeOk}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
          onCustomValueChange={setCustomValue}
          imageReferences={imageReferences}
          onRemoveReference={(path) =>
            setImageReferences((current) => current.filter((entry) => entry !== path))
          }
          firstFrame={firstFrame}
          lastFrame={lastFrame}
          frameFieldFirst={frameFieldFirst}
          frameFieldLast={frameFieldLast}
          advanced={advanced}
          onToggleAdvanced={() => setAdvanced((current) => !current)}
          onFrameFieldFirstChange={setFrameFieldFirst}
          onFrameFieldLastChange={setFrameFieldLast}
          onAddFiles={addFiles}
          onCancel={() => void cancel()}
        />

        <section className="workbench-panel workbench-results" aria-label={t("workbench.results")}>
          <div className="workbench-results-head">
            <h2>{t("workbench.results")}</h2>
            {run?.finishedAt ? (
              <span className="workbench-summary">
                {t("workbench.summary", { ok: succeeded, total: run.total })}
                {failed ? ` · ${t("workbench.partial", { count: failed })}` : ""}
                {run.model ? ` · ${run.model.modelId}` : ""}
              </span>
            ) : null}
          </div>

          {run?.errorCode ? (
            <p className="workbench-error">
              <strong>{run.errorCode}</strong>
              {run.message ? <span>{run.message}</span> : null}
            </p>
          ) : null}

          {run ? (
            <WorkbenchResults
              sessionId={run.sessionId}
              capability={run.capability}
              outputs={outputs}
              onUseAsReference={(path) =>
                setImageReferences((current) => [...current, path].slice(0, 4))
              }
              onRetry={() => void submit()}
            />
          ) : (
            <p className="workbench-empty">{t("workbench.empty")}</p>
          )}

          {savedPaths.length ? (
            <p className="workbench-hint font-mono" title={savedPaths.join("\n")}>
              {`${t("workbench.savedTo")} ${fileName(savedPaths[0])}${
                savedPaths.length > 1 ? ` (+${savedPaths.length - 1})` : ""
              }`}
            </p>
          ) : null}

          <WorkbenchHistory
            scopedHistory={scopedHistory}
            succeededHistory={succeededHistory}
            failedHistory={failedHistory}
            libraryCount={libraryCount}
            onPick={setRun}
            onRemove={(entry) => {
              // A render cost money, so removal is a second-confirmed move to the
              // recycle bin, never a silent delete.
              if (window.confirm(t("workbench.historyRemoveConfirm")))
                void removeLibraryEntries([entry.id]);
            }}
            onClear={() => {
              if (window.confirm(t("workbench.historyClearConfirm"))) void clearLibraryHistory();
            }}
            onReveal={() => void revealLibrary()}
          />
        </section>
      </div>
    </div>
  );
}
