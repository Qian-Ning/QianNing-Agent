import type { ComposerCommand } from "@pi-desktop/shared";

/**
 * Display labels shared by every surface that names a composer command: the
 * "/" menu, the painted draft token, and the transcript chip (D675).
 *
 * The kind badge is deliberately short — it labels a row, a token, and a pill,
 * not a section — while the menu keeps its longer group headings. Both come
 * from the same catalog keys, so a locale that translates one describes the
 * other consistently.
 */

export type ComposerCommandKind = ComposerCommand["kind"];

/** Long form: the "/" menu's group heading. */
export function commandKindGroupKey(kind: ComposerCommandKind): string {
  if (kind === "template") return "chat.slashGroupTemplates";
  if (kind === "plugin") return "chat.slashGroupPlugins";
  if (kind === "extension") return "chat.slashGroupExtensions";
  if (kind === "skill") return "chat.slashGroupSkills";
  return "chat.slashGroupApp";
}

/** Short form: the badge on a token, a chip, or a menu row. */
export function commandKindBadgeKey(kind: ComposerCommandKind): string {
  if (kind === "template") return "chat.kindTemplate";
  if (kind === "plugin") return "chat.kindPlugin";
  if (kind === "extension") return "chat.kindExtension";
  if (kind === "skill") return "chat.kindSkill";
  return "chat.kindApp";
}

/**
 * True when a title would only repeat the command name — the skill
 * `qianning/imagegen` titled "imagegen" — so a token, chip or menu row drops it
 * instead of printing the same word twice.
 */
export function commandTitleRepeatsName(name: string, title: string): boolean {
  return title === name || title === `/${name}` || name.endsWith(`/${title}`);
}

/** First-party command ids whose title and category the UI localizes itself. */
const BUILTIN_COMMAND_IDS: Readonly<Record<string, string>> = {
  "builtin.session.new": "new",
  "builtin.agent.compact": "compact",
  "builtin.mode.agent": "agentMode",
  "builtin.mode.plan": "planMode",
  "builtin.mode.goal": "goalMode",
};

/**
 * Title key for a first-party command, or null when the host's own title is the
 * only source. The host sends English titles, so a localized app has to name
 * its own commands.
 */
export function builtinCommandTitleKey(
  commandId: string | undefined,
): string | null {
  const suffix = commandId ? BUILTIN_COMMAND_IDS[commandId] : undefined;
  if (!suffix) return null;
  return `chat.builtin.${suffix}`;
}

/**
 * Category key for a first-party command, or null. The host sends the category
 * as the row description; it is localized here for the same reason as the
 * title.
 */
export function builtinCommandCategoryKey(
  commandId: string | undefined,
): string | null {
  return commandId && BUILTIN_COMMAND_IDS[commandId]
    ? "chat.builtin.category"
    : null;
}
