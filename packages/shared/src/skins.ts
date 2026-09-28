import type { ThemeColorScheme } from "./theme.js";

/**
 * A skin is a whole-look swap layered on a base theme — distinct from the
 * `theme` preference (light/dark/fox). It carries an allowlisted palette
 * override plus an optional local background image or video. It is NOT arbitrary
 * CSS: only the keys in {@link SKIN_TOKEN_KEYS} are honoured, values are
 * validated, and everything else is dropped fail-closed, so a hand-edited or
 * imported skin can never inject selectors, scripts, or remote URLs (the one
 * safe idea borrowed from dsh-skins).
 *
 * The base is one of the shipped appearances. `fox` reuses the 千凝 dark
 * appearance as the starting palette; a skin's own token overrides then layer on
 * top of whichever base it names.
 */
export type SkinBase = ThemeColorScheme | "fox";

/**
 * The palette keys a skin may override. Each maps to one or more real `--ds-*`
 * variables in {@link SKIN_TOKEN_CSS_VARS}. Keep this list small and audited: a
 * skin is a colour swap, not a stylesheet, so exposing the whole token layer
 * would let an imported skin repaint chrome into an unusable or deceptive state.
 */
export const SKIN_TOKEN_KEYS = [
  "accent",
  "accentHover",
  "bg",
  "bgElevated",
  "panel",
  "fg",
  "border",
  "focus",
] as const;

export type SkinTokenKey = (typeof SKIN_TOKEN_KEYS)[number];

/**
 * The concrete `--ds-*` variables each allowlisted key drives. One key can fan
 * out to several variables so a single user choice keeps related surfaces
 * coherent (e.g. `panel` paints every elevated surface tier at once).
 */
export const SKIN_TOKEN_CSS_VARS: Record<SkinTokenKey, readonly string[]> = {
  accent: ["--ds-accent"],
  accentHover: ["--ds-accent-hover", "--ds-accent-soft"],
  bg: ["--ds-bg-primary", "--ds-bg-under", "--ds-bg-inset"],
  bgElevated: ["--ds-bg-elevated-opaque", "--ds-bg-composer", "--ds-bg-dock"],
  panel: ["--ds-bg-secondary", "--ds-bg-tertiary", "--ds-raised", "--ds-bg-dock-raised"],
  fg: ["--ds-text-primary"],
  border: ["--ds-border-default", "--ds-border-subtle", "--ds-border-strong"],
  focus: ["--ds-focus"],
};

export type SkinBackgroundKind = "none" | "image" | "video";

/** Bounds for the background media controls, shared by editor UI and validator. */
export const SKIN_BG_LIMITS = {
  opacity: { min: 0.2, max: 1, default: 1 },
  blur: { min: 0, max: 20, default: 2 },
  scrim: { min: 0, max: 0.85, default: 0.42 },
} as const;

/**
 * An optional background layer painted behind the shell. `assetId` names a file
 * the host stored in the skins directory (never a raw path or URL that reaches
 * the renderer); the host serves it back over the `skin-asset://` scheme.
 * `opacity`/`blur`/`scrim` keep foreground text legible over busy media.
 */
export type SkinBackground = {
  kind: SkinBackgroundKind;
  /** Host-stored asset id; required for image/video, ignored for none. */
  assetId?: string;
  /** Original file name, for display and export. */
  assetName?: string;
  /** Media file extension, used to build the `skin-asset://` URL. */
  ext?: string;
  opacity?: number;
  blur?: number;
  scrim?: number;
};

export type Skin = {
  id: string;
  name: string;
  base: SkinBase;
  /** Allowlisted palette overrides. Missing keys fall through to the base theme. */
  tokens: Partial<Record<SkinTokenKey, string>>;
  background: SkinBackground;
  /** True for the shipped presets; user/imported skins omit it. */
  builtin?: boolean;
};

/** The reserved id that means "no skin — follow the plain theme". */
export const NO_SKIN_ID = "none";

/**
 * The URL scheme (with trailing colon) the host serves skin background media
 * over. Shared so the renderer builds `skin-asset://asset/<id>.<ext>` without
 * hard-coding the string. The scheme itself is registered in the main process.
 */
