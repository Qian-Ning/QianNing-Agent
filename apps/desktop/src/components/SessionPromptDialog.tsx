import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { Button, Textarea, TooltipButton } from "./ui";
import { IconBot, IconClose } from "./icons";

/**
 * The per-conversation persona editor.
 *
 * This is the only editable persona scope: the value belongs to ONE session
 * row (`sessions.system_prompt`) and leaves every other conversation on the
 * built-in default. Clearing the field (or typing only whitespace) removes the
 * prompt rather than storing an empty string, so the conversation returns to
 * the built-in persona.
 */
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const dirty = draft !== stored;
  const commit = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
