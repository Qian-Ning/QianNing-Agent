/**
 * Renderer-local persistence for the composer's quick-prompt cards.
 *
 * A quick prompt is a short, reusable prompt the user saves from a draft and
 * inserts again with one click. Like the model picker's favorites and the
 * plan-approval mode, these are a UI preference rather than host state: they
 * live in `localStorage` under the `pi.desktop.*` namespace and never touch the
 * Rust-owned database. The newest card leads the list; saving the same text
 * again refreshes its position instead of storing a duplicate, and the list is
 * bounded so the strip can never grow without limit.
 */

const STORAGE_KEY = "pi.desktop.composerPromptCards";
const MAX_CARDS = 12;
const LABEL_MAX = 40;

export type PromptCard = {
  /** Stable id for list keys and removal. */
  id: string;
  /** Full prompt text inserted into the composer draft. */
  text: string;
  /** Short single-line label shown on the card. */
  label: string;
};

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** Derive a short, single-line label from a prompt's full text. */
export function promptCardLabel(text: string): string {
  const firstLine =
    text
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.length > LABEL_MAX
    ? `${collapsed.slice(0, LABEL_MAX - 1)}\u2026`
    : collapsed;
}

function newId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to a non-cryptographic id: these are local list keys only.
  }
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPromptCard(value: unknown): value is PromptCard {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Record<string, unknown>;
  return (
    typeof card.id === "string" &&
    typeof card.text === "string" &&
    typeof card.label === "string" &&
    card.text.trim() !== ""
  );
}

function readCards(): PromptCard[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: PromptCard[] = [];
    for (const entry of parsed) {
      if (!isPromptCard(entry)) continue;
      const key = entry.text.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: entry.id, text: entry.text, label: entry.label });
      if (out.length >= MAX_CARDS) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writeCards(cards: PromptCard[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch {
    // A blocked or full localStorage must not break composing.
  }
}

/** Saved quick-prompt cards, newest first. */
export function loadPromptCards(): PromptCard[] {
  return readCards();
}

/**
 * Save `text` as the newest quick prompt and return the next list. Blank text
 * is ignored, text that already exists moves to the front rather than
 * duplicating, and the list is bounded to {@link COMPOSER_PROMPT_CARDS_MAX}.
 */
export function savePromptCard(text: string): PromptCard[] {
  const trimmed = text.trim();
  if (!trimmed) return readCards();
  const existing = readCards().filter((card) => card.text.trim() !== trimmed);
  const card: PromptCard = {
    id: newId(),
    text: trimmed,
    label: promptCardLabel(trimmed),
  };
  const next = [card, ...existing].slice(0, MAX_CARDS);
  writeCards(next);
  return next;
}

/** Remove the card with the given id and return the next list. */
export function removePromptCard(id: string): PromptCard[] {
  const next = readCards().filter((card) => card.id !== id);
  writeCards(next);
  return next;
}

/** Marker and schema version written into an exported file for recognition. */
const EXPORT_KIND = "qianning.promptCards";
const EXPORT_VERSION = 1;

type PromptCardExport = {
  kind: typeof EXPORT_KIND;
  version: number;
  cards: Array<{ text: string; label: string }>;
};

/**
 * Serialize the given cards into a shareable, human-readable JSON string. Ids
 * are intentionally dropped: they are local list keys, regenerated on import so
 * a shared file never collides with another machine's ids.
 */
export function exportPromptCards(cards: readonly PromptCard[]): string {
  const payload: PromptCardExport = {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    cards: cards.map((card) => ({ text: card.text, label: card.label })),
  };
  return JSON.stringify(payload, null, 2);
}

export type PromptCardImportResult = {
  /** The merged list, written back to storage. */
  cards: PromptCard[];
  /** How many cards were newly added. */
  added: number;
  /** How many entries were skipped (blank, duplicate, or over the cap). */
  skipped: number;
  /** False when the text was unparseable or not a recognizable card export. */
  ok: boolean;
};

/** Pull a card-like array out of either the wrapped export or a bare array. */
function extractImportedCards(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const cards = (parsed as Record<string, unknown>).cards;
    if (Array.isArray(cards)) return cards;
  }
  return null;
}

/**
 * Parse an exported payload and merge its cards into the stored list, keeping
 * existing cards ahead of imported ones, de-duplicating by trimmed text against
 * both the existing list and earlier entries in the same file, and bounding the
 * result to {@link COMPOSER_PROMPT_CARDS_MAX}. The merged list is written back
 * and returned alongside a count of what was added versus skipped. Unparseable
 * or wrong-shape input returns `ok: false` and leaves storage untouched.
 */
export function importPromptCards(json: string): PromptCardImportResult {
  const existing = readCards();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { cards: existing, added: 0, skipped: 0, ok: false };
  }
  const incoming = extractImportedCards(parsed);
  if (incoming === null) {
    return { cards: existing, added: 0, skipped: 0, ok: false };
  }
  const seen = new Set(existing.map((card) => card.text.trim()));
  const merged = [...existing];
  let added = 0;
  let skipped = 0;
  for (const entry of incoming) {
    const text =
      entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string"
        ? ((entry as Record<string, unknown>).text as string).trim()
        : "";
    if (!text || seen.has(text) || merged.length >= MAX_CARDS) {
      skipped += 1;
      continue;
    }
    seen.add(text);
    merged.push({ id: newId(), text, label: promptCardLabel(text) });
    added += 1;
  }
  writeCards(merged);
  return { cards: merged, added, skipped, ok: true };
}

export const COMPOSER_PROMPT_CARDS_STORAGE_KEY = STORAGE_KEY;
export const COMPOSER_PROMPT_CARDS_MAX = MAX_CARDS;
export const COMPOSER_PROMPT_CARDS_EXPORT_KIND = EXPORT_KIND;
export const COMPOSER_PROMPT_CARDS_EXPORT_FILENAME = "qianning-prompt-cards.json";
