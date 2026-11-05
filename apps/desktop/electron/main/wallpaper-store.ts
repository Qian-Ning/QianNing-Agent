import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { SkinWallpaperProject } from "@pi-desktop/shared";

/**
 * Host-side storage for live wallpapers.
 *
 * A Wallpaper Engine project is a directory, not a file: `project.json` plus a
 * `scene.pkg`, loose textures, or a small web page. The renderer never learns
 * where it lives. Importing copies the project into the installation data
 * directory under an opaque id, and the host serves that id over
 * `wallpaper://project/<id>/…`.
 *
 * Two rules shape the copy:
 *  - it is a copy, so deleting the user's source folder never blanks a skin;
 *  - the same caps as a media import apply (size and file count), so a stray
 *    multi-gigabyte folder cannot fill the profile before the user notices.
 */

/** The id grammar shared with the skin sanitizer. */
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{3,63}$/;

/** A single project may not exceed this; Wallpaper Engine scenes are usually far smaller. */
export const WALLPAPER_MAX_BYTES = 512 * 1024 * 1024;
/** Guards against a folder that is really somebody's Steam library. */
export const WALLPAPER_MAX_FILES = 4096;

export type WallpaperProjectKind = "scene" | "web";

export type WallpaperProject = SkinWallpaperProject;

export type WallpaperProjectMeta = {
  title: string;
  kind: WallpaperProjectKind;
  /** `preview.png` and friends, when present — served as `wallpaper://…/preview.png`. */
  preview: string | null;
};

/** The directory holding every imported wallpaper project. */
export function wallpapersDir(dataDir: string): string {
  return join(dataDir, "wallpapers");
}

/** True when `candidate` sits inside `root` (prefix-safe on boundaries). */
function isInside(root: string, candidate: string): boolean {
  const base = resolve(root) + sep;
  return resolve(candidate).startsWith(base);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read a project's display metadata. The manifest decides the kind; without one
 * the folder itself is the evidence — an `index.html` is a web project, and
 * anything else that reached this point is a scene.
 */
export function readWallpaperProjectMeta(dir: string): WallpaperProjectMeta {
  const manifest = readJson(join(dir, "project.json"));
  const rawType = typeof manifest?.type === "string" ? manifest.type.toLowerCase() : "";
  const kind: WallpaperProjectKind =
    rawType === "web" || rawType === "scene"
      ? rawType
      : existsSync(join(dir, "index.html"))
        ? "web"
        : "scene";
  const rawTitle = typeof manifest?.title === "string" ? manifest.title.trim() : "";
  const title = (rawTitle || basename(dir)).slice(0, 80);
  let preview: string | null = null;
  for (const name of ["preview.png", "preview.jpg", "preview.jpeg", "preview.webp", "preview.gif"]) {
    if (existsSync(join(dir, name))) {
      preview = name;
      break;
    }
  }
  return { title, kind, preview };
}

/** Why a folder that looks close to a project still cannot be served. */
export type WallpaperProblem = "packaged" | "unknown";

/**
 * Classify a folder before it is copied.
 *
 * The renderer serves loose files over `wallpaper://` and hands them to
 * `webwallgl`, which reads `scene.json`, models, materials and textures. It
 * cannot open Wallpaper Engine's private `scene.pkg` container, so a project
 * that only names a package would import "successfully" and then paint a black
 * frame. That is the one failure worth refusing at the door: the user gets a
 * message they can act on instead of a wallpaper that is silently empty.
 */
export function wallpaperProjectProblem(dir: string): WallpaperProblem | null {
  const manifest = readJson(join(dir, "project.json"));
  const declared = typeof manifest?.file === "string" ? manifest.file.trim() : "";
  if (declared && /\.pkg$/i.test(declared)) return "packaged";
  if (declared) {
    const entry = join(dir, ...declared.replace(/\\/g, "/").split("/"));
    if (isInside(dir, entry) && existsSync(entry)) return null;
    // The manifest names an entry that is not on disk: either the package was
    // never unpacked, or the copy is incomplete.
    return existsSync(join(dir, "scene.pkg")) ? "packaged" : "unknown";
  }
  if (existsSync(join(dir, "index.html"))) return null;
  if (existsSync(join(dir, "project.json"))) {
    return existsSync(join(dir, "scene.pkg")) ? "packaged" : "unknown";
  }
  if (existsSync(join(dir, "scene.pkg"))) return "packaged";
  return "unknown";
}

/** A folder is importable only when the runtime can actually read it. */
export function isWallpaperProjectDir(dir: string): boolean {
  return wallpaperProjectProblem(dir) === null;
}

function packagedError(): Error {
  return Object.assign(
    new Error("this project stores its scene in scene.pkg; unpack it first"),
    { errorCode: "WALLPAPER_PACKAGED" },
  );
}

type CopyTally = { bytes: number; files: number };

/** Recursive copy with a symlink refusal and the size/file caps. */
function copyProject(source: string, target: string, tally: CopyTally): void {
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    // `lstat` first: a junction in a workshop folder must never be followed into
    // an unrelated tree (and never copied out of it).
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyProject(from, to, tally);
      continue;
    }
    if (!stat.isFile()) continue;
    tally.files += 1;
    tally.bytes += stat.size;
    if (tally.files > WALLPAPER_MAX_FILES) throw new Error("wallpaper project has too many files");
    if (tally.bytes > WALLPAPER_MAX_BYTES) throw new Error("wallpaper project is too large");
    copyFileSync(from, to);
  }
}

