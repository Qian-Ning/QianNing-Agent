import {
  BUILTIN_SKINS,
  NO_SKIN_ID,
  SKIN_BG_LIMITS,
  type SkinWallpaperProject,
  builtinSkinById,
  deriveSkinBase,
  isSkinColor,
  sanitizeSkin,
  skinBaseScheme,
  skinCssVariables,
  type Skin,
  type SkinBackground,
  type SkinTokenKey,
} from "@pi-desktop/shared";

/**
 * The skin center's pure model.
 *
 * Everything the page and the editor decide about a skin — which colours it
 * exposes, what a draft looks like, whether it has unsaved changes, what the
 * preview shows — is a function here. Keeping it out of the components means the
 * rules are testable without rendering, and the page, the card and the editor
 * cannot drift apart: they all read the same fallbacks and the same derived base.
 */

/** One editable palette slot, with the fallback each base scheme reads from. */
export type EditorToken = {
  key: SkinTokenKey;
  labelKey: string;
  fallbackDark: string;
  fallbackLight: string;
};

export const EDITOR_TOKENS: readonly EditorToken[] = [
  { key: "accent", labelKey: "skins.fieldAccent", fallbackDark: "#7c6cf5", fallbackLight: "#b4532a" },
  { key: "bg", labelKey: "skins.fieldBg", fallbackDark: "#0a0b10", fallbackLight: "#f6f1e7" },
  { key: "panel", labelKey: "skins.fieldPanel", fallbackDark: "#14161f", fallbackLight: "#fffdf8" },
  { key: "fg", labelKey: "skins.fieldFg", fallbackDark: "#edeef6", fallbackLight: "#221d18" },
  { key: "focus", labelKey: "skins.fieldFocus", fallbackDark: "#a396ff", fallbackLight: "#b4532a" },
];

/** Exported for the contract test's allowlist assertion. */
export const EDITOR_TOKEN_KEYS = EDITOR_TOKENS.map((entry) => entry.key);

/**
 * What the editor edits. `original` is the skin this draft came from (null for a
 * new one) and exists so the editor can tell an untouched draft from a changed
 * one — closing an unmodified sheet must not ask "discard?", and saving must
 * not rewrite a skin nobody touched.
 */
export type SkinDraft = {
  id: string;
  name: string;
  tokens: Partial<Record<SkinTokenKey, string>>;
  background: SkinBackground;
  original: Skin | null;
};

// A new skin starts from the first shipped palette, not from an empty token set:
// a blank preview reads as a broken control, a seeded one reads as a starting point.
const NEW_SKIN_SEED = BUILTIN_SKINS.find((skin) => skin.id !== NO_SKIN_ID)?.id;

