import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MappingStore } from "./store.js";

/**
 * One table per directory, shared by every turn in this process.
 *
 * A per-turn instance re-read the file on each prompt and, worse, let two
 * concurrent turns hold divergent snapshots that overwrite each other on write.
 * Sharing it also makes the settings surface honest: clearing the table through
 * the sidecar empties the same object the next turn will use, instead of racing
 * a fresh load of the file that was just deleted.
 *
 * Keyed by directory because a process may serve more than one data directory.
 */
const stores = new Map<string, Promise<MappingStore>>();

/**
 * Opens the token table a session's redaction binding points at.
 *
 * The directory is created on demand. A corrupt or unreadable table opens empty
 * rather than failing the turn: the request is redacted either way, and the
 * reply simply restores fewer tokens than it could.
 */
export async function openMappingStore(dir: string): Promise<MappingStore> {
  const existing = stores.get(dir);
  if (existing) return existing;
  const opening = (async () => {
    await mkdir(dir, { recursive: true });
    const store = new MappingStore({ path: join(dir, "mappings.json") });
    await store.load();
    return store;
  })();
  stores.set(dir, opening);
  try {
    return await opening;
  } catch (error) {
    // A failed open must not poison the cache: the next turn retries.
    stores.delete(dir);
    throw error;
  }
}

/** Test seam: forget every cached table. */
export function resetMappingStores(): void {
  stores.clear();
}
