import type { ThemePreference } from "./types.js";

/** The two palettes anything can resolve to. */
export type ThemeColorScheme = "light" | "dark";

/**
 * A built-in theme preference. `system` is a preference rather than a palette:
 * it has no fixed colours, and each call site resolves it against its own
 * authority — `matchMedia` in the renderer, `nativeTheme` in main.
 */
export type BuiltinThemePreference = Exclude<ThemePreference, `plugin:${string}`>;

export type BuiltinTheme = {
  id: ThemeColorScheme;
  /** Palette the theme's overrides layer on. Fixed for a built-in theme. */
  base: ThemeColorScheme;
  /**
   * Native window background on Windows/Linux, as `#rrggbb`.
   *
   * The renderer, the main process, the plugin panel host, and the panel
   * preload all read this value here. macOS keeps `vibrancy` and is never sent
   * one.
   */
  windowBackground: string;
};

/**
 * The one place a built-in palette's window background is written down.
 *
 * Before this existed the same `#ffffff` / `#181818` pair was spelled out in
 * four files, so changing the dark plate meant finding all four. A contributed
 * theme declares the same value through
 * `contributes.windowAppearance.backgroundColor` (ADR 0248).
 */
const BUILTIN_THEME_BY_ID: Record<ThemeColorScheme, BuiltinTheme> = {
  light: { id: "light", base: "light", windowBackground: "#ffffff" },
  dark: { id: "dark", base: "dark", windowBackground: "#181818" },
};

/**
 * A shipped "appearance" theme: a named token override layered on a fixed base
 * color scheme, exactly like a plugin theme's `base` + CSS, but authored in the
 * app's own `tokens.css` (keyed on `data-appearance`) instead of contributed by
 * a plugin. `fox` is the "千凝 / QianNing" palette — a deep navy dressing over
 * the dark scheme that echoes the fox mascot (navy suit, cyan tail glow). It is
 * NOT a raw color scheme (`isThemeColorScheme` stays false for it), so Shiki,
 * Markdown, the native theme source, and window chrome all treat it as `dark`.
 */
export type BuiltinAppearance = "fox";

type BuiltinAppearanceDef = {
  /** Color scheme the appearance layers on; drives the `data-theme` attribute. */
  base: ThemeColorScheme;
  /** Native window background on Windows/Linux for this appearance, as `#rrggbb`. */
  windowBackground: string;
};

const BUILTIN_APPEARANCE_BY_ID: Record<BuiltinAppearance, BuiltinAppearanceDef> = {
  // #0a1024 is the indigo-navy base of the fox theme (styles/tokens.css
  // `:root[data-appearance="fox"]`); keeping it here means the native window
  // plate matches the painted surface the moment the theme applies.
  fox: { base: "dark", windowBackground: "#0a1024" },
};

/** Picker order for the built-in section, ahead of any contributed theme. */
export const BUILTIN_THEME_PREFERENCES: readonly BuiltinThemePreference[] = [
  "system",
  BUILTIN_THEME_BY_ID.light.id,
  BUILTIN_THEME_BY_ID.dark.id,
  "fox",
];

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  BUILTIN_THEME_BY_ID.light,
  BUILTIN_THEME_BY_ID.dark,
];

/** True when a stored preference names a palette instead of `system`/`plugin:`. */
export function isThemeColorScheme(value: unknown): value is ThemeColorScheme {
  return value === "light" || value === "dark";
}

/** True when a stored preference names a shipped appearance theme (e.g. `fox`). */
export function isBuiltinAppearance(value: unknown): value is BuiltinAppearance {
  return value === "fox";
}

/** True when a stored preference is one of the built-in options. */
export function isBuiltinThemePreference(value: unknown): value is BuiltinThemePreference {
  return value === "system" || isThemeColorScheme(value) || isBuiltinAppearance(value);
}

/** The base color scheme a shipped appearance theme layers on. */
export function builtinAppearanceBase(appearance: BuiltinAppearance): ThemeColorScheme {
  return BUILTIN_APPEARANCE_BY_ID[appearance].base;
}

/** Native window background for a shipped appearance theme. */
export function builtinAppearanceWindowBackground(appearance: BuiltinAppearance): string {
  return BUILTIN_APPEARANCE_BY_ID[appearance].windowBackground;
}

/** Native window background for a resolved built-in palette. */
export function builtinWindowBackground(scheme: ThemeColorScheme): string {
  return BUILTIN_THEME_BY_ID[scheme].windowBackground;
}
