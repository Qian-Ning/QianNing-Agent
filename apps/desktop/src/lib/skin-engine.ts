import {
  BUILTIN_SKINS,
  NO_SKIN_ID,
  SKIN_ASSET_URL_SCHEME,
  SKIN_BG_LIMITS,
  builtinSkinById,
  sanitizeSkin,
  skinBaseScheme,
  skinCssVariables,
  type Skin,
} from "@pi-desktop/shared";

/**
 * The renderer-side skin engine. A skin is applied in two independent layers:
 *
 *  1. **Palette** — the allowlisted `--ds-*` overrides are written into a single
 *     managed <style> element as a `:root[data-skin="<id>"]` block, and the id
 *     is set on the document root. Because the values only ever come from
 *     {@link skinCssVariables} (itself fed by the sanitizer), nothing but audited
 *     custom properties can reach the DOM — no selectors, no `url()`, no script.
 *
 *  2. **Background media** — an optional image/video painted behind the shell in
 *     a fixed, pointer-transparent layer, dimmed by a scrim and blur so
 *     foreground text stays legible. The media is loaded only over the host's
 *     `skin-asset://` scheme (never a filesystem path or remote URL). A <video>
 *     background pauses when the window loses focus so it does not burn CPU/GPU
 *     while the user is elsewhere.
 *
 * Applying a skin layers on top of the theme, and the two never fight:
 *
 *   - A PURE-COLOUR skin (no wallpaper) owns the palette: it injects its
 *     allowlisted `--ds-*` overrides and its `base` scheme drives the document
 *     colour foundation (a light skin like 米纸 lays its colours on the LIGHT
 *     token set so un-overridden text/border tokens stay legible). That base
 *     resolution lives in the shell runtime, next to the theme resolution.
 *   - A WALLPAPER skin (image/video) is a theme-AGNOSTIC layer only: it paints
 *     the media behind transparent chrome and does NOT inject its palette or
 *     drive the foundation. The Settings theme (light/dark/fox) keeps full
 *     ownership of every colour, so switching the theme still works with a
 *     wallpaper on (user: 设置里的主题要真实生效，图片/视频不和主题冲突). The skin
 *     may still carry stored colours for when its wallpaper is later removed,
 *     but they are ignored while the wallpaper is active.
 *
 * Clearing the skin (id === "none") restores the plain theme.
 */

const SKIN_STYLE_ID = "qn-skin-tokens";
const SKIN_BG_ID = "qn-skin-background";

/** Resolve a skin by id from the built-ins and the user's custom list. */
export function resolveSkin(id: string | undefined, custom: readonly Skin[]): Skin {
  const wanted = id && id.trim() ? id.trim() : NO_SKIN_ID;
  const fromCustom = custom.find((skin) => skin.id === wanted);
  if (fromCustom) return fromCustom;
  return builtinSkinById(wanted) ?? builtinSkinById(NO_SKIN_ID) ?? BUILTIN_SKINS[0];
}

/** Build the `skin-asset://` URL for a stored background asset. */
export function skinAssetUrl(assetId: string, ext: string): string {
  return `${SKIN_ASSET_URL_SCHEME}//asset/${assetId}.${ext}`;
}

function ensureStyleElement(): HTMLStyleElement {
  let style = document.getElementById(SKIN_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = SKIN_STYLE_ID;
    // Appended last so a skin's token overrides win over the base token sheet
    // and the appearance block, but a plugin theme (appended even later) still
    // wins over a skin, matching the theme > skin > base precedence.
    document.head.append(style);
  }
  return style;
}

function ensureBackgroundLayer(): HTMLDivElement {
  let layer = document.getElementById(SKIN_BG_ID) as HTMLDivElement | null;
  if (!layer) {
    layer = document.createElement("div");
    layer.id = SKIN_BG_ID;
    layer.className = "qn-skin-background";
    layer.setAttribute("aria-hidden", "true");
    // Behind everything, never interactive.
    document.body.prepend(layer);
  }
  return layer;
}

function clampBg(value: number | undefined, key: keyof typeof SKIN_BG_LIMITS): number {
  const limit = SKIN_BG_LIMITS[key];
  if (typeof value !== "number" || Number.isNaN(value)) return limit.default;
  return Math.min(limit.max, Math.max(limit.min, value));
}

