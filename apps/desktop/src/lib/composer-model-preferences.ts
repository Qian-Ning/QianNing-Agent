/**
 * Renderer-local persistence for the composer model picker's favorites and
 * recently-used models.
 *
 * These are UI preferences, not host state: like the plan-approval mode and the
 * plugin launch history, they live in `localStorage` under the `pi.desktop.*`
 * namespace and never touch the Rust-owned database. A model is identified by
 * the pair (providerId, wire modelId); the two are joined with a NUL separator
 * that cannot appear in either half, so the stored key round-trips exactly.
 */

const FAVORITES_KEY = "pi.desktop.composerModelFavorites";
const RECENTS_KEY = "pi.desktop.composerModelRecents";
const RECENTS_MAX = 8;
const KEY_SEPARATOR = "\u0000";

/** Stable composite identity for one configured model. */
export function composerModelKey(providerId: string, modelId: string): string {
  return `${providerId}${KEY_SEPARATOR}${modelId}`;
}

/** Split a composite key back into its provider id and model id. */
export function parseComposerModelKey(
  key: string,
): { providerId: string; modelId: string } | null {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index < 0) return null;
  const providerId = key.slice(0, index);
  const modelId = key.slice(index + KEY_SEPARATOR.length);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function readKeys(storageKey: string): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string" || !parseComposerModelKey(entry)) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

function writeKeys(storageKey: string, keys: string[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storageKey, JSON.stringify(keys));
  } catch {
    // A blocked or full localStorage must not break model selection.
  }
}

/** Favorite model keys, in the order the user starred them. */
export function loadFavoriteModelKeys(): string[] {
  return readKeys(FAVORITES_KEY);
}

/**
 * Toggle a model's favorite state and return the next ordered key list.
 * Newly starred models append to the end so the existing order is stable.
 */
export function toggleFavoriteModelKey(providerId: string, modelId: string): string[] {
  const key = composerModelKey(providerId, modelId);
  const current = loadFavoriteModelKeys();
  const next = current.includes(key)
    ? current.filter((entry) => entry !== key)
    : [...current, key];
  writeKeys(FAVORITES_KEY, next);
  return next;
}

/** Recently-used model keys, newest first, bounded to {@link RECENTS_MAX}. */
export function loadRecentModelKeys(): string[] {
  return readKeys(RECENTS_KEY).slice(0, RECENTS_MAX);
}

/** Record a model as the most recently used and return the next key list. */
export function rememberRecentModelKey(providerId: string, modelId: string): string[] {
  const key = composerModelKey(providerId, modelId);
  const next = [key, ...loadRecentModelKeys().filter((entry) => entry !== key)].slice(
    0,
    RECENTS_MAX,
  );
  writeKeys(RECENTS_KEY, next);
  return next;
}

export const COMPOSER_MODEL_FAVORITES_STORAGE_KEY = FAVORITES_KEY;
export const COMPOSER_MODEL_RECENTS_STORAGE_KEY = RECENTS_KEY;
export const COMPOSER_MODEL_RECENTS_MAX = RECENTS_MAX;
