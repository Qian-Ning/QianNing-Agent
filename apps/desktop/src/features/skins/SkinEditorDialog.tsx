import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SKIN_BG_LIMITS, type Skin, type SkinTokenKey } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input, portalOverlay } from "../../components/ui";
import { IconImage, IconTrash, IconVideo, IconX } from "../../components/icons";
import { SkinPreview } from "./SkinPreview";
import type { AssetSession } from "./asset-session";
import {
  EDITOR_TOKENS,
  draftBase,
  draftColor,
  draftFromSkin,
  draftToSkin,
  backgroundControl,
  isDraftDirty,
  normalizeHex,
  resetTokens,
  withBackground,
  withToken,
  type SkinDraft,
} from "./model";

export { EDITOR_TOKEN_KEYS } from "./model";

/**
 * The DIY skin editor.
 *
 * Three decisions replaced the old dialog:
 *
 *  - **Media is transactional.** Importing a file during an edit makes it
 *    *pending* in the session; only a successful save keeps it, and closing the
 *    editor discards what it created. The old version deleted the stored file the
 *    moment "remove" was pressed, so cancelling afterwards left the saved skin
 *    pointing at a missing wallpaper.
 *  - **The palette is a set of slots, not a form.** Each row shows the colour and
 *    the effective value; a background wallpaper greys the section out with one
 *    line explaining why (the theme owns colours while a wallpaper is on), which
 *    is cheaper to read than a disabled form with no reason.
 *  - **Unsaved work is never silently dropped.** Closing with changes asks first.
 *
 * There is deliberately NO base-theme selector: a skin is not a theme, and the
 * foundation follows the background colour (`deriveSkinBase`).
 */
