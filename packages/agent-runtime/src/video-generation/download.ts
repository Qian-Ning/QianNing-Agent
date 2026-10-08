import {
  downloadPublicMedia,
  mediaBoundedBytes,
  mediaError,
  type MediaDownloadOptions,
} from "../media/download.js";

/** A clip is tens of MiB, not a few hundred KiB. */
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
export type VideoDownloadOptions = MediaDownloadOptions;

/**
 * Stable error codes for this capability. The shared download core is generic;
 * these strings are the video surface's contract, asserted across the sidecar
 * RPC boundary.
 */
export const VIDEO_MEDIA_CODES = {
  invalidUrl: "VIDEO_INVALID_URL",
  unsafeUrl: "VIDEO_UNSAFE_URL",
  downloadFailed: "VIDEO_DOWNLOAD_FAILED",
  tooLarge: "VIDEO_TOO_LARGE",
  emptyResponse: "VIDEO_EMPTY_RESPONSE",
} as const;

export function videoError(code: string): Error & { errorCode: string } {
  return mediaError(code);
}

export function videoBoundedBytes(
  response: Pick<Response, "headers" | "body">,
  max: number,
): Promise<Uint8Array> {
  return mediaBoundedBytes(response, max, VIDEO_MEDIA_CODES);
}

export function downloadGeneratedVideo(
  raw: string,
  signal: AbortSignal,
  options: VideoDownloadOptions = {},
): Promise<Uint8Array> {
  return downloadPublicMedia(raw, signal, MAX_VIDEO_BYTES, VIDEO_MEDIA_CODES, options);
}

/**
 * Accept only containers the app can play back.
 *
 * `ftyp` at offset 4 is the ISO base media file format that mp4 and QuickTime
 * share; the brand decides which. `1A 45 DF A3` is the EBML header of
 * Matroska/WebM. A provider that hands back anything else is rejected rather
 * than saved with a guessed extension the player would then refuse.
 */
export function generatedVideoType(bytes: Uint8Array): { mimeType: string; extension: string } {
  const data = Buffer.from(bytes);
  if (data.length > MAX_VIDEO_BYTES) throw videoError("VIDEO_TOO_LARGE");
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp") {
    const brand = data.toString("ascii", 8, 12);
    if (brand.startsWith("qt"))
      return { mimeType: "video/quicktime", extension: "mov" };
    return { mimeType: "video/mp4", extension: "mp4" };
  }
  if (
    data.length >= 4 &&
    data[0] === 0x1a &&
    data[1] === 0x45 &&
    data[2] === 0xdf &&
    data[3] === 0xa3
  )
    return { mimeType: "video/webm", extension: "webm" };
  throw videoError("VIDEO_INVALID_CONTENT");
}
