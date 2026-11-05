import { BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A still for a project that does not ship one.
 *
 * A gallery card is 152 px wide and cannot mount a project, so a project with no
 * `preview.*` used to fall back to a flat palette. Here the project is loaded
 * once in a hidden window and its first painted frame is written back into the
 * copied project as `preview.png`; from then on the card paints the real
 * artwork, and the skin carries the file name like any imported still.
 *
 * The window is a capture rig, not a player: JavaScript is off (the engine
 * mounts projects with `scripts: false` for the same reason), no preload is
 * exposed, and it is destroyed as soon as the frame is read.
 */

const WIDTH = 960;
const HEIGHT = 540;
const LOAD_TIMEOUT_MS = 8000;
/**
 * Sample points, in milliseconds after load.
 *
 * A scene often opens on a dark first frame — the bundled sample fades in over
 * 18 seconds — so one early grab would store a near-black card. Three samples
 * across the first seconds, keeping the brightest, costs nothing on projects
 * that ship a still (they never get here) and gives a dim import a real picture.
 */
const SAMPLE_AT_MS = [1200, 3500, 7000];
const BRIGHT_ENOUGH = 40;

export async function captureWallpaperPreview(
  projectDir: string,
  projectId: string,
  entryFile: string,
): Promise<string | null> {
  let window: BrowserWindow | null = null;
  try {
    window = new BrowserWindow({
      show: false,
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      backgroundColor: "#000000",
      webPreferences: {
        // Never shown, never scripted: this exists only to paint one frame.
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.setBackgroundThrottling(false);

    // The project is already registered as a servable root by the caller, so the
    // same URL the app would mount is the one captured here.
    const url = `wallpaper://project/${projectId}/${encodeURI(entryFile)}`;
    await withTimeout(window.loadURL(url), LOAD_TIMEOUT_MS);

    let best: { png: Buffer; score: number } | null = null;
    let elapsed = 0;
    for (const at of SAMPLE_AT_MS) {
      await delay(at - elapsed);
      elapsed = at;
      const image = await window.webContents.capturePage();
      const png = image.toPNG();
      if (!png.length) continue;
      const score = meanLuma(image.toBitmap());
      if (!best || score > best.score) best = { png, score };
      if (score >= BRIGHT_ENOUGH) break;
    }
    if (!best) return null;

    const name = "preview.png";
    writeFileSync(join(projectDir, name), best.png);
    return name;
  } catch (error) {
    // A missing still is cosmetic; the import itself already succeeded.
    console.warn("[wallpaper] preview capture failed", error);
    return null;
  } finally {
    window?.destroy();
  }
}

/** Mean of the BGRA bitmap, 0–255. Enough to choose a frame, not a histogram. */
function meanLuma(bitmap: Buffer): number {
  if (!bitmap.length) return 0;
  let total = 0;
  let samples = 0;
  // Every 97th pixel keeps this linear in memory while staying representative.
  for (let i = 0; i + 3 < bitmap.length; i += 4 * 97) {
    total += 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
    samples += 1;
  }
  return samples ? total / samples : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(value: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wallpaper preview timed out")), ms);
    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