/**
 * Copy a project folder into the store and return its id. `sourcePath` may be
 * the folder itself or a file inside it (a `.pkg`, `project.json`), which is
 * what a drag-and-drop of one file naturally produces.
 */
export function importWallpaperProject(dataDir: string, sourcePath: string): WallpaperProject {
  const resolved = resolve(sourcePath);
  let sourceDir = resolved;
  try {
    if (statSync(resolved).isFile()) sourceDir = join(resolved, "..");
  } catch {
    throw new Error("wallpaper project not found");
  }
  const problem = wallpaperProjectProblem(sourceDir);
  if (problem === "packaged") throw packagedError();
  if (problem) throw new Error("not a wallpaper project (no project.json or index.html)");

  const root = wallpapersDir(dataDir);
  mkdirSync(root, { recursive: true });
  const projectId = createHash("sha1").update(randomUUID()).digest("hex").slice(0, 16);
  const target = join(root, projectId);
  mkdirSync(target, { recursive: true });
  const tally: CopyTally = { bytes: 0, files: 0 };
  try {
    copyProject(sourceDir, target, tally);
  } catch (error) {
    // A failed import must not leave a half-copied project behind: the next
    // scan would register it and the skin would paint a broken scene.
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  const meta = readWallpaperProjectMeta(target);
  return {
    projectId,
    title: meta.title,
    kind: meta.kind,
    bytes: tally.bytes,
    hasPreview: meta.preview !== null,
    preview: meta.preview,
  };
}

/**
 * A store-only ZIP reader, deliberately small.
 *
 * Wallpaper Engine content travels as `.zip` far more often than as a folder —
 * a download is one file, and the folder inside it is usually named after the
 * workshop item. Reading the central directory ourselves keeps that support
 * dependency-free (Node already inflates) and keeps every name on the same
 * `safeRelativePath` gate the bundle restorer uses.
 */
type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

function readZipDirectory(buf: Buffer): ZipEntry[] {
  // End of central directory: signature, then a fixed 18-byte body and a
  // variable comment. Scan backwards because the comment length is not known.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65_557; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  const directoryOffset = buf.readUInt32LE(eocd + 16);
  if (count > WALLPAPER_MAX_FILES) throw new Error("wallpaper project has too many files");

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("zip central directory is damaged");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one entry, inflated when the archive stored it compressed. */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) {
    throw new Error("zip entry is damaged");
  }
  const nameLength = buf.readUInt16LE(at + 26);
  const extraLength = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const body = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateRawSync(body, { maxOutputLength: entry.uncompressedSize || undefined });
  throw new Error("unsupported zip compression");
}

