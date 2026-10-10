/**
 * The host-owned scheme that maps the media library into the renderer.
 *
 * A finished render is a real file under `<data directory>/generated`, and the
 * workbench needs to play a clip in place rather than hand the user a folder
 * path. A `file://` URL would leak an absolute path into the renderer and is
 * blocked by the renderer's CSP; a `data:` URL would inflate a clip into memory
 * before playback even starts. Instead the library is served over one confined
 * scheme, `media-asset://library/<capability>/<name>`, whose path component is
 * the library-relative render path — never an absolute one.
 *
 * This module is deliberately free of any Electron import: the containment rule,
 * the Range parser and the response-header assembly are pure and unit-tested on
 * their own (`test/media-asset.test.mjs`). The Electron wiring lives beside it in
 * `media-asset-protocol.ts`. The scheme and its wire shape are owned here alone
 * (ADR 0322), so the main process and the tests cannot drift.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The scheme every library asset URL carries, reserved before app-ready. */
export const MEDIA_ASSET_SCHEME = "media-asset";

/**
 * The single host a library URL may address. A path under any other host is
 * refused, so one scheme can never be pointed at a second namespace.
 */
export const MEDIA_ASSET_HOST = "library";

/** Prefix of every library URL: `media-asset://library/`. */
export const MEDIA_ASSET_PREFIX = `${MEDIA_ASSET_SCHEME}://${MEDIA_ASSET_HOST}/`;

const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** The content type for a render, or null when its extension is not served. */
export function mediaAssetMimeType(fileName: string): string | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extension] ?? null;
}

/**
 * True when `candidate` resolves to a path strictly inside `root`. Compared on
 * resolved absolute paths with a trailing separator so a sibling directory that
 * merely shares a name prefix cannot pass.
 */
export function isInside(root: string, candidate: string): boolean {
  const base = resolve(root) + sep;
  return resolve(candidate).startsWith(base);
}

/**
 * The renderer-facing URL for a library-relative path (`video/<name>`). The
 * relative path is the only thing a URL ever carries; no absolute path is built
 * here, and separators are normalized to `/` so the URL is host-independent.
 */
export function mediaAssetUrl(relativePath: string): string {
  const posix = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .join("/");
  return `${MEDIA_ASSET_PREFIX}${posix}`;
}

/** A library-relative path must name a render under a capability directory. */
const ALLOWED_TOP = /^(image|video)\//;

/**
 * Map the path component of a `media-asset://` request to an absolute file
 * inside `root`, or null.
 *
 * This is the containment invariant (ADR 0322): the percent-decoded,
 * separator-normalized path —
 *  - must not be empty, absolute, drive-qualified, or carry a NUL,
 *  - must not contain a `.` or `..` segment (traversal is refused before any
 *    join, so an encoded `%2e%2e%2f` cannot slip past a later prefix test),
 *  - must begin with `image/` or `video/` (the library index beside the renders
 *    is not a servable asset),
 *  - and must still resolve inside the root after joining.
 *
 * Anything else fails closed with null rather than an escaped path.
 */
export function resolveLibraryAsset(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // A URL pathname is absolute-looking (`/video/x.mp4`), so the leading slashes
  // are the scheme's own, not traversal. What remains must be a relative path.
  const posix = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  // A Windows drive prefix is never a library-relative path.
  if (/^[A-Za-z]:/.test(posix)) return null;
  const segments = posix.split("/").filter((segment) => segment.length > 0);
  // Names only: a `.` or `..` segment is traversal, not a file name. Checked
  // before the join so it cannot be laundered by a valid-looking prefix.
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  if (!ALLOWED_TOP.test(segments.join("/"))) return null;
  const candidate = resolve(root, ...segments);
  if (!isInside(root, candidate)) return null;
  return candidate;
}

/**
 * The library-relative POSIX path for an absolute file, or null when it does not
 * sit inside `root` or does not name an `image/` or `video/` render. The inverse
 * of {@link resolveLibraryAsset}, used to build a URL for a file the app owns.
 */
