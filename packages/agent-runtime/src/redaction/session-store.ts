import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MappingStore } from "./store.js";

/**
 * Opens the token table a session's redaction binding points at.
 *
 * The directory is created on demand. A corrupt or unreadable table opens empty
 * rather than failing the turn: the request is redacted either way, and the
 * reply simply restores fewer tokens than it could.
 */
export async function openMappingStore(dir: string): Promise<MappingStore> {
  await mkdir(dir, { recursive: true });
  const store = new MappingStore({ path: join(dir, "mappings.json") });
  await store.load();
  return store;
}
