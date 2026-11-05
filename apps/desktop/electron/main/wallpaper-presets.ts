import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { importWallpaperSource, type WallpaperProject } from "./wallpaper-store";

/**
 * The bundled wallpaper gallery.
 *
 * These are photographs shipped with the app, each already a `web` project so
 * the import path stays the only way a project enters a profile: a preset is
 * copied, validated and registered by exactly the same code that handles a file
 * the user dropped. Nothing here renders anything by itself.
 */

export type WallpaperPreset = {
  id: string;
  title: string;
  /** A dark colour from the photograph, used for the tile before it is added. */
  accent: string;
  /** Bytes of the background, so the gallery can say how much this costs. */
  bytes: number;
};

const DEFAULT_ACCENT = "#1d1f24";

export function listWallpaperPresets(root: string): WallpaperPreset[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const presets: WallpaperPreset[] = [];
  for (const id of entries.sort()) {
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let manifest: { title?: unknown; accent?: unknown; type?: unknown; file?: unknown } | null = null;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    } catch {
      continue;
    }
    if (!manifest || manifest.type !== "web") continue;
    if (typeof manifest.file !== "string" || !existsSync(join(dir, manifest.file))) continue;
    const title = typeof manifest.title === "string" && manifest.title.trim() ? manifest.title : id;
    const accent = typeof manifest.accent === "string" && /^#[0-9a-f]{6}$/i.test(manifest.accent)
      ? manifest.accent
      : DEFAULT_ACCENT;
    presets.push({ id, title, accent, bytes: projectBytes(dir) });
  }
  return presets;
}

function projectBytes(dir: string): number {
  let total = 0;
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) total += statSync(path).size;
    }
  };
  try {
    walk(dir);
  } catch {
    return total;
  }
  return total;
}

/**
 * Copy a preset into the profile as a fresh project.
 *
 * `id` is matched against the directory listing, never joined blindly: a
 * renderer asking for `../../etc` must not walk out of the gallery.
 */
export function installWallpaperPreset(dataDir: string, root: string, id: string): WallpaperProject {
  const known = listWallpaperPresets(root).find((preset) => preset.id === id);
  if (!known) throw new Error("unknown wallpaper preset");
  return importWallpaperSource(dataDir, join(root, known.id));
}
