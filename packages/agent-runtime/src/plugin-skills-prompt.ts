import type { PluginSkillDef } from "./plugin-skills.js";

export type { PluginSkillDef };

/** Tool the model calls to pull a skill document into context on demand. */
export const SKILL_TOOL_NAME = "Skill";

/**
 * Render the skill catalog for the system prompt (D174: skills are
 * model-invoked). Only id/name/description ship up front — the body is loaded
 * through the `Skill` tool when the model decides a skill applies, so a long
 * document costs nothing until it is needed.
 */
const SKILLS_HEADER = [
  "# Skills",
  "",
  `Plugins have taught you the following skills. Each entry is a set of instructions you can load with the \`${SKILL_TOOL_NAME}\` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.`,
  "",
  `Entries under a heading are indexed by group: pass \`group:<name>\` to \`${SKILL_TOOL_NAME}\` to list that group's skills with their descriptions, then load the one that fits. The group line names a few members, so an obviously matching group needs no lookup.`,
].join("\n");

export const SKILL_SECTION_PREFIX = "skill:";

/** The section key a group heading occupies, namespaced so it cannot collide with a skill id. */
export const SKILL_GROUP_SECTION_PREFIX = "skill-group:";

/** Section holding a skill body the host matched to the session's first prompt. */
export const SKILL_PRELOAD_SECTION = "skill-preload";

/** A skill body the host matched to the first prompt. */
export type PreloadedSkill = {
  id: string;
  name: string;
  body: string;
};

/**
 * Render a preloaded body as its own system section.
 *
 * The heading states why the document is here, so a model reading a long
 * instruction block knows it answered the first message rather than arriving by
 * accident. The section is revocable like any other, which keeps transcript
 * rebuilds and idle refreshes honest.
 */
export function preloadedSkillSection(skill: PreloadedSkill): string {
  return [
    `# Preloaded skill: ${skill.name}`,
    "",
    `The first message matches the \`${skill.id}\` skill, so its instructions are included below. Follow them unless the task turns out to be about something else.`,
    "",
    skill.body.trim(),
  ].join("\n");
}

function skillEntry(skill: PluginSkillDef): string {
  const description = skill.description?.trim();
  return `- \`${skill.id}\` — ${skill.name}${description ? `: ${description}` : ""}`;
}

function byId(a: PluginSkillDef, b: PluginSkillDef): number {
  return a.id.localeCompare(b.id);
}

/**
 * Catalog entries in render order: entries without a group first — the shape
 * every third-party skill keeps today — then one heading per group and its
 * entries, groups in name order, entries in id order within a group.
 *
 * Grouping is presentation only: an entry under a heading is no more and no
 * less advertised than one in the flat list, and the renderer never filters.
 */
function orderedSkillEntries(skills: readonly PluginSkillDef[]): Array<[string, string]> {
  const grouped = new Map<string, PluginSkillDef[]>();
  const ungrouped: PluginSkillDef[] = [];
  for (const skill of skills) {
    const group = skill.group?.trim();
    if (group) {
      const bucket = grouped.get(group);
      if (bucket) bucket.push(skill);
      else grouped.set(group, [skill]);
    } else {
      ungrouped.push(skill);
    }
  }

  const entries: Array<[string, string]> = [];
  for (const skill of [...ungrouped].sort(byId)) {
    entries.push([`${SKILL_SECTION_PREFIX}${skill.id}`, skillEntry(skill)]);
  }
  // A group is one line, not a heading plus every entry: the shipped catalog is
  // 88 skills and roughly 9.5 kB of descriptions, and that text rides in every
  // session's system prompt. The members are one `group:<name>` call away, and
  // the teaser names enough of them that an obviously matching group costs no
  // lookup at all.
  for (const group of [...grouped.keys()].sort()) {
    const members = [...(grouped.get(group) ?? [])].sort(byId);
    const teaser = members.slice(0, 4).map((skill) => skill.name).join(", ");
    const rest = members.length > 4 ? `, +${members.length - 4} more` : "";
    entries.push([
      `${SKILL_GROUP_SECTION_PREFIX}${group}`,
      `- \`group:${group}\` — ${group} (${members.length}): ${teaser}${rest}`,
    ]);
  }
  return entries;
}

/**
 * Stable entry identities let Pi append only the changed or revoked skill.
 * A group heading is an entry identity too: it appears once (or not at all)
 * no matter how many of its entries moved, so an incremental update of a
 * group's members never re-sends the heading.
 */
export function pluginSkillsPromptSections(skills: readonly PluginSkillDef[]): Record<string, string> {
  if (!skills.length) return {};
  return Object.fromEntries([
    ["skills", SKILLS_HEADER],
    ...orderedSkillEntries(skills),
  ]);
}

export function pluginSkillsPrompt(skills: PluginSkillDef[]): string | undefined {
  if (!skills.length) return undefined;
  const entries = orderedSkillEntries(skills);
  return `${SKILLS_HEADER}\n\n${entries.map(([, text]) => text).join("\n")}`;
}