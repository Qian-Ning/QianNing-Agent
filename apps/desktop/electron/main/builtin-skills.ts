import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
 *
 * The shipped set is discovered from the resource directory rather than listed
 * here. A hand-maintained registry is a second source of truth: a file added
 * without a matching entry is silently dead, and a deleted file leaves an entry
 * that resolves to nothing. Discovery also means the catalog and
 * `loadBuiltinSkillBody` cannot disagree, because they read the same list.
 */

/** Bundled skill teaching the plugin-development loop. */
export const PLUGIN_DEV_SKILL_FILE = "plugin-development.md";
export const PLUGIN_DEV_SKILL_ID = "qianning/plugin-development";
export const IMAGE_GENERATION_SKILL_ID = "qianning/imagegen";
export const VIDEO_GENERATION_SKILL_ID = "qianning/videogen";

/**
 * Ids that are not the file-derived default, because they predate this naming
 * rule and are already written into sent transcripts. A skill listed here keeps
 * its id; every other file gets `qianning/<file name without extension>`.
 */
const EXPLICIT_SKILL_IDS: Readonly<Record<string, string>> = {
  "image-generation.md": IMAGE_GENERATION_SKILL_ID,
  "video-generation.md": VIDEO_GENERATION_SKILL_ID,
  [PLUGIN_DEV_SKILL_FILE]: PLUGIN_DEV_SKILL_ID,
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

/** The id a shipped file is advertised and resolved under. */
export function builtinSkillIdForFile(fileName: string): string {
  return EXPLICIT_SKILL_IDS[fileName] ?? `qianning/${basename(fileName, ".md")}`;
}

/** electron-builder copies `resources/skills` to `<resources>/skills`. */
function resolveBuiltinSkillDir(): string | null {
  const moduleDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;
  const candidates = [
    join(process.resourcesPath || "", "skills"),
    join(moduleDir, "../../resources/skills"),
    join(moduleDir, "../../../resources/skills"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every shipped skill file, in a stable order so the catalog does not reshuffle
 * between prompts. Reads the directory each call, like the file reads below, so
 * a packaged update takes effect without a restart.
 */
export function listBuiltinSkillFiles(): string[] {
  const dir = resolveBuiltinSkillDir();
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
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
  const dir = resolveBuiltinSkillDir();
  if (!dir) return null;
  const path = join(dir, fileName);
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
  /**
   * Whether a generation model is configured for the capability, when the caller
   * knows. `undefined` means the caller has no settings access and the entry is
   * kept, so a surface that cannot see the configuration stays complete.
   */
  imageGenerationAvailable?: boolean;
  videoGenerationAvailable?: boolean;
};

/**
 * Whether a shipped capability is usable in this session.
 *
 * The model pays context for every advertised entry, and a capability skill
 * whose tool has no configured model can only tell the model to go configure
 * one. So the entry is advertised while the capability is usable, and an
 * unavailable capability drops it. Keyed on the id rather than the file name,
 * so renaming a document cannot silently unhook the gate.
 */
function isCapabilityAvailable(id: string, input: BuiltinSkillInput): boolean {
  if (id === IMAGE_GENERATION_SKILL_ID) return input.imageGenerationAvailable !== false;
  if (id === VIDEO_GENERATION_SKILL_ID) return input.videoGenerationAvailable !== false;
  return true;
}

/**
 * Catalog entries for the built-in skills that apply to the given session, read
 * fresh so a packaged update takes effect without a restart.
 */
export function builtinSkills(input: BuiltinSkillInput): PluginSkillDef[] {
  const devWorkspace = isPluginWorkspace(input.workspacePath, input.pluginPaths);
  return listBuiltinSkillFiles().flatMap((file) => {
    // The plugin primer is the one entry gated on the workspace: it stays out of
    // the catalog until the session shows signs of plugin work.
    if (file === PLUGIN_DEV_SKILL_FILE && !devWorkspace) return [];
    const id = builtinSkillIdForFile(file);
    if (!isCapabilityAvailable(id, input)) return [];
    const raw = readBuiltinSkill(file);
    if (!raw?.raw.trim()) return [];
    const parsed = parseSkillFrontmatter(raw.raw);
    return parsed.body ? [{ id, name: parsed.name ?? id, description: parsed.description }] : [];
  });
}

/**
 * Load a built-in skill body for the `Skill` tool. Returns null for any id the
 * host does not ship, which is the caller's cue to try the plugin registry.
 *
 * A withheld entry still resolves here: only the advertisement is conditional,
 * so a transcript or an earlier model turn that named the id keeps working.
 */
export function loadBuiltinSkillBody(id: string): LoadedSkillDocument | null {
  const canonical = canonicalBuiltinSkillId(id);
  const file = listBuiltinSkillFiles().find((entry) => builtinSkillIdForFile(entry) === canonical);
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
