/**
 * Per-conversation prompt presets on the phone.
 *
 * The desktop keeps these in SQLite (`promptPreset.list/save/delete`); the
 * phone has no database, so the shelf lives in the same key/value store the
 * rest of the mobile state uses. The shape matches the desktop RPC so the
 * shared settings panel does not care which host answered.
 */

export interface PromptPreset {
  id: string;
  name: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = "qn.local.promptPresets";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrNull(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPreset(value: unknown): value is PromptPreset {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.text === "string";
}

export function listPresets(storage: StorageLike | null = storageOrNull()): PromptPreset[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPreset).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

function write(storage: StorageLike | null, presets: PromptPreset[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // A full quota loses the save; the caller still gets the preset back so the
    // panel does not claim failure for a list that is only in memory.
  }
}

export function savePreset(
  name: string,
  text: string,
  storage: StorageLike | null = storageOrNull(),
): PromptPreset {
  const trimmedName = name.trim() || "未命名提示词";
  const now = new Date().toISOString();
  const presets = listPresets(storage);
  // Saving the same name again replaces it: a shelf of near-duplicates is not
  // what "另存为" means.
  const existing = presets.find((preset) => preset.name === trimmedName);
  const preset: PromptPreset = existing
    ? { ...existing, text, updatedAt: now }
    : {
        id: "pp_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
        name: trimmedName,
        text,
        createdAt: now,
        updatedAt: now,
      };
  write(storage, [preset, ...presets.filter((row) => row.id !== preset.id)]);
  return preset;
}

export function deletePreset(
  id: string,
  storage: StorageLike | null = storageOrNull(),
): boolean {
  const presets = listPresets(storage);
  const next = presets.filter((preset) => preset.id !== id);
  if (next.length === presets.length) return false;
  write(storage, next);
  return true;
}
