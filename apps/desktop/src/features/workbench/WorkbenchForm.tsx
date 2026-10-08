/**
 * The workbench's compose panel.
 *
 * The parameter form is pure presentation over the page's draft state: every
 * field the user can set for the current capability, plus the run controls that
 * live at the bottom of the panel. The state itself stays in the page so the
 * results panel and the form read the same draft.
 */
import { useTranslation } from "react-i18next";
import { MAX_VIDEO_DURATION_SECONDS, type MediaWorkbenchProgress } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { IconClose, IconPlus } from "../../components/icons";
import {
  MAX_WORKBENCH_COUNT,
  VIDEO_DURATION_PRESETS,
  clampCount,
  composeFor,
  defaultResolutionFor,
  normalizeCount,
  ratioById,
  ratiosFor,
  resolutionsFor,
  resolutionTierLabel,
} from "./presets";
import {
  WorkbenchModelPicker,
  type WorkbenchModelChoice,
  type WorkbenchModelOption,
} from "./WorkbenchModelPicker";
import type { Capability } from "./useWorkbenchRuns";

const CUSTOM_SIZE = "__custom__";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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

export function WorkbenchForm({
  capability,
  isImage,
  choice,
  modelOptions,
  configured,
  resolvedModel,
  onModelChange,
  onOpenSettings,
  prompt,
  onPromptChange,
  onSubmit,
  running,
  canSubmit,
  elapsed,
  progress,
  countDraft,
  countInvalid,
  onCountDraftChange,
  count,
  duration,
  onDurationChange,
  ratio,
  resolution,
  customValue,
  sizeOk,
  onRatioChange,
  onResolutionChange,
  onCustomValueChange,
  imageReferences,
  onRemoveReference,
  firstFrame,
  lastFrame,
  frameFieldFirst,
  frameFieldLast,
  advanced,
  onToggleAdvanced,
  onFrameFieldFirstChange,
  onFrameFieldLastChange,
  onAddFiles,
  onCancel,
}: {
  capability: Capability;
  isImage: boolean;
  choice: WorkbenchModelChoice | null;
  modelOptions: WorkbenchModelOption[];
  configured: boolean;
  resolvedModel: string;
  onModelChange: (next: WorkbenchModelChoice | null) => void;
  onOpenSettings: () => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  running: boolean;
  canSubmit: boolean;
  elapsed: number;
  progress: MediaWorkbenchProgress | null;
  countDraft: string;
  countInvalid: boolean;
  onCountDraftChange: (value: string) => void;
  count: number;
  duration: number;
  onDurationChange: (value: number) => void;
  ratio: string;
  resolution: string;
  customValue: string;
  sizeOk: boolean;
  onRatioChange: (value: string) => void;
  onResolutionChange: (value: string) => void;
  onCustomValueChange: (value: string) => void;
  imageReferences: string[];
  onRemoveReference: (path: string) => void;
  firstFrame: string;
  lastFrame: string;
  frameFieldFirst: string;
  frameFieldLast: string;
  advanced: boolean;
  onToggleAdvanced: () => void;
  onFrameFieldFirstChange: (value: string) => void;
  onFrameFieldLastChange: (value: string) => void;
  onAddFiles: (target: "references" | "first" | "last") => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="workbench-panel workbench-compose" aria-label={t("workbench.compose")}>
      <div className="workbench-field">
        <span className="workbench-label">{t("workbench.model")}</span>
        <WorkbenchModelPicker
          value={choice}
          options={modelOptions}
          onChange={onModelChange}
        />
        {configured ? (
          <p className="workbench-hint font-mono">
            {resolvedModel}
            {choice ? ` · ${t("workbench.modelPinned")}` : ""}
          </p>
        ) : (
          <p className="workbench-hint is-error">
            {t("workbench.modelMissing")}
            <button type="button" className="workbench-link" onClick={onOpenSettings}>
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
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void onSubmit();
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
              onCountDraftChange(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))
            }
            onBlur={() => {
              // Leaving the field settles it: an out-of-range number is pulled
              // back to the nearest allowed one, so the box cannot stay wrong.
              const settled = normalizeCount(countDraft);
              onCountDraftChange(String(settled ?? clampCount(Number(countDraft))));
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
              onChange={(event) => onDurationChange(Number(event.target.value))}
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
        onRatio={onRatioChange}
        onResolution={onResolutionChange}
        onCustomValue={onCustomValueChange}
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
                  onClick={() => onRemoveReference(path)}
                >
                  <IconClose size={12} aria-hidden />
                </button>
              </span>
            ))}
            {imageReferences.length === 0 ? (
              <span className="workbench-hint">{t("workbench.referenceEmpty")}</span>
            ) : null}
          </div>
          <Button type="button" size="sm" onClick={() => void onAddFiles("references")}>
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
              onClick={() => void onAddFiles("first")}
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
              onClick={() => void onAddFiles("last")}
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
            onClick={onToggleAdvanced}
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
                    onChange={(event) => onFrameFieldFirstChange(event.target.value)}
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
                    onChange={(event) => onFrameFieldLastChange(event.target.value)}
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
            <Button type="button" variant="secondary" onClick={onCancel}>
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
            onClick={onSubmit}
          >
            {t("workbench.submit")}
          </Button>
        )}
      </div>
    </section>
  );
}
