import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PromptPreset, SessionSummary } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { Button, Input, Textarea, TooltipButton } from "./ui";
import { IconBot, IconClose, IconPlus, IconTrash } from "./icons";

/**
 * The per-conversation persona editor plus the saved-prompt shelf.
 *
 * The editor is the only editable persona scope: the value belongs to ONE
 * session row (`sessions.system_prompt`) and leaves every other conversation on
 * the built-in default. Clearing the field (or typing only whitespace) removes
 * the prompt rather than storing an empty string, so the conversation returns
 * to the built-in persona.
 *
 * The shelf is NOT a second scope. It stores prompt *source text* under a name;
 * applying one only fills this editor's draft, and nothing is auto-applied to
 * any other conversation or to a new one (ADR 0310).
 */

/** Mirror of host-core `MAX_SESSION_SYSTEM_PROMPT_CHARS`, for a client-side hint. */
const PROMPT_PRESET_MAX_CHARS = 200_000;
/** How much of a saved prompt to show in a shelf row. */
const PRESET_PREVIEW_CHARS = 80;

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function SessionPromptDialog({
  session,
  onClose,
  onSave,
}: {
  session: SessionSummary;
  onClose: () => void;
  onSave: (value: string | null) => Promise<void>;
}) {
  // Electron's native preview composites above renderer DOM, including a
  // portal, so hide it for the lifetime of this modal (same rule as rename).
  useBlockingOverlay();
  const { t } = useTranslation();
  const stored = session.systemPrompt ?? "";
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shelf state.
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [presetBusy, setPresetBusy] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  // An apply that would overwrite a non-empty, different draft waits here for
  // the user's inline confirmation.
  const [pendingApply, setPendingApply] = useState<PromptPreset | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PromptPreset | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  // Load the shelf once, when the dialog opens.
  useEffect(() => {
    let live = true;
    api
      .listPromptPresets()
      .then((result) => {
        if (live) setPresets(result.presets);
      })
      .catch((caught) => {
        if (live) setError(errorMessage(caught));
      });
    return () => {
      live = false;
    };
  }, []);

  const dirty = draft !== stored;
  const commit = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };
  // Save writes the trimmed draft, or removes the override when it is blank so
  // the conversation returns to the built-in persona.
  const save = () => {
    const trimmed = draft.trim();
    void commit(trimmed ? trimmed : null);
  };
  // One-click "stop using this prompt": drop the override without making the
  // user hand-delete the text first. Only offered when a prompt is stored.
  const clearOverride = () => void commit(null);

  // ---- shelf actions ------------------------------------------------------

  const applyPreset = (preset: PromptPreset) => {
    const current = draft.trim();
    if (current && current !== preset.text.trim()) {
      // Ask inline before discarding what the user typed.
      setPendingApply(preset);
      return;
    }
    setDraft(preset.text);
    setPendingApply(null);
    setError(null);
  };
  const confirmApply = () => {
    if (pendingApply) setDraft(pendingApply.text);
    setPendingApply(null);
    setError(null);
  };

  const savePreset = async () => {
    const name = presetName.trim();
    const text = draft.trim();
    if (!name || presetBusy) return;
    if (!text) {
      setError(t("chat.promptPresetNeedsText"));
      return;
    }
    // Mirror the host's case-insensitive duplicate refusal so the message names
    // the clash without a round trip.
    const clash = presets.find(
      (preset) => preset.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      setError(t("chat.promptPresetDuplicateName", { name: clash.name }));
      return;
    }
    if (text.length > PROMPT_PRESET_MAX_CHARS) {
      setError(t("chat.promptPresetTooLong", { limit: PROMPT_PRESET_MAX_CHARS }));
      return;
    }
    setPresetBusy(true);
    setError(null);
    try {
      const { preset } = await api.savePromptPreset(name, text);
      setPresets((prev) => [preset, ...prev]);
      setPresetName("");
      setSaveAsOpen(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPresetBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPresetBusy(true);
    setError(null);
    try {
      await api.deletePromptPreset(target.id);
      setPresets((prev) => prev.filter((preset) => preset.id !== target.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPresetBusy(false);
      setPendingDelete(null);
    }
  };

  const preview = (text: string) => {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > PRESET_PREVIEW_CHARS
      ? `${oneLine.slice(0, PRESET_PREVIEW_CHARS)}…`
      : oneLine;
  };

  const dialog = (
    <div
      className="overlay session-prompt-dialog-overlay"
      role="presentation"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="dialog session-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-prompt-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h3
              id="session-prompt-dialog-title"
              className="project-instructions-dialog-title"
            >
              {t("chat.conversationPromptTitle")}
            </h3>
            <div className="project-instructions-dialog-project">
              {session.title}
            </div>
          </div>
          <TooltipButton
            type="button"
            className="project-instructions-dialog-close"
            tooltip={t("settings.cancel")}
            ariaLabel={t("settings.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <p className="project-memory-dialog-description">
          {t("chat.conversationPromptDesc")}
        </p>
        <Textarea
          className="settings-instruction-editor session-prompt-dialog-editor"
          value={draft}
          placeholder={t("chat.conversationPromptPlaceholder")}
          aria-label={t("chat.conversationPromptTitle")}
          disabled={saving}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="project-memory-dialog-hint">
          {stored ? (
            <span className="session-prompt-state active">
              {t("chat.conversationPromptActive")}
            </span>
          ) : (
            <span className="session-prompt-state">
              {t("chat.conversationPromptInherit")}
            </span>
          )}
        </div>

        {/* ---- Saved-prompt shelf -------------------------------------- */}
        <section
          className="session-prompt-shelf"
          aria-label={t("chat.promptPresetShelfTitle")}
        >
          <div className="session-prompt-shelf-head">
            <span className="session-prompt-shelf-title">
              {t("chat.promptPresetShelfTitle")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="session-prompt-shelf-save-as"
              disabled={saving || presetBusy || !draft.trim()}
              onClick={() => setSaveAsOpen((open) => !open)}
            >
              <IconPlus size={14} />
              {t("chat.promptPresetSaveAsButton")}
            </Button>
          </div>

          {saveAsOpen ? (
            <div className="session-prompt-shelf-save">
              <Input
                className="session-prompt-shelf-name-input"
                value={presetName}
                placeholder={t("chat.promptPresetNamePlaceholder")}
                aria-label={t("chat.promptPresetNamePlaceholder")}
                disabled={saving || presetBusy}
                maxLength={80}
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void savePreset();
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={saving || presetBusy || !presetName.trim()}
                onClick={() => void savePreset()}
              >
                {t("chat.promptPresetSaveAsButton")}
              </Button>
            </div>
          ) : null}

          {presets.length === 0 ? (
            <p className="session-prompt-shelf-empty">
              {t("chat.promptPresetEmpty")}
            </p>
          ) : (
            <ul className="session-prompt-shelf-list">
              {presets.map((preset) => (
                <li className="session-prompt-shelf-item" key={preset.id}>
                  <div className="session-prompt-shelf-item-main">
                    <span className="session-prompt-shelf-item-name">
                      {preset.name}
                    </span>
                    <span className="session-prompt-shelf-item-preview">
                      {preview(preset.text)}
                    </span>
                  </div>
                  <div className="session-prompt-shelf-item-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="session-prompt-shelf-apply"
                      disabled={saving || presetBusy}
                      onClick={() => applyPreset(preset)}
                    >
                      {t("chat.promptPresetApplyButton")}
                    </Button>
                    <TooltipButton
                      type="button"
                      className="session-prompt-shelf-delete"
                      tooltip={t("chat.promptPresetDeleteButton")}
                      ariaLabel={t("chat.promptPresetDeleteButton")}
                      disabled={saving || presetBusy}
                      onClick={() => setPendingDelete(preset)}
                    >
                      <IconTrash size={14} />
                    </TooltipButton>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {pendingApply ? (
            <div className="session-prompt-shelf-confirm" role="alertdialog">
              <span>
                {t("chat.promptPresetReplaceConfirm", {
                  name: pendingApply.name,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={presetBusy}
                onClick={() => setPendingApply(null)}
              >
                {t("settings.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={presetBusy}
                onClick={confirmApply}
              >
                {t("chat.promptPresetApplyButton")}
              </Button>
            </div>
          ) : null}

          {pendingDelete ? (
            <div className="session-prompt-shelf-confirm" role="alertdialog">
              <span>
                {t("chat.promptPresetDeleteConfirm", {
                  name: pendingDelete.name,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={presetBusy}
                onClick={() => setPendingDelete(null)}
              >
                {t("settings.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={presetBusy}
                onClick={() => void confirmDelete()}
              >
                {t("chat.promptPresetDeleteButton")}
              </Button>
            </div>
          ) : null}
        </section>

        {error ? (
          <div className="project-memory-dialog-hint" role="status">
            {error}
          </div>
        ) : null}
        <div className="project-instructions-dialog-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          {stored ? (
            <Button
              variant="ghost"
              className="session-prompt-clear"
              disabled={saving}
              onClick={clearOverride}
            >
              {t("chat.conversationPromptClear")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving
              ? t("settings.saving")
              : t("chat.conversationPromptSave")}
          </Button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}

/** Compact topbar control that opens the conversation prompt editor. */
export function ConversationPromptButton({
  active,
  onOpen,
}: {
  /** True when this conversation carries its own prompt. */
  active: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TooltipButton
      type="button"
      className={`ct-icon-btn conversation-prompt-btn${active ? " active" : ""}`}
      data-active={active ? "true" : undefined}
      tooltip={
        active
          ? `${t("chat.conversationPromptTitle")} · ${t("chat.conversationPromptActive")}`
          : t("chat.conversationPromptTitle")
      }
      ariaLabel={t("chat.conversationPromptTitle")}
      aria-pressed={active}
      onClick={onOpen}
    >
      <IconBot size={15} />
    </TooltipButton>
  );
}
