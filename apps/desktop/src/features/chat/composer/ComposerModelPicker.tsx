import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { ComposerModelList } from "./ComposerModelList";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import {
  IconActivity,
  IconBot,
  IconCheck,
  IconChevronDown,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";
import { ThinkingLevelSlider } from "./ThinkingLevelSlider";
import { reasoningLevelLabelKey } from "./model";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;

export type ComposerModelPickerProps = {
  t: TFunction;
  controller: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  thinkingLevel: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  rootActions?: ReactNode;
};

/**
 * Two independent composer pills that share one controller (D629): a model
 * picker (left) and a reasoning-level picker (right). The reasoning pill only
 * appears for a model that publishes a reasoning ladder; both keep the same
 * keyboard, focus and latest-wins commit contract as the old combined chip.
 */
export function ComposerModelPicker({
  t,
  controller,
  modelLabel,
  thinkingLabel,
  thinkingLevel,
  selectedProviderId,
  selectedModelId,
  controlsBlocked,
  onCloseOtherMenus,
  rootActions,
}: ComposerModelPickerProps) {
  const {
    modelOpen,
    setModelOpen,
    reasoningOpen,
    setReasoningOpen,
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
  } = controller;

  return (
    <>
      <AnchoredMenu
        className="composer-model-thinking"
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        menuClassName="composer-model-menu composer-model-thinking-menu composer-model-browser-menu"
        label={t("chat.model")}
        role="menu"
        align="end"
        side="top"
        initialFocus="none"
        onMenuKeyDown={onModelMenuKeyDown}
        trigger={(ref) => (
          <TooltipButton
            ref={ref}
            type="button"
            className={`icon-btn composer-model-thinking-chip composer-model-chip ${modelOpen ? "active" : ""}`}
            tooltip={modelLabel}
            ariaLabel={`${t("chat.model")}: ${modelLabel}`}
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            disabled={controlsBlocked}
            onClick={() => {
              onCloseOtherMenus();
              setReasoningOpen(false);
              if (!modelOpen) {
                setQuery("");
                setModelHighlight(-1);
              }
              setModelOpen((current) => !current);
            }}
          >
            <span className="composer-model-thinking-icon" aria-hidden="true">
              <IconBot size={14} />
            </span>
            <span className="composer-model-thinking-model">{modelLabel}</span>
            <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
          </TooltipButton>
        )}
      >
        {rootActions}
        <ComposerModelList
          t={t} query={query} setQuery={setQuery}
          modelSearchRef={modelSearchRef} modelListRef={modelListRef}
          paneEntries={flatModels} modelHighlight={modelHighlight}
          setModelHighlight={setModelHighlight} selectModel={selectModel}
          selectedProviderId={selectedProviderId} selectedModelId={selectedModelId}
          selector={selector}
        />
      </AnchoredMenu>

      {hasReasoning ? (
        <AnchoredMenu
          className="composer-model-thinking"
          open={reasoningOpen}
          onClose={() => setReasoningOpen(false)}
          menuClassName="composer-model-menu composer-model-thinking-menu"
          label={t("chat.reasoningLevel")}
          role="menu"
          align="end"
          side="top"
          initialFocus="none"
          onMenuKeyDown={onReasoningMenuKeyDown}
          trigger={(ref) => (
            <TooltipButton
              ref={ref}
              type="button"
              className={`icon-btn composer-model-thinking-chip composer-reasoning-chip ${reasoningOpen ? "active" : ""}`}
              tooltip={`${t("chat.reasoningLevel")}: ${thinkingLabel}`}
              ariaLabel={`${t("chat.reasoningLevel")}: ${thinkingLabel}`}
              aria-haspopup="menu"
              aria-expanded={reasoningOpen}
              disabled={controlsBlocked}
              onClick={() => {
                onCloseOtherMenus();
                setModelOpen(false);
                if (!reasoningOpen) setThinkingHighlight(-1);
                setReasoningOpen((current) => !current);
              }}
            >
              <span className="composer-model-thinking-icon" aria-hidden="true">
                <IconActivity size={14} />
              </span>
              <span className="composer-model-thinking-level">{thinkingLabel}</span>
              <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
            </TooltipButton>
          )}
        >
          <div className="composer-thinking-heading">
            {modelPublishesReasoning
              ? t("chat.reasoningSupportedBy", { model: modelLabel })
              : t("chat.reasoningUnavailableFor", { model: modelLabel })}
          </div>
          <div className="composer-thinking-list" ref={thinkingListRef}>
            {thinkingMenuLevels.map((level, index) => (
              <button
                key={level}
                type="button"
                data-thinking-index={index}
                className={`composer-plus-item ${thinkingLevel === level ? "active" : ""} ${thinkingHighlight === index ? "kb-active" : ""}`}
                role="menuitemradio"
                aria-checked={thinkingLevel === level}
                onMouseMove={() => setThinkingHighlight(index)}
                onClick={() => void selectThinkingLevel(level)}
              >
                <span className="flex-1">{t(reasoningLevelLabelKey(level))}</span>
                {thinkingLevel === level ? <IconCheck size={14} className="composer-model-check" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
          {/* The slider mirrors the reference: one drag adjusts the level
              without leaving the menu; the radio list above stays as the
              precise picker (issue #417). */}
          {thinkingMenuLevels.length > 1 ? (
            <ThinkingLevelSlider
              key={`${selectedProviderId}:${selectedModelId}:${thinkingMenuLevels.join("|")}`}
              levels={thinkingMenuLevels}
              level={thinkingLevel}
              label={t("chat.reasoningLevel")}
              labelFor={(level) => t(reasoningLevelLabelKey(level))}
              commit={commitThinkingLevel}
            />
          ) : null}
        </AnchoredMenu>
      ) : null}
    </>
  );
}