/** A random id that cannot collide with a built-in (built-ins have no prefix). */
export function createSkinId(): string {
  return `diy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function draftFromSkin(skin: Skin | null): SkinDraft {
  if (skin) {
    return {
      id: skin.id,
      name: skin.name,
      tokens: { ...skin.tokens },
      background: { ...skin.background },
      original: skin,
    };
  }
  // Seeded so the first preview already looks intentional; every value stays
  // editable and the seed carries no background media.
  const seed = NEW_SKIN_SEED ? builtinSkinById(NEW_SKIN_SEED) : undefined;
  return {
    id: createSkinId(),
    name: "",
    tokens: seed ? { ...seed.tokens } : {},
    background: { kind: "none" },
    original: null,
  };
}

/** The base foundation follows the chosen background colour (no theme picker). */
export function draftBase(draft: SkinDraft): ReturnType<typeof deriveSkinBase> {
  return deriveSkinBase(draft.tokens.bg);
}

export function draftScheme(draft: SkinDraft): "light" | "dark" {
  return draftBase(draft);
}

/** What a colour field shows when the draft does not override that key. */
export function fallbackColor(draft: SkinDraft, key: SkinTokenKey): string {
  const entry = EDITOR_TOKENS.find((token) => token.key === key);
  if (!entry) return "#5b8def";
  return draftScheme(draft) === "light" ? entry.fallbackLight : entry.fallbackDark;
}

/** The value a swatch/preview should paint for a key. */
export function draftColor(draft: SkinDraft, key: SkinTokenKey): string {
  return draft.tokens[key] ?? fallbackColor(draft, key);
}

export function withToken(draft: SkinDraft, key: SkinTokenKey, value: string): SkinDraft {
  /* A colour equal to the effective fallback is removed rather than stored, so a
     skin carries only the values that actually differ from its foundation. */
  const next = { ...draft.tokens, [key]: value };
  return { ...draft, tokens: next };
}

export function resetTokens(draft: SkinDraft): SkinDraft {
  return { ...draft, tokens: {} };
}

export function withBackground(draft: SkinDraft, background: SkinBackground): SkinDraft {
  return { ...draft, background };
}

export function backgroundControl(
  draft: SkinDraft,
  key: "opacity" | "blur" | "scrim" | "sidebarTint",
  value: number,
): SkinDraft {
  const limits = SKIN_BG_LIMITS[key];
  const clamped = Math.min(limits.max, Math.max(limits.min, value));
  return { ...draft, background: { ...draft.background, [key]: clamped } };
}

/** The skin a draft would save as, or null when the shared sanitizer rejects it. */
export function draftToSkin(draft: SkinDraft): Skin | null {
  return sanitizeSkin({
    id: draft.id,
    name: draft.name.trim(),
    base: draftBase(draft),
    tokens: draft.tokens,
    background: draft.background,
  });
}

/** True when the draft differs from the skin it was opened from. */
export function isDraftDirty(draft: SkinDraft): boolean {
  const original = draft.original;
  if (!original) {
    return draft.name.trim() !== "" || Object.keys(draft.tokens).length > 0 || draft.background.kind !== "none";
  }
  if (draft.name.trim() !== original.name) return true;
  if (draft.background.kind !== original.background.kind) return true;
  if (draft.background.assetId !== original.background.assetId) return true;
  if (draft.background.projectId !== original.background.projectId) return true;
  for (const key of ["opacity", "blur", "scrim", "sidebarTint"] as const) {
    if ((draft.background[key] ?? null) !== (original.background[key] ?? null)) return true;
  }
  const keys = new Set([...Object.keys(original.tokens), ...Object.keys(draft.tokens)]);
  for (const key of keys) {
    const before = original.tokens[key as SkinTokenKey] ?? null;
    const after = draft.tokens[key as SkinTokenKey] ?? null;
    if (before !== after) return true;
  }
  return false;
}

/**
 * A copy of `skin` under a fresh id and an unused name. Built-ins can be
 * duplicated too — that is the usual way to start from a preset you like
 * instead of from 千凝.
 */
export function duplicateOf(skin: Skin, existing: readonly Skin[], copyLabel: (name: string) => string): Skin {
  const baseName = copyLabel(skin.name);
  let name = baseName;
  let index = 2;
  const taken = new Set(existing.map((entry) => entry.name));
  while (taken.has(name)) {
    name = `${baseName} ${index}`;
    index += 1;
  }
  const copy = sanitizeSkin({ ...skin, id: createSkinId(), name, builtin: false });
  return copy ?? { ...skin, id: createSkinId(), name, builtin: false };
}

/** The i18n key for a skin's kind chip. */
export function skinTypeKey(skin: Pick<Skin, "background">): string {
  if (skin.background.kind === "video") return "skins.typeVideo";
  if (skin.background.kind === "image") return "skins.typeImage";
  if (skin.background.kind === "scene") return "skins.typeScene";
  if (skin.background.kind === "web") return "skins.typeWeb";
  return "skins.typeColor";
}

/** Append " 2", " 3"… until the name is free, so an import never overwrites. */
function uniqueName(base: string, existing: readonly Skin[]): string {
  const taken = new Set(existing.map((entry) => entry.name));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

/**
 * Turn an imported wallpaper project into a skin. The colours start from the
 * current DIY seed so the first apply is legible, and the live background is the
 * only thing the user has to think about; every token stays editable afterwards.
 */
/** True when a skin already paints a background that can be swapped. */
export function hasWallpaper(skin: Skin): boolean {
  return skin.background.kind !== "none";
}

export function skinFromWallpaper(
  project: SkinWallpaperProject,
  existing: readonly Skin[],
): Skin {
  const seed = NEW_SKIN_SEED ? builtinSkinById(NEW_SKIN_SEED) : undefined;
  const created = sanitizeSkin({
    id: createSkinId(),
    name: uniqueName(project.title.trim() || "壁纸", existing),
    base: "dark",
    tokens: seed ? { ...seed.tokens } : {},
    background: {
      kind: project.kind,
      projectId: project.projectId,
      projectTitle: project.title,
      ...(project.preview ? { preview: project.preview } : {}),
      opacity: 1,
      blur: 0,
      scrim: SKIN_BG_LIMITS.scrim.default,
      sidebarTint: SKIN_BG_LIMITS.sidebarTint.default,
    },
  });
  return (
    created ?? {
      id: createSkinId(),
      name: uniqueName(project.title.trim() || "壁纸", existing),
      base: "dark",
      tokens: {},
      background: { kind: "none" },
    }
  );
}

/**
 * The preview's own custom properties: the skin's palette where it defines one,
 * the base-scheme fallbacks where it does not. Separate from `skinCssVariables`
 * because the preview must stay readable even for `none` (no tokens at all).
 */
/** `#rrggbb` (or `#rgb`) → `rgba(r, g, b, a)`; the preview builds its veils with this. */
export function hexToRgba(value: string, alpha: number): string {
  const raw = value.trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.replace(/(.)/g, "$1$1") : raw.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The preview's custom properties — see the note above. */
export function previewVariables(skin: Pick<Skin, "tokens" | "base">): Record<string, string> {
  const vars = skinCssVariables(skin as Skin);
  const scheme = skinBaseScheme(skin.base);
  const accent = vars["--ds-accent"] ?? "#7c6cf5";
  const fg = vars["--ds-text-primary"] ?? (scheme === "light" ? "#221d18" : "#edeef6");
  return {
    "--sk-bg": vars["--ds-bg-primary"] ?? (scheme === "light" ? "#f6f1e7" : "#0a0b10"),
    "--sk-panel": vars["--ds-bg-secondary"] ?? (scheme === "light" ? "#fffdf8" : "#14161f"),
    "--sk-accent": accent,
    "--sk-fg": fg,
    "--sk-focus": vars["--ds-focus"] ?? accent,
    // Derived layers: the mock window needs soft fills and hairlines the skin
    // does not carry as tokens. Alpha is computed here (rgba, not color-mix)
    // because the phone WebView predates `color-mix()`.
    "--sk-accent-weak": hexToRgba(accent, 0.16),
    "--sk-accent-faint": hexToRgba(accent, 0.07),
    "--sk-line": hexToRgba(fg, 0.12),
    "--sk-veil": `linear-gradient(140deg, ${hexToRgba(accent, 0.22)}, transparent 58%)`,
  };
}

/**
 * `none` means "follow the theme", so its swatch must look like the app's own
 * chrome rather than like a skin with colours — that is why the card draws it
 * with the current theme variables instead of the preview palette.
 */
export function isNoSkin(skin: Pick<Skin, "id">): boolean {
  return skin.id === "none";
}

/** Guards a hand-typed hex from reaching a colour input or the sanitizer. */
export function normalizeHex(value: string): string {
  const v = (value ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7).toLowerCase();
  return "#5b8def";
}

/** True when a string can be stored as a token (keeps the hex field honest). */
export function isHexColor(value: string): boolean {
  return isSkinColor(value);
}
