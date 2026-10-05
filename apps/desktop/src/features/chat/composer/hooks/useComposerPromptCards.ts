import { useCallback, useState } from "react";
import {
  importPromptCards,
  loadPromptCards,
  removePromptCard,
  savePromptCard,
  type PromptCard,
  type PromptCardImportResult,
} from "../../../../lib/composer-prompt-cards";

export type ComposerPromptCardsController = {
  /** Saved quick-prompt cards, newest first. */
  cards: PromptCard[];
  /** Store `text` as a quick prompt; returns false when the text was blank. */
  save: (text: string) => boolean;
  /** Remove a saved quick prompt by id. */
  remove: (id: string) => void;
  /** Merge an exported payload into the saved list; returns a result summary. */
  importText: (json: string) => PromptCardImportResult;
};

/**
 * Own the composer's quick-prompt cards: load the saved list once, then mirror
 * every save/remove/import back into both React state and `localStorage`. The
 * insert action belongs to the draft, so it is wired by the Composer rather
 * than held here — this hook only owns the persisted card list.
 */
export function useComposerPromptCards(): ComposerPromptCardsController {
  const [cards, setCards] = useState<PromptCard[]>(() => loadPromptCards());

  const save = useCallback((text: string) => {
    if (!text.trim()) return false;
    setCards(savePromptCard(text));
    return true;
  }, []);

  const remove = useCallback((id: string) => {
    setCards(removePromptCard(id));
  }, []);

  const importText = useCallback((json: string): PromptCardImportResult => {
    const result = importPromptCards(json);
    if (result.ok) setCards(result.cards);
    return result;
  }, []);

  return { cards, save, remove, importText };
}
