/**
 * The poster frame a clip row leads with, taken on this side of the app.
 *
 * A `<video>` element is a decoder, and the renderer is the only place the app has
 * one: the main process can resize a still with Electron's image decoder, but it
 * cannot pull a frame out of a clip. So the frame is taken here and the bytes are
 * handed to the main process, which owns the library and is the only side allowed
 * to write into it.
 *
 * Nothing here is load-bearing. A clip that will not decode, a canvas the frame
 * may not be drawn to, a write the main process refuses — each leaves the row
 * exactly as it would have been without a poster, and none of them touches the
 * render that produced it.
 */
import type { MediaWorkbenchCapability, MediaWorkbenchItemResult } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/** The width a poster is drawn at: the same HiDPI double the image copies use. */
export const POSTER_WIDTH = 64;

/** How long a clip is given to produce a frame before its row goes without one. */
const FRAME_BUDGET_MS = 5000;

/** Whether an item already names a derived copy. */
function hasThumbUrl(item: MediaWorkbenchItemResult): boolean {
  return "thumbUrl" in item && typeof item.thumbUrl === "string" && item.thumbUrl.length > 0;
}

/**
 * The clips in a finished run that still need a poster.
 *
 * Only a succeeded item with a file this app can load: a failed or cancelled item
 * produced nothing to decode. An item that already carries a `thumbUrl` has its
 * poster, so a second pass over the same results writes nothing.
 */
export function posterTargets(
  capability: MediaWorkbenchCapability,
  results: MediaWorkbenchItemResult[] | null | undefined,
): MediaWorkbenchItemResult[] {
  if (capability !== "video") return [];
  return (results ?? []).filter(
    (item) =>
      item.status === "succeeded" &&
      typeof item.path === "string" &&
      item.path.length > 0 &&
      typeof item.url === "string" &&
      item.url.length > 0 &&
      !hasThumbUrl(item),
  );
}

/**
 * The size a frame is drawn at: `POSTER_WIDTH` across, the clip's own aspect ratio
 * down, and nothing at all while the clip reports no dimensions.
 */
export function posterFrameSize(
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: POSTER_WIDTH, height: Math.max(1, Math.round((height / width) * POSTER_WIDTH)) };
}

/** Resolve on the event, or reject once the clip has spent its budget. */
function once(target: HTMLVideoElement, event: string, budgetMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(new Error(`the clip could not be decoded before ${event}`));
    const timer = window.setTimeout(
      () => finish(new Error(`the clip did not reach ${event} in time`)),
      budgetMs,
    );
    target.addEventListener(event, onEvent);
    target.addEventListener("error", onError);
  });
}

/** The frame a clip gives up as a PNG data URL, or null when it gives up none. */
async function frameFromClip(url: string): Promise<string | null> {
  const clip = document.createElement("video");
  clip.muted = true;
  clip.preload = "auto";
  // The frame is drawn to a canvas, so the bytes have to be CORS-clean; the
  // library scheme answers with the header that makes that true.
  clip.crossOrigin = "anonymous";
  clip.src = url;
  try {
    await once(clip, "loadeddata", FRAME_BUDGET_MS);
    const size = posterFrameSize(clip.videoWidth, clip.videoHeight);
    if (!size) return null;
    // A little way in: frame zero of a clip is often black, and a black square
    // reads as a broken picture rather than as a clip.
    clip.currentTime = Math.min(0.1, (clip.duration || 0) / 2);
    await once(clip, "seeked", FRAME_BUDGET_MS);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(clip, 0, 0, size.width, size.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    // Let go of the clip rather than leaving a decoder parked on it.
    clip.removeAttribute("src");
    clip.load();
  }
}

/**
 * Take a poster for every clip in a finished run that needs one.
 *
 * Called after a run answers and before the library is re-read, so the row that
 * appears already has its picture. Every failure is swallowed on purpose: this is
 * a small picture on a row, not part of the render.
 */
export async function savePosterFrames(
  capability: MediaWorkbenchCapability,
  results: MediaWorkbenchItemResult[] | null | undefined,
): Promise<void> {
  for (const item of posterTargets(capability, results)) {
    if (typeof item.url !== "string" || typeof item.path !== "string") continue;
    const dataUrl = await frameFromClip(item.url);
    if (!dataUrl) continue;
    await api.workbenchSaveThumbnail({ capability, path: item.path, dataUrl }).catch(() => undefined);
  }
}
