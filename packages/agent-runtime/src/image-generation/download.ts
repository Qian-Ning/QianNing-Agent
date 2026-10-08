import {
  downloadPublicMedia,
  mediaBoundedBytes,
  mediaError,
  publicMediaAddress,
  type MediaDownloadOptions,
} from "../media/download.js";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export type ImageDownloadOptions = MediaDownloadOptions;

/**
 * Stable error codes for this capability. The shared download core is generic;
 * these strings are the image surface's contract, asserted across the sidecar
 * RPC boundary, so they stay exactly as they shipped.
 */
export const IMAGE_MEDIA_CODES = {
  invalidUrl: "IMAGE_INVALID_URL",
  unsafeUrl: "IMAGE_UNSAFE_URL",
  downloadFailed: "IMAGE_DOWNLOAD_FAILED",
  tooLarge: "IMAGE_TOO_LARGE",
  emptyResponse: "IMAGE_EMPTY_RESPONSE",
} as const;

export function imageError(code: string): Error & { errorCode: string } {
  return mediaError(code);
}

export function boundedBytes(
  response: Pick<Response, "headers" | "body">,
  max: number,
): Promise<Uint8Array> {
  return mediaBoundedBytes(response, max, IMAGE_MEDIA_CODES);
}

export function publicImageAddress(address: string): boolean {
  return publicMediaAddress(address);
}

export function downloadGeneratedImage(
  raw: string,
  signal: AbortSignal,
  options: ImageDownloadOptions = {},
): Promise<Uint8Array> {
  return downloadPublicMedia(raw, signal, MAX_IMAGE_BYTES, IMAGE_MEDIA_CODES, options);
}

export function generatedImageType(bytes: Uint8Array): { mimeType: string; extension: string } {
  const data = Buffer.from(bytes);
  if (data.length > MAX_IMAGE_BYTES) throw imageError("IMAGE_TOO_LARGE");
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  )
    return { mimeType: "image/png", extension: "png" };
  if (
    data.length > 4 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255 &&
    data[data.length - 2] === 255 &&
    data[data.length - 1] === 217
  )
    return { mimeType: "image/jpeg", extension: "jpg" };
  if (
    data.length >= 16 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return { mimeType: "image/webp", extension: "webp" };
  throw imageError("IMAGE_INVALID_CONTENT");
}