let focusHandlersBound = false;
let boundVideo: HTMLVideoElement | null = null;

function bindVideoFocusPause(video: HTMLVideoElement): void {
  boundVideo = video;
  const sync = () => {
    if (!boundVideo) return;
    if (document.hasFocus() && !document.hidden) {
      void boundVideo.play().catch(() => undefined);
    } else {
      boundVideo.pause();
    }
  };
  if (!focusHandlersBound) {
    focusHandlersBound = true;
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
  }
  sync();
}

function clearBackgroundMedia(layer: HTMLDivElement): void {
  boundVideo = null;
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  layer.style.removeProperty("--qn-skin-scrim");
}

/**
 * Apply a skin's palette + background. Idempotent: calling it again with a
 * different skin swaps both layers cleanly, and calling it with the `none` skin
 * removes them. Safe to call on every settings change.
 */
export function applySkin(skin: Skin): void {
  const safe = sanitizeSkin(skin) ?? builtinSkinById(NO_SKIN_ID)!;
  const root = document.documentElement;
  const hasWallpaper = safe.background.kind !== "none" && !!safe.background.assetId && !!safe.background.ext;

  // --- palette layer ---
  // A WALLPAPER skin injects NO palette: the media is a theme-agnostic layer and
  // the Settings theme keeps full ownership of every colour, so light/dark/fox
  // switch normally with no conflict (user: 图片/视频不要和主题冲突). A PURE-COLOUR
  // skin owns the palette as before.
  const vars = hasWallpaper ? {} : skinCssVariables(safe);
  const style = ensureStyleElement();
  const keys = Object.keys(vars);
  if (safe.id === NO_SKIN_ID || keys.length === 0) {
    style.textContent = "";
    delete root.dataset.skin;
  } else {
    root.dataset.skin = safe.id;
    const body = keys.map((key) => `  ${key}: ${vars[key]};`).join("\n");
    // Scope to the active skin id so a stale block never lingers after a swap.
    style.textContent = `:root[data-skin="${cssEscape(safe.id)}"] {\n${body}\n}`;
  }

  // --- background media layer ---
  const layer = ensureBackgroundLayer();
  clearBackgroundMedia(layer);
  const bg = safe.background;
  if (bg.kind === "none" || !bg.assetId || !bg.ext) {
    layer.style.display = "none";
    delete root.dataset.skinBg;
    root.style.removeProperty("--qn-skin-sidebar-tint");
    return;
  }
  layer.style.display = "block";
  // The attribute is what turns the app surfaces translucent so the wallpaper
  // shows behind the chat; colour-only skins never set it, so their layout is
  // byte-for-byte unchanged.
  root.dataset.skinBg = bg.kind;
  const opacity = clampBg(bg.opacity, "opacity");
  const blur = clampBg(bg.blur, "blur");
  const scrim = clampBg(bg.scrim, "scrim");
  const sidebarTint = clampBg(bg.sidebarTint, "sidebarTint");
  layer.style.setProperty("--qn-skin-scrim", String(scrim));
  // Publish the sidebar translucency on the root so the wallpaper flows under
  // the sidebar (no hard seam) while a backdrop blur keeps its text legible.
  root.style.setProperty("--qn-skin-sidebar-tint", String(sidebarTint));
  const url = skinAssetUrl(bg.assetId, bg.ext);

  if (bg.kind === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.opacity = String(opacity);
    video.style.filter = blur > 0 ? `blur(${blur}px)` : "none";
    layer.append(video);
    bindVideoFocusPause(video);
  } else {
    const img = document.createElement("div");
    img.className = "qn-skin-background-image";
    img.style.backgroundImage = `url("${url}")`;
    img.style.opacity = String(opacity);
    img.style.filter = blur > 0 ? `blur(${blur}px)` : "none";
    layer.append(img);
  }
}

/** Minimal CSS identifier escape for the skin id used in the scoped selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\\n]/g, "\\$&");
}

/** The base color scheme a skin resolves to, for callers that need it. */
export function skinScheme(skin: Skin): "light" | "dark" {
  return skinBaseScheme(skin.base);
}