export const SKIN_ASSET_URL_SCHEME = "skin-asset:";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True when a value is a plain `#rgb`/`#rrggbb`/`#rrggbbaa` colour. */
export function isSkinColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The base scheme a skin's chrome resolves to (fox → dark). */
export function skinBaseScheme(base: SkinBase): ThemeColorScheme {
  return base === "light" ? "light" : "dark";
}

/**
 * Coerce any candidate into a safe {@link Skin}, dropping everything that is not
 * allowlisted. Returns null when the shape cannot be a skin at all (no id/name),
 * so callers fail closed instead of applying a half-parsed object. This is the
 * single choke point every entry path (settings load, import, editor save) runs
 * through.
 */
export function sanitizeSkin(input: unknown): Skin | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  if (!id || !name) return null;

  const base: SkinBase =
    raw.base === "light" || raw.base === "fox" ? (raw.base as SkinBase) : "dark";

  const tokens: Partial<Record<SkinTokenKey, string>> = {};
  const rawTokens =
    raw.tokens && typeof raw.tokens === "object" ? (raw.tokens as Record<string, unknown>) : {};
  for (const key of SKIN_TOKEN_KEYS) {
    const value = rawTokens[key];
    if (isSkinColor(value)) tokens[key] = (value as string).trim();
  }

  const rawBg =
    raw.background && typeof raw.background === "object"
      ? (raw.background as Record<string, unknown>)
      : {};
  const kind: SkinBackgroundKind =
    rawBg.kind === "image" || rawBg.kind === "video" ? rawBg.kind : "none";
  const background: SkinBackground = { kind };
  if (kind !== "none") {
    const assetId = typeof rawBg.assetId === "string" ? rawBg.assetId.trim() : "";
    // A media skin with no stored asset is downgraded to none rather than
    // rejected, so a partially-copied skin still applies its colours.
    if (!assetId) {
      background.kind = "none";
    } else {
      background.assetId = assetId;
      if (typeof rawBg.assetName === "string") background.assetName = rawBg.assetName.slice(0, 120);
      if (typeof rawBg.ext === "string") {
        const ext = rawBg.ext.replace(/^\./, "").toLowerCase();
        if (skinMediaKindForExtension(ext) === kind) background.ext = ext;
      }
      background.opacity = clamp(rawBg.opacity, SKIN_BG_LIMITS.opacity.min, SKIN_BG_LIMITS.opacity.max, SKIN_BG_LIMITS.opacity.default);
      background.blur = clamp(rawBg.blur, SKIN_BG_LIMITS.blur.min, SKIN_BG_LIMITS.blur.max, SKIN_BG_LIMITS.blur.default);
      background.scrim = clamp(rawBg.scrim, SKIN_BG_LIMITS.scrim.min, SKIN_BG_LIMITS.scrim.max, SKIN_BG_LIMITS.scrim.default);
    }
  }

  const skin: Skin = { id, name, base, tokens, background };
  if (raw.builtin === true) skin.builtin = true;
  return skin;
}

/**
 * The `--ds-*` variable/value pairs a skin contributes, expanded from its
 * allowlisted tokens. The renderer sets these as inline custom properties on the
 * document root; nothing else from a skin ever reaches the DOM.
 */
export function skinCssVariables(skin: Skin): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of SKIN_TOKEN_KEYS) {
    const value = skin.tokens[key];
    if (!value) continue;
    for (const cssVar of SKIN_TOKEN_CSS_VARS[key]) vars[cssVar] = value;
  }
  return vars;
}

/** File extension → whether it is an allowed skin background media type. */
export const SKIN_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif"] as const;
export const SKIN_VIDEO_EXTENSIONS = ["mp4", "webm"] as const;

/**
 * What the host returns after copying a picked/dropped file into the confined
 * assets directory. Shared so the renderer can type the IPC result without
 * importing a main-process module.
 */
export type SkinImportAssetResult = {
  assetId: string;
  assetName: string;
  ext: string;
  kind: "image" | "video";
  bytes: number;
};

