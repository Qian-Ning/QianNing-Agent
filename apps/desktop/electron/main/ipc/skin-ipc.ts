import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { dialog } from "electron";
import {
  IPC,
  QNSKIN_MAGIC,
  QNSKIN_VERSION,
  sanitizeQnskinBundle,
  sanitizeSkin,
  skinMediaKindForExtension,
  type QnskinBundle,
  type Skin,
  type SkinImportAssetResult,
} from "@pi-desktop/shared";
import {
  deleteSkinAsset,
  readSkinAsset,
  storeSkinAsset,
  SKIN_ASSET_MAX_BYTES,
} from "../skin-asset-protocol";
import {
  deleteWallpaperProject,
  exportWallpaperFiles,
  importWallpaperSource,
  registerWallpaperProject,
  restoreWallpaperProject,
  seedDemoWallpaper,
  type WallpaperProject,
} from "../wallpaper-store";
import { wallpaperRoots } from "../wallpaper-protocol";
import { installWallpaperPreset, listWallpaperPresets } from "../wallpaper-presets";
import type { IpcRegistrar } from "./types";

export type SkinIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  /** Bundled sample project, used when the user has no Wallpaper Engine library. */
  demoWallpaperRoot: string;
  /** Bundled gallery of ready-made projects (photographs, CC0). */
  presetWallpaperRoot: string;
  getMainWindow: () => Electron.BrowserWindow | null;
};

export type SkinImportWallpaperRequest = { path?: string };
export type SkinDeleteWallpaperRequest = { projectId?: string };

export type SkinImportAssetRequest = { path?: string };

export type SkinDeleteAssetRequest = { assetId?: string; ext?: string };
export type SkinExportRequest = {
  skin?: Skin;
  /**
   * Write straight to this path instead of asking. The window never sends it;
   * it exists so an automated run can exercise the real export/import round
   * trip, which a native save dialog otherwise makes impossible to script.
   */
  path?: string;
};
export type SkinImportResult = { skin: Skin; asset?: { ext: string; data: string } } | null;

/**
 * Register the skin center's host channels. These are the only skin operations
 * that need the main process: picking and copying local background media into
 * the confined assets directory, deleting it, and reading/writing a shareable
 * `.qnskin` bundle. Applying a skin and persisting the active id are pure
 * renderer + settings work and do not come through here.
 */
