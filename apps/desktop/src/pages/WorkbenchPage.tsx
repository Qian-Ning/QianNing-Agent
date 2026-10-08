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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_VIDEO_DURATION_SECONDS,
  type ImageGenerationInput,
  detectGenerationCapability,
  type MediaLibraryEntry,
  type MediaWorkbenchItemResult,
  type MediaWorkbenchProgress,
  type ProviderPublic,
  type VideoGenerationInput,
} from "@pi-desktop/shared";
import { Button } from "../components/ui";
import { IconClose, IconImage, IconPlus, IconVideo } from "../components/icons";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import {
  DEFAULT_VIDEO_DURATION,
  VIDEO_DURATION_PRESETS,
  composeFor,
  defaultResolutionFor,
  clampCount,
  MAX_WORKBENCH_COUNT,
  normalizeCount,
  isLocalEndpoint,
  resolutionTierLabel,
  ratioById,
  ratiosFor,
  resolutionsFor,
  sizeValid,
} from "../features/workbench/presets";
import {
  WorkbenchModelPicker,
  type WorkbenchModelChoice,
  type WorkbenchModelOption,
} from "../features/workbench/WorkbenchModelPicker";
import {
  WorkbenchResults,
  type ItemState,
  type WorkbenchOutput,
} from "../features/workbench/WorkbenchResults";

type Capability = "image" | "video";

const CUSTOM_SIZE = "__custom__";

/**
 * One past run. Kept beside the type it renders so the two history groups can
 * share a row without repeating the markup twice.
 */
