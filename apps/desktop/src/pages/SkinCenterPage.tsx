import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_SKINS,
  NO_SKIN_ID,
  type Skin,
  type SkinWallpaperPreset,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { Button, SettingsToggle } from "../components/ui";
import { IconDownload, IconImage, IconPlus } from "../components/icons";
import { SkinPreview } from "../features/skins/SkinPreview";
import { SkinTile } from "../features/skins/SkinTile";
import { SkinEditorDialog } from "../features/skins/SkinEditorDialog";
import { hasWallpaper, skinTypeKey } from "../features/skins/model";
import { useSkinLibrary } from "../features/skins/useSkinLibrary";

/**
 * The skin center is a gallery, not a settings form.
 *
 * One large stage shows what is on right now — the actual window, drawn with the
 * skin's own palette, because a colour swatch cannot tell you whether a theme is
 * pleasant. Below it, two rails of thumbnails: shipped looks and your own. Tiles
 * are pictures; every verb lives behind the ⋯ menu, so the page reads as a
 * wardrobe instead of a control panel.
 *
 * Persistence, asset ownership and write ordering live in `useSkinLibrary`;
 * this file is layout and intent only.
 */
export function SkinCenterPage() {
  const { t } = useTranslation();
  const library = useSkinLibrary();
  const [editing, setEditing] = useState<Skin | "new" | null>(null);
  const [dropping, setDropping] = useState(false);
  // Bundled artwork ships with the app; the list is read once because it only
  // changes when the app does. A missing gallery is not an error — the page
  // simply shows the two rails it always had.
  const [presets, setPresets] = useState<SkinWallpaperPreset[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .listSkinWallpaperPresets()
      .then((list) => {
        if (alive) setPresets(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Rotation walks the skins that actually carry a background; with fewer than
  // two of them the switch would look alive and never change anything.
  const rotatePool = library.customSkins.filter((skin) => skin.background?.kind !== "none").length;

  const active = library.activeSkin;
  const activeLabel = active.id === NO_SKIN_ID ? t("skins.followTheme") : active.name;
  const duplicate = (skin: Skin) => void library.duplicate(skin).then((copy) => copy && setEditing(copy));

  return (
    <div
      className="thread-scroll"
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        // Dragging over a child fires `dragleave` on the parent; only a leave
        // that actually exits the page should hide the target.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
        // Electron removed `File.path` in 32; the preload resolves a real
        // dropped file through webUtils, and returns null for anything else.
        const path = file ? api.getDroppedFilePath(file) : null;
        if (path) void library.importWallpaper("path", path);
      }}
    >
      <div className="page-frame sk-page">
        {dropping ? (
          <div className="sk-drop" aria-hidden>
            <span>{t("skins.dropHint")}</span>
          </div>
        ) : null}
        <header className="sk-head">
          <div className="sk-head-copy">
            <h1 className="page-title">{t("skins.title")}</h1>
            <p className="dest-row-meta">{t("skins.subtitle")}</p>
          </div>
          <div className="sk-head-actions">
            <Button variant="secondary" size="sm" onClick={() => void library.importWallpaper("pick")}>
              <IconImage size={14} aria-hidden /> {t("skins.importWallpaper")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void library.importFromFile()}>
              <IconDownload size={14} aria-hidden /> {t("skins.import")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
              <IconPlus size={14} aria-hidden /> {t("skins.create")}
            </Button>
            {/* Rotation is one switch, not a scheduler: turn it on, pick a pace.
                The interval appears only when rotation is on, so the default
                header stays three buttons wide. */}
            <span className="sk-rotate">
              <SettingsToggle
                checked={library.rotation.enabled}
                disabled={rotatePool < 2}
                label={t("skins.rotate")}
                onChange={() =>
                  void library.setRotation({
                    ...library.rotation,
                    enabled: !library.rotation.enabled,
                  })
                }
              />
              <span className="sk-rotate-label">{t("skins.rotate")}</span>
              {rotatePool < 2 ? (
                <span className="sk-rotate-hint">{t("skins.rotateNeedsTwo")}</span>
              ) : library.rotation.enabled ? (
                <select
                  className="sk-rotate-interval"
                  aria-label={t("skins.rotateInterval")}
                  value={library.rotation.minutes}
                  onChange={(event) =>
                    void library.setRotation({
                      ...library.rotation,
                      minutes: Number(event.target.value),
                    })
                  }
                >
                  {[15, 30, 60, 120, 240].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {t("skins.rotateEvery", { minutes })}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          </div>
        </header>

        <section className="sk-stage" aria-label={`${t("skins.current")}: ${activeLabel}`}>
          {/* Caption and tools live inside the preview, not beside it: they paint
              with the skin's own `--sk-*` variables, which only exist in there. */}
          <SkinPreview skin={active} variant="stage">
            <div className="sk-stage-caption">
              <span className="sk-stage-eyebrow">{t("skins.current")}</span>
              <strong className="sk-stage-name">{activeLabel}</strong>
              <span className="sk-stage-type">{t(skinTypeKey(active))}</span>
            </div>
            {active.id !== NO_SKIN_ID ? (
              <div className="sk-stage-tools">
                {active.builtin ? (
                  <Button variant="secondary" size="sm" onClick={() => duplicate(active)}>
                    {t("skins.duplicate")}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setEditing(active)}>
                    {t("skins.edit")}
                  </Button>
                )}
              </div>
            ) : null}
          </SkinPreview>
        </section>

        {presets.length > 0 ? (
          <section className="sk-preset-rail" aria-label={t("skins.presetsHeading")}>
            <div className="sk-rail-head">
              <h2>{t("skins.presetsHeading")}</h2>
              <span className="sk-rail-hint">{t("skins.presetsHint")}</span>
            </div>
            <div className="sk-rail">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="sk-preset"
                  onClick={() => void library.installPreset(preset)}
                  title={preset.title}
                >
                  <span
                    className="sk-preset-art"
                    style={{ ["--sk-preset-accent" as string]: preset.accent }}
                  />
                  <span className="sk-preset-name">{preset.title}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="sk-rail-block" aria-label={t("skins.builtinHeading")}>
          <div className="sk-rail-head">
            <h2>{t("skins.builtinHeading")}</h2>
          </div>
          <div className="sk-rail">
            {BUILTIN_SKINS.map((skin) => (
              <SkinTile
                key={skin.id}
                skin={skin}
                label={skin.id === NO_SKIN_ID ? t("skins.followTheme") : skin.name}
                active={library.isActive(skin.id)}
                onApply={() => void library.apply(skin.id)}
                actions={skin.id === NO_SKIN_ID ? {} : { onDuplicate: () => duplicate(skin) }}
              />
            ))}
          </div>
        </section>

        <section className="sk-rail-block" aria-label={t("skins.customHeading")}>
          <div className="sk-rail-head">
            <h2>{t("skins.customHeading")}</h2>
            {library.customSkins.length > 0 ? (
              <span className="sk-rail-count">{t("skins.count", { count: library.customSkins.length })}</span>
            ) : null}
          </div>

          {library.customSkins.length === 0 ? (
            <div className="sk-empty">
              <div className="sk-empty-copy">
                <p className="sk-empty-title">{t("skins.customEmptyTitle")}</p>
                <p className="sk-empty-hint">{t("skins.customEmpty")}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void library.importWallpaper("demo")}>
                <IconImage size={14} aria-hidden /> {t("skins.tryDemoWallpaper")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
                <IconPlus size={14} aria-hidden /> {t("skins.create")}
              </Button>
            </div>
          ) : (
            <div className="sk-rail">
              {library.customSkins.map((skin) => (
                <SkinTile
                  key={skin.id}
                  skin={skin}
                  label={skin.name}
                  active={library.isActive(skin.id)}
                  onApply={() => void library.apply(skin.id)}
                  actions={{
                    onEdit: () => setEditing(skin),
                    // Every skin that already carries a background can swap it
                    // in place; a colour-only skin gains one in the editor. The
                    // two sources stay distinct: a project goes through the
                    // wallpaper picker, a photo or clip through the media one.
                    onChangeWallpaper: hasWallpaper(skin)
                      ? () =>
                          void (skin.background.kind === "image" || skin.background.kind === "video"
                            ? library.changeMediaWallpaper(skin)
                            : library.changeWallpaper(skin))
                      : undefined,
                    onDuplicate: () => duplicate(skin),
                    onExport: () => void library.exportToFile(skin),
                    onRemove: () => {
                      if (window.confirm(t("skins.deleteConfirm", { name: skin.name }))) {
                        void library.remove(skin.id);
                      }
                    },
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {editing ? (
          <SkinEditorDialog
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? null : editing}
            startSession={library.startSession}
            onCancel={() => setEditing(null)}
            onSave={async (skin, session) => {
              await library.save(skin, session, editing === "new" ? null : editing);
              setEditing(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
