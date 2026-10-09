import { copyFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { dialog, shell, type BrowserWindow } from "electron";
import {
  IPC,
  MEDIA_WORKBENCH_CAPABILITIES,
  VIDEO_FRAME_FIELD_PATTERN,
  type MediaWorkbenchCapability,
  type MediaWorkbenchFileResult,
  type MediaWorkbenchModelChoice,
  type MediaLibraryResult,
  type MediaWorkbenchRequest,
  type VideoFrameFields,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import { createMediaWorkbenchService, resolveGeneratedFile } from "../services/media-workbench-service";
import {
  clearLibrary,
  mediaLibraryDir,
  migrateScratchRenders,
  readMediaLibrary,
  removeLibraryEntries,
  type MediaLibraryEntry,
} from "../services/media-library";
import type { IpcRegistrar } from "./types";

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The model the user picked; malformed input falls back to the configured one. */
function choiceOf(value: unknown): MediaWorkbenchModelChoice | undefined {
  const record = recordOf(value);
  const providerId = typeof record?.providerId === "string" ? record.providerId.trim() : "";
  const modelId = typeof record?.modelId === "string" ? record.modelId.trim() : "";
  if (!providerId || !modelId || providerId.length > 128 || modelId.length > 256)
    return undefined;
  return { providerId, modelId };
}

/** Multipart names for a clip's frames; only well-formed names survive. */
function frameFieldsOf(value: unknown): VideoFrameFields | undefined {
  const record = recordOf(value);
  const pick = (raw: unknown) =>
    typeof raw === "string" && VIDEO_FRAME_FIELD_PATTERN.test(raw) ? raw : undefined;
  const first = pick(record?.first);
  const last = pick(record?.last);
  if (!first && !last) return undefined;
  return { ...(first ? { first } : {}), ...(last ? { last } : {}) };
}

function capabilityOf(value: unknown): MediaWorkbenchCapability {
  return MEDIA_WORKBENCH_CAPABILITIES.includes(value as MediaWorkbenchCapability)
    ? (value as MediaWorkbenchCapability)
    : "image";
}

/**
 * The media workbench channels.
 *
 * Unlike the Agent tools, the caller here is the user's own click, so there is
 * no approval round-trip: the request runs the same service the tool runs.
 * Progress is pushed to the window that started it, which is what a render that
 * takes minutes needs to show.
 */
export function registerWorkbenchIpc({
  registrar,
  getMainWindow,
  getHost,
  dataDir,
  allowFakeIp,
}: {
  registrar: IpcRegistrar;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  dataDir: string;
  /** The same network policy the generation tools run under. */
  allowFakeIp?: () => boolean;
}): void {
  const service = createMediaWorkbenchService({
    dataDir,
    getHost,
    ...(allowFakeIp ? { allowFakeIp } : {}),
    emit: (event) => getMainWindow()?.webContents.send(IPC.event.workbenchProgress, event),
  });
  const { handle } = registrar;

  handle(IPC.invoke.workbenchGenerate, async (input: Record<string, unknown> = {}) => {
    const capability = capabilityOf(input.capability);
    // A workbench render belongs to the app's library, not to a conversation, so
    // a session is optional here: the run is accepted with or without one.
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    const model = choiceOf(input.model);
    const frames = frameFieldsOf(input.frames);
    return service.generate({
      capability,
      sessionId,
      ...(model ? { model } : {}),
      ...(frames ? { frames } : {}),
      input: (input.input ?? {}) as MediaWorkbenchRequest["input"],
    });
  });

  handle(IPC.invoke.workbenchCancel, async (input: Record<string, unknown> = {}) => ({
    cancelled: service.cancel(typeof input.generationId === "string" ? input.generationId : ""),
  }));

  /**
   * The file this app actually wrote, or nothing.
   *
   * Same containment rule as the generation path's output directory: the target
   * must resolve inside the media library, or inside the scratch root and the
   * named session's directory, so a renderer cannot point these channels at an
   * arbitrary file. A library render needs no session.
   */
  const resolveRender = async (input: Record<string, unknown>): Promise<string | null> => {
    const raw = typeof input.path === "string" ? input.path : "";
    if (!raw) return null;
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    let scratchPath: string | undefined;
    const host = sessionId ? getHost() : null;
    if (host) {
      const result = await host
        .call<{ path: string }>("session.getScratchPath", { sessionId })
        .catch(() => null);
      if (result && typeof result.path === "string") scratchPath = result.path;
    }
    return resolveGeneratedFile({
      dataDir,
      ...(scratchPath ? { scratchPath } : {}),
      target: raw,
    });
  };

  handle(
    IPC.invoke.workbenchSaveAs,
    async (input: Record<string, unknown> = {}): Promise<MediaWorkbenchFileResult> => {
      const source = await resolveRender(input);
      if (!source) return { ok: false };
      const window = getMainWindow();
      const options = { defaultPath: basename(source) };
      const picked = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      try {
        await copyFile(source, picked.filePath);
      } catch {
        return { ok: false };
      }
      return { ok: true, path: picked.filePath };
    },
  );

  /**
   * What this app has rendered before.
   *
   * The index is read once per call and never watched. The one-time import of
   * renders left behind in session scratch runs on the first read, so a user who
   * never opens the workbench pays nothing for it.
   */
  let imported = false;
  handle(IPC.invoke.workbenchLibrary, async (): Promise<MediaLibraryResult> => {
    if (!imported) {
      imported = true;
      await migrateScratchRenders(dataDir).catch(() => undefined);
    }
    return { entries: await readMediaLibrary(dataDir) };
  });

  /**
   * Reclaim the file a removed entry owned.
   *
   * Only a succeeded run has a file, and trashing is best effort by design: a
   * file that is already gone, or an OS that refuses to recycle, must never block
   * the removal the user asked for.
   */
  const trashEntryFile = (entry: MediaLibraryEntry): Promise<void> =>
    entry.status === "succeeded" && typeof entry.path === "string"
      ? shell.trashItem(entry.path).catch(() => undefined)
      : Promise.resolve();

  /**
   * Forget the named entries, sending each file to the OS trash rather than
   * deleting it — a render cost money, so a mistaken removal must be recoverable
   * from the recycle bin.
   */
  handle(
    IPC.invoke.workbenchLibraryRemove,
    async (input: Record<string, unknown> = {}): Promise<MediaLibraryResult> => {
      const ids = Array.isArray(input.ids)
        ? input.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      const removed = await removeLibraryEntries(dataDir, ids);
      await Promise.all(removed.map(trashEntryFile));
      return { entries: await readMediaLibrary(dataDir) };
    },
  );

  /** Forget the whole library, sending every render to the OS trash. */
  handle(
    IPC.invoke.workbenchLibraryClear,
    async (): Promise<MediaLibraryResult> => {
      const removed = await clearLibrary(dataDir);
      await Promise.all(removed.map(trashEntryFile));
      return { entries: [] };
    },
  );

  /** Open the library directory itself, creating it first if it is not there. */
  handle(
    IPC.invoke.workbenchLibraryReveal,
    async (): Promise<MediaWorkbenchFileResult> => {
      const dir = mediaLibraryDir(dataDir);
      await mkdir(dir, { recursive: true }).catch(() => undefined);
      const error = await shell.openPath(dir);
      return error ? { ok: false } : { ok: true, path: dir };
    },
  );

  handle(
    IPC.invoke.workbenchReveal,
    async (input: Record<string, unknown> = {}): Promise<MediaWorkbenchFileResult> => {
      const source = await resolveRender(input);
      if (!source) return { ok: false };
      shell.showItemInFolder(source);
      return { ok: true, path: source };
    },
  );
}
