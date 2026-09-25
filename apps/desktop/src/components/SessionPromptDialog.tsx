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
 * Scope is the whole point of this surface: the value belongs to ONE session
 * row (`sessions.system_prompt`), outranks the app-wide prompt for that
 * conversation, and leaves every other conversation on the global value. The
 * dialog therefore shows which of the two is in effect, so "why is this chat
 * answering differently" is answerable without reading source.
 *
 * Clearing the field (or typing only whitespace) removes the override rather
 * than storing an empty string, so the conversation returns to the global /
 * built-in persona.
 */
export function SessionPromptDialog({
  session,
  globalPrompt,
  onClose,
  onSave,
}: {
  session: SessionSummary;
  /** The app-wide prompt, shown as the inherited value in the empty state. */
  globalPrompt?: string;
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
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const trimmed = draft.trim();
      await onSave(trimmed ? trimmed : null);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
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
        {error ? (
          <div className="project-memory-dialog-hint" role="status">
            {error}
          </div>
        ) : null}
        {!stored && globalPrompt && draft.trim() === "" ? (
          <div className="settings-instruction-path session-prompt-inherited">
            {globalPrompt}
          </div>
        ) : null}
        <div className="project-instructions-dialog-actions">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
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
