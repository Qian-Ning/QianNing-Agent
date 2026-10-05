import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SKIN_BG_LIMITS,
  builtinSkinById,
  deriveSkinBase,
  sanitizeSkin,
  skinCssVariables,
  type Skin,
  type SkinBackground,
  type SkinTokenKey,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { skinAssetUrl } from "../../lib/skin-engine";
import { useAppStore } from "../../stores/app-store";
import { Button, Input, portalOverlay } from "../../components/ui";
import { IconImage, IconTrash, IconVideo, IconX } from "../../components/icons";

/** The palette keys the editor exposes, in display order, each with a fallback. */
const EDITOR_TOKENS: { key: SkinTokenKey; labelKey: string; fallbackDark: string; fallbackLight: string }[] = [
  { key: "accent", labelKey: "skins.fieldAccent", fallbackDark: "#5b8def", fallbackLight: "#3b6fd4" },
  { key: "bg", labelKey: "skins.fieldBg", fallbackDark: "#0f1115", fallbackLight: "#f7f2ea" },
  { key: "panel", labelKey: "skins.fieldPanel", fallbackDark: "#181b21", fallbackLight: "#ffffff" },
  { key: "fg", labelKey: "skins.fieldFg", fallbackDark: "#e6e8ee", fallbackLight: "#2c2620" },
  { key: "focus", labelKey: "skins.fieldFocus", fallbackDark: "#3cc0ea", fallbackLight: "#3b6fd4" },
];

type Draft = {
  id: string;
  name: string;
  tokens: Partial<Record<SkinTokenKey, string>>;
  background: SkinBackground;
};

/**
 * The DIY skin editor. The user names the skin, tunes an allowlisted set of
 * colours with native pickers, and optionally attaches a local image/video
 * background (with opacity/blur/scrim/sidebar-transparency sliders). A live
 * preview pane on the right reflects every change. Only allowlisted tokens ever
 * leave this dialog — the shared sanitizer runs on save.
 *
 * There is deliberately NO base-theme (dark/light/fox) selector here: a skin is
 * not a theme, and duplicating the Settings theme picker inside the editor
 * confused the two (user: 新建皮肤这边不要有主题，会和设置里面的主题冲突). The base
 * token foundation is derived automatically from the skin's own background
 * colour, so a light palette lays on the light foundation and a dark one on the
 * dark foundation without the user choosing a theme.
 */