function HistoryRow({
  entry,
  onPick,
}: {
  entry: Run;
  onPick: (entry: Run) => void;
}) {
  const { t } = useTranslation();
  const succeeded = entry.results?.filter((item) => item.status === "succeeded").length ?? 0;
  return (
    <li>
      <button type="button" onClick={() => onPick(entry)}>
        <span
          className={`workbench-history-dot${
            entry.ok === null ? "" : entry.ok ? " is-ok" : " is-bad"
          }`}
        />
        <span className="workbench-history-prompt">{entry.prompt}</span>
        <span className="workbench-history-meta">
          {[
            new Date(entry.startedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }),
            entry.model?.modelId,
            entry.size,
            entry.errorCode ?? `${succeeded}/${entry.total}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
    </li>
  );
}

type Run = {
  id: string;
  capability: Capability;
  /** What the request was sent with; save and reveal are scoped to it. */
  sessionId: string;
  prompt: string;
  model: WorkbenchModelChoice | null;
  startedAt: number;
  finishedAt?: number;
  results: MediaWorkbenchItemResult[] | null;
  states: Record<number, ItemState>;
  total: number;
  /** The size this run asked for, when it asked for one. */
  size?: string;
  ok: boolean | null;
  errorCode?: string;
  message?: string;
};

/**
 * A render the app already owns, in the shape the page renders runs in.
 *
 * Only the file and what is known about it survive a restart; the per-item states
 * are reconstructed from the recorded outcome, so a library entry opens in the
 * results panel exactly like a run that just finished.
 */
function runFromEntry(entry: MediaLibraryEntry): Run {
  const at = Date.parse(entry.createdAt);
  const startedAt = Number.isNaN(at) ? 0 : at;
  return {
    id: entry.id,
    capability: entry.capability,
    sessionId: "",
    prompt: entry.prompt ?? "",
    model: entry.modelId ? { providerId: "", modelId: entry.modelId } : null,
    startedAt,
    finishedAt: startedAt,
    results: [
      {
        index: 0,
        status: entry.status,
        ...(entry.status === "succeeded" ? { path: entry.path } : {}),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      },
    ],
    states: { 0: entry.status },
    total: 1,
    ...(entry.size ? { size: entry.size } : {}),
    ok: entry.status === "succeeded",
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
  };
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

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

function ShapeField({
  capability,
  ratio,
  resolution,
  customValue,
  valid,
  onRatio,
  onResolution,
  onCustomValue,
  label,
  defaultLabel,
  resolutionLabel,
  resolutionFirstLabel,
  customLabel,
  invalidLabel,
  placeholder,
  resolvedLabel,
}: {
  capability: Capability;
  ratio: string;
  resolution: string;
  customValue: string;
  valid: boolean;
  onRatio: (value: string) => void;
  onResolution: (value: string) => void;
  onCustomValue: (value: string) => void;
  label: string;
  defaultLabel: string;
  resolutionLabel: string;
  resolutionFirstLabel: string;
  customLabel: string;
  invalidLabel: string;
  placeholder: string;
  resolvedLabel: (size: string) => string;
}) {
  const active = ratio ? ratioById(capability, ratio) : null;
  // Ratio and resolution are two independent choices. A tier without a chosen
  // ratio still means something, so it composes against the capability's first
  // ratio — and the option label spells out the size that will be sent, so the
  // fallback is never a surprise.
  const composeRatio = active ?? ratiosFor(capability)[0] ?? null;
  const isCustom = resolution === CUSTOM_SIZE;
  const composed =
    composeRatio && resolution && !isCustom
      ? composeFor(capability, composeRatio, Number(resolution))
      : "";
  const shown = isCustom ? customValue.trim() : composed;
  return (
    <div className="workbench-field">
      <div className="workbench-pair">
        <div className="workbench-subfield">
          <label className="workbench-label" htmlFor="workbench-ratio">
            {label}
          </label>
          <select
            id="workbench-ratio"
            className="field-select"
            value={ratio}
            onChange={(event) => {
              onRatio(event.target.value);
              // A ratio without a resolution is not a size, so choosing one brings
              // the tier along and clearing it takes the tier with it.
              onResolution(
                event.target.value ? String(defaultResolutionFor(capability)) : "",
              );
            }}
          >
            <option value="">{defaultLabel}</option>
            {ratiosFor(capability).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="workbench-subfield">
          <label className="workbench-label" htmlFor="workbench-resolution">
            {resolutionLabel}
          </label>
          <select
            id="workbench-resolution"
            className="field-select"
            value={resolution}
            onChange={(event) => onResolution(event.target.value)}
          >
            <option value="">{resolutionFirstLabel}</option>
            {resolutionsFor(capability).map((tier) => (
              <option key={tier} value={String(tier)}>
                {composeRatio
                  ? `${composeFor(capability, composeRatio, tier)} · ${resolutionTierLabel(capability, tier)}`
                  : resolutionTierLabel(capability, tier)}
              </option>
            ))}
            <option value={CUSTOM_SIZE}>{customLabel}</option>
          </select>
        </div>
      </div>
      {isCustom ? (
        <input
          className="workbench-input font-mono"
          value={customValue}
          placeholder={placeholder}
          aria-label={resolutionLabel}
          aria-invalid={!valid}
          onChange={(event) => onCustomValue(event.target.value)}
        />
      ) : null}
      {shown && valid ? <p className="workbench-hint font-mono">{resolvedLabel(shown)}</p> : null}
      {!valid ? <p className="workbench-hint is-error">{invalidLabel}</p> : null}
    </div>
  );
}

export function WorkbenchPage() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setPage = useAppStore((state) => state.setPage);

  const [capability, setCapability] = useState<Capability>("image");
  // Image and video keep separate drafts: they are different pieces of work, and
  // one box shared between the tabs threw the other prompt away.
  const [prompts, setPrompts] = useState<Record<Capability, string>>({ image: "", video: "" });
  const prompt = prompts[capability];
  const setPrompt = (value: string) =>
    setPrompts((current) => ({ ...current, [capability]: value }));
  // The count is kept as typed text so a wrong entry is visible and blocking
  // rather than silently rewritten while the user is still typing it.
  const [countDraft, setCountDraft] = useState("1");
  const countValue = normalizeCount(countDraft);
  const count = countValue ?? 1;
  const countInvalid = countValue === null;
  const [ratio, setRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [duration, setDuration] = useState(DEFAULT_VIDEO_DURATION);
  const [imageReferences, setImageReferences] = useState<string[]>([]);
  const [firstFrame, setFirstFrame] = useState("");
  const [lastFrame, setLastFrame] = useState("");
  const [frameFieldFirst, setFrameFieldFirst] = useState("");
  const [frameFieldLast, setFrameFieldLast] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [choices, setChoices] = useState<Record<Capability, WorkbenchModelChoice | null>>({
    image: null,
    video: null,
  });
  const [progress, setProgress] = useState<MediaWorkbenchProgress | null>(null);
  // Results belong to the capability that produced them: one panel shared
  // between the tabs showed an image run while the video tab was open.
  const [runs, setRuns] = useState<Record<Capability, Run | null>>({ image: null, video: null });
  const run = runs[capability];
  const setRun = (value: Run | null | ((current: Run | null) => Run | null)) =>
    setRuns((current) => ({
      ...current,
      [capability]: typeof value === "function" ? value(current[capability]) : value,
    }));
  const [history, setHistory] = useState<Run[]>([]);
  // What the app rendered before this window opened. Read once, on mount, so a
  // restart does not erase assets the user paid for.
  const [library, setLibrary] = useState<Run[]>([]);
  // History belongs to the capability that produced it, and a run that failed is
  // a different thing from a run that worked, so the two never share a list.
  const scopedHistory = [...library, ...history].filter(
    (entry) => entry.capability === capability,
  );
  const succeededHistory = scopedHistory.filter((entry) => entry.ok !== false);
  const failedHistory = scopedHistory.filter((entry) => entry.ok === false);
  const [now, setNow] = useState(() => Date.now());
  const generationRef = useRef("");

  const isImage = capability === "image";
  const running = run !== null && run.finishedAt === undefined;

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
  const canSubmit =
    !countInvalid &&
    !running &&
    prompt.trim().length > 0 &&
    sizeOk &&
    lastFrameOk &&
    configured;

  useEffect(() => {
    setRun(null);
    setProgress(null);
  }, [capability]);

  useEffect(() => {
    let cancelled = false;
    void api
      .workbenchLibrary()
      .then((result) => {
        if (!cancelled) setLibrary(result.entries.map(runFromEntry));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // The main process reports progress under the id it assigned, which the renderer
  // only learns from the first event; adopting it here keeps later events matching.
  useEffect(
    () =>
      api.onWorkbenchProgress((event) => {
        if (event.sessionId !== (activeSessionId ?? "")) return;
        if (!event.generationId) return;
        if (generationRef.current && event.generationId !== generationRef.current) return;
        generationRef.current = event.generationId;
        setProgress(event);
        if (!event.item) return;
        const item = event.item;
        setRun((current) =>
          current ? { ...current, states: { ...current.states, [item.index]: item.status } } : current,
        );
      }),
    [activeSessionId],
  );

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

  const submit = useCallback(async () => {
    if (!prompt.trim() || running || !sizeOk || !lastFrameOk) return;
    const frameFields =
      !isImage && (frameFieldFirst.trim() || frameFieldLast.trim())
        ? {
            ...(frameFieldFirst.trim() ? { first: frameFieldFirst.trim() } : {}),
            ...(frameFieldLast.trim() ? { last: frameFieldLast.trim() } : {}),
          }
        : undefined;
    const input: ImageGenerationInput | VideoGenerationInput = isImage
      ? {
          items: [
            {
              prompt: prompt.trim(),
              count,
              ...(size.trim() ? { size: size.trim() } : {}),
              ...(imageReferences.length ? { images: imageReferences } : {}),
            },
          ],
        }
      : {
          items: [
            {
              prompt: prompt.trim(),
              count,
              durationSeconds: duration,
              ...(size.trim() ? { size: size.trim() } : {}),
              ...(firstFrame ? { image: firstFrame } : {}),
              ...(lastFrame && firstFrame ? { lastFrame } : {}),
            },
          ],
        };
    const startedAt = Date.now();
    const model = choice ?? null;
    generationRef.current = "";
    setNow(startedAt);
    setProgress(null);
    setRun({
      id: "",
      capability,
      sessionId: activeSessionId ?? "",
      prompt: prompt.trim(),
      model,
      startedAt,
      results: null,
      states: {},
      total: count,
      ok: null,
    });
    try {
      const result = await api.workbenchGenerate({
        capability,
        sessionId: activeSessionId ?? "",
        ...(model ? { model } : {}),
        ...(frameFields ? { frames: frameFields } : {}),
        input,
      });
      const finished: Run = {
        id: result.generationId,
        capability,
        sessionId: activeSessionId ?? "",
        prompt: prompt.trim(),
        model:
          model ??
          (result.providerId && result.modelId
            ? { providerId: result.providerId, modelId: result.modelId }
            : null),
        startedAt,
        finishedAt: Date.now(),
        ...(size ? { size } : {}),
        results: result.results,
        states: result.results.reduce<Record<number, ItemState>>((accumulator, item) => {
          accumulator[item.index] = item.status;
          return accumulator;
        }, {}),
        total: Math.max(count, result.results.length),
        ok: result.ok,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
      setRun(finished);
      setHistory((current) => [finished, ...current].slice(0, 24));
    } catch (error) {
      setRun((current) =>
        current
          ? {
              ...current,
              finishedAt: Date.now(),
              results: [],
              ok: false,
              errorCode: "MEDIA_FAILED",
              message: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    } finally {
      generationRef.current = "";
    }
  }, [
    activeSessionId,
    capability,
    choice,
    count,
    duration,
    firstFrame,
    frameFieldFirst,
    frameFieldLast,
    imageReferences,
    isImage,
    lastFrame,
    lastFrameOk,
    prompt,
    running,
    size,
    sizeOk,
  ]);

  const cancel = async () => {
    if (generationRef.current) await api.workbenchCancel(generationRef.current);
  };

  const outputs = useMemo<WorkbenchOutput[]>(() => {
    if (!run) return [];
    const total = Math.max(run.total, run.results?.length ?? 0);
    return Array.from({ length: total }, (_unused, index) => {
      const result = run.results?.find((item) => item.index === index);
      const state: ItemState =
        result?.status ?? run.states[index] ?? (run.finishedAt ? "failed" : "pending");
      return { index, state, ...(result ? { result } : {}) };
    });
  }, [run]);

  const elapsed = run ? (run.finishedAt ?? now) - run.startedAt : 0;
  const succeeded = run?.results?.filter((item) => item.status === "succeeded").length ?? 0;
  const failed = run?.results?.filter((item) => item.status !== "succeeded").length ?? 0;
  const savedPaths = outputs
    .map((output) => output.result?.path)
    .filter((path): path is string => Boolean(path));

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
        <section className="workbench-panel workbench-compose" aria-label={t("workbench.compose")}>
          <div className="workbench-field">
            <span className="workbench-label">{t("workbench.model")}</span>
            <WorkbenchModelPicker
              value={choice}
              options={modelOptions}
              onChange={(next) => setChoices((current) => ({ ...current, [capability]: next }))}
            />
            {configured ? (
              <p className="workbench-hint font-mono">
                {resolvedModel}
                {choice ? ` · ${t("workbench.modelPinned")}` : ""}
              </p>
            ) : (
              <p className="workbench-hint is-error">
                {t("workbench.modelMissing")}
                <button type="button" className="workbench-link" onClick={() => setPage("settings")}>
                  {t("workbench.modelSetup")}
                </button>
              </p>
            )}
          </div>

          <div className="workbench-field">
            <label className="workbench-label" htmlFor="workbench-prompt">
              {t("workbench.promptLabel")}
            </label>
            <textarea
              id="workbench-prompt"
              className="workbench-textarea"
              rows={7}
              value={prompt}
              placeholder={t("workbench.promptPlaceholder")}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
              }}
            />
            <p className="workbench-hint">
              {`${t("workbench.promptHint")} · ${prompt.trim().length}`}
            </p>
          </div>

          <div className="workbench-row">
            <div className="workbench-field">
              <label className="workbench-label" htmlFor="workbench-count">
                {t("workbench.count")}
              </label>
              <input
                id="workbench-count"
                className="workbench-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={countInvalid}
                aria-describedby={countInvalid ? "workbench-count-error" : undefined}
                value={countDraft}
                onChange={(event) =>
                  setCountDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))
                }
                onBlur={() => {
                  // Leaving the field settles it: an out-of-range number is pulled
                  // back to the nearest allowed one, so the box cannot stay wrong.
                  const settled = normalizeCount(countDraft);
                  setCountDraft(String(settled ?? clampCount(Number(countDraft))));
                }}
              />
              {countInvalid ? (
                <p className="workbench-hint is-error" id="workbench-count-error" role="alert">
                  {t("workbench.countRange", { max: MAX_WORKBENCH_COUNT })}
                </p>
              ) : null}
            </div>
            {isImage ? null : (
              <div className="workbench-field">
                <label className="workbench-label" htmlFor="workbench-duration">
                  {t("workbench.duration")}
                </label>
                <select
                  id="workbench-duration"
                  className="field-select"
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                >
                  {VIDEO_DURATION_PRESETS.filter(
                    (value) => value <= MAX_VIDEO_DURATION_SECONDS,
                  ).map((value) => (
                    <option key={value} value={value}>
                      {`${value}s`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <ShapeField
            capability={capability}
            ratio={ratio}
            resolution={resolution}
            customValue={customValue}
            valid={sizeOk}
            onRatio={setRatio}
            onResolution={setResolution}
            onCustomValue={setCustomValue}
            label={t("workbench.size")}
            defaultLabel={t("workbench.sizeDefault")}
            resolutionLabel={t("workbench.resolution")}
            resolutionFirstLabel={t("workbench.resolutionFirst")}
            customLabel={t("workbench.sizeCustom")}
            invalidLabel={t("workbench.sizeInvalid")}
            placeholder={t("workbench.sizePlaceholder")}
            resolvedLabel={(value) => t("workbench.sizeResolved", { size: value })}
          />

          {isImage ? (
            <div className="workbench-field">
              <span className="workbench-label">{t("workbench.reference")}</span>
              <div className="workbench-frames">
                {imageReferences.map((path) => (
                  <span key={path} className="workbench-chip" title={path}>
                    {fileName(path)}
                    <button
                      type="button"
                      aria-label={t("workbench.removeReference")}
                      onClick={() =>
                        setImageReferences((current) =>
                          current.filter((entry) => entry !== path),
                        )
                      }
                    >
                      <IconClose size={12} aria-hidden />
                    </button>
                  </span>
                ))}
                {imageReferences.length === 0 ? (
                  <span className="workbench-hint">{t("workbench.referenceEmpty")}</span>
                ) : null}
              </div>
              <Button type="button" size="sm" onClick={() => void addFiles("references")}>
                <IconPlus size={14} aria-hidden />
                {t("workbench.referenceAdd")}
              </Button>
            </div>
          ) : (
            <div className="workbench-field">
              <span className="workbench-label">{t("workbench.framesOptional")}</span>
              <div className="workbench-frames">
                <button
                  type="button"
                  className={`workbench-slot${firstFrame ? " is-set" : ""}`}
                  onClick={() => void addFiles("first")}
                >
                  <span className="workbench-slot-title">{t("workbench.firstFrame")}</span>
                  <span className="workbench-slot-value font-mono">
                    {firstFrame ? fileName(firstFrame) : t("workbench.frameNone")}
                  </span>
                </button>
                <button
                  type="button"
                  className={`workbench-slot${lastFrame ? " is-set" : ""}`}
                  disabled={!firstFrame}
                  onClick={() => void addFiles("last")}
                >
                  <span className="workbench-slot-title">{t("workbench.lastFrame")}</span>
                  <span className="workbench-slot-value font-mono">
                    {lastFrame ? fileName(lastFrame) : t("workbench.frameNone")}
                  </span>
                </button>
              </div>
              <p className="workbench-hint">{t("workbench.framesHint")}</p>
              {lastFrame && !firstFrame ? (
                <p className="workbench-hint is-error">{t("workbench.lastFrameNeedsFirst")}</p>
              ) : null}
            </div>
          )}

          {isImage ? null : (
            <div className="workbench-advanced">
              <button
                type="button"
                className="workbench-disclosure"
                aria-expanded={advanced}
                onClick={() => setAdvanced((current) => !current)}
              >
                {t("workbench.advanced")}
              </button>
              {advanced ? (
                <div className="workbench-advanced-body">
                  <p className="workbench-hint">{t("workbench.frameFieldHint")}</p>
                  <div className="workbench-row">
                    <div className="workbench-field">
                      <label className="workbench-label" htmlFor="workbench-field-first">
                        {t("workbench.frameFieldFirst")}
                      </label>
                      <input
                        id="workbench-field-first"
                        className="workbench-input font-mono"
                        value={frameFieldFirst}
                        placeholder="input_reference"
                        onChange={(event) => setFrameFieldFirst(event.target.value)}
                      />
                    </div>
                    <div className="workbench-field">
                      <label className="workbench-label" htmlFor="workbench-field-last">
                        {t("workbench.frameFieldLast")}
                      </label>
                      <input
                        id="workbench-field-last"
                        className="workbench-input font-mono"
                        value={frameFieldLast}
                        placeholder="last_frame"
                        onChange={(event) => setFrameFieldLast(event.target.value)}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          <p className="workbench-estimate">
            {isImage
              ? t("workbench.estimateImages", { count })
              : t("workbench.estimateVideos", { count, seconds: duration * count })}
          </p>

          <div className="workbench-actions">
            {running ? (
              <>
                <Button type="button" variant="secondary" onClick={() => void cancel()}>
                  {t("workbench.cancel")}
                </Button>
                <span className="workbench-elapsed">
                  {`${t("workbench.elapsed")} ${clock(elapsed)}`}
                  {progress ? ` · ${progress.completed}/${progress.total}` : ""}
                </span>
              </>
            ) : (
              <Button
                type="button"
                variant="primary"
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                {t("workbench.submit")}
              </Button>
            )}
          </div>
        </section>

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

          <div className="workbench-history">
            <h2>{t("workbench.history")}</h2>
            {scopedHistory.length === 0 ? (
              <p className="workbench-hint">{t("workbench.historyEmpty")}</p>
            ) : (
              <>
                {succeededHistory.length > 0 ? (
                  <>
                    <p className="workbench-history-group">
                      {`${t("workbench.historySucceeded")} · ${succeededHistory.length}`}
                    </p>
                    <ul className="workbench-history-list">
                      {succeededHistory.map((entry) => (
                        <HistoryRow key={entry.id} entry={entry} onPick={setRun} />
                      ))}
                    </ul>
                  </>
                ) : null}
                {failedHistory.length > 0 ? (
                  <>
                    <p className="workbench-history-group">
                      {`${t("workbench.historyFailed")} · ${failedHistory.length}`}
                    </p>
                    <ul className="workbench-history-list">
                      {failedHistory.map((entry) => (
                        <HistoryRow key={entry.id} entry={entry} onPick={setRun} />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