export function skinMediaKindForExtension(ext: string): SkinBackgroundKind {
  const clean = ext.replace(/^\./, "").toLowerCase();
  if ((SKIN_IMAGE_EXTENSIONS as readonly string[]).includes(clean)) return "image";
  if ((SKIN_VIDEO_EXTENSIONS as readonly string[]).includes(clean)) return "video";
  return "none";
}

/**
 * The shipped preset skins. Colours are literal so the presets are self-contained;
 * `none` is the reserved "follow the theme" identity and carries no overrides.
 * The 千凝 preset mirrors the fox appearance so the skin center and the theme
 * picker agree on that palette.
 */
export const BUILTIN_SKINS: readonly Skin[] = [
  { id: NO_SKIN_ID, name: "跟随主题", base: "dark", tokens: {}, background: { kind: "none" }, builtin: true },
  {
    id: "qianning",
    name: "千凝",
    base: "fox",
    tokens: { accent: "#5b8def", bg: "#0a1024", panel: "#111a33", fg: "#eef3fd", focus: "#3cc0ea" },
    background: { kind: "none" },
    builtin: true,
  },
  {
    id: "amber",
    name: "暖橙",
    base: "dark",
    tokens: { accent: "#e8873c", accentHover: "#ff9d55", bg: "#1a1614", panel: "#241d18", fg: "#f2e8df", focus: "#ffb066" },
    background: { kind: "none" },
    builtin: true,
  },
  {
    id: "forest",
    name: "森绿",
    base: "dark",
    tokens: { accent: "#40c977", accentHover: "#5bd98c", bg: "#0f1712", panel: "#16211a", fg: "#e6f2ea", focus: "#5bd98c" },
    background: { kind: "none" },
    builtin: true,
  },
  {
    id: "paper",
    name: "米纸",
    base: "light",
    tokens: { accent: "#c2603a", accentHover: "#d6704a", bg: "#f7f2ea", panel: "#efe7db", fg: "#2c2620", focus: "#c2603a" },
    background: { kind: "none" },
    builtin: true,
  },
];

/** Look up a built-in skin by id. */
export function builtinSkinById(id: string): Skin | undefined {
  return BUILTIN_SKINS.find((skin) => skin.id === id);
}

/**
 * The on-disk shape of an exported `.qnskin` bundle: the skin definition plus
 * its background media inlined as base64 so a single file is shareable. The
 * host writes and reads this; both sides re-validate through {@link sanitizeSkin}
 * so a hand-edited or hostile bundle cannot smuggle anything past the allowlist.
 */
export const QNSKIN_MAGIC = "qnskin";
export const QNSKIN_VERSION = 1;

export type QnskinBundle = {
  magic: typeof QNSKIN_MAGIC;
  version: number;
  skin: Skin;
  /** Present only when the skin carries an image/video background. */
  asset?: {
    ext: string;
    /** base64-encoded media bytes. */
    data: string;
  };
};

/** Validate a parsed bundle's envelope, returning the safe skin or null. */
export function sanitizeQnskinBundle(input: unknown): QnskinBundle | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (raw.magic !== QNSKIN_MAGIC) return null;
  if (typeof raw.version !== "number" || raw.version > QNSKIN_VERSION) return null;
  const skin = sanitizeSkin(raw.skin);
  if (!skin) return null;
  const bundle: QnskinBundle = { magic: QNSKIN_MAGIC, version: QNSKIN_VERSION, skin };
  const rawAsset =
    raw.asset && typeof raw.asset === "object" ? (raw.asset as Record<string, unknown>) : null;
  if (skin.background.kind !== "none" && rawAsset) {
    const ext = typeof rawAsset.ext === "string" ? rawAsset.ext.replace(/^\./, "").toLowerCase() : "";
    const data = typeof rawAsset.data === "string" ? rawAsset.data : "";
    if (ext && data && skinMediaKindForExtension(ext) === skin.background.kind) {
      bundle.asset = { ext, data };
    } else {
      // Media declared but unusable — drop to a colours-only skin rather than reject.
      bundle.skin = { ...skin, background: { kind: "none" } };
    }
  } else if (skin.background.kind !== "none") {
    bundle.skin = { ...skin, background: { kind: "none" } };
  }
  return bundle;
}