/** Extract a `.zip` into a scratch folder and return the project root inside it. */
function extractZipProject(archive: Buffer, target: string): string {
  const entries = readZipDirectory(archive);
  const tally: CopyTally = { bytes: 0, files: 0 };
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    // Archives written on Windows use backslashes; normalize before the gate so
    // one spelling cannot slip past it.
    const relative = safeRelativePath(entry.name.split("\\").join("/"));
    if (!relative) throw new Error("wallpaper archive has an unsafe path");
    tally.files += 1;
    tally.bytes += entry.uncompressedSize;
    if (tally.files > WALLPAPER_MAX_FILES) throw new Error("wallpaper project has too many files");
    if (tally.bytes > WALLPAPER_MAX_BYTES) throw new Error("wallpaper project is too large");
    const out = join(target, ...relative.split("/"));
    if (!isInside(target, out)) throw new Error("wallpaper archive has an unsafe path");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readZipEntry(archive, entry));
  }
  return findProjectRoot(target, 0);
}

/**
 * The project root inside an extracted archive. Downloads wrap the project in a
 * folder named after the item, and sometimes in one more (`content/`), so the
 * search is bounded rather than recursive.
 */
function findProjectRoot(dir: string, depth: number): string {
  const problem = wallpaperProjectProblem(dir);
  if (problem === null) return dir;
  // A package anywhere in the search is the specific answer, even if another
  // folder happens to look like a bare project.
  if (problem === "packaged") throw packagedError();
  let packaged = false;
  if (depth < 2) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      try {
        return findProjectRoot(child, depth + 1);
      } catch (error) {
        // Keep looking: the first folder in an archive is often `__MACOSX`.
        if ((error as { errorCode?: string }).errorCode === "WALLPAPER_PACKAGED") packaged = true;
      }
    }
  }
  if (packaged) throw packagedError();
  throw new Error("not a wallpaper project (no project.json or index.html)");
}

/**
 * Import whatever the user picked: a project folder, a file inside one, or a
 * `.zip` of either. The archive is unpacked into a scratch folder under the
 * store and removed before returning, so the only copy that survives is the
 * project the skin will mount.
 */
