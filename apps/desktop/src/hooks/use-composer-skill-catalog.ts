import { useEffect, useState } from "react";
import type { ComposerCommand } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { loadComposerCommands } from "./use-composer-autocomplete";

/**
 * One skill, reduced to what the composer and the transcript render (D673).
 * The composer paints `/name` tokens in the draft from `byName`; the transcript
 * labels a sent turn's skill mentions from `byId`.
 */
export type ComposerSkillEntry = {
  /** Skill id the model's `Skill` tool receives. */
  id: string;
  /** Slash name without the slash. */
  name: string;
  /** Human title (`Chapter writing`), falling back to the name. */
  title: string;
};

export type ComposerSkillCatalog = {
  byName: Map<string, ComposerSkillEntry>;
  byId: Map<string, ComposerSkillEntry>;
  /** False until the first read of the merged command source settles. */
  loaded: boolean;
};

const EMPTY_CATALOG: ComposerSkillCatalog = {
  byName: new Map(),
  byId: new Map(),
  loaded: false,
};

/** Pure reduction of the merged command list to the skill entries (tested). */
export function composerSkillCatalog(
  commands: readonly ComposerCommand[],
): ComposerSkillCatalog {
  const byName = new Map<string, ComposerSkillEntry>();
  const byId = new Map<string, ComposerSkillEntry>();
  for (const command of commands) {
    if (command.kind !== "skill" || !command.skillId) continue;
    const entry: ComposerSkillEntry = {
      id: command.skillId,
      name: command.name,
      title: command.title || command.name,
    };
    byName.set(command.name, entry);
    byId.set(entry.id, entry);
  }
  return { byName, byId, loaded: true };
}

/**
 * Skills available to the composer, from the same cached source the slash menu
 * reads. A failed read leaves the catalog empty, which only means the draft
 * keeps plain text styling until the next read — never a blocked composer.
 */
export function useComposerSkillCatalog(): ComposerSkillCatalog {
  const workspaceKey = useAppStore((state) => state.workspace?.path ?? "");
  const [catalog, setCatalog] = useState<ComposerSkillCatalog>(EMPTY_CATALOG);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadComposerCommands()
        .then((commands) => {
          if (!cancelled) setCatalog(composerSkillCatalog(commands));
        })
        .catch(() => {
          if (!cancelled) setCatalog(EMPTY_CATALOG);
        });
    };
    load();
    // Installing or removing a skill changes both the menu and the painted
    // tokens, so the catalog follows the plugin-changed notification.
    const unsubscribe = api.onPluginChanged?.(load);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [workspaceKey]);

  return catalog;
}