export function registerSkinIpc({
  registrar,
  dataDir,
  demoWallpaperRoot,
  presetWallpaperRoot,
  getMainWindow,
}: SkinIpcDependencies): void {
  // Import a local image/video as a background asset. The renderer may pass a
  // path it already resolved from a drop (via webUtils.getPathForFile); with no
  // path we open a native picker. Either way the bytes are copied under an
  // opaque id — the original path never becomes the skin's reference.
  registrar.handle(IPC.invoke.skinImportAsset, async (request: SkinImportAssetRequest) => {
    let sourcePath = typeof request?.path === "string" ? request.path : "";
    if (!sourcePath) {
      const window = getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, pickerOptions())
        : await dialog.showOpenDialog(pickerOptions());
      if (result.canceled || result.filePaths.length === 0) return null;
      sourcePath = result.filePaths[0];
    }
    const ext = extname(sourcePath).replace(/^\./, "").toLowerCase();
    const kind = skinMediaKindForExtension(ext);
    if (kind === "none") throw new Error("unsupported skin background type");
    const bytes = new Uint8Array(readFileSync(sourcePath));
    if (bytes.byteLength > SKIN_ASSET_MAX_BYTES) throw new Error("skin asset too large");
    const stored = storeSkinAsset(dataDir, ext, bytes);
    const result: SkinImportAssetResult = {
      assetId: stored.assetId,
      assetName: basename(sourcePath),
      ext: stored.ext,
      kind,
      bytes: stored.bytes,
    };
    return result;
  });

  registrar.handle(IPC.invoke.skinDeleteAsset, async (request: SkinDeleteAssetRequest) => {
    if (request?.assetId && request?.ext) {
      deleteSkinAsset(dataDir, request.assetId, request.ext);
    }
    return { ok: true };
  });

  // Export a skin to a `.qnskin` file the user chooses. The background media, if
  // any, is inlined as base64 so the single file is self-contained and shareable.
  registrar.handle(IPC.invoke.skinExport, async (request: SkinExportRequest) => {
    const skin = sanitizeSkin(request?.skin);
    if (!skin) throw new Error("invalid skin");
    const window = getMainWindow();
    const target = request.path?.trim();
    const save = target
      ? { canceled: false, filePath: target }
      : window
        ? await dialog.showSaveDialog(window, saveOptions(skin.name))
        : await dialog.showSaveDialog(saveOptions(skin.name));
    if (save.canceled || !save.filePath) return { ok: false };
    const bundle: QnskinBundle = { magic: QNSKIN_MAGIC, version: QNSKIN_VERSION, skin };
    if (skin.background.kind !== "none" && skin.background.assetId) {
      const ext = extForAsset(skin);
      const bytes = ext ? readSkinAsset(dataDir, skin.background.assetId, ext) : null;
      if (bytes && ext) {
        bundle.asset = { ext, data: Buffer.from(bytes).toString("base64") };
      } else {
        // Asset gone — export a colours-only skin rather than a dangling reference.
        bundle.skin = { ...skin, background: { kind: "none" } };
      }
    }
    // A live wallpaper is a directory on this machine, so the bundle carries the
    // project's own files. Without them a shared skin arrives pointing at a
    // project id the importing installation has never seen.
    if (skin.background.kind === "scene" || skin.background.kind === "web") {
      const projectId = skin.background.projectId;
      try {
        if (!projectId) throw new Error("missing project");
        bundle.wallpaper = {
          projectId,
          files: exportWallpaperFiles(dataDir, projectId),
        };
      } catch {
        // Project gone — ship the colours rather than a skin that cannot mount.
        bundle.skin = { ...skin, background: { kind: "none" } };
      }
    }
    writeFileSync(save.filePath, JSON.stringify(bundle));
    return { ok: true, path: save.filePath };
  });

  // Import a `.qnskin` file. Everything is re-validated through the shared
  // sanitizer; the inlined media is written to a fresh confined asset so the
  // returned skin references an id this installation owns.
  registrar.handle(IPC.invoke.skinImport, async (request?: { path?: string }): Promise<SkinImportResult> => {
    const window = getMainWindow();
    const given = request?.path?.trim();
    const result = given
      ? { canceled: false, filePaths: [given] }
      : window
        ? await dialog.showOpenDialog(window, openBundleOptions())
        : await dialog.showOpenDialog(openBundleOptions());
    if (result.canceled || result.filePaths.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(result.filePaths[0], "utf8"));
    } catch {
      throw new Error("not a valid .qnskin file");
    }
    const bundle = sanitizeQnskinBundle(parsed);
    if (!bundle) throw new Error("not a valid .qnskin file");
    const skin = bundle.skin;
    if (bundle.wallpaper && (skin.background.kind === "scene" || skin.background.kind === "web")) {
      // The bundle's project id belongs to the exporting install; restore the
      // files under a fresh id this installation owns and serve that one.
      const project = restoreWallpaperProject(dataDir, bundle.wallpaper.files);
      registerWallpaperProject(dataDir, project.projectId, wallpaperRoots);
      skin.background = {
        ...skin.background,
        kind: project.kind,
        projectId: project.projectId,
        projectTitle: project.title,
      };
    }
    if (bundle.asset && skin.background.kind !== "none") {
      const bytes = new Uint8Array(Buffer.from(bundle.asset.data, "base64"));
      const stored = storeSkinAsset(dataDir, bundle.asset.ext, bytes);
      skin.background.assetId = stored.assetId;
    }
    return { skin };
  });

  // Import a live wallpaper project. The picker hands back a directory (or a
  // file inside one); the host copies it under an opaque id and registers that
  // id as a servable root, so the renderer can mount it immediately.
  registrar.handle(
    IPC.invoke.skinImportWallpaper,
    async (request: SkinImportWallpaperRequest): Promise<WallpaperProject | null> => {
      let sourcePath = typeof request?.path === "string" ? request.path : "";
      if (!sourcePath) {
        const window = getMainWindow();
        const options = folderPickerOptions();
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) return null;
        sourcePath = result.filePaths[0];
      }
      const project = importWallpaperSource(dataDir, sourcePath);
      registerWallpaperProject(dataDir, project.projectId, wallpaperRoots);
      return project;
    },
  );

  // The bundled sample, for installations with no Wallpaper Engine library.
  registrar.handle(IPC.invoke.skinSeedWallpaper, async (): Promise<WallpaperProject> => {
    const project = seedDemoWallpaper(dataDir, demoWallpaperRoot);
    registerWallpaperProject(dataDir, project.projectId, wallpaperRoots);
    return project;
  });

  // The bundled gallery. Listing is metadata only: the renderer never learns a
  // filesystem path, and installing goes through the same import path a dropped
  // folder takes, so validation and id generation cannot drift apart.
  registrar.handle(IPC.invoke.skinListWallpaperPresets, async () =>
    listWallpaperPresets(presetWallpaperRoot),
  );

  registrar.handle(
    IPC.invoke.skinInstallWallpaperPreset,
    async (request: { id?: string }): Promise<WallpaperProject> => {
      const id = typeof request?.id === "string" ? request.id : "";
      const project = installWallpaperPreset(dataDir, presetWallpaperRoot, id);
      registerWallpaperProject(dataDir, project.projectId, wallpaperRoots);
      return project;
    },
  );

  // Deleting a project removes the copied files and stops serving the root. The
  // renderer only calls this once no surviving skin references the id.
  registrar.handle(
    IPC.invoke.skinDeleteWallpaper,
    async (request: SkinDeleteWallpaperRequest) => {
      const projectId = typeof request?.projectId === "string" ? request.projectId : "";
      const ok = deleteWallpaperProject(dataDir, projectId);
      if (ok) wallpaperRoots.delete(projectId);
      return { ok };
    },
  );
}

