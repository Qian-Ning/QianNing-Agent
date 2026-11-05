import { dialog } from "electron";
import { join } from "node:path";
import { IPC } from "@pi-desktop/shared";
import {
  deleteWallpaperProject,
  importWallpaperSource,
  readWallpaperEntryFile,
  readWallpaperProjectMeta,
  registerWallpaperProject,
  seedDemoWallpaper,
  type WallpaperProject,
} from "../wallpaper-store";
import { captureWallpaperPreview } from "../wallpaper-thumbnail";
import { wallpaperRoots } from "../wallpaper-protocol";
import { installWallpaperPreset, listWallpaperPresets } from "../wallpaper-presets";
import type { IpcRegistrar } from "./types";

/**
 * Live-wallpaper host channels.
 *
 * Kept apart from the skin channels because they answer a different question:
 * a project is a directory that has to be copied, validated and registered as a
 * servable root, while a skin is a record in settings. The renderer calls these
 * only through `useSkinLibrary`, and every path here ends in the same
 * `registerWallpaperProject`, so one project id cannot be served without also
 * being known to the protocol.
 */
export type SkinWallpaperIpcDependencies = {
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

export function registerSkinWallpaperIpc({
  registrar,
  dataDir,
  demoWallpaperRoot,
  presetWallpaperRoot,
  getMainWindow,
}: SkinWallpaperIpcDependencies): void {
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
      return withPreview(dataDir, project);
    },
  );

  // The bundled sample, for installations with no Wallpaper Engine library.
  registrar.handle(IPC.invoke.skinSeedWallpaper, async (): Promise<WallpaperProject> => {
    const project = seedDemoWallpaper(dataDir, demoWallpaperRoot);
    registerWallpaperProject(dataDir, project.projectId, wallpaperRoots);
    return withPreview(dataDir, project);
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
      return withPreview(dataDir, project);
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


/**
 * A project that ships no still gets one captured from its own first frame.
 *
 * The capture runs after the project is registered, because it loads the very
 * `wallpaper://` URL the app would mount — a still taken from any other source
 * could drift from what the engine paints. Failure is silent by design: the
 * import already succeeded and a card without a picture is cosmetic.
 */
async function withPreview(dataDir: string, project: WallpaperProject): Promise<WallpaperProject> {
  if (project.hasPreview) return project;
  const dir = join(dataDir, "wallpapers", project.projectId);
  const entry = readWallpaperEntryFile(dir);
  if (!entry) return project;
  const name = await captureWallpaperPreview(dir, project.projectId, entry);
  if (!name) return project;
  const meta = readWallpaperProjectMeta(dir);
  return { ...project, hasPreview: meta.preview !== null, preview: meta.preview };
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
    filters: [{ name: "Wallpaper project", extensions: ["zip", "json", "pkg", "html"] }],
  };
}