export function SkinEditorDialog({
  initial,
  onCancel,
  onSave,
}: {
  initial: Skin | null;
  onCancel: () => void;
  onSave: (skin: Skin) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const setToken = (key: SkinTokenKey, value: string) => {
    setDraft((d) => ({ ...d, tokens: { ...d.tokens, [key]: value } }));
  };

  // The base foundation follows the chosen background colour — no theme picker.
  const derivedBase = deriveSkinBase(draft.tokens.bg);

  const fallbackFor = (key: SkinTokenKey): string => {
    const entry = EDITOR_TOKENS.find((e) => e.key === key);
    if (!entry) return "#5b8def";
    return derivedBase === "light" ? entry.fallbackLight : entry.fallbackDark;
  };

  const attachMedia = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.importSkinAsset();
      if (!result) return;
      setDraft((d) => ({
        ...d,
        background: {
          kind: result.kind,
          assetId: result.assetId,
          assetName: result.assetName,
          ext: result.ext,
          opacity: d.background.opacity ?? SKIN_BG_LIMITS.opacity.default,
          blur: d.background.blur ?? SKIN_BG_LIMITS.blur.default,
          scrim: d.background.scrim ?? SKIN_BG_LIMITS.scrim.default,
          sidebarTint: d.background.sidebarTint ?? SKIN_BG_LIMITS.sidebarTint.default,
        },
      }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const clearMedia = () => {
    const prev = draft.background;
    setDraft((d) => ({ ...d, background: { kind: "none" } }));
    if (prev.assetId && prev.ext) {
      void api.deleteSkinAsset(prev.assetId, prev.ext).catch(() => undefined);
    }
  };

  const setBgControl = (key: "opacity" | "blur" | "scrim" | "sidebarTint", value: number) => {
    setDraft((d) => ({ ...d, background: { ...d.background, [key]: value } }));
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name) {
      nameRef.current?.focus();
      showToast(t("skins.nameRequired"), { variant: "error" });
      return;
    }
    const candidate: Skin = {
      id: draft.id,
      name,
      base: derivedBase,
      tokens: draft.tokens,
      background: draft.background,
    };
    const safe = sanitizeSkin(candidate);
    if (!safe) {
      showToast(t("skins.saveInvalid"), { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      await onSave(safe);
    } finally {
      setBusy(false);
    }
  };

  // Build the live preview swatch from the current draft.
  const previewSkin: Skin = {
    id: draft.id,
    name: draft.name,
    base: derivedBase,
    tokens: draft.tokens,
    background: draft.background,
  };
  const previewVars = useMemo(() => skinCssVariables(previewSkin), [draft]);
  const hasBg = draft.background.kind !== "none";
  const previewStyle: Record<string, string> = {
    ["--sk-bg" as string]: previewVars["--ds-bg-primary"] ?? fallbackFor("bg"),
    ["--sk-panel" as string]: previewVars["--ds-bg-secondary"] ?? fallbackFor("panel"),
    ["--sk-accent" as string]: previewVars["--ds-accent"] ?? fallbackFor("accent"),
    ["--sk-fg" as string]: previewVars["--ds-text-primary"] ?? fallbackFor("fg"),
    ["--sk-focus" as string]: previewVars["--ds-focus"] ?? fallbackFor("focus"),
    // Drives how translucent the preview sidebar is over a wallpaper, mirroring
    // the live shell so the sidebar-transparency slider is actually visible here.
    ["--sk-side-tint" as string]: hasBg
      ? String(draft.background.sidebarTint ?? SKIN_BG_LIMITS.sidebarTint.default)
      : "1",
  };
  const bgUrl =
    draft.background.kind !== "none" && draft.background.assetId && draft.background.ext
      ? skinAssetUrl(draft.background.assetId, draft.background.ext)
      : null;

  return portalOverlay(
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("skins.editorTitle")}>
      <div className="skin-editor">
        <header className="skin-editor-head">
          <h2>{initial ? t("skins.editorEditTitle") : t("skins.editorTitle")}</h2>
          <button type="button" className="skin-editor-close" onClick={onCancel} aria-label={t("common.close")}>
            <IconX size={16} />
          </button>
        </header>

        <div className="skin-editor-body">
          <div className="skin-editor-controls">
            <label className="skin-editor-field">
              <span>{t("skins.fieldName")}</span>
              <Input
                ref={nameRef}
                value={draft.name}
                maxLength={40}
                placeholder={t("skins.namePlaceholder")}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </label>

            <div
              className="skin-editor-colors"
              data-muted={hasBg ? "true" : undefined}
              title={hasBg ? t("skins.bgThemeHint") : undefined}
            >
              {EDITOR_TOKENS.map((entry) => {
                const value = draft.tokens[entry.key] ?? fallbackFor(entry.key);
                return (
                  <label key={entry.key} className="skin-editor-color">
                    <input
                      type="color"
                      value={normalizeHex(value)}
                      onChange={(e) => setToken(entry.key, e.target.value)}
                    />
                    <span className="skin-editor-color-label">{t(entry.labelKey)}</span>
                    <span className="skin-editor-color-hex">{normalizeHex(value)}</span>
                  </label>
                );
              })}
            </div>

            <div className="skin-editor-field">
              <span>{t("skins.fieldBackground")}</span>
              {draft.background.kind === "none" ? (
                <Button variant="secondary" size="sm" onClick={() => void attachMedia()} disabled={busy}>
                  <IconImage size={14} aria-hidden /> {t("skins.attachMedia")}
                </Button>
              ) : (
                <div className="skin-editor-media">
                  <div className="skin-editor-media-row">
                    <span className="skin-editor-media-name">
                      {draft.background.kind === "video" ? <IconVideo size={13} /> : <IconImage size={13} />}
                      {draft.background.assetName ?? t("skins.mediaAttached")}
                    </span>
                    <button type="button" className="skin-editor-media-remove" onClick={clearMedia} aria-label={t("skins.removeMedia")}>
                      <IconTrash size={13} />
                    </button>
                  </div>
                  <SliderRow
                    label={t("skins.opacity")}
                    min={SKIN_BG_LIMITS.opacity.min}
                    max={SKIN_BG_LIMITS.opacity.max}
                    step={0.05}
                    value={draft.background.opacity ?? SKIN_BG_LIMITS.opacity.default}
                    onChange={(v) => setBgControl("opacity", v)}
                  />
                  <SliderRow
                    label={t("skins.blur")}
                    min={SKIN_BG_LIMITS.blur.min}
                    max={SKIN_BG_LIMITS.blur.max}
                    step={1}
                    value={draft.background.blur ?? SKIN_BG_LIMITS.blur.default}
                    onChange={(v) => setBgControl("blur", v)}
                  />
                  <SliderRow
                    label={t("skins.scrim")}
                    min={SKIN_BG_LIMITS.scrim.min}
                    max={SKIN_BG_LIMITS.scrim.max}
                    step={0.05}
                    value={draft.background.scrim ?? SKIN_BG_LIMITS.scrim.default}
                    onChange={(v) => setBgControl("scrim", v)}
                  />
                  <SliderRow
                    label={t("skins.sidebarTint")}
                    min={SKIN_BG_LIMITS.sidebarTint.min}
                    max={SKIN_BG_LIMITS.sidebarTint.max}
                    step={0.05}
                    value={draft.background.sidebarTint ?? SKIN_BG_LIMITS.sidebarTint.default}
                    onChange={(v) => setBgControl("sidebarTint", v)}
                  />
                  <p className="skin-editor-hint">{t("skins.sidebarTintHint")}</p>
                  <p className="skin-editor-hint">{t("skins.bgThemeHint")}</p>
                  {draft.background.kind === "video" ? (
                    <p className="skin-editor-hint">{t("skins.videoHint")}</p>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          <div className="skin-editor-preview" style={previewStyle}>
            {bgUrl ? (
              draft.background.kind === "video" ? (
                <video className="skin-editor-preview-media" src={bgUrl} muted loop playsInline autoPlay />
              ) : (
                <div className="skin-editor-preview-media" style={{ backgroundImage: `url("${bgUrl}")` }} />
              )
            ) : null}
            <div className="skin-editor-preview-scrim" style={{ opacity: draft.background.kind === "none" ? 0 : (draft.background.scrim ?? SKIN_BG_LIMITS.scrim.default) }} />
            <div className="skin-editor-preview-app">
              <aside className="skin-editor-preview-side" data-has-bg={hasBg ? "true" : undefined}>
                <span className="skin-editor-preview-side-row is-active" />
                <span className="skin-editor-preview-side-row" />
                <span className="skin-editor-preview-side-row" />
              </aside>
              <div className="skin-editor-preview-ui">
                <div className="skin-editor-preview-topbar">
                  <span className="skin-editor-preview-dot" />
                  {t("skins.previewTitle")}
                </div>
                <div className="skin-editor-preview-msg user">{t("skins.previewUser")}</div>
                <div className="skin-editor-preview-msg bot">{t("skins.previewBot")}</div>
                <div className="skin-editor-preview-cta">{t("skins.previewButton")}</div>
              </div>
            </div>
          </div>
        </div>

        <footer className="skin-editor-foot">
          <Button variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>{t("skins.save")}</Button>
        </footer>
      </div>
    </div>,
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="skin-editor-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function toDraft(initial: Skin | null): Draft {
  if (initial) {
    return {
      id: initial.id,
      name: initial.name,
      tokens: { ...initial.tokens },
      background: { ...initial.background },
    };
  }
  // A fresh skin seeds from the 千凝 palette so the first preview already looks
  // intentional, but the user can retune every field. The base foundation is
  // derived from the background colour, so no theme choice is needed here.
  const seed = builtinSkinById("qianning");
  return {
    id: `diy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    tokens: seed ? { ...seed.tokens } : {},
    background: { kind: "none" },
  };
}

/** Native <input type=color> needs a #rrggbb value; drop any alpha channel. */
function normalizeHex(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7).toLowerCase();
  return "#5b8def";
}

/** Exported for the contract test's allowlist assertion. */
export const EDITOR_TOKEN_KEYS = EDITOR_TOKENS.map((e) => e.key);