function extForAsset(skin: Skin): string | null {
  if (skin.background.ext) return skin.background.ext;
  const name = skin.background.assetName ?? "";
  const ext = extname(name).replace(/^\./, "").toLowerCase();
  return ext || null;
}

function pickerOptions(): Electron.OpenDialogOptions {
  return {
    title: "Select a background image or video",
    properties: ["openFile"],
    filters: [
      { name: "Image or video", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "webm"] },
    ],
  };
}

function saveOptions(name: string): Electron.SaveDialogOptions {
  const safe = name.replace(/[^\p{L}\p{N}_ -]/gu, "").trim() || "skin";
  return { title: "Export skin", defaultPath: `${safe}.qnskin`, filters: [{ name: "QianNing skin", extensions: ["qnskin"] }] };
}

/**
 * One picker for both shapes a download arrives in: a `.zip` of the project, or
 * a file inside an unpacked folder. Electron cannot offer files and folders in
 * one dialog, and a zip is the common case — a folder is still reachable by
 * opening it and choosing its `project.json`.
 */
function folderPickerOptions(): Electron.OpenDialogOptions {
  return {
    title: "Select a wallpaper project or .zip",
    properties: ["openFile"],
    filters: [
      { name: "Wallpaper project", extensions: ["zip", "json", "pkg", "html"] },
    ],
  };
}

function openBundleOptions(): Electron.OpenDialogOptions {
  return {
    title: "Import skin",
    properties: ["openFile"],
    filters: [{ name: "QianNing skin", extensions: ["qnskin"] }],
  };
}