export function libraryRelativePath(root: string, absoluteFile: string): string | null {
  const rel = relative(resolve(root), resolve(absoluteFile));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const posix = rel.split(sep).join("/");
  return ALLOWED_TOP.test(posix) ? posix : null;
}

/**
 * The URL for a library file when it is one, or undefined: a failed or cancelled
 * entry has no `path`, and a path outside the library is not servable. This is
 * the single place a render is turned into a URL the renderer may load.
 */
export function mediaAssetUrlForFile(
  root: string,
  absoluteFile: string | undefined,
): string | undefined {
  if (!absoluteFile) return undefined;
  const rel = libraryRelativePath(root, absoluteFile);
  return rel ? mediaAssetUrl(rel) : undefined;
}

/** A satisfied byte range: both ends inclusive, in bytes. */
export type ByteRange = { start: number; end: number };

/**
 * The outcome of reading a `Range` header. `none` is "serve the whole file with
 * 200"; `invalid` is "syntactically a range but unsatisfiable" (416); `range` is
 * a 206 over the given window.
 */
export type ParsedByteRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "range"; start: number; end: number };

/**
 * Parse a single HTTP byte range (`bytes=start-end`) against a known file size.
 * Only the single-range form a `<video>` element emits is supported; a multipart
 * range, a malformed header, or a range past the end is rejected as `invalid`
 * (416) rather than silently served whole. A missing header is `none` (200).
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ParsedByteRange {
  if (header == null || header.trim() === "") return { kind: "none" };
  if (size <= 0) return { kind: "invalid" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "invalid" };
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "invalid" };
  if (rawStart === "") {
    // Suffix form `bytes=-N`: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return { kind: "invalid" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isInteger(start) || start >= size) return { kind: "invalid" };
  if (rawEnd === "") return { kind: "range", start, end: size - 1 };
  const parsedEnd = Number(rawEnd);
  if (!Number.isInteger(parsedEnd) || parsedEnd < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(parsedEnd, size - 1) };
}

/** `Content-Range` for a 206, e.g. `bytes 0-1023/4096`. */
export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/**
 * Headers for a 206 over `[start, end]`. `Accept-Ranges: bytes` is what tells a
 * `<video>` element it may seek, and `Content-Range`/`Content-Length` are what
 * make a drag-to-seek produce the right window.
 *
 * The CORS headers are what let the renderer *draw* bytes it may already display:
 * a poster frame is taken by decoding a finished clip onto a canvas, and a
 * cross-origin media element taints one unless the response allows it. The scheme
 * is registered `corsEnabled`, so this is the half that was missing. `*` is
 * deliberate — the scheme serves only this app's own library, read-only, with
 * every path confined to the library root and no credentials involved.
 */
export function rangeResponseHeaders(
  start: number,
  end: number,
  size: number,
  mime: string,
): Record<string, string> {
  return {
    "content-type": mime,
    "content-length": String(end - start + 1),
    "content-range": contentRangeHeader(start, end, size),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges, content-range, content-length",
  };
}

/**
 * Headers for a 200 over the whole file. `Accept-Ranges` advertises seeking; the
 * CORS headers are the same pair described on {@link rangeResponseHeaders}, for
 * the requests that are not ranges.
 */
export function fullResponseHeaders(size: number, mime: string): Record<string, string> {
  return {
    "content-type": mime,
    "content-length": String(size),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "accept-ranges, content-range, content-length",
  };
}

/** The largest poster frame the main process will keep from the renderer, in bytes. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The bytes of a PNG a canvas encoded, or null when the value is not one.
 *
 * A poster frame arrives as bytes the renderer produced, so the shape is checked
 * rather than trusted: only a PNG `data:` URL within the size cap is accepted, and
 * the magic number is verified so the copy lands as the image it claims to be.
 * The header already reads images from this app's own library; this is the return
 * path, and it stays this narrow on purpose.
 */
export function decodeThumbnailDataUrl(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) return null;
  return bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? bytes : null;
}
