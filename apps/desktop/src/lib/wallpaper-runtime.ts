import type { SkinBackground } from "@pi-desktop/shared";

/**
 * The live-wallpaper runtime.
 *
 * A scene or web wallpaper is not an image: it is a project directory rendered
 * by `webwallgl` into a canvas/iframe. This module owns that instance's whole
 * life — one project at a time, mounted into the skin background layer that
 * `skin-engine` already paints and dims, destroyed the moment the skin changes
 * so a heavy scene never keeps a GPU context alive behind another wallpaper.
 *
 * `webwallgl` is imported on demand: an installation that never picks a live
 * wallpaper never downloads or evaluates the renderer.
 */

type WallpaperInstance = {
  destroy?: () => void;
  pause?: () => void;
  play?: () => void;
};

type Current = {
  projectId: string;
  host: HTMLDivElement;
  instance: WallpaperInstance | null;
  background: SkinBackground;
  /**
   * The wallpaper was mounted while the window was hidden. `webwallgl` pauses
   * the document's CSS animations on mount, and its `play()` does not restart
   * them for a page source, so such an instance stays frozen for good. The
   * instance is remounted on the next visible frame instead of resumed.
   */
  pausedAtMount: boolean;
};

let current: Current | null = null;
/** Bumped on every teardown so a slow `import()` cannot mount a stale project. */
let generation = 0;
let visibilityBound = false;

/** The served base URL for a live background, or null when it is not one. */
export function liveWallpaperUrl(background: SkinBackground): string | null {
  if (background.kind !== "scene" && background.kind !== "web") return null;
  const id = background.projectId;
  if (!id) return null;
  return `wallpaper://project/${id}/`;
}

/** Destroy the running wallpaper, if any. Safe to call repeatedly. */
export function clearLiveWallpaper(): void {
  generation += 1;
  if (!current) return;
  const { instance, host } = current;
  current = null;
  try {
    instance?.destroy?.();
  } catch {
    // A destroy that throws must not strand the layer; removal below still runs.
  }
  host.remove();
}

function bindVisibility(): void {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!current) return;
    if (document.hidden) {
      current.instance?.pause?.();
      return;
    }
    if (current.pausedAtMount) {
      // Resume is not enough for a page source: rebuild it while the window can
      // actually paint, which is the only state webwallgl animates in.
      const { background, host } = current;
      const layer = host.parentElement;
      clearLiveWallpaper();
      if (layer) applyLiveWallpaper(background, layer);
      return;
    }
    current.instance?.play?.();
  });
}

/**
 * Mount the wallpaper a background names, or clear the layer when it names
 * none. Re-applying the same project is a no-op: `applySkin` runs on every
 * settings change, and re-mounting a scene for an unrelated colour edit would
 * flash the desktop.
 */
export function applyLiveWallpaper(background: SkinBackground, layer: HTMLElement): void {
  const url = liveWallpaperUrl(background);
  // The phone build shares this renderer but has no `wallpaper://` handler and
  // no desktop host; a live background there would just be an empty frame.
  if (!url || typeof window === "undefined" || !window.piDesktop) {
    clearLiveWallpaper();
    return;
  }
  const projectId = background.projectId as string;
  if (current?.projectId === projectId) return;

  clearLiveWallpaper();
  bindVisibility();
  const token = generation;
  const host = document.createElement("div");
  host.className = "qn-live-wallpaper";
  layer.append(host);
  current = { projectId, host, instance: null, background, pausedAtMount: false };

  void (async () => {
    const { mount, httpSource } = await import("webwallgl");
    if (token !== generation) return;
    const instance = (await mount(host, {
      source: httpSource(url, {}),
      // A wallpaper is scenery: 30 fps is enough to read as motion and leaves
      // the GPU headroom the interface needs while a model streams.
      fps: 30,
      volume: 0,
      // Never run a project's own scripts by default. A workshop scene is code
      // we did not write, and `webwallgl` is explicit that this is not a
      // security boundary.
      scripts: false,
    })) as unknown as WallpaperInstance;
    if (token !== generation) {
      instance.destroy?.();
      return;
    }
    const hidden = document.hidden;
    current = { projectId, host, instance, background, pausedAtMount: hidden };
    if (hidden) instance.pause?.();
  })().catch((error: unknown) => {
    console.warn("[wallpaper] mount failed", error);
    if (token === generation) clearLiveWallpaper();
  });
}

// Development-only handle: lets a DevTools session mount a project without
// waiting for a settings round trip, which is how the layer is captured in the
// Electron window during review. Stripped from production builds by the bundler.
if (import.meta.env.DEV) {
  (window as unknown as { __qnApplyWallpaper?: typeof applyLiveWallpaper }).__qnApplyWallpaper =
    applyLiveWallpaper;
}
