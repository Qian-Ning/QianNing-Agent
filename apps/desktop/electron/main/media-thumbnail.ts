/**
 * The derived thumbnails the media history leads with.
 *
 * A row used to decode the full-size render, which is the wrong shape once a
 * library grows; the right one is a small copy written when the render lands.
 * This module is the only place that writes one. It uses Electron's own image
 * decoder, so no image dependency joins the tree, and the render file itself is
 * never touched. Nothing here is load-bearing: a copy that cannot be written is a
 * smaller picture, never a failed run.
 *
 * Images only. A clip's poster frame needs the video decoder, which lives in the
 * renderer rather than the main process, and putting one on disk is its own item.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nativeImage } from "electron";
import { libraryRelativePath } from "./media-asset";
import {
  mediaLibraryDir,
  type MediaLibraryCapability,
  thumbPathFor,
} from "./services/media-library";

/**
 * The width a copy is written at, in pixels. History rows draw the picture at 32
 * CSS pixels, so this is its HiDPI double: sharp on a scaled display, still only
 * a few kilobytes beside the render.
 */
const THUMB_WIDTH = 64;

/**
 * Write the small copy of one finished render, best effort.
 *
 * A failed or cancelled item has no file, a non-image capability has no copy, and
 * an unreadable file decodes to an empty image: each of those returns quietly and
 * leaves the row on the full-size render, which is how it behaved before
 * thumbnails existed.
 */
export async function writeRenderThumbnail(
  dataDir: string,
  capability: MediaLibraryCapability,
  file: string | undefined,
): Promise<void> {
  if (capability !== "image" || typeof file !== "string" || file.length === 0) return;
  // Only a render inside the library gets a copy: a file this app cannot serve
  // has no row to lead with, and copying it in would leave an orphan behind.
  if (!libraryRelativePath(mediaLibraryDir(dataDir), file)) return;
  const target = thumbPathFor(dataDir, capability, file);
  if (!target) return;
  const source = nativeImage.createFromPath(file);
  if (source.isEmpty()) return;
  const small = source.resize({ width: THUMB_WIDTH, quality: "good" });
  if (small.isEmpty()) return;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, small.toPNG());
}
