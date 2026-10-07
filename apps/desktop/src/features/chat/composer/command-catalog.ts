import type { ComposerCommand } from "@pi-desktop/shared";

/**
 * The command catalog the composer reads: what the "/" menu lists, what the
 * draft token is painted from, and what a sent turn is labelled with (D673,
 * D675). Pure data so the three surfaces can never disagree about a command's
 * kind or title, and so the reduction is unit-testable without a React tree.
 */

/** Everything a token, chip or menu row needs to label one command. */
export type ComposerCommandEntry = {
  /** Palette id for builtin/plugin/extension commands; absent for templates and skills. */
  id?: string;
  /** Slash name without the leading slash; a skill's name is its id. */
  name: string;
  /** Human title, falling back to the name. */
  title: string;
  kind: ComposerCommand["kind"];
  /** Skill id the model's `Skill` tool receives; skills only. */
  skillId?: string;
};

export type ComposerCommandCatalog = {
  /** Every command keyed by slash name, for text the composer sent. */
  byName: Map<string, ComposerCommandEntry>;
  /** Skill entries keyed by the id a mention records, for the transcript. */
  byId: Map<string, ComposerCommandEntry>;
  /** False until the first read of the merged command source settles. */
  loaded: boolean;
};

export const EMPTY_COMMAND_CATALOG: ComposerCommandCatalog = {
  byName: new Map(),
  byId: new Map(),
  loaded: false,
};

/**
 * Skill ids that earlier builds shipped under another brand. A turn sent before
 * the rename still names one, and the transcript looks the entry up by id, so
 * the old id has to resolve to the current entry. Kept in step with
 * `apps/desktop/electron/main/builtin-skills.ts` (LEGACY_BUILTIN_SKILL_IDS).
 */
export const LEGACY_SKILL_ID_ALIASES: Readonly<Record<string, string>> = {
  "pi-desktop/imagegen": "qianning/imagegen",
  "pi-desktop/plugin-development": "qianning/plugin-development",
};

/** Reduce the merged command list to what the UI renders. */
export function composerCommandCatalog(
  commands: readonly ComposerCommand[],
): ComposerCommandCatalog {
  const byName = new Map<string, ComposerCommandEntry>();
  const byId = new Map<string, ComposerCommandEntry>();
  for (const command of commands) {
    const entry: ComposerCommandEntry = {
      ...(command.id ? { id: command.id } : {}),
      name: command.name,
      title: command.title || command.name,
      kind: command.kind,
      ...(command.skillId ? { skillId: command.skillId } : {}),
    };
    byName.set(command.name, entry);
    if (entry.skillId) byId.set(entry.skillId, entry);
  }
  for (const [legacyId, currentId] of Object.entries(LEGACY_SKILL_ID_ALIASES)) {
    const current = byId.get(currentId);
    if (!current) continue;
    byId.set(legacyId, current);
    // A skill's slash name is its id, so a turn sent before the rename whose
    // whole body was the invocation resolves through the name lookup too.
    byName.set(legacyId, current);
  }
  return { byName, byId, loaded: true };
}
