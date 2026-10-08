import { copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaLibraryCapability, MediaLibraryEntry } from "@pi-desktop/shared";

// The shape lives in shared so the renderer and the main process cannot drift.
export type { MediaLibraryCapability, MediaLibraryEntry };

/**
 * The media library: what the workbench produced, remembered across restarts.
 *
 * A render costs money, so a finished file is not a cache entry — it is the
 * asset. Files live under `<data directory>/generated/<capability>/` and the
 * index beside them records what each one is, so the workbench can list its own
 * history after a restart without scanning directories.
 *
 * The index is a plain JSON file read once when the workbench opens and appended
 * once per finished run. Nothing here polls, watches, or scans in the background.
 */
export const MEDIA_LIBRARY_DIR = "generated";
/** Oldest entries are dropped past this; the files themselves stay on disk. */
export const MAX_LIBRARY_ENTRIES = 500;
/** A one-time migration reads at most this many stray renders. */
const MIGRATION_LIMIT = 200;

/**
 * The one rule that bounds the index. Pure, so the cap is tested without
 * creating five hundred files.
 */
export function pruneLibrary<T>(entries: T[]): T[] {
  return entries.length > MAX_LIBRARY_ENTRIES ? entries.slice(-MAX_LIBRARY_ENTRIES) : entries;
}

export function mediaLibraryDir(dataDir: string, capability?: MediaLibraryCapability): string {
  return capability
    ? resolve(dataDir, MEDIA_LIBRARY_DIR, capability)
    : resolve(dataDir, MEDIA_LIBRARY_DIR);
}

function indexPath(dataDir: string): string {
  return resolve(mediaLibraryDir(dataDir), "index.json");
}

/** Appends are serialized per data directory: two runs must not interleave. */
const writes = new Map<string, Promise<void>>();

async function realWithin(base: string, candidate: string): Promise<boolean> {
  const root = await realpath(base).catch(() => null);
  if (!root) return false;
  const target = await realpath(candidate).catch(() => null);
  if (!target) return false;
  const rel = relative(root, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function isEntry(value: unknown): value is MediaLibraryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    (entry.capability === "image" || entry.capability === "video") &&
    typeof entry.path === "string" &&
    (entry.status === "succeeded" || entry.status === "failed" || entry.status === "cancelled") &&
    typeof entry.createdAt === "string"
  );
}

/**
 * Every entry the workbench may show.
 *
 * A damaged or hand-edited index yields what can still be trusted rather than an
 * exception: unreadable JSON reads as empty, and an entry whose path no longer
 * resolves inside the library root is dropped instead of being handed to the
 * renderer as a file it may save.
 */
export async function readMediaLibrary(dataDir: string): Promise<MediaLibraryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(indexPath(dataDir), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries = parsed.filter(isEntry);
  const checked = await Promise.all(
    entries.map(async (entry) =>
      (await realWithin(mediaLibraryDir(dataDir), entry.path)) ? entry : null,
    ),
  );
  return checked.filter((entry): entry is MediaLibraryEntry => entry !== null);
}

/**
 * Record finished renders. One read, one write, and the oldest entries past the
 * cap fall off the end — the files stay, only the memory of them is bounded.
 */
export async function appendMediaLibrary(
  dataDir: string,
  entries: MediaLibraryEntry[],
): Promise<MediaLibraryEntry[]> {
  if (entries.length === 0) return [];
  const key = resolve(dataDir);
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readMediaLibrary(dataDir);
      const merged = pruneLibrary([...current, ...entries]);
      const dir = mediaLibraryDir(dataDir);
      await mkdir(dir, { recursive: true });
      // Temp file plus rename: a crash mid-write cannot leave a half index.
      const temp = join(dir, `index.${randomUUID()}.tmp`);
      await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      await rename(temp, indexPath(dataDir));
    });
  writes.set(key, next);
  try {
    await next;
  } finally {
    if (writes.get(key) === next) writes.delete(key);
  }
  return entries;
}

/** Builds the entry for one finished render of a workbench run. */
export function libraryEntryFrom(input: {
  capability: MediaLibraryCapability;
  path: string;
  status: MediaLibraryEntry["status"];
  prompt?: string;
  modelId?: string;
  size?: string;
  errorCode?: string;
  createdAt?: string;
}): MediaLibraryEntry {
  return {
    id: randomUUID(),
    capability: input.capability,
    path: input.path,
    status: input.status,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

const RENDER_NAME = /^generated-[0-9a-fA-F-]{36}\.(png|jpe?g|webp|gif|mp4|webm|mov)$/;

/**
 * One-time: pull renders that earlier builds left in session scratch folders
 * into the library, so nothing paid for is stranded inside a conversation.
 *
 * Runs only when no index exists yet, reads at most `MIGRATION_LIMIT` files, and
 * copies rather than moves — the original is never destroyed. After this, the
 * scratch folders are left alone.
 */
export async function migrateScratchRenders(dataDir: string): Promise<MediaLibraryEntry[]> {
  // An index already existing means this app has run before: never re-import.
  const indexPresent = await stat(indexPath(dataDir)).then(
    () => true,
    () => false,
  );
  if (indexPresent) return [];

  const scratchRoot = resolve(dataDir, "scratch");
  const sessions = await readdir(scratchRoot, { withFileTypes: true }).catch(() => []);
  const found: { session: string; name: string }[] = [];
  for (const session of sessions) {
    if (!session.isDirectory() || found.length >= MIGRATION_LIMIT) continue;
    const names = await readdir(join(scratchRoot, session.name)).catch(() => []);
    for (const name of names) {
      if (found.length >= MIGRATION_LIMIT) break;
      if (RENDER_NAME.test(name)) found.push({ session: session.name, name });
    }
  }
  if (found.length === 0) return [];

  const migrated: MediaLibraryEntry[] = [];
  for (const item of found) {
    const source = join(scratchRoot, item.session, item.name);
    const isVideo = /\.(mp4|webm|mov)$/i.test(item.name);
    const capability: MediaLibraryCapability = isVideo ? "video" : "image";
    const target = join(mediaLibraryDir(dataDir, capability), item.name);
    try {
      await mkdir(mediaLibraryDir(dataDir, capability), { recursive: true });
      const file = await stat(source);
      if (!file.isFile()) continue;
      await copyFile(source, target);
      migrated.push(
        libraryEntryFrom({
          capability,
          path: target,
          status: "succeeded",
          createdAt: file.mtime.toISOString(),
        }),
      );
    } catch {
      // A file that vanished mid-migration is simply not recovered.
    }
  }
  await appendMediaLibrary(dataDir, migrated);
  return migrated;
}
