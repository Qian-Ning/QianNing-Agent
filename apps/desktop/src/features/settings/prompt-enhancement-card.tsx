/**
 * Prompt-enhancement settings (ADR 0121).
 *
 * This card owns the Composer Enhance prompt action: an edit button that opens
 * the template editor, and the model plus reasoning rows that pick which model
 * runs the rewrite.
 *
 * Both the system prompt and the user template are editable here. Each field
 * shows its built-in default when no override is saved, so the editor opens on
 * the value in force and "restore default" is self-explanatory. Editing a field
 * back to the exact default text clears that override rather than storing a
 * frozen copy, so a later product improvement to the default still reaches a
 * user who never customized it. The `{{draft}}` placeholder is optional: a user
 * template without it still sends the draft (it is appended at render time).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  PROMPT_ENHANCEMENT_DRAFT_VARIABLE,
  PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH,
  isCustomPromptEnhancementTemplateActive,
} from "@pi-desktop/shared";
import { Button, Field, TooltipButton, portalOverlay } from "../../components/ui";
import { IconPencil, IconX } from "../../components/icons";
import { SettingsCard, SettingsRow } from "./primitives";
import { EnhancementModelCard } from "../../components/settings/EnhancementModelCard";

export function PromptEnhancementCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editorOpen, setEditorOpen] = useState(false);
  const hasCustomTemplate = isCustomPromptEnhancementTemplateActive({
    customTemplate: settings.promptEnhancementCustomTemplate,
    userTemplate: settings.promptEnhancementUserTemplate,
    systemPrompt: settings.promptEnhancementSystemPrompt,
  });

  return (
    <SettingsCard title={t("settings.promptEnhancementTitle")}>
      <SettingsRow
        title={t("settings.promptEnhancementCustomTemplate")}
        description={t("settings.promptEnhancementCustomTemplateDesc")}
        detail={
          hasCustomTemplate
            ? t("settings.promptEnhancementCustomTemplateActive")
            : undefined
        }
      >
        <TooltipButton
          type="button"
          className="settings-icon-button"
          ariaLabel={t("settings.promptEnhancementEdit")}
          tooltip={t("settings.promptEnhancementEdit")}
          onClick={() => setEditorOpen(true)}
        >
          <IconPencil size={15} />
        </TooltipButton>
      </SettingsRow>

      <EnhancementModelCard />

      {editorOpen ? (
        <PromptEnhancementEditorSheet
          settings={settings}
          saveSettings={saveSettings}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </SettingsCard>
  );
}

/**
 * The editor itself. Drafts are local until Save, so closing the sheet
 * abandons the edit — the same contract as the subagent editor.
 *
 * Layout follows the ext-sheet design system: head / body / error / actions.
 * Insert Draft and Restore Default are left-side utility buttons in the
 * actions footer, matching SubagentEditorSheet's pattern.
 */
function PromptEnhancementEditorSheet({
  settings,
  saveSettings,
  onClose,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const savedSystem = settings.promptEnhancementSystemPrompt ?? "";
  const savedTemplate = settings.promptEnhancementUserTemplate ?? "";
  const [systemDraft, setSystemDraft] = useState(
    savedSystem || PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT,
  );
  const [templateDraft, setTemplateDraft] = useState(
    savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement | null>(null);

  const systemTooLong =
    [...systemDraft].length > PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH;
  const templateTooLong =
    [...templateDraft].length > PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH;
  const systemDefault = systemDraft === PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT;
  const templateDefault =
    templateDraft === PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE;
  const dirty =
    systemDraft !== (savedSystem || PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT) ||
    templateDraft !== (savedTemplate || PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const insertDraftVariable = () => {
    const element = templateRef.current;
    if (!element) {
      setTemplateDraft((current) => `${current}${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}`);
      return;
    }
    const start = element.selectionStart ?? templateDraft.length;
    const end = element.selectionEnd ?? start;
    setTemplateDraft(
      `${templateDraft.slice(0, start)}${PROMPT_ENHANCEMENT_DRAFT_VARIABLE}${templateDraft.slice(end)}`,
    );
    const caret = start + PROMPT_ENHANCEMENT_DRAFT_VARIABLE.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const restoreDefaults = () => {
    setSystemDraft(PROMPT_ENHANCEMENT_DEFAULT_SYSTEM_PROMPT);
    setTemplateDraft(PROMPT_ENHANCEMENT_DEFAULT_USER_TEMPLATE);
  };

  const save = async () => {
    if (systemTooLong || templateTooLong || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      // Editing a field back to its default clears that override, so a later
      // improvement to the default still reaches this user.
      const systemValue = systemDefault ? "" : systemDraft;
      const templateValue = templateDefault ? "" : templateDraft;
      await saveSettings({
        promptEnhancementSystemPrompt: systemValue,
        promptEnhancementUserTemplate: templateValue,
        promptEnhancementCustomTemplate: Boolean(
          systemValue.trim() || templateValue.trim(),
        ),
      });
      onClose();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const hasValidationError = systemTooLong || templateTooLong;
  const errorMessage = hasValidationError
    ? t("settings.promptEnhancementTooLong")
    : saveError
      ? t("settings.promptEnhancementSaveError")
      : null;

  return portalOverlay(
    <div
      className="overlay ext-sheet-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="dialog ext-sheet"
        role="dialog"
        aria-modal
        aria-labelledby="prompt-enhancement-sheet-title"
      >
        <div className="ext-sheet-head">
          <div>
            <h3 id="prompt-enhancement-sheet-title" className="ext-sheet-title">
              {t("settings.promptEnhancementTitle")}
            </h3>
            <div className="ext-sheet-sub">
              {t("settings.promptEnhancementDesc")}
            </div>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={() => {
              if (!saving) onClose();
            }}
            disabled={saving}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          <Field
            label={t("settings.promptEnhancementSystemPrompt")}
            hint={t("settings.promptEnhancementSystemPromptDesc")}
          >
            <textarea
              className="field-textarea ext-skill-body"
              value={systemDraft}
              rows={8}
              onChange={(event) => setSystemDraft(event.target.value)}
              aria-label={t("settings.promptEnhancementSystemPrompt")}
              aria-invalid={systemTooLong}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </Field>
          <Field
            label={t("settings.promptEnhancementUserTemplate")}
            hint={t("settings.promptEnhancementUserTemplateDesc")}
          >
            <textarea
              ref={templateRef}
              className="field-textarea ext-skill-body"
              value={templateDraft}
              rows={10}
              onChange={(event) => setTemplateDraft(event.target.value)}
              aria-label={t("settings.promptEnhancementUserTemplate")}
              aria-invalid={templateTooLong}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </Field>
        </div>

        {errorMessage ? (
          <p className="ext-sheet-error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className="ext-sheet-actions">
          <Button variant="ghost" type="button" onClick={insertDraftVariable}>
            {t("settings.promptEnhancementInsertDraft")}
          </Button>
          <Button variant="ghost" type="button" onClick={restoreDefaults}>
            {t("settings.promptEnhancementRestore")}
          </Button>
          <div className="ext-sheet-actions-end">
            <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={!dirty || saving || hasValidationError}
              onClick={() => void save()}
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
  );
}
