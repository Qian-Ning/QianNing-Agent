import { useRef, type ChangeEvent } from "react";
import type { TFunction } from "i18next";
import { TooltipButton } from "../../../components/ui";
import {
  IconDownload,
  IconPlus,
  IconUpload,
  IconX,
} from "../../../components/icons";
import type { PromptCard } from "../../../lib/composer-prompt-cards";

/** Below this trimmed length a draft is too short to be worth saving. */
const MIN_SAVE_LENGTH = 4;

export type ComposerPromptCardsProps = {
  t: TFunction;
  cards: readonly PromptCard[];
  /** Current draft text; decides which of the states the strip shows. */
  draftText: string;
  disabled: boolean;
  onInsert: (text: string) => void;
  onSave: () => void;
  onRemove: (id: string) => void;
  /** Download the saved cards as a shareable JSON file. */
  onExport: () => void;
  /** Merge a picked JSON file into the saved cards. */
  onImportFile: (file: File) => void;
};

/**
 * Quick-prompt strip above the composer input — the renderer-local "tool
 * drawer" for reusable prompts.
 *
 * With an empty draft it offers the saved prompts for one-click insertion plus
 * export/import so a prompt library can be shared between machines; while a
 * substantial draft is being written it offers to save that draft as a new
 * quick prompt. The states are mutually exclusive, so the strip never competes
 * with active typing. An empty library still shows the import affordance so a
 * shared file can be brought in on a fresh machine.
 *
 * The save and library controls intentionally do not depend on input focus:
 * gating them on focus would unmount them on the editor's blur, dropping the
 * click that was about to land.
 */
export function ComposerPromptCards({
  t,
  cards,
  draftText,
  disabled,
  onInsert,
  onSave,
  onRemove,
  onExport,
  onImportFile,
}: ComposerPromptCardsProps) {
  const importInputRef = useRef<HTMLInputElement>(null);

  const onImportChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same filename fires change again.
    event.target.value = "";
    if (file) onImportFile(file);
  };

  const importControl = (
    <>
      <TooltipButton
        type="button"
        className="composer-prompt-card-tool"
        tooltip={t("chat.promptCardsImport")}
        ariaLabel={t("chat.promptCardsImport")}
        disabled={disabled}
        onClick={() => importInputRef.current?.click()}
      >
        <IconUpload size={13} aria-hidden="true" />
      </TooltipButton>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="composer-prompt-card-import-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onImportChange}
      />
    </>
  );

  const trimmed = draftText.trim();

  if (trimmed.length === 0) {
    if (cards.length === 0) {
      return (
        <div className="composer-prompt-cards" aria-label={t("chat.promptCards")}>
          {importControl}
        </div>
      );
    }
    return (
      <div
        className="composer-prompt-cards"
        role="list"
        aria-label={t("chat.promptCards")}
      >
        {cards.map((card) => (
          <div key={card.id} className="composer-prompt-card" role="listitem">
            <button
              type="button"
              className="composer-prompt-card-insert"
              title={card.text}
              aria-label={t("chat.promptCardInsert", { label: card.label })}
              disabled={disabled}
              onClick={() => onInsert(card.text)}
            >
              {card.label}
            </button>
            <TooltipButton
              type="button"
              className="composer-prompt-card-remove"
              tooltip={t("chat.promptCardRemove", { label: card.label })}
              ariaLabel={t("chat.promptCardRemove", { label: card.label })}
              disabled={disabled}
              onClick={() => onRemove(card.id)}
            >
              <IconX size={12} aria-hidden="true" />
            </TooltipButton>
          </div>
        ))}
        <span className="composer-prompt-card-tools">
          <TooltipButton
            type="button"
            className="composer-prompt-card-tool"
            tooltip={t("chat.promptCardsExport")}
            ariaLabel={t("chat.promptCardsExport")}
            disabled={disabled}
            onClick={onExport}
          >
            <IconDownload size={13} aria-hidden="true" />
          </TooltipButton>
          {importControl}
        </span>
      </div>
    );
  }

  if (trimmed.length < MIN_SAVE_LENGTH) return null;

  return (
    <div className="composer-prompt-cards" aria-label={t("chat.promptCards")}>
      <TooltipButton
        type="button"
        className="composer-prompt-card-save"
        tooltip={t("chat.promptCardSave")}
        ariaLabel={t("chat.promptCardSave")}
        disabled={disabled}
        onClick={onSave}
      >
        <IconPlus size={12} aria-hidden="true" />
        <span className="composer-prompt-card-save-label">
          {t("chat.promptCardSave")}
        </span>
      </TooltipButton>
    </div>
  );
}