import {
  chooseSkillToPreload,
  SKILL_PRELOAD_MAX_BODY_CHARS,
  type PluginSkillDef,
  type PreloadedSkill,
} from "@pi-desktop/agent-runtime";

import { loadBuiltinSkillBody } from "./builtin-skills.ts";

/**
 * Choose at most one skill whose body should arrive with the first turn.
 *
 * The matcher is deliberately conservative — a wrong pick spends context on
 * instructions for a task nobody asked for — so most prompts return undefined
 * and the model keeps the catalogue and the `Skill` tool. Only bundled
 * documents are eligible here: a plugin or user skill's body is owned by
 * another registry, and preloading it would bypass that registry's own
 * resolution order.
 *
 * A body above `SKILL_PRELOAD_MAX_BODY_CHARS` is left to the `Skill` tool for
 * the same reason: the guess is cheap only while the document is small.
 */
export function resolvePreloadedSkill(
  content: string,
  skills: readonly PluginSkillDef[],
): PreloadedSkill | undefined {
  const chosen = chooseSkillToPreload(content, skills);
  if (!chosen) return undefined;
  const document = loadBuiltinSkillBody(chosen.id);
  if (!document || document.body.length > SKILL_PRELOAD_MAX_BODY_CHARS) return undefined;
  return { id: document.id, name: document.name, body: document.body };
}
