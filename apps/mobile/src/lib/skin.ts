import { BUILTIN_SKINS, skinBaseScheme, skinCssVariables, type Skin } from "@pi-desktop/shared/skins";

/**
 * The phone wears the desktop's skin, not a lookalike.
 *
 * The desktop paints a skin by setting `data-theme` to the skin's base scheme and
 * then writing the skin's allowlisted tokens onto :root. We call the same
 * `skinCssVariables` the desktop calls, so "米纸" here is byte-for-byte the
 * "米纸" there — one catalog, one palette, no second copy to drift.
 */

const STORAGE_KEY = "qn.mobile.skin";

/** The desktop ships 米纸 as its warm default; the phone should look like it. */
export const DEFAULT_SKIN_ID = "paper";

export function listSkins(): readonly Skin[] {
  return BUILTIN_SKINS;
}

export function findSkin(id: string | null | undefined): Skin {
  return BUILTIN_SKINS.find((skin) => skin.id === id) ?? BUILTIN_SKINS.find((skin) => skin.id === DEFAULT_SKIN_ID) ?? BUILTIN_SKINS[0]!;
}

export function loadSkinId(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SKIN_ID;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

export function applySkin(id: string): void {
  const skin = findSkin(id);
  const root = document.documentElement;
  root.setAttribute("data-theme", skinBaseScheme(skin.base));
  root.setAttribute("data-skin", skin.id);
  for (const [name, value] of Object.entries(skinCssVariables(skin))) {
    root.style.setProperty(name, value);
  }

  // A skin may name a base whose accent is monochrome; without this the focus
  // ring and the primary button would keep the previous skin's hue after a swap.
  root.style.setProperty("--ds-focus", skin.tokens.focus ?? skin.tokens.accent ?? "currentColor");
}

export function saveSkinId(id: string): void {
  applySkin(id);
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A private-mode WebView without storage still renders; it just forgets.
  }
}
