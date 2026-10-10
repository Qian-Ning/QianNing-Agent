import { copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_LIBRARY_ENTRIES,
  type MediaLibraryCapability,
  type MediaLibraryEntry,
} from "@pi-desktop/shared";

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
/**
 * Oldest entries are dropped past this; the files themselves stay on disk. The
 * bound lives in shared so the workbench and the main process agree on it.
 */
export { MAX_LIBRARY_ENTRIES };
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
  if (
    typeof entry.id !== "string" ||
    (entry.capability !== "image" && entry.capability !== "video") ||
    (entry.status !== "succeeded" && entry.status !== "failed" && entry.status !== "cancelled") ||
    typeof entry.createdAt !== "string"
  ) {
    return false;
  }
  // A path is optional — a failed or cancelled run produced no file — but when
  // present it must be a string, and a succeeded run must carry one.
  if (entry.path !== undefined && typeof entry.path !== "string") return false;
  return entry.status !== "succeeded" || typeof entry.path === "string";
}

/**
 * Every entry the workbench may show.
 *
 * A damaged or hand-edited index yields what can still be trusted rather than an
 * exception: unreadable JSON reads as empty, and an entry that *names a file*
 * whose path no longer resolves inside the library root is dropped instead of
 * being handed to the renderer as a file it may save. A failed or cancelled
 * entry has no file to hand out, so it is kept as recorded.
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
  const libraryRoot = mediaLibraryDir(dataDir);
  const checked = await Promise.all(
    entries.map(async (entry) => {
      // Only an entry that names a file is bounded by the library root; this is
      // the invariant that keeps "show in folder" from becoming a file reader.
      if (entry.path === undefined) return entry;
      return (await realWithin(libraryRoot, entry.path)) ? entry : null;
    }),
  );
  return checked.filter((entry): entry is MediaLibraryEntry => entry !== null);
}

/**
 * Serialize one read-modify-write of the index per data directory: two runs must
 * not interleave, and a crash mid-write must not leave a half index. The
 * callback sees the entries as they read back (already filtered) and returns the
 * next index plus whatever the caller needs handed back.
 */
async function mutateLibrary<T>(
  dataDir: string,
  mutate: (current: MediaLibraryEntry[]) => { next: MediaLibraryEntry[]; result: T },
): Promise<T> {
  const key = resolve(dataDir);
  const previous = writes.get(key) ?? Promise.resolve();
  let outcome: T = undefined as T;
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readMediaLibrary(dataDir);
      const { next: merged, result } = mutate(current);
      outcome = result;
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
  return outcome;
}

/**
 * Record finished renders. One read, one write, and the oldest entries past the
 * cap fall off the end — the files stay, only the memory of them is bounded.
 *
 * Successes and failures alike are recorded: a run that failed or was cancelled
 * is written too, with no path of its own.
 */
export async function appendMediaLibrary(
  dataDir: string,
  entries: MediaLibraryEntry[],
): Promise<MediaLibraryEntry[]> {
  if (entries.length === 0) return [];
  await mutateLibrary(dataDir, (current) => ({
    next: pruneLibrary([...current, ...entries]),
    result: undefined,
  }));
  return entries;
}

/**
 * Forget the entries with the given ids. Returns exactly the entries that were
 * removed, so the caller can reclaim their files — this service never touches a
 * file itself, which is what keeps it free of Electron.
 */
export async function removeLibraryEntries(
  dataDir: string,
  ids: string[],
): Promise<MediaLibraryEntry[]> {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  return mutateLibrary(dataDir, (current) => ({
    next: current.filter((entry) => !wanted.has(entry.id)),
    result: current.filter((entry) => wanted.has(entry.id)),
  }));
}

/**
 * Forget everything. Returns the entries that were in the index so the caller
 * can reclaim their files; the index is written as an empty list.
 */
export async function clearLibrary(dataDir: string): Promise<MediaLibraryEntry[]> {
  return mutateLibrary(dataDir, (current) => ({ next: [], result: current }));
}

/** Builds the entry for one finished render of a workbench run. */
export function libraryEntryFrom(input: {
  capability: MediaLibraryCapability;
  /** Absent for a failed or cancelled run: there is no file to record. */
  path?: string;
  status: MediaLibraryEntry["status"];
  prompt?: string;
  /** The provider the run resolved, when it got that far. */
  providerId?: string;
  modelId?: string;
  size?: string;
  errorCode?: string;
  createdAt?: string;
}): MediaLibraryEntry {
  return {
    id: randomUUID(),
    capability: input.capability,
    ...(input.path ? { path: input.path } : {}),
    status: input.status,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
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
