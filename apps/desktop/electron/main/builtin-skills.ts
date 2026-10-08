import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "@pi-desktop/plugin-sdk";
import type { PluginSkillDef } from "@pi-desktop/agent-runtime";
import type { LoadedSkillDocument } from "./skill-document";

/**
 * Skills QianNing Agent ships itself.
 *
 * These ride the same catalog-plus-`Skill`-tool path as plugin-contributed
 * skills (D174), so a first-party skill and a third-party one are
 * indistinguishable to the model — but they need no permission grant, because
 * the host is not a plugin.
 */

/** Bundled skill teaching the plugin-development loop. */
export const PLUGIN_DEV_SKILL_FILE = "plugin-development.md";
export const PLUGIN_DEV_SKILL_ID = "qianning/plugin-development";
export const IMAGE_GENERATION_SKILL_ID = "qianning/imagegen";
const IMAGE_GENERATION_SKILL_FILE = "image-generation.md";
export const VIDEO_GENERATION_SKILL_ID = "qianning/videogen";
const VIDEO_GENERATION_SKILL_FILE = "video-generation.md";

/**
 * One table for id-to-file, so a new bundled capability cannot be added to the
 * catalog while `loadBuiltinSkillBody` quietly stops resolving it.
 */
const BUILTIN_SKILL_FILES: Readonly<Record<string, string>> = {
  [IMAGE_GENERATION_SKILL_ID]: IMAGE_GENERATION_SKILL_FILE,
  [VIDEO_GENERATION_SKILL_ID]: VIDEO_GENERATION_SKILL_FILE,
  [PLUGIN_DEV_SKILL_ID]: PLUGIN_DEV_SKILL_FILE,
};

/**
 * Skill ids this build shipped under before the brand rename. The id doubles as
 * the slash name, so it is user-visible and it is stored in sent transcripts:
 * both the old and the new id keep resolving, and only the current id is
 * advertised in the catalog.
 */
export const LEGACY_BUILTIN_SKILL_IDS: Readonly<Record<string, string>> = {
  "pi-desktop/imagegen": IMAGE_GENERATION_SKILL_ID,
  "pi-desktop/plugin-development": PLUGIN_DEV_SKILL_ID,
};

/** The current id for a built-in skill id, whether current or legacy. */
export function canonicalBuiltinSkillId(id: string): string {
  return LEGACY_BUILTIN_SKILL_IDS[id] ?? id;
}

/** electron-builder copies `resources/skills` to `<resources>/skills`. */
function resolveBuiltinSkillPath(fileName: string): string | null {
  const moduleDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;
  const candidates = [
    join(process.resourcesPath || "", "skills", fileName),
    join(moduleDir, "../../resources/skills", fileName),
    join(moduleDir, "../../../resources/skills", fileName),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * True when this workspace looks like plugin development: a plugin manifest at
 * the root, or a plugin already loaded from inside it.
 *
 * The gate matters. A plugin-authoring primer in every session would burn
 * context for the vast majority of sessions that never write a plugin; the
 * three plugin tools stay registered regardless, and calling one puts a
 * manifest in the workspace, which activates the skill on the next prompt.
 */
export function isPluginWorkspace(
  workspacePath: string | null | undefined,
  pluginPaths: string[] = [],
): boolean {
  if (!workspacePath) return false;
  const manifestPath = join(workspacePath, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest &&
        typeof manifest === "object" &&
        typeof manifest.schemaVersion === "number" &&
        typeof manifest.main === "string"
      ) {
        return true;
      }
    } catch {
      // An unparseable manifest is not evidence either way.
    }
  }
  const prefix = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
  return pluginPaths.some((path) => path === workspacePath || path.startsWith(prefix));
}

/** Front matter carries the skill's title and applicability line. */
function readBuiltinSkill(fileName: string): { path: string; raw: string } | null {
  const path = resolveBuiltinSkillPath(fileName);
  if (!path) return null;
  try {
    return { path, raw: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

export type BuiltinSkillInput = {
  workspacePath?: string | null;
  /** Directories of currently loaded plugins, used to detect a dev workspace. */
  pluginPaths?: string[];
};

/**
 * Catalog entries for the built-in skills that apply to the given session, read
 * fresh so a packaged update takes effect without a restart.
 */
export function builtinSkills(input: BuiltinSkillInput): PluginSkillDef[] {
  const ids = [IMAGE_GENERATION_SKILL_ID, VIDEO_GENERATION_SKILL_ID];
  if (isPluginWorkspace(input.workspacePath, input.pluginPaths)) ids.push(PLUGIN_DEV_SKILL_ID);
  return ids.flatMap((id) => {
    const raw = readBuiltinSkill(BUILTIN_SKILL_FILES[id]);
    if (!raw?.raw.trim()) return [];
    const parsed = parseSkillFrontmatter(raw.raw);
    return parsed.body ? [{ id, name: parsed.name ?? id, description: parsed.description }] : [];
  });
}

/**
 * Load a built-in skill body for the `Skill` tool. Returns null for any id the
 * host does not ship, which is the caller's cue to try the plugin registry.
 */
export function loadBuiltinSkillBody(id: string): LoadedSkillDocument | null {
  const canonical = canonicalBuiltinSkillId(id);
  const file = BUILTIN_SKILL_FILES[canonical];
  if (!file) return null;
  const raw = readBuiltinSkill(file);
  if (!raw?.raw.trim()) return null;
  const parsed = parseSkillFrontmatter(raw.raw);
  if (!parsed.body) return null;
  return {
    id: canonical,
    name: parsed.name ?? id,
    body: parsed.body,
    location: raw.path,
  };
}
