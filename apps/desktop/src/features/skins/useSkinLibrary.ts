import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  NO_SKIN_ID,
  sanitizeSkin,
  sanitizeSkinRotation,
  type Skin,
  type SkinRotationSettings,
  type SkinWallpaperPreset,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { resolveSkin } from "../../lib/skin-engine";
import { createAssetSession, type AssetSession } from "./asset-session";
import { createSkinId, duplicateOf, skinFromWallpaper } from "./model";
import { writeSkinSettings } from "./skin-settings-writer";

/**
 * The one place a skin library is mutated.
 *
 * Before this hook the page wrote `{ ...settings, ...patch }` itself, spreading a
 * settings object captured at render time. Two edits in flight (apply a skin,
 * then delete another) could write the second change over the first, and every
 * caller had to remember to clean up media. Here:
 *
 *   - writes are serialized through one queue, and each write re-reads the
 *     current settings instead of trusting a stale copy,
 *   - the store is updated optimistically and restored if the host rejects it,
 *   - media belongs to an {@link AssetSession}: a replaced or deleted background
 *     is only removed from disk when no surviving skin still references it.
 */
export type SkinLibrary = {
  customSkins: readonly Skin[];
  activeId: string;
  activeSkin: Skin;
  isActive: (id: string) => boolean;
  apply: (id: string) => Promise<void>;
  save: (skin: Skin, session?: AssetSession, previous?: Skin | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  duplicate: (skin: Skin) => Promise<Skin | null>;
  importFromFile: () => Promise<Skin | null>;
  /**
   * Copy a live-wallpaper project into the profile and turn it into a skin.
   * `demo` seeds the bundled sample instead of opening a picker, so the feature
   * is reachable without a Wallpaper Engine library.
   */
  /** `path` is a dropped archive or project folder; `pick` opens the dialog. */
  importWallpaper: (mode: "pick" | "demo" | "path", path?: string) => Promise<Skin | null>;
  /** Swap the wallpaper behind an existing skin; palette, name and id stay. */
  changeWallpaper: (skin: Skin) => Promise<void>;
  /** Add one bundled preset as a new skin, through the normal import path. */
  installPreset: (preset: SkinWallpaperPreset) => Promise<Skin | null>;
  /** Swap a photo or clip behind an existing skin; palette, name and id stay. */
  changeMediaWallpaper: (skin: Skin) => Promise<void>;
  exportToFile: (skin: Skin) => Promise<void>;
  /** Automatic rotation through the background-carrying skins. */
  rotation: SkinRotationSettings;
  setRotation: (next: SkinRotationSettings) => Promise<void>;
  /** A fresh media session for one editing pass. */
  startSession: () => AssetSession;
};

export function useSkinLibrary(): SkinLibrary {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);

  const customSkins = useMemo(() => settings?.customSkins ?? [], [settings?.customSkins]);
  const activeId = settings?.activeSkinId ?? NO_SKIN_ID;
  const activeSkin = useMemo(() => resolveSkin(activeId, customSkins), [activeId, customSkins]);

  const report = useCallback(
    (error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    },
    [showToast],
  );

  /**
   * Deletes a media file only when no stored skin still points at it. Two skins
   * can share one asset (a duplicate does), so "the skin is gone" is not the same
   * question as "the file is unused".
   */
  const deleteIfUnreferenced = useCallback(async (assetId: string, ext?: string) => {
    if (!ext) return;
    const stillUsed = (useAppStore.getState().settings?.customSkins ?? []).some(
      (entry) => entry.background.assetId === assetId,
    );
    if (stillUsed) return;
    await api.deleteSkinAsset(assetId, ext).catch(() => undefined);
  }, []);

  /** The same reference question for a copied wallpaper project. */
  const deleteProjectIfUnreferenced = useCallback(async (projectId: string | undefined) => {
    if (!projectId) return;
    const stillUsed = (useAppStore.getState().settings?.customSkins ?? []).some(
      (entry) => entry.background.projectId === projectId,
    );
    if (stillUsed) return;
    await api.deleteSkinWallpaper(projectId).catch(() => undefined);
  }, []);

  /**
   * Serialized persistence. The patch is a function of the *current* settings, so
   * a queued write never resurrects a field another write already changed.
   */
  const persist = useCallback(
    (patch: (current: NonNullable<typeof settings>) => Partial<NonNullable<typeof settings>>) =>
      writeSkinSettings(patch),
    [],
  );

  const apply = useCallback(
    async (id: string) => {
      try {
        await persist(() => ({ activeSkinId: id }));
      } catch (error) {
        report(error);
      }
    },
    [persist, report],
  );

  const save = useCallback(
    async (skin: Skin, session?: AssetSession, previous?: Skin | null) => {
      const safe = sanitizeSkin(skin);
      if (!safe) {
        showToast(t("skins.saveInvalid"), { variant: "error" });
        return;
      }
      try {
        await persist((current) => {
          const list = current.customSkins ?? [];
          const exists = list.some((entry) => entry.id === safe.id);
          const customSkins = exists
            ? list.map((entry) => (entry.id === safe.id ? safe : entry))
            : [...list, safe];
          return { customSkins, activeSkinId: safe.id };
        });
        // The save landed: files this edit imported now belong to the stored skin.
        session?.commit();
        // The file the edit replaced is garbage only once nothing points at it.
        const replaced = previous?.background;
        if (replaced?.assetId && replaced.assetId !== safe.background.assetId) {
          await deleteIfUnreferenced(replaced.assetId, replaced.ext);
        }
        // Same rule for a copied project: editing a live skin onto another
        // wallpaper leaves the old folder behind unless nothing points at it.
        if (replaced?.projectId && replaced.projectId !== safe.background.projectId) {
          await deleteProjectIfUnreferenced(replaced.projectId);
        }
      } catch (error) {
        report(error);
      }
    },
    [deleteIfUnreferenced, persist, report, showToast, t],
  );

  const remove = useCallback(
    async (id: string) => {
      const target = customSkins.find((entry) => entry.id === id) ?? null;
      try {
        await persist((current) => {
          const customSkins = (current.customSkins ?? []).filter((entry) => entry.id !== id);
          const activeSkinId = current.activeSkinId === id ? NO_SKIN_ID : current.activeSkinId;
          return { customSkins, activeSkinId };
        });
        if (target?.background.assetId) {
          await deleteIfUnreferenced(target.background.assetId, target.background.ext);
        }
        if (target?.background.projectId) {
          await deleteProjectIfUnreferenced(target.background.projectId);
        }
      } catch (error) {
        report(error);
      }
    },
    [customSkins, deleteIfUnreferenced, persist, report],
  );

  const duplicate = useCallback(
    async (skin: Skin) => {
      const copy = duplicateOf(skin, customSkins, (name) => t("skins.copySuffix", { name }));
      try {
        // A copy is not applied: the user asked for a starting point, not a swap.
        await persist((current) => ({ customSkins: [...(current.customSkins ?? []), copy] }));
        return copy;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [customSkins, persist, report, t],
  );

  const importFromFile = useCallback(async () => {
    try {
      const result = await api.importSkin();
      if (!result) return null;
      const safe = sanitizeSkin(result.skin);
      if (!safe) throw new Error(t("skins.importInvalid"));
      // A fresh id keeps the import from overwriting a skin that already exists;
      // the name is kept as-is so the user recognises the file they opened.
      const imported: Skin = { ...safe, id: createSkinId(), builtin: false };
      await persist((current) => ({
        customSkins: [...(current.customSkins ?? []), imported],
        activeSkinId: imported.id,
      }));
      showToast(t("skins.imported"), { variant: "success" });
      return imported;
    } catch (error) {
      report(error);
      return null;
    }
  }, [persist, report, showToast, t]);

  const importWallpaper = useCallback(
    async (mode: "pick" | "demo" | "path", path?: string) => {
      try {
        const project =
          mode === "demo"
            ? await api.seedSkinWallpaper()
            : await api.importSkinWallpaper(mode === "path" ? path : undefined);
        if (!project) return null;
        const skin = skinFromWallpaper(project, useAppStore.getState().settings?.customSkins ?? []);
        await persist((current) => ({
          customSkins: [...(current.customSkins ?? []), skin],
          activeSkinId: skin.id,
        }));
        showToast(t("skins.wallpaperImported", { name: project.title }), { variant: "success" });
        return skin;
      } catch (error) {
        // The host rejects with an English technical reason ("no project.json",
        // "too many files"). That reason is for the log; the person who picked
        // the file needs the one sentence that tells them what to pick instead.
        console.warn("[skins] wallpaper import failed", error);
        const code = (error as { code?: string }).code;
        showToast(
          t(code === "WALLPAPER_PACKAGED" ? "skins.wallpaperPackaged" : "skins.wallpaperImportFailed"),
          { variant: "error" },
        );
        return null;
      }
    },
    [persist, report, showToast, t],
  );

  /**
   * Add one wallpaper from the bundled gallery.
   *
   * The host copies the preset into the profile and returns the project it
   * created; from there this is the same road a dropped folder takes — one skin
   * per project, named after the artwork.
   */
  const installPreset = useCallback(
    async (preset: SkinWallpaperPreset) => {
      try {
        const project = await api.installSkinWallpaperPreset(preset.id);
        const skin = skinFromWallpaper(project, useAppStore.getState().settings?.customSkins ?? []);
        await persist((current) => ({
          customSkins: [...(current.customSkins ?? []), skin],
          activeSkinId: skin.id,
        }));
        showToast(t("skins.wallpaperImported", { name: project.title }), { variant: "success" });
        return skin;
      } catch (error) {
        console.warn("[skins] preset install failed", error);
        showToast(t("skins.wallpaperImportFailed"), { variant: "error" });
        return null;
      }
    },
    [persist, showToast, t],
  );

  /**
   * Replace the wallpaper of an existing skin.
   *
   * The skin's id, name, palette and position in the rail are the user's work;
   * only the background changes. It goes through `save` so the replaced project
   * is released exactly like an edit's replaced file — one ownership rule for
   * both kinds of background.
   */
  const changeWallpaper = useCallback(
    async (skin: Skin) => {
      try {
        const project = await api.importSkinWallpaper();
        if (!project) return;
        // Read the stored copy: the tile may have rendered before a rotation or
        // another tab's write, and this write must start from what is on disk.
        const base =
          useAppStore.getState().settings?.customSkins?.find((entry) => entry.id === skin.id) ?? skin;
        const next = sanitizeSkin({
          ...base,
          background: {
            ...base.background,
            kind: project.kind,
            assetId: undefined,
            ext: undefined,
            projectId: project.projectId,
            projectTitle: project.title,
            preview: project.preview ?? undefined,
          },
        });
        if (!next) {
          showToast(t("skins.saveInvalid"), { variant: "error" });
          return;
        }
        await save(next, undefined, base);
        showToast(t("skins.wallpaperChanged", { name: project.title }), { variant: "success" });
      } catch (error) {
        console.warn("[skins] wallpaper change failed", error);
        const code = (error as { code?: string }).code;
        showToast(
          t(code === "WALLPAPER_PACKAGED" ? "skins.wallpaperPackaged" : "skins.wallpaperImportFailed"),
          { variant: "error" },
        );
      }
    },
    [save, showToast, t],
  );

  /**
   * Replace a still/video background from the media picker.
   *
   * Same ownership rules as the project swap: the new file is adopted by a
   * session, the save commits it, and the replaced file is deleted only if no
   * surviving skin still points at it. Only the background changes.
   */
  const changeMediaWallpaper = useCallback(
    async (skin: Skin) => {
      const session = createAssetSession((assetId, ext) => deleteIfUnreferenced(assetId, ext));
      try {
        const result = await api.importSkinAsset();
        if (!result) {
          await session.discard();
          return;
        }
        session.adopt(result);
        const base =
          useAppStore.getState().settings?.customSkins?.find((entry) => entry.id === skin.id) ?? skin;
        const next = sanitizeSkin({
          ...base,
          background: {
            ...base.background,
            kind: result.kind,
            assetId: result.assetId,
            assetName: result.assetName,
            ext: result.ext,
            projectId: undefined,
            projectTitle: undefined,
          },
        });
        if (!next) {
          await session.discard();
          showToast(t("skins.saveInvalid"), { variant: "error" });
          return;
        }
        await save(next, session, base);
        showToast(t("skins.wallpaperChanged", { name: result.assetName ?? result.kind }), {
          variant: "success",
        });
      } catch (error) {
        await session.discard();
        console.warn("[skins] media wallpaper change failed", error);
        showToast(t("skins.wallpaperImportFailed"), { variant: "error" });
      }
    },
    [deleteIfUnreferenced, save, showToast, t],
  );

  const rotation = useMemo<SkinRotationSettings>(
    () => sanitizeSkinRotation(settings?.skinRotation) ?? { enabled: false, minutes: 30 },
    [settings?.skinRotation],
  );

  const setRotation = useCallback(
    async (next: SkinRotationSettings) => {
      try {
        await persist(() => ({ skinRotation: sanitizeSkinRotation(next) ?? undefined }));
      } catch (error) {
        report(error);
      }
    },
    [persist, report],
  );

  const exportToFile = useCallback(
    async (skin: Skin) => {
      try {
        const result = await api.exportSkin(skin);
        if (result.ok) showToast(t("skins.exported"), { variant: "success" });
      } catch (error) {
        report(error);
      }
    },
    [report, showToast, t],
  );

  const startSession = useCallback(
    () => createAssetSession((assetId, ext) => deleteIfUnreferenced(assetId, ext)),
    [deleteIfUnreferenced],
  );

  return {
    customSkins,
    activeId,
    activeSkin,
    isActive: (id: string) => id === activeId,
    apply,
    save,
    remove,
    duplicate,
    importFromFile,
    importWallpaper,
    changeWallpaper,
    changeMediaWallpaper,
    installPreset,
    exportToFile,
    rotation,
    setRotation,
    startSession,
  };
}
