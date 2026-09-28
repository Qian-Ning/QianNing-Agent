import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_SKINS,
  NO_SKIN_ID,
  sanitizeSkin,
  type Skin,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { applySkin, resolveSkin } from "../lib/skin-engine";
import { Button } from "../components/ui";
import { IconDownload, IconPalette, IconPlus } from "../components/icons";
import { SkinEditorDialog } from "../features/skins/SkinEditorDialog";
import { SkinCard } from "../features/skins/SkinCard";

/**
 * The skin center: a full page (its own sidebar entry) that lets the user swap
 * the whole look — colours plus an optional image/video wallpaper — build their
 * own, and share skins as files. It is distinct from the theme picker: applying
 * a skin never changes light/dark; it layers on top.
 */
export function SkinCenterPage() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const showToast = useAppStore((s) => s.showToast);
  const [editing, setEditing] = useState<Skin | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const activeSkinId = settings?.activeSkinId ?? NO_SKIN_ID;
  const customSkins = useMemo(() => settings?.customSkins ?? [], [settings?.customSkins]);

  // Live preview: hovering a card applies it transiently; leaving restores the
  // saved active skin. The store is never written until the user commits.
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => {
    const id = previewId ?? activeSkinId;
    applySkin(resolveSkin(id, customSkins));
    return () => {
      applySkin(resolveSkin(activeSkinId, customSkins));
    };
  }, [previewId, activeSkinId, customSkins]);

  const persist = async (patch: {
    activeSkinId?: string;
    customSkins?: Skin[];
  }) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    await api.setSettings(next);
    useAppStore.setState({ settings: next });
  };

  const applyAndSave = async (id: string) => {
    setPreviewId(null);
    try {
      await persist({ activeSkinId: id });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const saveSkin = async (skin: Skin) => {
    const safe = sanitizeSkin(skin);
    if (!safe) return;
    const rest = customSkins.filter((entry) => entry.id !== safe.id);
    const nextCustom = [...rest, safe];
    await persist({ customSkins: nextCustom, activeSkinId: safe.id });
    setEditing(null);
  };

  const deleteSkin = async (id: string) => {
    const target = customSkins.find((entry) => entry.id === id);
    const nextCustom = customSkins.filter((entry) => entry.id !== id);
    const nextActive = activeSkinId === id ? NO_SKIN_ID : activeSkinId;
    try {
      await persist({ customSkins: nextCustom, activeSkinId: nextActive });
      // Free the background asset the deleted skin owned.
      if (target?.background.assetId && target.background.ext) {
        await api.deleteSkinAsset(target.background.assetId, target.background.ext).catch(() => undefined);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const exportSkin = async (skin: Skin) => {
    try {
      const result = await api.exportSkin(skin);
      if (result.ok) showToast(t("skins.exported"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const importSkin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.importSkin();
      if (!result) return;
      const safe = sanitizeSkin(result.skin);
      if (!safe) throw new Error(t("skins.importInvalid"));
      // Give the imported skin a fresh id so it never clobbers an existing one.
      const imported: Skin = { ...safe, id: freshId(), builtin: false };
      const nextCustom = [...customSkins, imported];
      await persist({ customSkins: nextCustom, activeSkinId: imported.id });
      showToast(t("skins.imported"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;

  return (
    <div className="skin-center">
      <header className="skin-center-head">
        <div className="skin-center-title">
          <IconPalette size={20} aria-hidden />
          <div>
            <h1>{t("skins.title")}</h1>
            <p>{t("skins.subtitle")}</p>
          </div>
        </div>
        <div className="skin-center-actions">
          <Button variant="secondary" size="sm" onClick={() => void importSkin()} disabled={busy}>
            <IconDownload size={14} aria-hidden /> {t("skins.import")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
            <IconPlus size={14} aria-hidden /> {t("skins.create")}
          </Button>
        </div>
      </header>

      <section className="skin-grid" aria-label={t("skins.builtinHeading")}>
        <h2 className="skin-grid-heading">{t("skins.builtinHeading")}</h2>
        <div className="skin-grid-cards">
          {BUILTIN_SKINS.map((skin) => (
            <SkinCard
              key={skin.id}
              skin={skin}
              active={activeSkinId === skin.id}
              onApply={() => void applyAndSave(skin.id)}
              onPreviewStart={() => setPreviewId(skin.id)}
              onPreviewEnd={() => setPreviewId(null)}
              typeLabel={skinTypeLabel(skin, t)}
            />
          ))}
        </div>
      </section>

      <section className="skin-grid" aria-label={t("skins.customHeading")}>
        <h2 className="skin-grid-heading">{t("skins.customHeading")}</h2>
        {customSkins.length === 0 ? (
          <p className="skin-empty">{t("skins.customEmpty")}</p>
        ) : (
          <div className="skin-grid-cards">
            {customSkins.map((skin) => (
              <SkinCard
                key={skin.id}
                skin={skin}
                active={activeSkinId === skin.id}
                onApply={() => void applyAndSave(skin.id)}
                onPreviewStart={() => setPreviewId(skin.id)}
                onPreviewEnd={() => setPreviewId(null)}
                onEdit={() => setEditing(skin)}
                onExport={() => void exportSkin(skin)}
                onDelete={() => void deleteSkin(skin.id)}
                typeLabel={skinTypeLabel(skin, t)}
                editable
              />
            ))}
          </div>
        )}
      </section>

      {editing ? (
        <SkinEditorDialog
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={saveSkin}
        />
      ) : null}
    </div>
  );
}

function skinTypeLabel(skin: Skin, t: (key: string) => string): string {
  if (skin.background.kind === "video") return t("skins.typeVideo");
  if (skin.background.kind === "image") return t("skins.typeImage");
  return t("skins.typeColor");
}

/** A random custom-skin id that never collides with a built-in reserved id. */
function freshId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `diy-${Date.now().toString(36)}-${rand}`;
}