export function SkinEditorDialog({
  initial,
  onCancel,
  onSave,
  startSession,
}: {
  initial: Skin | null;
  onCancel: () => void;
  onSave: (skin: Skin, session: AssetSession) => Promise<void>;
  startSession: () => AssetSession;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [draft, setDraft] = useState<SkinDraft>(() => draftFromSkin(initial));
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const session = useMemo(() => startSession(), [startSession]);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const dirty = isDraftDirty(draft);
  const base = draftBase(draft);
  const hasMedia = draft.background.kind !== "none";
  const pending = draft.background.assetId ? session.pending().some((entry) => entry.assetId === draft.background.assetId) : false;

  const requestClose = () => {
    if (dirty && !window.confirm(t("skins.discardBody"))) return;
    void sessionRef.current.discard();
    onCancel();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const attachMedia = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.importSkinAsset();
      if (!result) return;
      session.adopt(result);
      // Replacing a file this edit already imported frees the one it replaces;
      // a file the saved skin owns is left to the library, which deletes it only
      // after the save lands and only if nothing else references it.
      const previous = draft.background;
      if (previous.assetId && previous.ext && session.pending().some((entry) => entry.assetId === previous.assetId)) {
        session.drop(previous.assetId, previous.ext);
      }
      setDraft((current) =>
        withBackground(current, {
          kind: result.kind,
          assetId: result.assetId,
          assetName: result.assetName,
          ext: result.ext,
          opacity: current.background.opacity ?? SKIN_BG_LIMITS.opacity.default,
          blur: current.background.blur ?? SKIN_BG_LIMITS.blur.default,
          scrim: current.background.scrim ?? SKIN_BG_LIMITS.scrim.default,
          sidebarTint: current.background.sidebarTint ?? SKIN_BG_LIMITS.sidebarTint.default,
        }),
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const clearMedia = () => {
    if (pending && draft.background.assetId && draft.background.ext) {
      session.drop(draft.background.assetId, draft.background.ext);
    }
    setDraft((current) => withBackground(current, { kind: "none" }));
  };

  const save = async () => {
    if (!draft.name.trim()) {
      nameRef.current?.focus();
      showToast(t("skins.nameRequired"), { variant: "error" });
      return;
    }
    const skin = draftToSkin(draft);
    if (!skin) {
      showToast(t("skins.saveInvalid"), { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      await onSave(skin, session);
    } finally {
      setBusy(false);
    }
  };

  const preview: Skin = {
    id: draft.id,
    name: draft.name || t("skins.previewTitle"),
    base,
    tokens: draft.tokens,
    background: draft.background,
  };

  return portalOverlay(
    <div className="overlay skin-editor-overlay" role="dialog" aria-modal="true" aria-label={initial ? t("skins.editorEditTitle") : t("skins.editorTitle")}>
      <div className="sk-editor">
        <header className="sk-editor-head">
          <div className="sk-editor-heading">
            <span className="sk-editor-heading-icon" aria-hidden>
              <IconImage size={14} />
            </span>
            <h2>{initial ? t("skins.editorEditTitle") : t("skins.editorTitle")}</h2>
          </div>
          <button type="button" className="sk-editor-close" onClick={requestClose} aria-label={t("common.close")}>
            <IconX size={16} />
          </button>
        </header>

        <div className="sk-editor-body">
          <div className="sk-editor-preview">
            <SkinPreview skin={preview} variant="editor" />
          </div>

          <div className="sk-editor-form">
            <label className="sk-field">
              <span className="sk-field-label">{t("skins.fieldName")}</span>
              <Input
                ref={nameRef}
                value={draft.name}
                maxLength={40}
                placeholder={t("skins.namePlaceholder")}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>

            <section className="sk-section" aria-label={t("skins.fieldAccent")}>
              <div className="sk-section-head">
                <h3>{t("skins.sectionColors")}</h3>
                <button type="button" className="sk-section-reset" onClick={() => setDraft((current) => resetTokens(current))}>
                  {t("skins.resetColors")}
                </button>
              </div>
              <div className="sk-swatches" data-muted={hasMedia ? "true" : undefined}>
                {EDITOR_TOKENS.map((entry) => {
                  const value = draftColor(draft, entry.key);
                  return (
                    <label key={entry.key} className="sk-swatch">
                      <span className="sk-swatch-chip" style={{ background: normalizeHex(value) }}>
                        <input
                          type="color"
                          value={normalizeHex(value)}
                          onChange={(event) => setDraft((current) => withToken(current, entry.key, event.target.value))}
                          aria-label={t(entry.labelKey)}
                        />
                      </span>
                      <span className="sk-swatch-copy">
                        <span className="sk-swatch-label">{t(entry.labelKey)}</span>
                        <span className="sk-swatch-hex">{normalizeHex(value)}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {hasMedia ? <p className="sk-hint">{t("skins.bgThemeHint")}</p> : null}
            </section>

            <section className="sk-section">
              <div className="sk-section-head">
                <h3>{t("skins.fieldBackground")}</h3>
              </div>
              {hasMedia ? (
                <div className="sk-media">
                  <div className="sk-media-row">
                    <span className="sk-media-icon" aria-hidden>
                      {draft.background.kind === "video" ? <IconVideo size={14} /> : <IconImage size={14} />}
                    </span>
                    <span className="«redacted:sk-…»">
                      {draft.background.kind === "scene" || draft.background.kind === "web"
                        ? draft.background.projectTitle ?? t("skins.mediaAttached")
                        : draft.background.assetName ?? t("skins.mediaAttached")}
                    </span>
                    <button type="button" className="sk-media-remove" onClick={clearMedia} aria-label={t("skins.removeMedia")}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                  <SliderRow
                    label={t("skins.opacity")}
                    min={SKIN_BG_LIMITS.opacity.min}
                    max={SKIN_BG_LIMITS.opacity.max}
                    step={0.05}
                    value={draft.background.opacity ?? SKIN_BG_LIMITS.opacity.default}
                    onChange={(value) => setDraft((current) => backgroundControl(current, "opacity", value))}
                  />
                  <SliderRow
                    label={t("skins.blur")}
                    min={SKIN_BG_LIMITS.blur.min}
                    max={SKIN_BG_LIMITS.blur.max}
                    step={1}
                    value={draft.background.blur ?? SKIN_BG_LIMITS.blur.default}
                    onChange={(value) => setDraft((current) => backgroundControl(current, "blur", value))}
                  />
                  <SliderRow
                    label={t("skins.scrim")}
                    min={SKIN_BG_LIMITS.scrim.min}
                    max={SKIN_BG_LIMITS.scrim.max}
                    step={0.05}
                    value={draft.background.scrim ?? SKIN_BG_LIMITS.scrim.default}
                    onChange={(value) => setDraft((current) => backgroundControl(current, "scrim", value))}
                  />
                  <SliderRow
                    label={t("skins.sidebarTint")}
                    min={SKIN_BG_LIMITS.sidebarTint.min}
                    max={SKIN_BG_LIMITS.sidebarTint.max}
                    step={0.05}
                    value={draft.background.sidebarTint ?? SKIN_BG_LIMITS.sidebarTint.default}
                    onChange={(value) => setDraft((current) => backgroundControl(current, "sidebarTint", value))}
                  />
                  <p className="sk-hint">{t("skins.sidebarTintHint")}</p>
                  {draft.background.kind === "video" ? <p className="sk-hint">{t("skins.videoHint")}</p> : null}
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void attachMedia()} disabled={busy}>
                  <IconImage size={14} aria-hidden /> {t("skins.attachMedia")}
                </Button>
              )}
            </section>
          </div>
        </div>

        <footer className="sk-editor-foot">
          <Button variant="ghost" size="sm" onClick={requestClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || !draft.name.trim()}>
            {t("skins.save")}
          </Button>
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
  format = (v: number) => `${Math.round(v * 100)}%`,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="sk-slider">
      <span className="sk-slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="sk-slider-value">{format(value)}</span>
    </label>
  );
}

/** Unused but explicit: the editor never writes a token outside this list. */
export type EditorTokenKey = SkinTokenKey;
