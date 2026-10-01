import type { TFunction } from "i18next";
import { TooltipButton } from "../../../components/ui";
import { IconPlus, IconX } from "../../../components/icons";
import type { PromptCard } from "../../../lib/composer-prompt-cards";

/** Below this trimmed length a draft is too short to be worth saving. */
const MIN_SAVE_LENGTH = 4;

export type ComposerPromptCardsProps = {
  t: TFunction;
  cards: readonly PromptCard[];
  /** Current draft text; decides which of the two states the strip shows. */
  draftText: string;
  disabled: boolean;
  onInsert: (text: string) => void;
  onSave: () => void;
  onRemove: (id: string) => void;
};

/**
 * Quick-prompt strip above the composer input.
 *
 * With an empty draft it offers the saved prompts for one-click insertion;
 * while a substantial draft is being written it offers to save that draft as a
 * new quick prompt. The two states are mutually exclusive, so the strip never
 * competes with active typing, and it renders nothing when neither applies.
 *
 * The save affordance intentionally does not depend on input focus: gating it
 * on focus would unmount it on the editor's blur, dropping the click that was
 * about to land on it.
 */
export function ComposerPromptCards({
  t,
  cards,
  draftText,
  disabled,
  onInsert,
  onSave,
  onRemove,
}: ComposerPromptCardsProps) {
  const trimmed = draftText.trim();

  if (trimmed.length === 0) {
    if (cards.length === 0) return null;
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
