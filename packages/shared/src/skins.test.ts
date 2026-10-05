import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKINS,
  NO_SKIN_ID,
  QNSKIN_MAGIC,
  QNSKIN_VERSION,
  SKIN_TOKEN_KEYS,
  builtinSkinById,
  isSkinColor,
  sanitizeQnskinBundle,
  sanitizeSkin,
  skinBaseScheme,
  deriveSkinBase,
  skinCssVariables,
  skinMediaKindForExtension,
} from "./skins.js";

describe("skins", () => {
  it("ships the reserved no-skin identity plus the named presets", () => {
    expect(builtinSkinById(NO_SKIN_ID)?.tokens).toEqual({});
    expect(BUILTIN_SKINS.every((skin) => skin.builtin)).toBe(true);
    expect(BUILTIN_SKINS.map((skin) => skin.id)).toContain("qianning");
  });

  it("resolves fox and light bases to their color scheme", () => {
    expect(skinBaseScheme("fox")).toBe("dark");
    expect(skinBaseScheme("dark")).toBe("dark");
    expect(skinBaseScheme("light")).toBe("light");
  });

  it("accepts only #rgb/#rrggbb/#rrggbbaa colors", () => {
    expect(isSkinColor("#0a1024")).toBe(true);
    expect(isSkinColor("#fff")).toBe(true);
    expect(isSkinColor("#0a1024ff")).toBe(true);
    expect(isSkinColor("red")).toBe(false);
    expect(isSkinColor("url(evil)")).toBe(false);
    expect(isSkinColor("#0a10")).toBe(false);
  });

  it("fails closed on a shape that cannot be a skin", () => {
    expect(sanitizeSkin(null)).toBeNull();
    expect(sanitizeSkin({})).toBeNull();
    expect(sanitizeSkin({ id: "x" })).toBeNull();
    expect(sanitizeSkin({ name: "x" })).toBeNull();
  });

  it("drops non-allowlisted tokens and non-color values", () => {
    const skin = sanitizeSkin({
      id: "diy-1",
      name: "Test",
      base: "dark",
      tokens: {
        accent: "#5b8def",
        // not a color -> dropped
        bg: "javascript:alert(1)",
        // not in the allowlist -> dropped
        evil: "#000000",
        "--ds-bg-primary": "#000000",
      },
      background: { kind: "none" },
    });
    expect(skin).not.toBeNull();
    expect(skin!.tokens.accent).toBe("#5b8def");
    expect(skin!.tokens.bg).toBeUndefined();
    expect(Object.keys(skin!.tokens).every((k) => (SKIN_TOKEN_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("only expands allowlisted tokens into --ds-* variables", () => {
    const skin = sanitizeSkin({
      id: "diy-2",
      name: "Vars",
      base: "dark",
      tokens: { accent: "#5b8def", bg: "#0a1024" },
      background: { kind: "none" },
    })!;
    const vars = skinCssVariables(skin);
    expect(vars["--ds-accent"]).toBe("#5b8def");
    expect(vars["--ds-bg-primary"]).toBe("#0a1024");
    // Every emitted key must be a --ds- custom property, never a raw selector.
    expect(Object.keys(vars).every((k) => k.startsWith("--ds-"))).toBe(true);
  });

  it("drives the sidebar/rail off the panel token so the whole shell reskins", () => {
    // Regression: a skin that recoloured only the chat pane left the sidebar on
    // the base theme, because the light theme hard-codes --ds-settings-rail-bg
    // and the sidebar reads --ds-bg-sidebar. The panel token must reach both.
    const skin = sanitizeSkin({
      id: "diy-panel",
      name: "Panel",
      base: "dark",
      tokens: { panel: "#111a33" },
      background: { kind: "none" },
    })!;
    const vars = skinCssVariables(skin);
    expect(vars["--ds-bg-sidebar"]).toBe("#111a33");
    expect(vars["--ds-settings-rail-bg"]).toBe("#111a33");
    expect(vars["--ds-bg-secondary"]).toBe("#111a33");
  });

  it("downgrades a media background with no stored asset to none", () => {
    const skin = sanitizeSkin({
      id: "diy-3",
      name: "NoAsset",
      base: "dark",
      tokens: {},
      background: { kind: "video" },
    })!;
    expect(skin.background.kind).toBe("none");
  });

  it("clamps background media controls into range", () => {
    const skin = sanitizeSkin({
      id: "diy-4",
      name: "Clamp",
      base: "dark",
      tokens: {},
      background: { kind: "image", assetId: "abc", opacity: 5, blur: -3, scrim: 9, sidebarTint: 9 },
    })!;
    expect(skin.background.opacity).toBeLessThanOrEqual(1);
    expect(skin.background.blur).toBeGreaterThanOrEqual(0);
    expect(skin.background.scrim).toBeLessThanOrEqual(0.85);
    // The sidebar-backing control clamps to its own range (0–0.85).
    expect(skin.background.sidebarTint).toBeLessThanOrEqual(0.85);
    expect(skin.background.sidebarTint).toBeGreaterThanOrEqual(0);
    // Default is 0 = fully transparent sidebar over a wallpaper.
    const dflt = sanitizeSkin({
      id: "diy-4b",
      name: "Default",
      base: "dark",
      tokens: {},
      background: { kind: "image", assetId: "abc" },
    })!;
    expect(dflt.background.sidebarTint).toBe(0);
  });

  it("derives a skin's base foundation from its background luminance (no theme picker)", () => {
    // The editor no longer asks the user to pick dark/light/fox — a skin is not a
    // theme. deriveSkinBase reads the bg colour: a light background lays the
    // palette on the light foundation so un-overridden text stays legible.
    expect(deriveSkinBase("#f7f2ea")).toBe("light");
    expect(deriveSkinBase("#0a1024")).toBe("dark");
    expect(deriveSkinBase(undefined)).toBe("dark");
    expect(deriveSkinBase("not-a-color")).toBe("dark");
  });

  it("classifies media file extensions", () => {
    expect(skinMediaKindForExtension("png")).toBe("image");
    expect(skinMediaKindForExtension(".JPG")).toBe("image");
    expect(skinMediaKindForExtension("mp4")).toBe("video");
    expect(skinMediaKindForExtension("webm")).toBe("video");
    expect(skinMediaKindForExtension("exe")).toBe("none");
  });

  it("keeps a media background's asset id and ext, dropping a mismatched ext", () => {
    const keep = sanitizeSkin({
      id: "diy-ext",
      name: "Ext",
      base: "dark",
      tokens: {},
      background: { kind: "image", assetId: "deadbeef", ext: "png" },
    })!;
    expect(keep.background.ext).toBe("png");
    // An extension whose kind disagrees with the declared kind is dropped.
    const mismatch = sanitizeSkin({
      id: "diy-mismatch",
      name: "Mismatch",
      base: "dark",
      tokens: {},
      background: { kind: "image", assetId: "deadbeef", ext: "mp4" },
    })!;
    expect(mismatch.background.ext).toBeUndefined();
  });

  it("validates a .qnskin bundle envelope and re-sanitizes its skin", () => {
    const good = sanitizeQnskinBundle({
      magic: QNSKIN_MAGIC,
      version: QNSKIN_VERSION,
      skin: { id: "s1", name: "Shared", base: "dark", tokens: { accent: "#5b8def" }, background: { kind: "none" } },
    });
    expect(good?.magic).toBe(QNSKIN_MAGIC);
    expect(good?.skin.tokens.accent).toBe("#5b8def");
    // Wrong magic, too-new version, and a non-skin body all fail closed.
    expect(sanitizeQnskinBundle({ magic: "nope", version: 1, skin: {} })).toBeNull();
    expect(sanitizeQnskinBundle({ magic: QNSKIN_MAGIC, version: 999, skin: {} })).toBeNull();
    expect(sanitizeQnskinBundle(null)).toBeNull();
  });

  it("drops a bundle's inline asset when its ext disagrees with the skin kind", () => {
    const bundle = sanitizeQnskinBundle({
      magic: QNSKIN_MAGIC,
      version: QNSKIN_VERSION,
      skin: { id: "s2", name: "V", base: "dark", tokens: {}, background: { kind: "video", assetId: "abc", ext: "mp4" } },
      asset: { ext: "png", data: "AAAA" },
    });
    // Declared video but the asset is an image -> collapse to colours-only.
    expect(bundle?.skin.background.kind).toBe("none");
    expect(bundle?.asset).toBeUndefined();
  });
});