export function importWallpaperSource(dataDir: string, sourcePath: string): WallpaperProject {
  const resolved = resolve(sourcePath);
  let isArchive = false;
  try {
    isArchive = statSync(resolved).isFile() && /\.zip$/i.test(resolved);
  } catch {
    throw new Error("wallpaper project not found");
  }
  if (!isArchive) return importWallpaperProject(dataDir, resolved);

  const root = wallpapersDir(dataDir);
  mkdirSync(root, { recursive: true });
  const scratch = join(root, `.incoming-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const projectRoot = extractZipProject(readFileSync(resolved), scratch);
    return importWallpaperProject(dataDir, projectRoot);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Copy the bundled sample project, so the feature is usable without Wallpaper Engine. */
export function seedDemoWallpaper(dataDir: string, demoRoot: string): WallpaperProject {
  if (!isWallpaperProjectDir(demoRoot)) throw new Error("bundled wallpaper project is missing");
  const root = wallpapersDir(dataDir);
  mkdirSync(root, { recursive: true });
  const projectId = createHash("sha1").update(randomUUID()).digest("hex").slice(0, 16);
  const target = join(root, projectId);
  mkdirSync(target, { recursive: true });
  const tally: CopyTally = { bytes: 0, files: 0 };
  copyProject(demoRoot, target, tally);
  const meta = readWallpaperProjectMeta(target);
  return {
    projectId,
    title: meta.title,
    kind: meta.kind,
    bytes: tally.bytes,
    hasPreview: meta.preview !== null,
    preview: meta.preview,
  };
}

/**
 * Register every stored project as a servable root. Runs at boot so a skin saved
 * in a previous session still resolves; a project directory that is missing is
 * simply skipped, and its skin degrades to colours only.
 */
export function registerStoredWallpapers(
  dataDir: string,
  roots: Map<string, string>,
): void {
  const root = wallpapersDir(dataDir);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    if (!isInside(root, dir)) continue;
    const problem = wallpaperProjectProblem(dir);
    if (problem) {
      // A stored project that cannot be served is not fatal: the skin that
      // points at it degrades to its colours. Saying why turns a mystery into
      // a support answer.
      console.warn(`[wallpaper] project ${entry.name} is not servable (${problem})`);
      continue;
    }
    roots.set(entry.name, dir);
  }
}

/** Register one project root after an import, without waiting for a restart. */
export function registerWallpaperProject(dataDir: string, projectId: string, roots: Map<string, string>): void {
  if (!PROJECT_ID.test(projectId)) return;
  const dir = join(wallpapersDir(dataDir), projectId);
  if (!isInside(wallpapersDir(dataDir), dir) || !existsSync(dir)) return;
  roots.set(projectId, dir);
}

/** Delete an imported project. The fixed `demo` root is not deletable here. */
export function deleteWallpaperProject(dataDir: string, projectId: string): boolean {
  if (!PROJECT_ID.test(projectId)) return false;
  const root = wallpapersDir(dataDir);
  const dir = join(root, projectId);
  if (!isInside(root, dir) || !existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export type WallpaperFile = { path: string; data: string };

/**
 * Read a stored project as a portable file list. Symlinks are skipped exactly as
 * they are on import, so an export cannot smuggle a file from outside the root.
 */
export function exportWallpaperFiles(dataDir: string, projectId: string): WallpaperFile[] {
  if (!PROJECT_ID.test(projectId)) throw new Error("unknown wallpaper project");
  const root = wallpapersDir(dataDir);
  const dir = join(root, projectId);
  if (!isInside(root, dir) || !existsSync(dir)) throw new Error("wallpaper project not found");
  const files: WallpaperFile[] = [];
  const tally: CopyTally = { bytes: 0, files: 0 };
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const from = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(from, relative);
        continue;
      }
      if (!stat.isFile()) continue;
      tally.files += 1;
      tally.bytes += stat.size;
      if (tally.files > WALLPAPER_MAX_FILES) throw new Error("wallpaper project has too many files");
      if (tally.bytes > WALLPAPER_MAX_BYTES) throw new Error("wallpaper project is too large");
      files.push({ path: relative, data: readFileSync(from).toString("base64") });
    }
  };
  walk(dir, "");
  return files;
}

/** Reject anything that could write outside the project root it is restoring into. */
function safeRelativePath(raw: string): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 240) return null;
  if (raw.includes("\\") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

/**
 * Write a portable file list back into the store as a fresh project. Used by the
 * `.qnskin` import path: the bundle carries the scene's own files, so a skin
 * shared between machines still has a wallpaper to mount.
 */
export function restoreWallpaperProject(dataDir: string, files: WallpaperFile[]): WallpaperProject {
  if (!Array.isArray(files) || files.length === 0) throw new Error("wallpaper bundle is empty");
  if (files.length > WALLPAPER_MAX_FILES) throw new Error("wallpaper project has too many files");
  const root = wallpapersDir(dataDir);
  mkdirSync(root, { recursive: true });
  const projectId = createHash("sha1").update(randomUUID()).digest("hex").slice(0, 16);
  const target = join(root, projectId);
  mkdirSync(target, { recursive: true });
  const tally: CopyTally = { bytes: 0, files: 0 };
  try {
    for (const file of files) {
      const relative = safeRelativePath(file.path);
      if (!relative || typeof file.data !== "string") throw new Error("wallpaper bundle has an unsafe path");
      const bytes = Buffer.from(file.data, "base64");
      tally.files += 1;
      tally.bytes += bytes.byteLength;
      if (tally.files > WALLPAPER_MAX_FILES) throw new Error("wallpaper project has too many files");
      if (tally.bytes > WALLPAPER_MAX_BYTES) throw new Error("wallpaper project is too large");
      const out = join(target, ...relative.split("/"));
      if (!isInside(target, out)) throw new Error("wallpaper bundle has an unsafe path");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
    }
    if (!isWallpaperProjectDir(target)) throw new Error("not a wallpaper project");
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
  const meta = readWallpaperProjectMeta(target);
  return {
    projectId,
    title: meta.title,
    kind: meta.kind,
    bytes: tally.bytes,
    hasPreview: meta.preview !== null,
    preview: meta.preview,
  };
}
